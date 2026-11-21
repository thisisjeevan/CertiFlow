import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import { HttpError } from '../http.js';
import { notifyWorkflow } from '../workflow/events.js';
import { withWorkflowWrite } from '../workflow/write.js';
import { isCandidateName, isCandidatePhone, isReference, readCandidateCsv } from './csv.js';

export interface CentreOwner {
  id: string;
  centreId: string;
}

const batchFields = {
  id: true,
  centreId: true,
  courseName: true,
  createdAt: true,
  revisions: {
    orderBy: { revision: 'desc' },
    take: 1,
    select: {
      id: true, revision: true, status: true, editVersion: true, submittedAt: true, statusSince: true,
      _count: { select: { candidates: true } },
    },
  },
} satisfies Prisma.BatchSelect;

const completionFields = {
  id: true, centreId: true, reference: true, candidateReference: true, courseName: true,
  completedOn: true, passed: true,
} satisfies Prisma.TrainingCompletionSelect;

type BatchRecord = Prisma.BatchGetPayload<{ select: typeof batchFields }>;
type Revision = BatchRecord['revisions'][number];
type Completion = Prisma.TrainingCompletionGetPayload<{ select: typeof completionFields }>;

function versionFor(revision: Revision) {
  return revision.id + ':' + revision.editVersion;
}

function batchSummary({ revisions, ...batch }: BatchRecord) {
  const current = revisions[0];
  if (!current) return { ...batch, revision: null };

  const { _count, ...revision } = current;
  return { ...batch, revision: { ...revision, candidateCount: _count.candidates, version: versionFor(current) } };
}

async function ownedBatch(db: Prisma.TransactionClient, owner: CentreOwner, id: string) {
  const batch = await db.batch.findFirst({
    where: { id, centreId: owner.centreId },
    select: batchFields,
  });
  if (!batch) throw new HttpError(403, 'BATCH_FORBIDDEN', 'This batch is unavailable to your centre.');
  return batch;
}

async function readBatch(db: Prisma.TransactionClient, owner: CentreOwner, id: string) {
  const batch = await ownedBatch(db, owner, id);
  const revision = batch.revisions[0];
  const rows = revision ? await db.revisionCandidate.findMany({
    where: { revisionId: revision.id },
    orderBy: { candidate: { reference: 'asc' } },
    select: {
      fullName: true,
      phoneE164: true,
      candidate: { select: { id: true, reference: true, trainingCompletion: { select: { reference: true } } } },
    },
  }) : [];
  const candidates = rows.map(({ candidate, fullName, phoneE164 }) => ({
    id: candidate.id,
    reference: candidate.reference,
    fullName,
    phoneE164,
    completionReference: candidate.trainingCompletion?.reference ?? null,
  }));
  return { ...batchSummary(batch), candidates };
}

function currentRevision(batch: BatchRecord, expectedVersion: string) {
  const revision = batch.revisions[0];
  if (!revision) throw new HttpError(409, 'NO_BATCH_REVISION', 'This batch has no editable revision.');
  if (versionFor(revision) !== expectedVersion) {
    throw new HttpError(409, 'STALE_DRAFT', 'This batch changed. Reload it before trying again.');
  }
  return revision;
}

function requireDraft(revision: Revision) {
  if (revision.status !== 'DRAFT') {
    throw new HttpError(409, 'BATCH_NOT_DRAFT', 'Only a draft batch can be changed or submitted.');
  }
}

function withCentreWrite<T>(
  db: PrismaClient, owner: CentreOwner, write: (tx: Prisma.TransactionClient) => Promise<T>,
) {
  return withWorkflowWrite(db, owner.id, owner.centreId, (tx, actor) => {
    if (actor.role !== 'TRAINING_CENTRE' || actor.centreId !== owner.centreId) {
      throw new HttpError(403, 'FORBIDDEN', 'This centre is unavailable to your account.');
    }
    return write(tx);
  });
}

export async function listBatches(db: PrismaClient, owner: CentreOwner) {
  const batches = await db.$transaction((tx) => tx.batch.findMany({
    where: { centreId: owner.centreId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: batchFields,
  }), { isolationLevel: 'RepeatableRead' });
  return batches.map(batchSummary);
}

export function getBatch(db: PrismaClient, owner: CentreOwner, id: string) {
  return db.$transaction((tx) => readBatch(tx, owner, id), { isolationLevel: 'RepeatableRead' });
}

export function createBatch(
  db: PrismaClient, owner: CentreOwner, input: { centreId: string; courseName: string },
) {
  if (owner.centreId !== input.centreId) {
    throw new HttpError(403, 'CENTRE_FORBIDDEN', 'You can only create batches for your assigned centre.');
  }

  return withCentreWrite(db, owner, async (tx) => {
    const batch = await tx.batch.create({
      data: {
        centreId: input.centreId,
        courseName: input.courseName,
        revisions: { create: { createdById: owner.id, revision: 1 } },
      },
      select: batchFields,
    });
    return { ...batchSummary(batch), candidates: [] };
  });
}

export function editBatch(db: PrismaClient, owner: CentreOwner, id: string, version: string, courseName: string) {
  return withCentreWrite(db, owner, async (tx) => {
    const batch = await ownedBatch(tx, owner, id);
    const revision = currentRevision(batch, version);
    requireDraft(revision);

    if (batch.courseName !== courseName) {
      if (revision.revision !== 1) {
        throw new HttpError(409, 'COURSE_LOCKED', 'The course is fixed after the first revision.');
      }
      await tx.batch.update({ where: { id }, data: { courseName } });
      await tx.batchRevision.update({ where: { id: revision.id }, data: { editVersion: { increment: 1 } } });
    }
    return readBatch(tx, owner, id);
  });
}

function completionIssue(completion: Completion | null | undefined, batch: BatchRecord, reference: string, now: Date) {
  if (!completion || completion.centreId !== batch.centreId) return 'Use a training completion registered for this centre.';
  if (completion.candidateReference !== reference) return 'This completion belongs to a different candidate reference.';
  if (completion.courseName !== batch.courseName) return 'This completion is for a different course.';
  if (!completion.passed) return 'The training result must be marked as passed.';
  if (completion.completedOn > now) return 'The recorded completion date is in the future.';
}

export function importCandidates(db: PrismaClient, owner: CentreOwner, id: string, version: string, file: Buffer) {
  return withCentreWrite(db, owner, async (tx) => {
    const batch = await ownedBatch(tx, owner, id);
    const revision = currentRevision(batch, version);
    requireDraft(revision);
    const { rows, issues } = readCandidateCsv(file);
    const referenceRows = rows.filter(({ reference, completionReference }) =>
      isReference(reference) && isReference(completionReference),
    );

    const existing = await tx.candidate.findMany({
      where: { batchId: id },
      select: {
        id: true, reference: true, trainingCompletionId: true,
        revisions: { where: { revisionId: { not: revision.id } }, take: 1, select: { revisionId: true } },
      },
    });
    const completions = await tx.trainingCompletion.findMany({
      where: { centreId: owner.centreId, reference: { in: [...new Set(referenceRows.map(({ completionReference }) => completionReference))] } },
      select: { ...completionFields, candidate: { select: { id: true, batchId: true } } },
    });
    const completionByReference = new Map(completions.map((completion) => [completion.reference, completion]));
    const existingByReference = new Map(existing.map((candidate) => [candidate.reference, candidate]));
    const now = new Date();
    const roster = referenceRows.flatMap((row) => {
      const completion = completionByReference.get(row.completionReference);
      const prior = existingByReference.get(row.reference);
      const problem = completionIssue(completion, batch, row.reference, now);
      if (!completion || problem) {
        issues.push({ row: row.row, field: 'completion_reference', message: problem ?? 'Choose a registered completion.' });
      } else if (completion.candidate && completion.candidate.batchId !== id) {
        issues.push({ row: row.row, field: 'completion_reference', message: 'This completion is already assigned to another batch.' });
      } else if (completion.candidate && completion.candidate.id !== prior?.id) {
        issues.push({ row: row.row, field: 'completion_reference', message: 'This completion is already assigned to a different candidate.' });
      } else if (prior?.revisions.length && prior.trainingCompletionId && prior.trainingCompletionId !== completion.id) {
        issues.push({ row: row.row, field: 'completion_reference', message: 'Use the completion recorded for this candidate in the earlier revision.' });
      } else {
        return [{ row, prior, candidateId: prior?.id ?? randomUUID(), completionId: completion.id }];
      }
      return [];
    });
    if (issues.length) {
      issues.sort((a, b) => a.row - b.row);
      throw new HttpError(422, 'INVALID_IMPORT', 'Correct the flagged fields and upload the CSV again.', issues);
    }

    const retained = new Set(roster.map(({ candidateId }) => candidateId));
    const changes = existing.flatMap((candidate) =>
      candidate.trainingCompletionId && !candidate.revisions.length && !retained.has(candidate.id)
        ? [{ id: candidate.id, completionId: null as string | null }]
        : [],
    );
    const newCandidates = roster.flatMap(({ row, prior, candidateId, completionId }) => {
      if (!prior) return [{ id: candidateId, batchId: id, reference: row.reference, trainingCompletionId: completionId }];
      if (prior.trainingCompletionId !== completionId) changes.push({ id: prior.id, completionId });
      return [];
    });

    await tx.revisionCandidate.deleteMany({ where: { revisionId: revision.id } });
    if (changes.length) {
      const assignments = changes.map(({ id, completionId }) => Prisma.sql`(${id}::uuid, ${completionId}::uuid)`);
      await tx.$executeRaw`
        UPDATE "Candidate" c SET "trainingCompletionId" = assignment.completion_id
        FROM (VALUES ${Prisma.join(assignments)}) AS assignment(candidate_id, completion_id)
        WHERE c.id = assignment.candidate_id AND c."batchId" = ${id}::uuid
      `;
    }
    if (newCandidates.length) await tx.candidate.createMany({ data: newCandidates });
    await tx.revisionCandidate.createMany({
      data: roster.map(({ row, candidateId }) => ({
        batchId: id, revisionId: revision.id, candidateId, fullName: row.fullName, phoneE164: row.phoneE164,
      })),
    });
    await tx.batchRevision.update({ where: { id: revision.id }, data: { editVersion: { increment: 1 } } });
    return readBatch(tx, owner, id);
  });
}

export function submitBatch(db: PrismaClient, owner: CentreOwner, id: string, version: string) {
  return withCentreWrite(db, owner, (tx) => submitDraft(tx, owner, id, version));
}

// Call inside a transaction that holds the centre lock.
export async function submitDraft(tx: Prisma.TransactionClient, owner: CentreOwner, id: string, version: string) {
  const batch = await ownedBatch(tx, owner, id);
  const revision = currentRevision(batch, version);
  if (revision.status === 'DISTRICT_REVIEW') return readBatch(tx, owner, id);
  requireDraft(revision);

  const rows = await tx.revisionCandidate.findMany({
    where: { revisionId: revision.id },
    select: {
      fullName: true,
      phoneE164: true,
      candidate: { select: { reference: true, trainingCompletion: { select: completionFields } } },
    },
  });
  if (!rows.length) throw new HttpError(422, 'EMPTY_BATCH', 'Import at least one candidate before submitting.');
  const now = new Date();
  const invalid = rows.some(({ fullName, phoneE164, candidate }) =>
    !isCandidateName(fullName) || !isCandidatePhone(phoneE164)
    || completionIssue(candidate.trainingCompletion, batch, candidate.reference, now),
  );
  if (invalid) {
    throw new HttpError(422, 'INVALID_ROSTER', 'Some candidates lack a valid completion for this course. Import a corrected CSV before submitting.');
  }

  const transition = await tx.batchRevision.updateMany({
    where: { id: revision.id, status: 'DRAFT', editVersion: revision.editVersion },
    data: { status: 'DISTRICT_REVIEW', submittedAt: now, statusSince: now },
  });
  if (transition.count !== 1) throw new HttpError(409, 'STALE_DRAFT', 'This batch changed. Reload it before trying again.');

  const event = {
    batchId: id,
    revisionId: revision.id,
    centreId: owner.centreId,
    actorId: owner.id,
    candidateCount: rows.length,
    submittedAt: now.toISOString(),
  };
  await tx.auditEvent.create({
    data: {
      resourceType: 'BatchRevision',
      resourceId: revision.id,
      action: 'BATCH_SUBMITTED',
      actorId: owner.id,
      details: { ...event, previousStatus: 'DRAFT', status: 'DISTRICT_REVIEW' },
      createdAt: now,
    },
  });
  await tx.outboxEvent.create({
    data: {
      type: 'batch.submitted',
      aggregateId: id,
      dedupeKey: 'batch.submitted:' + revision.id,
      payload: event,
      createdAt: now,
    },
  });
  await notifyWorkflow(tx, batch, 'DISTRICT_REVIEW', 'batch.submitted:' + revision.id, now);
  return readBatch(tx, owner, id);
}

export function startCorrection(db: PrismaClient, owner: CentreOwner, id: string, returnedRevisionId: string) {
  return withCentreWrite(db, owner, async (tx) => {
    const batch = await ownedBatch(tx, owner, id);
    const previous = batch.revisions[0];
    if (!previous || previous.id !== returnedRevisionId) {
      throw new HttpError(409, 'STALE_REVISION', 'This revision has been superseded. Reload the batch.');
    }
    if (previous.status !== 'RETURNED') {
      throw new HttpError(409, 'CORRECTION_UNAVAILABLE', 'Only a returned revision can be corrected.');
    }

    const now = new Date();
    const revision = await tx.batchRevision.create({
      data: { batchId: id, revision: previous.revision + 1, createdById: owner.id, createdAt: now, statusSince: now },
    });
    const snapshots = await tx.revisionCandidate.findMany({
      where: { revisionId: previous.id },
      select: { candidateId: true, fullName: true, phoneE164: true },
    });
    if (snapshots.length) {
      await tx.revisionCandidate.createMany({
        data: snapshots.map((candidate) => ({ ...candidate, batchId: id, revisionId: revision.id })),
      });
    }

    const payload = {
      batchId: id, revisionId: revision.id, previousRevisionId: previous.id, revision: revision.revision,
      centreId: owner.centreId, actorId: owner.id, previousStatus: 'RETURNED', status: 'DRAFT',
      candidateCount: snapshots.length, occurredAt: now.toISOString(),
    };
    await tx.auditEvent.create({
      data: {
        resourceType: 'BatchRevision', resourceId: revision.id, action: 'BATCH_CORRECTION_STARTED',
        actorId: owner.id, details: payload, createdAt: now,
      },
    });
    await tx.outboxEvent.create({
      data: {
        type: 'batch.correction_started', aggregateId: id, dedupeKey: 'batch.correction_started:' + previous.id,
        payload, createdAt: now,
      },
    });
    return readBatch(tx, owner, id);
  });
}
