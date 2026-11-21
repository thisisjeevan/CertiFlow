import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import request, { type Test } from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { hashPassword } from '../../src/auth/password.js';
import { readApiConfig } from '../../src/config.js';
import type { DecisionOutcome, ReviewStage, Role } from '../../src/generated/prisma/client.js';
import { createLiveUpdates } from '../../src/live.js';
import { escalateOverdueReviews } from '../../src/workflow/escalation.js';
import { testDatabase } from './database.js';

const db = testDatabase();
const config = readApiConfig({
  NODE_ENV: 'test', APP_ORIGIN: 'http://localhost:8080', DATABASE_URL: process.env.TEST_DATABASE_URL,
});
const app = createApp(config, db);
const live = createLiveUpdates(db);
let liveServer: Server;
let liveUrl: string;
const key = randomBytes(6).toString('hex');
const password = randomBytes(24).toString('base64url');
const accounts = ['owner', 'otherOwner', 'dev', 'meera', 'kabir', 'outsider', 'quality', 'state'] as const;
type Account = (typeof accounts)[number];
type Batch = { id: string; revision: { id: string; revision: number; status: string; version: string } };
const cookies = new Map<Account, string>();
const actorIds = new Map<Account, string>();
const centreIds: string[] = [];
const districtIds: string[] = [];
const emailFor = (account: Account) => account.toLowerCase() + '-' + key + '@example.test';
let sequence = 0;

beforeAll(async () => {
  const passwordHash = await hashPassword(password);
  await db.$transaction(async (tx) => {
    const north = await tx.district.create({ data: { code: 'review-n-' + key, name: 'Review District' } });
    const south = await tx.district.create({ data: { code: 'review-s-' + key, name: 'Other District' } });
    districtIds.push(north.id, south.id);
    const primary = await tx.trainingCentre.create({ data: { code: 'review-n-' + key, name: 'Review Centre', districtId: north.id } });
    const other = await tx.trainingCentre.create({ data: { code: 'review-s-' + key, name: 'Other Centre', districtId: south.id } });
    centreIds.push(primary.id, other.id);

    const records = {
      owner: { role: 'TRAINING_CENTRE', centreId: primary.id },
      otherOwner: { role: 'TRAINING_CENTRE', centreId: other.id },
      dev: { role: 'DISTRICT_OFFICER', districtId: north.id },
      meera: { role: 'DISTRICT_OFFICER', districtId: north.id },
      kabir: { role: 'DISTRICT_OFFICER', districtId: north.id },
      outsider: { role: 'DISTRICT_OFFICER', districtId: south.id },
      quality: { role: 'QUALITY_REVIEWER' },
      state: { role: 'STATE_OFFICER' },
    } satisfies Record<Account, { role: Role; centreId?: string; districtId?: string }>;
    const users = await tx.user.createManyAndReturn({ data: accounts.map((account) => ({
      ...records[account], email: emailFor(account), displayName: account, passwordHash,
    })) });
    for (const account of accounts) actorIds.set(account, users.find(({ email }) => email === emailFor(account))!.id);
  });

  await Promise.all(accounts.map(async (account) => {
    const res = await request(app).post('/api/auth/login').send({ email: emailFor(account), password }).expect(200);
    const values = res.headers['set-cookie'];
    if (!Array.isArray(values) || !values[0]) throw new Error('Missing session cookie.');
    cookies.set(account, values[0].split(';', 1)[0]!);
  }));

  liveServer = createApp(config, db, live).listen(0, '127.0.0.1');
  await once(liveServer, 'listening');
  const address = liveServer.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server address.');
  liveUrl = 'http://127.0.0.1:' + address.port;
}, 20_000);

afterAll(async () => {
  live.close();
  const closed = liveServer ? new Promise<void>((resolve) => liveServer.close(() => resolve())) : undefined;
  liveServer?.closeAllConnections();
  await closed;
  try {
    await db.$transaction(async (tx) => {
      const batches = await tx.batch.findMany({ where: { centreId: { in: centreIds } }, select: { id: true } });
      const batchIds = batches.map(({ id }) => id);
      const revisions = await tx.batchRevision.findMany({ where: { batchId: { in: batchIds } }, select: { id: true } });
      const revisionIds = revisions.map(({ id }) => id);
      await tx.notification.deleteMany({ where: { resourceId: { in: batchIds } } });
      await tx.reviewEscalation.deleteMany({ where: { revisionId: { in: revisionIds } } });
      await tx.outboxEvent.deleteMany({ where: { aggregateId: { in: batchIds } } });
      await tx.auditEvent.deleteMany({ where: { resourceType: 'BatchRevision', resourceId: { in: revisionIds } } });
      await tx.decision.deleteMany({ where: { revisionId: { in: revisionIds } } });
      await tx.revisionCandidate.deleteMany({ where: { batchId: { in: batchIds } } });
      await tx.candidate.deleteMany({ where: { batchId: { in: batchIds } } });
      await tx.batchRevision.deleteMany({ where: { batchId: { in: batchIds } } });
      await tx.batch.deleteMany({ where: { id: { in: batchIds } } });
      await tx.trainingCompletion.deleteMany({ where: { centreId: { in: centreIds } } });
      await tx.user.deleteMany({ where: { email: { in: accounts.map(emailFor) } } });
      await tx.trainingCentre.deleteMany({ where: { id: { in: centreIds } } });
      await tx.district.deleteMany({ where: { id: { in: districtIds } } });
    });
  } finally {
    await db.$disconnect();
  }
});

function as(client: Test, account: Account) {
  return client.set('Cookie', cookies.get(account)!);
}

function decide(
  account: Account, batch: Batch, stage: ReviewStage = 'DISTRICT', outcome: DecisionOutcome = 'APPROVE', reason?: string,
) {
  return as(request(app).post('/api/reviews/' + batch.id + '/revisions/' + batch.revision.id + '/decisions'), account)
    .send({ stage, outcome, reason });
}

function timeline(batch: Batch, account: Account = 'owner') {
  return as(request(app).get('/api/reviews/' + batch.id + '/timeline'), account);
}

function submit(batch: Batch, account: Account = 'owner') {
  return as(request(app).post('/api/batches/' + batch.id + '/submit'), account)
    .set('X-Draft-Version', batch.revision.version).send({});
}

function replaceRoster(batch: Batch, csv: string, account: Account = 'owner') {
  return as(request(app).put('/api/batches/' + batch.id + '/candidates'), account)
    .set('X-Draft-Version', batch.revision.version).type('text/csv').send(csv);
}

async function submittedBatch(count = 3, account: 'owner' | 'otherOwner' = 'owner') {
  const centreId = centreIds[account === 'owner' ? 0 : 1]!;
  const courseName = 'Approval Test ' + ++sequence;
  const roster = Array.from({ length: count }, (_, index) => ({
    reference: 'REVIEW-' + sequence + '-' + (index + 1), candidateReference: 'P-' + (index + 1),
  }));
  await db.trainingCompletion.createMany({ data: roster.map((record) => ({
    ...record, centreId, courseName, completedOn: new Date('2025-04-01T00:00:00Z'), passed: true,
  })) });
  const header = 'candidate_reference,full_name,phone_e164,completion_reference';
  const csv = [header, ...roster.map((row) => [row.candidateReference, 'Original Name', '+12025550100', row.reference].join(','))].join('\n');

  const draft = (await as(request(app).post('/api/batches'), account).send({ centreId, courseName }).expect(201)).body.batch as Batch;
  const imported = (await replaceRoster(draft, csv, account).expect(200)).body.batch as Batch;
  const submitted = (await submit(imported, account).expect(200)).body.batch as Batch;
  return { ...submitted, csv };
}

function openEvents(account: Account) {
  const controller = new AbortController();
  const frames: string[] = [];
  const received = fetch(liveUrl + '/api/events', {
    headers: { cookie: cookies.get(account)! }, signal: controller.signal,
  }).then(async (response) => {
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('cache-control')).toContain('no-store');
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffered = '';
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        buffered += next.value;
        const complete = buffered.split('\n\n');
        buffered = complete.pop()!;
        frames.push(...complete.filter((frame) => frame.startsWith('event:')));
      }
    } finally {
      reader.releaseLock();
    }
  }).catch((error: unknown) => {
    if (!controller.signal.aborted) throw error;
  });

  const sync = (scope: string) => vi.waitFor(() => {
    expect(frames.some((frame) => frame.startsWith('event: sync\n') && frame.includes('"' + scope + '"'))).toBe(true);
  }, { timeout: 4_000 });
  return { frames, sync, close: async () => { controller.abort(); await received; } };
}

describe('scoped SSE using the shared PostgreSQL state', () => {
  it('requires a valid session and rejects cross-origin stream requests', async () => {
    await request(app).get('/api/events').expect(401);
    await request(app).get('/api/events').set('Cookie', 'certiflow_session=' + 'A'.repeat(43)).expect(401);
    await as(request(app).get('/api/events'), 'owner').set('Origin', 'https://other.example.test').expect(403);
    const stream = openEvents('outsider');
    try {
      await stream.sync('workflow');
      expect(stream.frames).toEqual(['event: sync\ndata: ["workflow","notifications"]']);
      await db.user.update({ where: { id: actorIds.get('outsider')! }, data: { districtId: districtIds[0] } });
      await vi.waitFor(() => expect(stream.frames).toContain('event: session-ended\ndata: {}'), { timeout: 4_000 });
    } finally {
      await db.user.update({ where: { id: actorIds.get('outsider')! }, data: { districtId: districtIds[1] } });
      await stream.close();
    }
  });

  it('updates the reviewer queue and owner across API instances while isolating other centres and districts', async () => {
    const owner = openEvents('owner');
    const dev = openEvents('dev');
    const otherOwner = openEvents('otherOwner');
    const outsider = openEvents('outsider');
    const state = openEvents('state');
    const observers = [owner, dev, otherOwner, outsider, state];
    try {
      await Promise.all(observers.map((observer) => observer.sync('workflow')));
      for (const { frames } of observers) frames.length = 0;

      const batch = await submittedBatch();
      await dev.sync('workflow');
      await dev.sync('notifications');
      expect((await as(request(app).get('/api/reviews'), 'dev').expect(200)).body.queue)
        .toContainEqual(expect.objectContaining({ id: batch.id, districtApprovals: 0 }));
      expect(state.frames).toEqual([]);

      dev.frames.length = 0;
      await decide('meera', batch).expect(201);
      await dev.sync('workflow');
      expect((await as(request(app).get('/api/reviews'), 'dev').expect(200)).body.queue)
        .toContainEqual(expect.objectContaining({ id: batch.id, districtApprovals: 1 }));

      owner.frames.length = 0;
      await decide('dev', batch).expect(201);
      await owner.sync('workflow');
      await state.sync('workflow');
      expect((await as(request(app).get('/api/batches/' + batch.id), 'owner').expect(200)).body.batch.revision.status).toBe('STATE_REVIEW');
      expect(otherOwner.frames).toEqual([]);
      expect(outsider.frames).toEqual([]);
      expect(JSON.stringify([...owner.frames, ...dev.frames, ...state.frames])).not.toContain(batch.id);
    } finally {
      await Promise.all(observers.map((observer) => observer.close()));
    }
  });

  it('resynchronizes committed changes and persisted notifications when a client reconnects', async () => {
    const original = openEvents('dev');
    try { await original.sync('workflow'); } finally { await original.close(); }
    const batch = await submittedBatch();
    const resumed = openEvents('dev');
    try {
      await resumed.sync('workflow');
      await resumed.sync('notifications');
      expect((await as(request(app).get('/api/reviews'), 'dev').expect(200)).body.queue)
        .toContainEqual(expect.objectContaining({ id: batch.id }));
      expect((await as(request(app).get('/api/notifications'), 'dev').expect(200)).body.notifications)
        .toContainEqual(expect.objectContaining({ resourceId: batch.id, type: 'BATCH_DISTRICT_REVIEW' }));
    } finally {
      await resumed.close();
    }
  });
});

const hours = (value: number) => value * 60 * 60 * 1_000;
const alertType = 'REVIEW_ESCALATED';
const alertRows = (revisionId: string) => db.reviewEscalation.findMany({ where: { revisionId }, orderBy: { createdAt: 'asc' } });
const changeStageAge = (revisionId: string, start: Date) =>
  db.batchRevision.update({ where: { id: revisionId }, data: { statusSince: start } });

describe('automatic escalation in PostgreSQL', () => {
  it('waits until a review exceeds 24 hours, records the evidence, and alerts state officers only', async () => {
    const batch = await submittedBatch();
    const now = new Date();
    const start = new Date(now.getTime() - hours(24));
    await changeStageAge(batch.revision.id, start);
    await escalateOverdueReviews(db, now);
    expect(await alertRows(batch.revision.id)).toEqual([]);

    const state = openEvents('state');
    try {
      await state.sync('notifications');
      state.frames.length = 0;
      const escalatedAt = new Date(now.getTime() + 1);
      await escalateOverdueReviews(db, escalatedAt);
      await state.sync('notifications');
      expect(await alertRows(batch.revision.id)).toMatchObject([
        { stage: 'DISTRICT', stageStartedAt: start, thresholdHours: 24, createdAt: escalatedAt },
      ]);
      expect(await db.auditEvent.findMany({ where: { resourceId: batch.revision.id, action: alertType } })).toMatchObject([
        { actorId: null, createdAt: escalatedAt, details: { stage: 'DISTRICT', batchId: batch.id,
          revisionId: batch.revision.id, thresholdHours: 24, escalatedAt: escalatedAt.toISOString() } },
      ]);
      expect(await db.notification.findMany({ where: { resourceId: batch.id, type: alertType } }))
        .toMatchObject([{ userId: actorIds.get('state') }]);
      const inbox = (await as(request(app).get('/api/notifications'), 'state').expect(200)).body.notifications;
      expect(inbox).toContainEqual(expect.objectContaining({
        type: alertType, resourceId: batch.id,
        escalation: { stage: 'DISTRICT', thresholdHours: 24, stageStartedAt: start.toISOString(),
          revision: { revision: 1, batch: { courseName: expect.any(String) } } },
      }));
    } finally {
      await state.close();
    }
  });

  it('uses row locks and deduplicates concurrent scans and restarts', async () => {
    const batch = await submittedBatch();
    const now = new Date();
    await changeStageAge(batch.revision.id, new Date(now.getTime() - hours(25)));
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "BatchRevision" WHERE id = ${batch.revision.id}::uuid FOR UPDATE`;
      await escalateOverdueReviews(db, now);
      expect(await alertRows(batch.revision.id)).toHaveLength(0);
    });
    await Promise.all([escalateOverdueReviews(db, now), escalateOverdueReviews(db, now), escalateOverdueReviews(db, now)]);
    await escalateOverdueReviews(db, new Date(now.getTime() + hours(1)));
    expect(await alertRows(batch.revision.id)).toHaveLength(1);
    expect(await db.notification.count({ where: { resourceId: batch.id, type: alertType } })).toBe(1);
    expect(await db.auditEvent.count({ where: { resourceId: batch.revision.id, action: alertType } })).toBe(1);
  });

  it('resets review age through district, quality and state and preserves earlier escalations', async () => {
    const batch = await submittedBatch(50);
    const now = new Date();
    const old = new Date(now.getTime() - hours(25));
    await changeStageAge(batch.revision.id, old);
    await escalateOverdueReviews(db, now);

    await decide('dev', batch).expect(201);
    await decide('meera', batch).expect(201);
    await escalateOverdueReviews(db, new Date());
    expect(await alertRows(batch.revision.id)).toMatchObject([{ stage: 'DISTRICT' }]);
    await changeStageAge(batch.revision.id, old);
    await escalateOverdueReviews(db, new Date());

    await decide('quality', batch, 'QUALITY').expect(201);
    await escalateOverdueReviews(db, new Date());
    expect(await alertRows(batch.revision.id)).toHaveLength(2);
    await changeStageAge(batch.revision.id, old);
    await escalateOverdueReviews(db, new Date());
    expect((await alertRows(batch.revision.id)).map(({ stage }) => stage).sort()).toEqual(['DISTRICT', 'QUALITY', 'STATE']);
    const quality = openEvents('quality');
    try {
      await quality.sync('workflow');
      quality.frames.length = 0;
      await decide('state', batch, 'STATE').expect(201);
      await quality.sync('workflow');
      expect((await as(request(app).get('/api/reviews/' + batch.id), 'quality').expect(200)).body.batch.revision.status).toBe('APPROVED');
    } finally {
      await quality.close();
    }
    await escalateOverdueReviews(db, new Date(Date.now() + hours(25)));
    expect(await alertRows(batch.revision.id)).toHaveLength(3);
  });

  it('gives a corrected resubmission its own clock and its own deduplication key', async () => {
    const batch = await submittedBatch();
    const old = new Date(Date.now() - hours(25));
    await changeStageAge(batch.revision.id, old);
    await escalateOverdueReviews(db);
    await decide('dev', batch, 'DISTRICT', 'RETURN', 'Correct the evidence.').expect(201);
    const correction = (await as(request(app).post('/api/batches/' + batch.id + '/correction'), 'owner')
      .send({ revisionId: batch.revision.id }).expect(201)).body.batch as Batch;
    await submit(correction).expect(200);
    await escalateOverdueReviews(db);
    expect(await alertRows(correction.revision.id)).toHaveLength(0);
    await changeStageAge(correction.revision.id, old);
    await escalateOverdueReviews(db);
    expect(await alertRows(correction.revision.id)).toMatchObject([{ stage: 'DISTRICT' }]);
    expect(await alertRows(batch.revision.id)).toMatchObject([{ stage: 'DISTRICT' }]);
    expect(await db.notification.count({ where: { resourceId: batch.id, type: alertType } })).toBe(2);
  });
});

function transitions(batch: Batch) {
  return db.outboxEvent.findMany({
    where: { aggregateId: batch.id, dedupeKey: { startsWith: 'batch.transition:' + batch.revision.id + ':' } },
    orderBy: { createdAt: 'asc' },
  });
}

async function overlap(requests: Test[]) {
  const running = await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "TrainingCentre" WHERE id = ${centreIds[0]}::uuid FOR NO KEY UPDATE`;
    const results = requests.map((pending) => pending.then((reply) => reply));
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      await tx.$queryRaw`SELECT pg_stat_clear_snapshot()::text`;
      const [waiting] = await tx.$queryRaw<{ count: bigint }[]>`
        WITH RECURSIVE blocked(pid) AS (
          SELECT pg_backend_pid()
          UNION
          SELECT a.pid FROM pg_stat_activity a JOIN blocked b ON b.pid = ANY(pg_blocking_pids(a.pid))
        )
        SELECT count(*) FROM blocked WHERE pid <> pg_backend_pid()
      `;
      if (waiting?.count === BigInt(requests.length)) return results;
      await delay(20);
    }
    throw new Error('Expected each HTTP request to wait on the PostgreSQL row lock.');
  });
  return Promise.all(running);
}


describe('revision-aware approval workflow in PostgreSQL', () => {
  it('records the first district vote without moving the batch', async () => {
    const batch = await submittedBatch();
    const reply = await decide('dev', batch).expect(201);
    expect(reply.body).toMatchObject({ status: 'DISTRICT_REVIEW', districtApprovals: 1, decision: { actorId: actorIds.get('dev') } });
    expect(await transitions(batch)).toEqual([]);
    const review = await as(request(app).get('/api/reviews/' + batch.id), 'dev').expect(200);
    expect(review.body.batch).toMatchObject({ canDecide: false, districtApprovals: 1, districtThreshold: 2 });
  });

  it('advances once after two distinct district votes and bypasses quality at 49 candidates', async () => {
    const batch = await submittedBatch(49);
    await decide('dev', batch).expect(201);
    expect((await decide('meera', batch).expect(201)).body).toMatchObject({ status: 'STATE_REVIEW', districtApprovals: 2 });
    expect((await decide('kabir', batch).expect(409)).body.error.code).toBe('WRONG_STAGE');
    expect(await transitions(batch)).toMatchObject([{ type: 'batch.review_advanced', payload: { candidateCount: 49, status: 'STATE_REVIEW' } }]);
    await as(request(app).get('/api/reviews/' + batch.id), 'quality').expect(403);
  });

  it('preserves both simultaneous valid votes and emits exactly one district transition', async () => {
    const batch = await submittedBatch(60);
    const results = await overlap([decide('dev', batch), decide('meera', batch)]);
    expect(results.map(({ status }) => status)).toEqual([201, 201]);
    expect(results.map(({ body }) => body.status).sort()).toEqual(['DISTRICT_REVIEW', 'QUALITY_REVIEW']);
    const decisions = await db.decision.findMany({ where: { revisionId: batch.revision.id } });
    expect(decisions.map(({ actorId }) => actorId).sort()).toEqual([actorIds.get('dev'), actorIds.get('meera')].sort());
    expect(await transitions(batch)).toMatchObject([{ payload: { previousStatus: 'DISTRICT_REVIEW', status: 'QUALITY_REVIEW', districtApprovals: 2 } }]);
    const history = (await timeline(batch).expect(200)).body;
    expect(history.audit.filter(({ action }: { action: string }) => action === 'BATCH_REVIEW_DECISION')).toHaveLength(2);
    expect(history.audit.filter(({ action }: { action: string }) => action === 'BATCH_REVIEW_TRANSITION')).toHaveLength(1);
  });

  it('rejects a concurrent duplicate by one officer while one vote is recorded', async () => {
    const batch = await submittedBatch();
    const replies = await overlap([decide('dev', batch), decide('dev', batch)]);
    expect(replies.map(({ status }) => status).sort()).toEqual([201, 409]);
    expect(replies.find(({ status }) => status === 409)?.body.error.code).toBe('DECISION_EXISTS');
    expect(await db.decision.count({ where: { revisionId: batch.revision.id } })).toBe(1);
    expect(await transitions(batch)).toEqual([]);
  });

  it('scopes queues, detail and timelines and prevents role, district and actor substitution', async () => {
    const batch = await submittedBatch();
    const anotherDistrict = await submittedBatch(3, 'otherOwner');
    const queue = await as(request(app).get('/api/reviews'), 'dev').expect(200);
    expect(queue.body.queue).toContainEqual(expect.objectContaining({ id: batch.id }));
    expect(queue.body.queue).not.toContainEqual(expect.objectContaining({ id: anotherDistrict.id }));
    await request(app).get('/api/reviews').expect(401);
    await as(request(app).get('/api/reviews'), 'owner').expect(403);
    await as(request(app).get('/api/reviews/' + batch.id), 'outsider').expect(403);
    await timeline(batch, 'outsider').expect(403);
    await timeline(batch, 'otherOwner').expect(403);
    await decide('outsider', batch).expect(403);
    await decide('owner', batch).expect(403);
    await decide('quality', batch).expect(403);
    await as(request(app).post('/api/reviews/' + batch.id + '/revisions/' + batch.revision.id + '/decisions'), 'dev')
      .send({ stage: 'DISTRICT', outcome: 'APPROVE', actorId: actorIds.get('meera') }).expect(400);
    expect(await db.decision.count({ where: { revisionId: batch.revision.id } })).toBe(0);
  });

  it('requires quality review at 50 candidates and prevents bypass by any role', async () => {
    const batch = await submittedBatch(50);
    expect((await decide('quality', batch, 'QUALITY').expect(409)).body.error.code).toBe('WRONG_STAGE');
    await decide('dev', batch).expect(201);
    expect((await decide('meera', batch).expect(201)).body.status).toBe('QUALITY_REVIEW');
    await timeline(batch, 'state').expect(403);
    await decide('state', batch, 'STATE').expect(409);
    await decide('dev', batch, 'QUALITY').expect(403);
    const queue = await as(request(app).get('/api/reviews'), 'quality').expect(200);
    expect(queue.body.queue).toContainEqual(expect.objectContaining({ id: batch.id, candidateCount: 50 }));
    const detail = await as(request(app).get('/api/reviews/' + batch.id), 'quality').expect(200);
    expect(detail.body.batch.candidates).toHaveLength(50);
    expect(detail.body.batch.candidates[0]).not.toHaveProperty('phoneE164');
    expect((await decide('quality', batch, 'QUALITY').expect(201)).body.status).toBe('STATE_REVIEW');
  });

  it('restricts final approval to state and persists a durable issuance handoff', async () => {
    const batch = await submittedBatch(60);
    await decide('dev', batch).expect(201);
    await decide('meera', batch).expect(201);
    await decide('quality', batch, 'QUALITY').expect(201);
    await decide('quality', batch, 'STATE').expect(403);
    await decide('dev', batch, 'STATE').expect(403);
    const reply = await decide('state', batch, 'STATE').expect(201);
    expect(reply.body).toMatchObject({ status: 'APPROVED', decision: { actorId: actorIds.get('state') } });
    expect((await decide('state', batch, 'STATE').expect(409)).body.error.code).toBe('REVIEW_CLOSED');

    const events = await db.outboxEvent.findMany({ where: { aggregateId: batch.id, type: 'batch.approved' } });
    expect(events).toMatchObject([{
      completedAt: null,
      payload: { batchId: batch.id, revisionId: batch.revision.id, status: 'APPROVED', candidateCount: 60, actorId: actorIds.get('state') },
    }]);
    expect(events[0]?.payload).not.toHaveProperty('candidates');
    const history = (await timeline(batch, 'state').expect(200)).body;
    expect(history.audit).toContainEqual(expect.objectContaining({
      action: 'BATCH_REVIEW_TRANSITION', revisionId: batch.revision.id,
      actor: { id: actorIds.get('state'), displayName: 'state' }, createdAt: reply.body.decision.createdAt,
      details: expect.objectContaining({ previousStatus: 'STATE_REVIEW', status: 'APPROVED', decisionId: reply.body.decision.id }),
    }));
  });

  it('opens one correction, rejects stale votes, and counts only the resubmitted revision', async () => {
    const batch = await submittedBatch();
    await decide('dev', batch).expect(201);
    expect((await decide('meera', batch, 'DISTRICT', 'RETURN', '   ').expect(400)).body.error.code).toBe('REASON_REQUIRED');
    await decide('meera', batch, 'DISTRICT', 'RETURN', 'Correct the names.').expect(201);
    expect((await decide('kabir', batch).expect(409)).body.error.code).toBe('REVIEW_CLOSED');

    const open = (account: Account = 'owner') => as(request(app).post('/api/batches/' + batch.id + '/correction'), account)
      .send({ revisionId: batch.revision.id });
    await open('otherOwner').expect(403);
    const [first, second, oldSubmit] = await overlap([open(), open(), submit(batch)]);
    expect([first!.status, second!.status].sort()).toEqual([201, 409]);
    expect(oldSubmit?.status).toBe(409);
    const draft = [first, second].find((reply) => reply?.status === 201)?.body.batch as Batch;
    expect(draft).toMatchObject({ id: batch.id, revision: { revision: 2, status: 'DRAFT' } });
    expect(draft.revision.id).not.toBe(batch.revision.id);
    expect((await decide('kabir', batch).expect(409)).body.error.code).toBe('STALE_REVISION');
    const districtView = (await timeline(batch, 'dev').expect(200)).body;
    expect(districtView.revisions.map(({ revision }: { revision: number }) => revision)).toEqual([1]);

    const corrected = (await replaceRoster(draft, batch.csv.replaceAll('Original Name', 'Corrected Name')).expect(200)).body.batch as Batch;
    const current = (await submit(corrected).expect(200)).body.batch as Batch;
    expect((await decide('dev', current).expect(201)).body).toMatchObject({ status: 'DISTRICT_REVIEW', districtApprovals: 1 });
    const history = (await timeline(batch).expect(200)).body;
    expect(history.revisions).toMatchObject([
      { revision: 2, status: 'DISTRICT_REVIEW', decisions: [{ outcome: 'APPROVE' }] },
      { revision: 1, status: 'RETURNED', decisions: expect.arrayContaining([expect.objectContaining({
        stage: 'DISTRICT', outcome: 'RETURN', reason: 'Correct the names.',
        createdAt: expect.any(String), actor: { id: actorIds.get('meera'), displayName: 'meera' },
      })]) },
    ]);
    expect(history.audit.filter(({ revisionId }: { revisionId: string }) => revisionId === batch.revision.id)).toHaveLength(4);
    expect(history.audit).toContainEqual(expect.objectContaining({ action: 'BATCH_CORRECTION_STARTED', revisionId: draft.revision.id }));
    expect(await db.revisionCandidate.findMany({ where: { revisionId: batch.revision.id }, select: { fullName: true } }))
      .toEqual(Array.from({ length: 3 }, () => ({ fullName: 'Original Name' })));
    expect((await decide('meera', current).expect(201)).body.status).toBe('STATE_REVIEW');
  });

  it('serializes a return competing with the centre opening a correction', async () => {
    const batch = await submittedBatch();
    const correction = as(request(app).post('/api/batches/' + batch.id + '/correction'), 'owner')
      .send({ revisionId: batch.revision.id });
    const [returned, opened] = await overlap([decide('dev', batch, 'DISTRICT', 'RETURN', 'Review the roster.'), correction]);
    expect(returned?.status).toBe(201);
    expect([201, 409]).toContain(opened?.status);
    const revisions = await db.batchRevision.findMany({ where: { batchId: batch.id }, orderBy: { revision: 'asc' } });
    expect(revisions.map(({ status }) => status)).toEqual(opened?.status === 201 ? ['RETURNED', 'DRAFT'] : ['RETURNED']);
    expect(await transitions(batch)).toMatchObject([{ type: 'batch.returned' }]);
    expect(await db.outboxEvent.count({ where: { aggregateId: batch.id, type: 'batch.correction_started' } }))
      .toBe(opened?.status === 201 ? 1 : 0);
  });

  it('closes a rejected submission and preserves the decision with its reason', async () => {
    const batch = await submittedBatch();
    await decide('dev', batch).expect(201);
    await decide('meera', batch, 'DISTRICT', 'REJECT').expect(400);
    await decide('meera', batch, 'DISTRICT', 'REJECT', 'Training evidence disputed.').expect(201);
    await decide('kabir', batch).expect(409);
    await as(request(app).post('/api/batches/' + batch.id + '/correction'), 'owner').send({ revisionId: batch.revision.id }).expect(409);
    const history = (await timeline(batch).expect(200)).body;
    expect(history.revisions[0].status).toBe('REJECTED');
    expect(history.revisions[0].decisions).toHaveLength(2);
    expect(history.revisions[0].decisions).toContainEqual(expect.objectContaining({ outcome: 'REJECT', reason: 'Training evidence disputed.' }));
    expect(await transitions(batch)).toMatchObject([{ type: 'batch.rejected' }]);
  });

  it.each(['RETURN', 'REJECT'] as const)('serializes an approval competing with %s', async (adverse) => {
    const batch = await submittedBatch();
    await decide('dev', batch).expect(201);
    const replies = await overlap([decide('meera', batch), decide('kabir', batch, 'DISTRICT', adverse, 'Check training evidence.')]);
    expect(replies.map(({ status }) => status).sort()).toEqual([201, 409]);
    const winner = replies.find(({ status }) => status === 201);
    const status = winner?.body.decision.outcome === 'APPROVE' ? 'STATE_REVIEW' : adverse === 'RETURN' ? 'RETURNED' : 'REJECTED';
    expect(await db.batchRevision.findUnique({ where: { id: batch.revision.id } })).toMatchObject({ status });
    expect(await db.decision.count({ where: { revisionId: batch.revision.id } })).toBe(2);
    expect(await transitions(batch)).toMatchObject([{ payload: { status } }]);
  });

  it('persists scoped notifications and enforces an account-owned read marker', async () => {
    const batch = await submittedBatch(50);
    const assigned = await db.notification.findMany({ where: { resourceId: batch.id, type: 'BATCH_DISTRICT_REVIEW' } });
    expect(assigned.map(({ userId }) => userId).sort()).toEqual([actorIds.get('dev'), actorIds.get('meera'), actorIds.get('kabir')].sort());
    await decide('dev', batch).expect(201);
    await decide('meera', batch).expect(201);
    const inbox = await as(request(app).get('/api/notifications'), 'quality').expect(200);
    const entry = inbox.body.notifications.find(({ resourceId }: { resourceId: string }) => resourceId === batch.id);
    expect(entry).toMatchObject({ type: 'BATCH_QUALITY_REVIEW', readAt: null });
    const mark = '/api/notifications/' + entry.id + '/read';
    await as(request(app).patch(mark), 'outsider').send({}).expect(404);
    await as(request(app).patch(mark), 'quality').send({}).expect(204);
    const read = await db.notification.findUniqueOrThrow({ where: { id: BigInt(entry.id) } });
    await as(request(app).patch(mark), 'quality').send({}).expect(204);
    expect(read.readAt).toBeInstanceOf(Date);
    expect((await db.notification.findUnique({ where: { id: BigInt(entry.id) } }))?.readAt).toEqual(read.readAt);
    await decide('quality', batch, 'QUALITY', 'RETURN', 'Verify the participant list.').expect(201);
    expect(await db.notification.findMany({ where: { resourceId: batch.id, type: 'BATCH_RETURNED' } }))
      .toMatchObject([{ userId: actorIds.get('owner') }]);
  });

  it('rolls back a vote, its audit, status and notifications when the transition outbox fails', async () => {
    const batch = await submittedBatch();
    await decide('dev', batch).expect(201);
    await db.outboxEvent.create({
      data: {
        aggregateId: batch.id, dedupeKey: 'batch.transition:' + batch.revision.id + ':DISTRICT_REVIEW',
        type: 'test.preexisting', payload: {},
      },
    });
    await decide('meera', batch).expect(500);
    expect(await db.batchRevision.findUnique({ where: { id: batch.revision.id } })).toMatchObject({ status: 'DISTRICT_REVIEW' });
    expect(await db.decision.count({ where: { revisionId: batch.revision.id } })).toBe(1);
    expect(await db.auditEvent.count({ where: { resourceId: batch.revision.id, action: 'BATCH_REVIEW_TRANSITION' } })).toBe(0);
    expect(await db.auditEvent.count({ where: { resourceId: batch.revision.id, action: 'BATCH_REVIEW_DECISION' } })).toBe(1);
    expect(await db.outboxEvent.count({ where: { aggregateId: batch.id, type: 'batch.review_decision_recorded' } })).toBe(1);
    expect(await db.notification.count({ where: { resourceId: batch.id, type: 'BATCH_STATE_REVIEW' } })).toBe(0);
  });
});
