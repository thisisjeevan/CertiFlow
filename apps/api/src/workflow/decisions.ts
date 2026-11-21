import { centreScope } from '../auth/policy.js';
import type { Principal } from '../auth/session.js';
import type { DecisionOutcome, PrismaClient, ReviewStage, RevisionStatus } from '../generated/prisma/client.js';
import { HttpError } from '../http.js';
import { notifyWorkflow } from './events.js';
import { districtThreshold, qualityThreshold, requireStageRole, reviewRules } from './policy.js';
import { withWorkflowWrite } from './write.js';

type DecisionInput = { stage: ReviewStage; outcome: DecisionOutcome; reason?: string };

type ReviewDestination = Exclude<RevisionStatus, 'DRAFT' | 'DISTRICT_REVIEW'>;

function nextStatus(input: DecisionInput, districtApprovals: number, candidateCount: number): ReviewDestination | undefined {
  if (input.outcome === 'RETURN') return 'RETURNED';
  if (input.outcome === 'REJECT') return 'REJECTED';

  switch (input.stage) {
    case 'DISTRICT':
      if (districtApprovals < districtThreshold) return undefined;
      return candidateCount >= qualityThreshold ? 'QUALITY_REVIEW' : 'STATE_REVIEW';
    case 'QUALITY': return 'STATE_REVIEW';
    case 'STATE': return 'APPROVED';
  }
}

const transitionTypes = {
  QUALITY_REVIEW: 'batch.review_advanced',
  STATE_REVIEW: 'batch.review_advanced',
  RETURNED: 'batch.returned',
  REJECTED: 'batch.rejected',
  APPROVED: 'batch.approved',
} satisfies Record<ReviewDestination, string>;

export async function recordDecision(db: PrismaClient, viewer: Principal, batchId: string, revisionId: string, input: DecisionInput) {
  requireStageRole(viewer.role, input.stage);
  const batch = await db.batch.findFirst({
    where: { id: batchId, centre: centreScope(viewer) },
    select: { id: true, centreId: true },
  });
  if (!batch) throw new HttpError(403, 'REVIEW_FORBIDDEN', 'This batch is unavailable to your account.');

  return withWorkflowWrite(db, viewer.id, batch.centreId, async (tx, actor, centre) => {
    requireStageRole(actor.role, input.stage);
    if (input.stage === 'DISTRICT' && actor.districtId !== centre.districtId) {
      throw new HttpError(403, 'REVIEW_FORBIDDEN', 'This batch is outside your district.');
    }
    const revision = await tx.batchRevision.findFirst({
      where: { batchId, batch: { centreId: centre.id } },
      orderBy: { revision: 'desc' },
      select: {
        id: true, revision: true, status: true,
        _count: { select: { candidates: true } },
        decisions: { select: { actorId: true, stage: true, outcome: true } },
      },
    });
    if (!revision || revision.id !== revisionId) {
      throw new HttpError(409, 'STALE_REVISION', 'This revision has been superseded. Reload the batch.');
    }

    const previousStatus = reviewRules[input.stage].status;
    if (revision.status !== previousStatus) {
      const closed = ['APPROVED', 'RETURNED', 'REJECTED'].includes(revision.status);
      throw new HttpError(409, closed ? 'REVIEW_CLOSED' : 'WRONG_STAGE',
        closed ? 'This revision is closed for review.' : 'This revision is unavailable at the requested stage.');
    }
    if (revision.decisions.some((decision) => decision.stage === input.stage && decision.actorId === actor.id)) {
      throw new HttpError(409, 'DECISION_EXISTS', 'You already recorded a decision for this revision and stage.');
    }

    const candidateCount = revision._count.candidates;
    const approvedDistrict = revision.decisions.filter(({ stage, outcome }) => stage === 'DISTRICT' && outcome === 'APPROVE');
    const qualityApproved = revision.decisions.some(({ stage, outcome }) => stage === 'QUALITY' && outcome === 'APPROVE');
    if (candidateCount === 0
      || (input.stage !== 'DISTRICT' && approvedDistrict.length < districtThreshold)
      || (input.stage === 'QUALITY' && candidateCount < qualityThreshold)
      || (input.stage === 'STATE' && candidateCount >= qualityThreshold && !qualityApproved)) {
      throw new HttpError(409, 'PREREQUISITES_UNMET', 'This revision has incomplete prerequisites for review.');
    }

    const now = new Date();
    const decision = await tx.decision.create({
      data: { revisionId, actorId: actor.id, stage: input.stage, outcome: input.outcome, reason: input.reason, createdAt: now },
    });
    const districtApprovals = approvedDistrict.length + Number(input.stage === 'DISTRICT' && input.outcome === 'APPROVE');
    const status = nextStatus(input, districtApprovals, candidateCount);
    const payload = {
      batchId, revisionId, revision: revision.revision, centreId: centre.id, actorId: actor.id, decisionId: decision.id,
      stage: input.stage, outcome: input.outcome, candidateCount, districtApprovals, occurredAt: now.toISOString(),
    };

    await tx.auditEvent.create({
      data: {
        resourceType: 'BatchRevision', resourceId: revisionId, actorId: actor.id, action: 'BATCH_REVIEW_DECISION',
        details: payload, createdAt: now,
      },
    });
    await tx.outboxEvent.create({
      data: {
        aggregateId: batchId, dedupeKey: 'batch.review_decision:' + decision.id,
        type: 'batch.review_decision_recorded', payload, createdAt: now,
      },
    });

    if (status) {
      const transition = await tx.batchRevision.updateMany({
        where: { id: revisionId, status: previousStatus },
        data: { status, statusSince: now },
      });
      if (transition.count !== 1) {
        throw new HttpError(409, 'WRONG_STAGE', 'This revision changed. Reload the batch.');
      }
      const transitionPayload = { ...payload, previousStatus, status };
      const dedupeKey = 'batch.transition:' + revisionId + ':' + previousStatus;
      await tx.auditEvent.create({
        data: {
          resourceType: 'BatchRevision', resourceId: revisionId, actorId: actor.id, action: 'BATCH_REVIEW_TRANSITION',
          details: transitionPayload, createdAt: now,
        },
      });
      await tx.outboxEvent.create({
        data: { aggregateId: batchId, dedupeKey, type: transitionTypes[status], payload: transitionPayload, createdAt: now },
      });
      await notifyWorkflow(tx, batch, status, dedupeKey, now);
    }
    return { decision, status: status ?? previousStatus, districtApprovals };
  });
}
