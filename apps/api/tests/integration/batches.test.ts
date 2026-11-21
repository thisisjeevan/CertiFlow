import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { hashPassword } from '../../src/auth/password.js';
import { readApiConfig } from '../../src/config.js';
import { testDatabase } from './database.js';

const db = testDatabase();
const config = readApiConfig({
  NODE_ENV: 'test',
  APP_ORIGIN: 'http://localhost:8080',
  DATABASE_URL: process.env.TEST_DATABASE_URL,
});
const app = createApp(config, db);
const key = randomBytes(8).toString('hex');
const password = randomBytes(24).toString('base64url');
const courseName = 'Solar Installation Basics';
const header = 'candidate_reference,full_name,phone_e164,completion_reference';

interface Draft {
  id: string;
  revision: { id: string; version: string; status: string; candidateCount: number; submittedAt: string | null };
  candidates: { id: string; reference: string; fullName: string }[];
}

let districtId: string;
let centreId: string;
let otherCentreId: string;
let actorId: string;
let centreCookie: string;
let otherCookie: string;
let districtCookie: string;
let evidenceSequence = 0;

async function signIn(email: string) {
  const response = await request(app).post('/api/auth/login').send({ email, password }).expect(200);
  const cookies = response.headers['set-cookie'];
  if (!Array.isArray(cookies) || !cookies[0]) throw new Error('Session cookie was not returned.');
  return cookies[0].split(';', 1)[0]!;
}

beforeAll(async () => {
  const passwordHash = await hashPassword(password);
  const fixture = await db.$transaction(async (tx) => {
    const district = await tx.district.create({ data: { code: 'batch-' + key, name: 'Batch Test District' } });
    const centre = await tx.trainingCentre.create({
      data: { code: 'primary-' + key, name: 'Primary Centre', districtId: district.id },
    });
    const other = await tx.trainingCentre.create({
      data: { code: 'different-' + key, name: 'Other Centre', districtId: district.id },
    });
    const users = await tx.user.createManyAndReturn({ data: [
      {
        email: 'batch-owner-' + key + '@example.test', displayName: 'Batch Owner',
        role: 'TRAINING_CENTRE', centreId: centre.id, passwordHash,
      },
      {
        email: 'other-owner-' + key + '@example.test', displayName: 'Other Owner',
        role: 'TRAINING_CENTRE', centreId: other.id, passwordHash,
      },
      {
        email: 'batch-officer-' + key + '@example.test', displayName: 'Batch Officer',
        role: 'DISTRICT_OFFICER', districtId: district.id, passwordHash,
      },
    ] });
    return { districtId: district.id, centreId: centre.id, otherCentreId: other.id, users };
  });
  ({ districtId, centreId, otherCentreId } = fixture);
  actorId = fixture.users.find((user) => user.centreId === centreId)!.id;
  [centreCookie, otherCookie, districtCookie] = await Promise.all([
    signIn('batch-owner-' + key + '@example.test'),
    signIn('other-owner-' + key + '@example.test'),
    signIn('batch-officer-' + key + '@example.test'),
  ]);
}, 15_000);

afterAll(async () => {
  try {
    if (!districtId) return;
    const centreIds = [centreId, otherCentreId];
    await db.$transaction(async (tx) => {
      const batches = await tx.batch.findMany({ where: { centreId: { in: centreIds } }, select: { id: true } });
      const batchIds = batches.map(({ id }) => id);
      const revisions = await tx.batchRevision.findMany({ where: { batchId: { in: batchIds } }, select: { id: true } });
      await tx.outboxEvent.deleteMany({ where: { aggregateId: { in: batchIds } } });
      await tx.notification.deleteMany({ where: { resourceId: { in: batchIds } } });
      await tx.auditEvent.deleteMany({ where: { resourceType: 'BatchRevision', resourceId: { in: revisions.map(({ id }) => id) } } });
      await tx.revisionCandidate.deleteMany({ where: { batchId: { in: batchIds } } });
      await tx.candidate.deleteMany({ where: { batchId: { in: batchIds } } });
      await tx.batchRevision.deleteMany({ where: { batchId: { in: batchIds } } });
      await tx.batch.deleteMany({ where: { id: { in: batchIds } } });
      await tx.trainingCompletion.deleteMany({ where: { centreId: { in: centreIds } } });
      await tx.user.deleteMany({ where: { OR: [{ centreId: { in: centreIds } }, { districtId }] } });
      await tx.trainingCentre.deleteMany({ where: { id: { in: centreIds } } });
      await tx.district.delete({ where: { id: districtId } });
    });
  } finally {
    await db.$disconnect();
  }
});

async function createDraft(assignedCentre = centreId, cookie = centreCookie) {
  const response = await request(app).post('/api/batches').set('Cookie', cookie)
    .send({ centreId: assignedCentre, courseName }).expect(201);
  return response.body.batch as Draft;
}

async function registerCompletion(options: {
  centre?: string; course?: string; passed?: boolean; completedOn?: Date;
} = {}) {
  const suffix = ++evidenceSequence;
  return db.trainingCompletion.create({ data: {
    centreId: options.centre ?? centreId,
    reference: 'COMP-' + suffix,
    candidateReference: 'CAND-' + suffix,
    courseName: options.course ?? courseName,
    passed: options.passed ?? true,
    completedOn: options.completedOn ?? new Date('2025-04-01T00:00:00Z'),
  } });
}

function row(completion: { reference: string; candidateReference: string }, name = 'Asha Rao', phone = '+12025550100') {
  return [completion.candidateReference, name, phone, completion.reference].join(',');
}

function csv(...rows: string[]) {
  return [header, ...rows].join('\r\n') + '\r\n';
}

function upload(draft: Draft, file: string | Buffer, cookie = centreCookie) {
  return request(app).put('/api/batches/' + draft.id + '/candidates')
    .set('Cookie', cookie).set('X-Draft-Version', draft.revision.version).type('text/csv').send(file);
}

function submit(draft: Draft) {
  return request(app).post('/api/batches/' + draft.id + '/submit').set('Cookie', centreCookie)
    .set('X-Draft-Version', draft.revision.version).send({});
}

function detail(draft: Draft) {
  return request(app).get('/api/batches/' + draft.id).set('Cookie', centreCookie);
}

describe('batch intake against PostgreSQL', () => {
  it('creates a draft, imports passed candidates, and lists the persisted roster', async () => {
    const draft = await createDraft();
    expect(draft.revision).toMatchObject({ status: 'DRAFT', candidateCount: 0 });
    const evidence = await registerCompletion();
    const response = await upload(draft, csv(row(evidence, '"Asha Rao, Jr."'))).expect(200);
    expect(response.body.batch.revision).toMatchObject({ status: 'DRAFT', candidateCount: 1 });
    expect(response.body.batch.revision.version).not.toBe(draft.revision.version);
    expect(response.body.batch.candidates).toMatchObject([{
      reference: evidence.candidateReference, fullName: 'Asha Rao, Jr.',
      completionReference: evidence.reference, phoneE164: '+12025550100',
    }]);

    const stored = await db.revisionCandidate.findFirstOrThrow({ where: { revisionId: draft.revision.id }, include: { candidate: true } });
    expect(stored.candidate.trainingCompletionId).toBe(evidence.id);
    expect((await detail(draft).expect(200)).body).toEqual(response.body);
    const list = await request(app).get('/api/batches').set('Cookie', centreCookie).expect(200);
    expect(list.body.batches).toContainEqual(expect.objectContaining({ id: draft.id }));
  });

  it('reports the physical row and field and persists zero changes when any row is invalid', async () => {
    const draft = await createDraft();
    const valid = await registerCompletion();
    const invalid = await registerCompletion();
    const result = await upload(draft, csv(row(valid), '', row(invalid, 'Sameer Iyer', '555'))).expect(422);
    expect(result.body.error.issues).toEqual([{
      row: 4, field: 'phone_e164', message: 'Enter an international number, such as +12025550100.',
    }]);
    expect(await db.candidate.count({ where: { batchId: draft.id } })).toBe(0);
    expect(await db.revisionCandidate.count({ where: { revisionId: draft.revision.id } })).toBe(0);
    expect((await detail(draft).expect(200)).body.batch.revision.version).toBe(draft.revision.version);
  });

  it('rejects repeated candidate and completion references within one file', async () => {
    const draft = await createDraft();
    const evidence = await registerCompletion();
    const result = await upload(draft, csv(row(evidence), row(evidence))).expect(422);
    expect(result.body.error.issues).toEqual([
      { row: 3, field: 'candidate_reference', message: 'This reference duplicates row 2.' },
      { row: 3, field: 'completion_reference', message: 'This reference duplicates row 2.' },
    ]);
    expect(await db.candidate.count({ where: { batchId: draft.id } })).toBe(0);
  });

  it('checks centre, candidate, course, passed status and completion date against the register', async () => {
    const draft = await createDraft();
    const foreign = await registerCompletion({ centre: otherCentreId });
    const wrongCandidate = await registerCompletion();
    const wrongCourse = await registerCompletion({ course: 'Another Course' });
    const failed = await registerCompletion({ passed: false });
    const future = await registerCompletion({ completedOn: new Date('2100-01-01T00:00:00Z') });
    const reply = await upload(draft, csv(
      row(foreign, 'Asha Rao', '555'), row({ ...wrongCandidate, candidateReference: 'DIFFERENT' }),
      row(wrongCourse), row(failed), row(future),
    )).expect(422);
    expect(reply.body.error.issues).toEqual([
      { row: 2, field: 'phone_e164', message: 'Enter an international number, such as +12025550100.' },
      { row: 2, field: 'completion_reference', message: 'Use a training completion registered for this centre.' },
      { row: 3, field: 'completion_reference', message: 'This completion belongs to a different candidate reference.' },
      { row: 4, field: 'completion_reference', message: 'This completion is for a different course.' },
      { row: 5, field: 'completion_reference', message: 'The training result must be marked as passed.' },
      { row: 6, field: 'completion_reference', message: 'The recorded completion date is in the future.' },
    ]);
    expect(await db.candidate.count({ where: { batchId: draft.id } })).toBe(0);
  });

  it('keeps the original candidate snapshots, claims, and version after a failed replacement', async () => {
    const draft = await createDraft();
    const original = await registerCompletion();
    const other = await registerCompletion();
    const first = await upload(draft, csv(row(original))).expect(200);
    const imported = first.body.batch as Draft;
    await upload(imported, csv(row(original, 'Edited Name'), row(other, ''))).expect(422);
    expect((await detail(draft).expect(200)).body).toEqual(first.body);
    expect(await db.candidate.count({ where: { batchId: draft.id } })).toBe(1);
    expect(await db.candidate.findUnique({ where: { trainingCompletionId: original.id } }))
      .toMatchObject({ id: imported.candidates[0]?.id, batchId: draft.id });
  });

  it('replaces a valid draft, retains candidate identity, and releases a removed draft-only claim', async () => {
    const draft = await createDraft();
    const retained = await registerCompletion();
    const removed = await registerCompletion();
    const initial = await upload(draft, csv(row(retained), row(removed))).expect(200);
    const imported = initial.body.batch as Draft;
    const existingId = imported.candidates.find((candidate) => candidate.reference === retained.candidateReference)?.id;
    const replaced = await upload(imported, csv(row(retained, 'Updated Name'))).expect(200);
    expect(replaced.body.batch.candidates).toMatchObject([{ id: existingId, fullName: 'Updated Name' }]);
    expect(await db.candidate.findUnique({ where: { trainingCompletionId: removed.id } })).toBeNull();
    const newDraft = await createDraft();
    await upload(newDraft, csv(row(removed))).expect(200);
  });

  it('restricts creation and access to the assigned centre and denies non-centre roles', async () => {
    const draft = await createDraft();
    const otherDraft = await createDraft(otherCentreId, otherCookie);
    await request(app).post('/api/batches').set('Cookie', centreCookie).send({ centreId: otherCentreId, courseName }).expect(403);
    await request(app).get('/api/batches').expect(401);
    await request(app).get('/api/batches').set('Cookie', districtCookie).expect(403);
    await request(app).get('/api/batches/' + draft.id).set('Cookie', otherCookie).expect(403);
    await upload(draft, csv('C-1,Asha Rao,+12025550100,T-1'), otherCookie).expect(403);
    const list = await request(app).get('/api/batches').set('Cookie', otherCookie).expect(200);
    expect(list.body.batches.map(({ id }: { id: string }) => id)).toEqual([otherDraft.id]);
  });

  it('rejects malformed, empty, unsupported, oversized, and cross-origin uploads', async () => {
    const draft = await createDraft();
    const invalid = await upload(draft, csv('C-1,"Asha Rao,+12025550100,T-1')).expect(400);
    expect(invalid.body.error.issues[0]).toMatchObject({ row: 2, field: 'row' });
    await upload(draft, csv()).expect(422);
    await upload(draft, 'candidate_reference,full_name').expect(422);
    await upload(draft, 'a'.repeat(512 * 1024 + 1)).expect(413);
    await upload(draft, csv('C-1,Asha Rao,+12025550100,T-1')).set('Origin', 'https://other.example.test').expect(403);
    await request(app).put('/api/batches/' + draft.id + '/candidates')
      .set('Cookie', centreCookie).set('X-Draft-Version', draft.revision.version)
      .type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(Buffer.from('PK')).expect(415);
    expect(await db.revisionCandidate.count({ where: { revisionId: draft.revision.id } })).toBe(0);
  });

  it('rejects empty and ineligible rosters after a course edit, preserving the imported candidates', async () => {
    const draft = await createDraft();
    await submit(draft).expect(422, { error: { code: 'EMPTY_BATCH', message: 'Import at least one candidate before submitting.' } });
    const evidence = await registerCompletion();
    const imported = (await upload(draft, csv(row(evidence))).expect(200)).body.batch as Draft;
    const edit = await request(app).patch('/api/batches/' + draft.id).set('Cookie', centreCookie)
      .set('X-Draft-Version', imported.revision.version).send({ courseName: 'Electrical Safety' }).expect(200);
    expect(edit.body.batch).toMatchObject({ courseName: 'Electrical Safety', candidates: imported.candidates });
    const edited = edit.body.batch as Draft;
    expect(edited.revision.version).not.toBe(imported.revision.version);
    expect((await submit(edited).expect(422)).body.error.code).toBe('INVALID_ROSTER');
    expect(await db.outboxEvent.count({ where: { aggregateId: draft.id } })).toBe(0);
    expect((await detail(draft).expect(200)).body.batch.revision.status).toBe('DRAFT');
  });

  it('accepts only one of two concurrent imports based on the same draft version', async () => {
    const draft = await createDraft();
    const first = await registerCompletion();
    const second = await registerCompletion();
    const results = await Promise.all([upload(draft, csv(row(first))), upload(draft, csv(row(second)))]);
    expect(results.map(({ status }) => status).sort()).toEqual([200, 409]);
    expect(results.find(({ status }) => status === 409)?.body.error.code).toBe('STALE_DRAFT');
    const winner = results.find(({ status }) => status === 200)?.body.batch;
    expect((await detail(draft).expect(200)).body.batch).toEqual(winner);
    expect(await db.candidate.count({ where: { batchId: draft.id } })).toBe(1);
  });

  it('serializes a concurrent import and submission without replacing the submitted roster', async () => {
    const draft = await createDraft();
    const original = await registerCompletion();
    const replacement = await registerCompletion();
    const current = (await upload(draft, csv(row(original))).expect(200)).body.batch as Draft;
    const [importReply, submitReply] = await Promise.all([upload(current, csv(row(replacement))), submit(current)]);
    expect([importReply.status, submitReply.status].sort()).toEqual([200, 409]);

    const stored = (await detail(draft).expect(200)).body.batch;
    const submitted = submitReply.status === 200;
    expect(stored.revision).toMatchObject({ status: submitted ? 'DISTRICT_REVIEW' : 'DRAFT', candidateCount: 1 });
    expect(stored.candidates).toMatchObject([{ reference: submitted ? original.candidateReference : replacement.candidateReference }]);
    expect(await db.outboxEvent.count({ where: { aggregateId: draft.id } })).toBe(submitted ? 1 : 0);
  });

  it('prevents the same completion from being claimed by two contemporaneous drafts', async () => {
    const first = await createDraft();
    const second = await createDraft();
    const evidence = await registerCompletion();
    const results = await Promise.all([upload(first, csv(row(evidence))), upload(second, csv(row(evidence)))]);
    expect(results.map(({ status }) => status).sort()).toEqual([200, 422]);
    expect(results.find(({ status }) => status === 422)?.body.error.issues).toEqual([
      { row: 2, field: 'completion_reference', message: 'This completion is already assigned to another batch.' },
    ]);
    expect(await db.candidate.count({ where: { trainingCompletionId: evidence.id } })).toBe(1);
  });

  it('retries submission idempotently with one attributed audit record and one outbox event', async () => {
    const draft = await createDraft();
    const evidence = await registerCompletion();
    const imported = (await upload(draft, csv(row(evidence))).expect(200)).body.batch as Draft;
    const [first, retry] = await Promise.all([submit(imported).expect(200), submit(imported).expect(200)]);
    expect(first.body).toEqual(retry.body);
    const revision = first.body.batch.revision;
    expect(revision).toMatchObject({ status: 'DISTRICT_REVIEW', candidateCount: 1 });
    expect(new Date(revision.submittedAt).toISOString()).toBe(revision.submittedAt);
    await upload(imported, csv(row(evidence))).expect(409);

    const audit = await db.auditEvent.findMany({ where: { resourceId: revision.id, action: 'BATCH_SUBMITTED' } });
    const outbox = await db.outboxEvent.findMany({ where: { aggregateId: draft.id } });
    expect(audit).toMatchObject([{
      actorId,
      createdAt: new Date(revision.submittedAt),
      details: { previousStatus: 'DRAFT', status: 'DISTRICT_REVIEW', submittedAt: revision.submittedAt },
    }]);
    expect(outbox).toMatchObject([{
      type: 'batch.submitted',
      dedupeKey: 'batch.submitted:' + revision.id,
      createdAt: new Date(revision.submittedAt),
      payload: { actorId, candidateCount: 1, revisionId: revision.id, submittedAt: revision.submittedAt },
    }]);
    expect(outbox[0]?.payload).not.toHaveProperty('candidates');
  });

  it('rolls back the transition and audit if the outbox write fails', async () => {
    const draft = await createDraft();
    const evidence = await registerCompletion();
    const imported = (await upload(draft, csv(row(evidence))).expect(200)).body.batch as Draft;
    await db.outboxEvent.create({ data: {
      dedupeKey: 'batch.submitted:' + draft.revision.id,
      type: 'test.existing',
      aggregateId: draft.id,
      payload: {},
    } });
    await submit(imported).expect(500);
    expect(await db.batchRevision.findUnique({ where: { id: draft.revision.id } }))
      .toMatchObject({ status: 'DRAFT', submittedAt: null });
    expect(await db.auditEvent.count({ where: { resourceId: draft.revision.id, action: 'BATCH_SUBMITTED' } })).toBe(0);
  });
});
