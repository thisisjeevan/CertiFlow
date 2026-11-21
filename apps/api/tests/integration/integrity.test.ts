import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { Prisma } from '../../src/generated/prisma/client.js';
import { testDatabase } from './database.js';

const db = testDatabase();

afterAll(() => db.$disconnect());

async function createBatch(tx: Prisma.TransactionClient) {
  const district = await tx.district.create({ data: { code: randomUUID(), name: 'Fixture District' } });
  const centre = await tx.trainingCentre.create({
    data: { code: randomUUID(), name: 'Fixture Centre', districtId: district.id },
  });
  const author = await tx.user.create({
    data: {
      email: randomUUID() + '@example.test',
      displayName: 'Fixture Author',
      passwordHash: 'fixture-disabled',
      active: false,
      role: 'TRAINING_CENTRE',
      centreId: centre.id,
    },
  });
  const batch = await tx.batch.create({ data: { centreId: centre.id, courseName: 'Fixture Course' } });
  return { batchId: batch.id, authorId: author.id, districtId: district.id };
}

describe('foundation constraints in PostgreSQL', () => {
  it('rejects a district officer without a jurisdiction', async () => {
    await expect(db.$transaction((tx) => tx.user.create({
      data: {
        email: randomUUID() + '@example.test',
        displayName: 'Fixture Officer',
        passwordHash: 'fixture-disabled',
        active: false,
        role: 'DISTRICT_OFFICER',
      },
    }))).rejects.toThrow(/User_role_scope_check/);
  });

  it('rejects a second live revision for a batch', async () => {
    await expect(db.$transaction(async (tx) => {
      const { batchId, authorId } = await createBatch(tx);
      await tx.batchRevision.create({ data: { batchId, createdById: authorId, revision: 1 } });
      await tx.batchRevision.create({ data: { batchId, createdById: authorId, revision: 2 } });
    })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('prevents coupling a revision to a candidate from another batch', async () => {
    await expect(db.$transaction(async (tx) => {
      const first = await createBatch(tx);
      const second = await createBatch(tx);
      const revision = await tx.batchRevision.create({
        data: { batchId: first.batchId, createdById: first.authorId, revision: 1 },
      });
      const candidate = await tx.candidate.create({
        data: { batchId: second.batchId, reference: 'candidate-1' },
      });
      await tx.revisionCandidate.create({
        data: {
          revisionId: revision.id,
          candidateId: candidate.id,
          batchId: first.batchId,
          fullName: 'Test Candidate',
          phoneE164: '+919000000001',
        },
      });
    })).rejects.toMatchObject({ code: 'P2003' });
  });

  it('rejects two decisions by the same district officer at the same stage and revision', async () => {
    await expect(db.$transaction(async (tx) => {
      const { batchId, authorId, districtId } = await createBatch(tx);
      const officer = await tx.user.create({
        data: {
          email: randomUUID() + '@example.test', displayName: 'Fixture Officer',
          passwordHash: 'fixture-disabled', active: false, role: 'DISTRICT_OFFICER', districtId,
        },
      });
      const revision = await tx.batchRevision.create({
        data: { batchId, createdById: authorId, revision: 1, status: 'DISTRICT_REVIEW', submittedAt: new Date() },
      });
      const decision = { revisionId: revision.id, actorId: officer.id, stage: 'DISTRICT', outcome: 'APPROVE' } as const;
      await tx.decision.create({ data: decision });
      await tx.decision.create({ data: decision });
    })).rejects.toMatchObject({ code: 'P2002' });
  });

  it('rejects a second certificate for the same stable candidate across revisions', async () => {
    await expect(db.$transaction(async (tx) => {
      const { batchId, authorId } = await createBatch(tx);
      const original = await tx.batchRevision.create({
        data: { batchId, createdById: authorId, revision: 1, status: 'RETURNED', submittedAt: new Date() },
      });
      const latest = await tx.batchRevision.create({
        data: { batchId, createdById: authorId, revision: 2, status: 'APPROVED', submittedAt: new Date() },
      });
      const candidate = await tx.candidate.create({ data: { batchId, reference: 'candidate-1' } });
      const snapshot = { batchId, candidateId: candidate.id, fullName: 'Test Candidate', phoneE164: '+919000000001' };
      await tx.revisionCandidate.createMany({ data: [
        { ...snapshot, revisionId: original.id },
        { ...snapshot, revisionId: latest.id },
      ] });
      await tx.certificate.create({ data: { number: randomUUID(), revisionId: latest.id, candidateId: candidate.id } });
      await tx.certificate.create({ data: { number: randomUUID(), revisionId: original.id, candidateId: candidate.id } });
    })).rejects.toMatchObject({ code: 'P2002' });
  });
});
