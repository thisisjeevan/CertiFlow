import { centreScope } from '../auth/policy.js';
import type { Principal } from '../auth/session.js';
import type { Prisma, PrismaClient } from '../generated/prisma/client.js';
import { HttpError } from '../http.js';
import { districtThreshold, reviewerStage, reviewRules, revisionVisibility, workflowScope } from './policy.js';

const centreFields = { name: true, district: { select: { name: true } } } as const;
const decisionFields = {
  id: true, stage: true, outcome: true, reason: true, createdAt: true,
  actor: { select: { id: true, displayName: true } },
} as const;
const revisionFields = { id: true, revision: true, status: true, submittedAt: true, statusSince: true } as const;
const districtApprovals = { where: { stage: 'DISTRICT', outcome: 'APPROVE' } } as const;

export async function reviewQueue(db: PrismaClient, viewer: Principal) {
  const stage = reviewerStage(viewer.role);
  const queue = await db.batchRevision.findMany({
    where: {
      status: reviewRules[stage].status,
      batch: { centre: centreScope(viewer) },
      decisions: { none: { actorId: viewer.id, stage } },
    },
    orderBy: [{ statusSince: 'asc' }, { id: 'asc' }],
    take: 100,
    select: {
      ...revisionFields,
      batch: { select: { id: true, courseName: true, centre: { select: centreFields } } },
      _count: { select: { candidates: true, decisions: districtApprovals } },
    },
  });
  return queue.map(({ _count, batch, ...revision }) => ({
    ...batch, revision, candidateCount: _count.candidates, districtApprovals: _count.decisions,
  }));
}

export function reviewBatch(db: PrismaClient, viewer: Principal, id: string) {
  const stage = reviewerStage(viewer.role);
  return db.$transaction(async (tx) => {
    const batch = await tx.batch.findFirst({
      where: { id, ...workflowScope(viewer) },
      select: {
        id: true, courseName: true, centre: { select: centreFields },
        revisions: {
          where: revisionVisibility(viewer), orderBy: { revision: 'desc' }, take: 1,
          select: {
            ...revisionFields,
            decisions: { where: { actorId: viewer.id, stage }, take: 1, select: { id: true } },
            candidates: {
              orderBy: { candidate: { reference: 'asc' } },
              select: { fullName: true, candidate: { select: { reference: true } } },
            },
            _count: { select: { candidates: true, decisions: districtApprovals } },
          },
        },
      },
    });
    const current = batch?.revisions[0];
    if (!batch || !current) throw new HttpError(403, 'REVIEW_FORBIDDEN', 'This batch is unavailable to your account.');

    const { id: batchId, courseName, centre } = batch;
    const { decisions, candidates, _count, ...revision } = current;
    const canDecide = revision.status === reviewRules[stage].status && !decisions.length;
    return {
      id: batchId, courseName, centre, revision, canDecide, stage, districtThreshold,
      candidateCount: _count.candidates, districtApprovals: _count.decisions,
      candidates: candidates.map(({ fullName, candidate }) => ({ fullName, reference: candidate.reference })),
    };
  }, { isolationLevel: 'RepeatableRead' });
}

function auditDetails(value: Prisma.JsonValue) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const { previousStatus, status, decisionId, previousRevisionId, candidateCount } = value;
  return {
    previousStatus: typeof previousStatus === 'string' ? previousStatus : undefined,
    status: typeof status === 'string' ? status : undefined,
    decisionId: typeof decisionId === 'string' ? decisionId : undefined,
    previousRevisionId: typeof previousRevisionId === 'string' ? previousRevisionId : undefined,
    candidateCount: typeof candidateCount === 'number' ? candidateCount : undefined,
  };
}

export function reviewTimeline(db: PrismaClient, viewer: Principal, id: string) {
  return db.$transaction(async (tx) => {
    const batch = await tx.batch.findFirst({
      where: { id, ...workflowScope(viewer) },
      select: {
        revisions: {
          where: revisionVisibility(viewer), orderBy: { revision: 'desc' },
          select: { ...revisionFields, decisions: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: decisionFields } },
        },
      },
    });
    if (!batch) throw new HttpError(403, 'REVIEW_FORBIDDEN', 'This batch is unavailable to your account.');

    const audit = await tx.auditEvent.findMany({
      where: {
        resourceType: 'BatchRevision',
        resourceId: { in: batch.revisions.map((revision) => revision.id) },
        action: { in: ['BATCH_SUBMITTED', 'BATCH_CORRECTION_STARTED', 'BATCH_REVIEW_DECISION', 'BATCH_REVIEW_TRANSITION'] },
      },
      orderBy: { id: 'asc' },
      select: { id: true, resourceId: true, action: true, createdAt: true, actor: decisionFields.actor, details: true },
    });
    return {
      batchId: id,
      revisions: batch.revisions,
      audit: audit.map(({ id, resourceId, details, ...entry }) => ({
        ...entry, id: id.toString(), revisionId: resourceId, details: auditDetails(details),
      })),
    };
  }, { isolationLevel: 'RepeatableRead' });
}
