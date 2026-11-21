import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import request, { type Test } from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { hashPassword } from '../../src/auth/password.js';
import { dispatchDueCertificateWork, jobIdentity, processCertificateWork, startCertification } from '../../src/certificates/dispatcher.js';
import { grantToken } from '../../src/certificates/tokens.js';
import type { IssuanceSettings } from '../../src/certificates/work-context.js';
import { readApiConfig } from '../../src/config.js';
import type { Role } from '../../src/generated/prisma/client.js';
import { testDatabase } from './database.js';

const redisUrl = process.env.TEST_REDIS_URL;
if (!redisUrl) throw new Error('Set TEST_REDIS_URL to a dedicated Redis test instance.');
const db = testDatabase();
const key = randomBytes(6).toString('hex');
const origin = 'http://localhost:8080';
const linkSecret = randomBytes(32).toString('base64url');
const password = randomBytes(24).toString('base64url');
const names = ['owner', 'dev', 'meera', 'neha', 'farah'] as const;
type Account = (typeof names)[number];
const fixtureBatches = new Set<string>();
const users = new Map<Account, { id: string; cookie: string }>();
let directory: string;
let centreId: string;
let districtId: string;
let app: ReturnType<typeof createApp>;
let sequence = 0;
const email = (name: string) => name + '-' + key + '@example.test';

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'certiflow-pdf-'));
  app = createApp(readApiConfig({
    NODE_ENV: 'test', APP_ORIGIN: origin, DATABASE_URL: process.env.TEST_DATABASE_URL,
    CERTIFICATE_STORAGE: directory, CERTIFICATE_LINK_SECRET: linkSecret,
  }), db);
  const passwordHash = await hashPassword(password);
  const fixture = await db.$transaction(async (tx) => {
    const district = await tx.district.create({ data: { name: 'Certificate District', code: key } });
    const centre = await tx.trainingCentre.create({ data: { name: 'Certificate Centre', code: key, districtId: district.id } });
    const roles: Role[] = ['TRAINING_CENTRE', 'DISTRICT_OFFICER', 'DISTRICT_OFFICER', 'QUALITY_REVIEWER', 'STATE_OFFICER'];
    const accounts = await tx.user.createManyAndReturn({
      data: names.map((name, index) => ({
        role: roles[index]!, centreId: index === 0 ? centre.id : null,
        districtId: index === 1 || index === 2 ? district.id : null,
        email: email(name), displayName: name, passwordHash,
      })),
    });
    return { centre, district, accounts };
  });
  centreId = fixture.centre.id;
  districtId = fixture.district.id;
  for (const name of names) {
    const signedIn = await request(app).post('/api/auth/login').send({ email: email(name), password }).expect(200);
    const cookies = signedIn.headers['set-cookie'];
    if (!Array.isArray(cookies) || !cookies[0]) throw new Error('Missing session cookie');
    users.set(name, { id: fixture.accounts.find((account) => account.email === email(name))!.id, cookie: cookies[0].split(';', 1)[0]! });
  }
}, 20_000);

afterEach(async () => {
  const batchIds = Array.from(fixtureBatches);
  await db.$transaction(async (tx) => {
    const revisions = await tx.batchRevision.findMany({ where: { batchId: { in: batchIds } }, select: { id: true } });
    const revisionIds = revisions.map(({ id }) => id);
    const certificates = await tx.certificate.findMany({ where: { revisionId: { in: revisionIds } }, select: { id: true } });
    const certificateIds = certificates.map(({ id }) => id);
    const deliveries = await tx.messageDelivery.findMany({ where: { certificateId: { in: certificateIds } }, select: { id: true } });
    const deliveryIds = deliveries.map(({ id }) => id);
    await tx.mockWhatsAppMessage.deleteMany({ where: { deliveryId: { in: deliveryIds } } });
    await tx.deliveryAttempt.deleteMany({ where: { deliveryId: { in: deliveryIds } } });
    await tx.messageDelivery.deleteMany({ where: { id: { in: deliveryIds } } });
    await tx.certificate.deleteMany({ where: { id: { in: certificateIds } } });
    await tx.outboxEvent.deleteMany({ where: { aggregateId: { in: [...batchIds, ...certificateIds] } } });
    await tx.auditEvent.deleteMany({ where: { resourceId: { in: [...revisionIds, ...certificateIds] } } });
    await tx.notification.deleteMany({ where: { resourceId: { in: batchIds } } });
    await tx.decision.deleteMany({ where: { revisionId: { in: revisionIds } } });
    await tx.revisionCandidate.deleteMany({ where: { revisionId: { in: revisionIds } } });
    await tx.candidate.deleteMany({ where: { batchId: { in: batchIds } } });
    await tx.batchRevision.deleteMany({ where: { id: { in: revisionIds } } });
    await tx.batch.deleteMany({ where: { id: { in: batchIds } } });
  });
  fixtureBatches.clear();
});

afterAll(async () => {
  try {
    if (centreId) {
      await db.trainingCompletion.deleteMany({ where: { centreId } });
      await db.user.deleteMany({ where: { email: { in: names.map(email) } } });
      await db.trainingCentre.delete({ where: { id: centreId } });
      await db.district.delete({ where: { id: districtId } });
    }
  } finally {
    await db.$disconnect();
    if (directory && dirname(directory) === tmpdir()) await rm(directory, { recursive: true, force: true });
  }
});

function staff(test: Test, name: Account) {
  return test.set('Cookie', users.get(name)!.cookie);
}

async function approve(count: number) {
  const prefix = 'CERT-' + ++sequence + '-';
  const courseName = 'Issuance Course ' + sequence;
  const roster = Array.from({ length: count }, (_, index) => ({
    reference: prefix + (index + 1), candidateReference: 'P-' + (index + 1),
  }));
  await db.trainingCompletion.createMany({
    data: roster.map((row) => ({ ...row, courseName, centreId, completedOn: new Date('2025-01-01T00:00:00Z'), passed: true })),
  });
  const batch = (await staff(request(app).post('/api/batches'), 'owner').send({ centreId, courseName }).expect(201)).body.batch;
  fixtureBatches.add(batch.id);
  const csv = ['candidate_reference,full_name,phone_e164,completion_reference',
    ...roster.map(({ reference, candidateReference }, index) => [candidateReference, 'Candidate ' + (index + 1), '+12025550100', reference].join(',')),
  ].join('\n');
  const imported = (await staff(request(app).put('/api/batches/' + batch.id + '/candidates'), 'owner')
    .set('X-Draft-Version', batch.revision.version).type('text/csv').send(csv).expect(200)).body.batch;
  await staff(request(app).post('/api/batches/' + batch.id + '/submit'), 'owner')
    .set('X-Draft-Version', imported.revision.version).send({}).expect(200);

  const endpoint = '/api/reviews/' + batch.id + '/revisions/' + batch.revision.id + '/decisions';
  const votes = await Promise.all((['dev', 'meera'] as const).map((user) =>
    staff(request(app).post(endpoint), user).send({ stage: 'DISTRICT', outcome: 'APPROVE' }).expect(201)));
  expect(votes.map(({ body }) => body.status)).toContain(count >= 50 ? 'QUALITY_REVIEW' : 'STATE_REVIEW');
  if (count >= 50) await staff(request(app).post(endpoint), 'neha').send({ stage: 'QUALITY', outcome: 'APPROVE' }).expect(201);
  await staff(request(app).post(endpoint), 'farah').send({ stage: 'STATE', outcome: 'APPROVE' }).expect(201);

  const event = await db.outboxEvent.findFirstOrThrow({ where: { type: 'batch.approved', aggregateId: batch.id } });
  return { id: batch.id as string, revisionId: batch.revision.id as string, event };
}

function settings(mockMode: IssuanceSettings['mockMode'] = 'success'): IssuanceSettings {
  return { origin, directory, linkSecret, mockMode, retryBaseMs: 250 };
}
function runtime(prefix: string, options = settings(), url = redisUrl) {
  return startCertification(db, { ...options, redisUrl: url!, prefix, pollMs: 35, leaseMs: 450, stalledInterval: 500 },
    (event, error) => { if (event.includes('job_failed')) console.error(event, error); });
}
async function waitDeliveries(revisionId: string, expected: number) {
  await vi.waitFor(async () => {
    expect(await db.messageDelivery.count({ where: { status: 'DELIVERED', certificate: { revisionId } } })).toBe(expected);
  }, { timeout: 22_000, interval: 80 });
}
async function generateOne(options = settings()) {
  const batch = await approve(1);
  await processCertificateWork(db, batch.event.id, options);
  const certificate = await db.certificate.findFirstOrThrow({ where: { revisionId: batch.revisionId } });
  const generation = await db.outboxEvent.findFirstOrThrow({ where: { aggregateId: certificate.id, type: 'certificate.generate' } });
  await processCertificateWork(db, generation.id, options);
  const delivery = await db.outboxEvent.findFirstOrThrow({ where: { aggregateId: certificate.id, type: 'certificate.deliver' } });
  return { batch, certificate, generation, delivery };
}
async function deliveryProgress(id: string) {
  return db.messageDelivery.findUniqueOrThrow({
    where: { certificateId: id }, include: { history: { orderBy: { attempt: 'asc' } }, mockMessage: true },
  });
}


describe('certificate issuance with PostgreSQL, BullMQ and Redis', () => {
  it('issues and delivers 60 unique private PDFs through the complete HTTP approval workflow', async () => {
    const batch = await approve(60);
    const running = runtime('m4-sixty-' + key, settings('mixed'));
    try {
      await waitDeliveries(batch.revisionId, 60);
      const certificates = await db.certificate.findMany({ where: { revisionId: batch.revisionId } });
      expect(certificates).toHaveLength(60);
      for (const field of ['candidateId', 'number', 'trainingCompletionId', 'objectKey'] as const) {
        expect(new Set(certificates.map((row) => row[field])).size).toBe(60);
      }
      expect(certificates.every(({ generationStatus, generationAttempts }) => generationStatus === 'READY' && generationAttempts === 1)).toBe(true);
      await Promise.all(certificates.map(async ({ objectKey, checksum }) => {
        const bytes = await readFile(join(directory, objectKey!));
        expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(checksum);
      }));
      expect(await db.mockWhatsAppMessage.count({ where: { delivery: { certificate: { revisionId: batch.revisionId } } } })).toBe(60);
      const counts = await staff(request(app).get('/api/certificates/batches'), 'farah').expect(200);
      expect(counts.body.batches).toContainEqual(expect.objectContaining({ revisionId: batch.revisionId, candidates: 60, ready: 60, delivered: 60 }));
      const outcomes = await db.deliveryAttempt.groupBy({ by: ['outcome'], where: { delivery: { certificate: { revisionId: batch.revisionId } } } });
      expect(outcomes.map(({ outcome }) => outcome)).toEqual(expect.arrayContaining(['REJECTED', 'TIMEOUT_AFTER_ACCEPTANCE', 'RECEIPT_RECOVERED']));
      expect((await db.outboxEvent.findUniqueOrThrow({ where: { id: batch.event.id } })).completedAt).toBeInstanceOf(Date);
    } finally {
      await running.stop();
    }
  }, 30_000);

  it('replays the approval event and an equivalent second event without changing certificate identities', async () => {
    const batch = await approve(3);
    const replay = await db.outboxEvent.create({ data: {
      type: 'batch.approved', aggregateId: batch.id, dedupeKey: 'test-replay:' + batch.id, payload: { revisionId: batch.revisionId },
    } });
    await Promise.all([processCertificateWork(db, replay.id, settings()), processCertificateWork(db, batch.event.id, settings())]);
    const issued = await db.certificate.findMany({ where: { revisionId: batch.revisionId }, orderBy: { id: 'asc' } });
    expect(issued).toHaveLength(3);
    await db.outboxEvent.update({ where: { id: batch.event.id }, data: { completedAt: null } });
    await processCertificateWork(db, batch.event.id, settings());
    expect(await db.certificate.findMany({ where: { revisionId: batch.revisionId }, orderBy: { id: 'asc' } })).toEqual(issued);
    expect(await db.outboxEvent.count({ where: { type: 'certificate.generate', aggregateId: { in: issued.map(({ id }) => id) } } })).toBe(3);
  });

  it('serializes simultaneous duplicate generation jobs and reuses the committed PDF', async () => {
    const batch = await approve(1);
    await processCertificateWork(db, batch.event.id, settings());
    const certificate = await db.certificate.findFirstOrThrow({ where: { revisionId: batch.revisionId } });
    const original = await db.outboxEvent.findFirstOrThrow({ where: { type: 'certificate.generate', aggregateId: certificate.id } });
    const duplicate = await db.outboxEvent.create({ data: {
      type: 'certificate.generate', aggregateId: certificate.id, dedupeKey: 'test-duplicate:' + certificate.id, payload: {},
    } });
    await Promise.all([original, duplicate, original].map(({ id }) => processCertificateWork(db, id, settings())));
    const prepared = await db.certificate.findUniqueOrThrow({ where: { id: certificate.id } });
    expect(prepared).toMatchObject({ generationStatus: 'READY', generationAttempts: 1 });
    const file = join(directory, prepared.objectKey!);
    const written = await stat(file);
    await db.outboxEvent.update({ where: { id: original.id }, data: { completedAt: null } });
    await processCertificateWork(db, original.id, settings());
    expect((await stat(file)).mtimeMs).toBe(written.mtimeMs);
    expect(await db.auditEvent.count({ where: { resourceId: certificate.id, action: 'CERTIFICATE_ISSUED' } })).toBe(1);
    expect(await db.outboxEvent.count({ where: { aggregateId: certificate.id, type: 'certificate.deliver' } })).toBe(1);
  });

  it('recovers an active job after the actual worker process is killed and restarted', async () => {
    const batch = await approve(1);
    const prefix = 'm4-restart-' + key;
    const connection = new Redis(redisUrl!, { maxRetriesPerRequest: 1 });
    const queue = new Queue('certification', { prefix, connection });
    await queue.waitUntilReady();
    const env = {
      ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL, REDIS_URL: redisUrl,
      APP_ORIGIN: origin, CERTIFICATE_STORAGE: directory, CERTIFICATE_LINK_SECRET: linkSecret,
      CERTIFICATION_QUEUE_PREFIX: prefix, MOCK_WHATSAPP_MODE: 'success',
    };
    try {
      await dispatchDueCertificateWork(db, queue, 450);
      await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "OutboxEvent" WHERE id = ${batch.event.id}::uuid FOR UPDATE`;
        const child = spawn(process.execPath, ['dist/worker.js'], { env, stdio: 'ignore', windowsHide: true });
        const exited = once(child, 'exit');
        try {
          await vi.waitFor(async () => expect(await queue.getJobState(jobIdentity(batch.event.id))).toBe('active'),
            { timeout: 6_000, interval: 40 });
          expect(await tx.certificate.count({ where: { revisionId: batch.revisionId } })).toBe(0);
        } finally {
          child.kill('SIGKILL');
          await exited;
        }
      }, { timeout: 9_000 });
      expect((await db.outboxEvent.findUniqueOrThrow({ where: { id: batch.event.id } })).completedAt).toBeNull();
      const restarted = runtime(prefix);
      try {
        await waitDeliveries(batch.revisionId, 1);
        expect(await db.certificate.count({ where: { revisionId: batch.revisionId } })).toBe(1);
      } finally {
        await restarted.stop();
      }
    } finally {
      await queue.close();
      connection.disconnect();
    }
  }, 35_000);

  it('keeps committed work after Redis disconnect and republishes a lost queue job', async () => {
    const batch = await approve(1);
    const prefix = 'm4-redis-' + key;
    const down = new Redis(redisUrl!, { maxRetriesPerRequest: 1, enableOfflineQueue: false, commandTimeout: 500 });
    const broken = new Queue('certification', { prefix, connection: down });
    await broken.waitUntilReady();
    down.disconnect();
    try {
      await expect(dispatchDueCertificateWork(db, broken, 450)).rejects.toThrow();
      const pending = await db.outboxEvent.findUniqueOrThrow({ where: { id: batch.event.id } });
      expect(pending).toMatchObject({ completedAt: null, attempts: 1 });
      expect(await db.certificate.count({ where: { revisionId: batch.revisionId } })).toBe(0);
    } finally {
      await broken.close().catch(() => undefined);
    }
    const live = new Redis(redisUrl!, { maxRetriesPerRequest: 1 });
    const queue = new Queue('certification', { prefix, connection: live });
    try {
      await vi.waitFor(async () => expect(await dispatchDueCertificateWork(db, queue, 450)).toBeGreaterThan(0),
        { timeout: 4_000, interval: 50 });
      expect(await queue.getJobState(jobIdentity(batch.event.id))).toBe('waiting');
      await queue.drain();
      expect(await queue.getJobState(jobIdentity(batch.event.id))).toBe('unknown');
      const recovered = runtime(prefix);
      try {
        await waitDeliveries(batch.revisionId, 1);
        expect((await db.outboxEvent.findUniqueOrThrow({ where: { id: batch.event.id } })).attempts).toBeGreaterThan(2);
      } finally {
        await recovered.stop();
      }
    } finally {
      await queue.close();
      live.disconnect();
    }
  }, 25_000);

  it('records a rejection, applies backoff and retries to one accepted logical message', async () => {
    const options = { ...settings('reject_once'), retryBaseMs: 1_000 };
    const { batch, certificate, delivery } = await generateOne(options);
    await processCertificateWork(db, delivery.id, options);
    const rejected = await deliveryProgress(certificate.id);
    expect(rejected).toMatchObject({ status: 'PENDING', attempts: 1, lastError: 'MOCK_PROVIDER_REJECTED', mockMessage: null });
    expect(rejected.history[0]?.outcome).toBe('REJECTED');
    expect(rejected.nextAttemptAt!.getTime() - rejected.history[0]!.createdAt.getTime()).toBe(1_000);
    await processCertificateWork(db, delivery.id, options);
    expect((await deliveryProgress(certificate.id)).attempts).toBe(1);

    const running = runtime('m4-retry-' + key, options);
    try {
      await waitDeliveries(batch.revisionId, 1);
      const delivered = await deliveryProgress(certificate.id);
      expect(delivered.history.map(({ outcome }) => outcome)).toEqual(['REJECTED', 'ACCEPTED']);
      expect(delivered.providerReceipt).toBe(delivered.mockMessage?.id);
    } finally {
      await running.stop();
    }
  });

  it('ends repeated provider rejections after five attempts without creating a receipt', async () => {
    const options = { ...settings('reject_always'), retryBaseMs: 30 };
    const { certificate, delivery } = await generateOne(options);
    const running = runtime('m4-exhaustion-' + key, options);
    try {
      await vi.waitFor(async () => expect((await deliveryProgress(certificate.id)).status).toBe('FAILED'),
        { timeout: 8_000, interval: 50 });
      const failed = await deliveryProgress(certificate.id);
      expect(failed).toMatchObject({ attempts: 5, lastError: 'MOCK_PROVIDER_REJECTED', mockMessage: null });
      expect(failed.history.map(({ outcome }) => outcome)).toEqual(Array.from({ length: 5 }, () => 'REJECTED'));
      expect((await db.outboxEvent.findUniqueOrThrow({ where: { id: delivery.id } })).completedAt).toBeInstanceOf(Date);
    } finally {
      await running.stop();
    }
  }, 12_000);

  it('recovers the existing mock receipt after timeout following acceptance', async () => {
    const options = settings('timeout_after_acceptance');
    const { batch, certificate, delivery } = await generateOne(options);
    await processCertificateWork(db, delivery.id, options);
    const accepted = await deliveryProgress(certificate.id);
    expect(accepted).toMatchObject({ status: 'PENDING', providerReceipt: null, lastError: 'MOCK_PROVIDER_TIMEOUT' });
    expect(accepted.mockMessage?.id).toEqual(expect.any(String));
    const restarted = runtime('m4-timeout-' + key, options);
    try {
      await waitDeliveries(batch.revisionId, 1);
      const delivered = await deliveryProgress(certificate.id);
      expect(delivered.providerReceipt).toBe(accepted.mockMessage?.id);
      expect(delivered.history.map(({ outcome }) => outcome)).toEqual(['TIMEOUT_AFTER_ACCEPTANCE', 'RECEIPT_RECOVERED']);
      expect(await db.mockWhatsAppMessage.count({ where: { deliveryId: delivered.id } })).toBe(1);
    } finally {
      await restarted.stop();
    }
  });

  it('protects the PDF, verifies current validity, and atomically revokes it with attributable audit', async () => {
    const { batch, certificate, delivery } = await generateOne();
    await processCertificateWork(db, delivery.id, settings());
    const verify = '/api/verify/' + certificate.number;
    const download = '/api/certificates/' + certificate.id + '/download';
    const revoke = '/api/certificates/' + certificate.id + '/revoke';
    await request(app).get(download).expect(403);
    await request(app).get(download).set('Authorization', 'Bearer ' + 'A'.repeat(43)).expect(403);
    const visible = await request(app).get(verify).expect(200);
    expect(visible.body).toMatchObject({ status: 'VALID', number: certificate.number, centreName: 'Certificate Centre' });
    expect(visible.headers['cache-control']).toContain('no-store');
    for (const field of ['fullName', 'phoneE164', 'downloadUrl', 'objectKey']) expect(visible.body).not.toHaveProperty(field);

    const inbox = '/api/certificates/batches/' + batch.revisionId + '/mock-messages';
    await staff(request(app).get(inbox), 'owner').expect(403);
    const accepted = await staff(request(app).get(inbox), 'farah').expect(200);
    const link = new URL(accepted.body.messages[0].downloadUrl);
    const token = link.hash.slice(1);
    expect(link.search).toBe('');
    const pdf = await request(app).get(download).set('Authorization', 'Bearer ' + token).expect(200);
    expect(pdf.headers['content-type']).toMatch(/application\/pdf/);
    expect(pdf.body.subarray(0, 5).toString()).toBe('%PDF-');
    await staff(request(app).post(revoke), 'owner').send({ reason: 'Not authorized.' }).expect(403);
    await staff(request(app).post(revoke), 'dev').send({ reason: 'Not authorized.' }).expect(403);
    await staff(request(app).post(revoke), 'farah').send({ reason: '   ' }).expect(400);
    const revoked = await staff(request(app).post(revoke), 'farah').send({ reason: 'Certificate issued in error.' }).expect(200);
    expect(visible.headers.etag).toEqual(expect.any(String));
    const invalid = await request(app).get(verify).set('If-None-Match', visible.headers.etag!).expect(200);
    expect(invalid.body).toEqual({ status: 'REVOKED', number: certificate.number });
    await request(app).get(download).set('Authorization', 'Bearer ' + token).expect(403);
    await staff(request(app).post(revoke), 'farah').send({ reason: 'Replacement attempt.' }).expect(409);
    expect(await db.auditEvent.findMany({ where: { resourceId: certificate.id, action: 'CERTIFICATE_REVOKED' } })).toMatchObject([{
      actorId: users.get('farah')!.id, createdAt: new Date(revoked.body.revokedAt), details: { reason: 'Certificate issued in error.' },
    }]);
    expect((await staff(request(app).get(inbox), 'farah').expect(200)).body.messages[0].downloadUrl).toBeNull();
  });

  it('rejects expired grants and suppresses mock sends queued before revocation', async () => {
    const options = { ...settings(), linkTtlMs: 50 };
    const first = await generateOne(options);
    await processCertificateWork(db, first.delivery.id, options);
    const { mockMessage } = await deliveryProgress(first.certificate.id);
    const token = grantToken(linkSecret, mockMessage!.id, mockMessage!.expiresAt);
    await delay(60);
    await request(app).get('/api/certificates/' + first.certificate.id + '/download')
      .set('Authorization', 'Bearer ' + token).expect(403);

    const another = await generateOne();
    await staff(request(app).post('/api/certificates/' + another.certificate.id + '/revoke'), 'farah')
      .send({ reason: 'Revoke before sending.' }).expect(200);
    await processCertificateWork(db, another.delivery.id, settings());
    await processCertificateWork(db, another.generation.id, settings());
    expect(await deliveryProgress(another.certificate.id)).toMatchObject({ status: 'CANCELLED', attempts: 0, mockMessage: null });
    expect((await request(app).get('/api/verify/' + another.certificate.number).expect(200)).body.status).toBe('REVOKED');
  });
});
