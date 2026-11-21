import { centreScope } from '../auth/policy.js';
import type { Principal } from '../auth/session.js';
import type { Prisma, ReviewStage, RevisionStatus, Role } from '../generated/prisma/client.js';
import { HttpError } from '../http.js';

export const reviewRules = {
  DISTRICT: { role: 'DISTRICT_OFFICER', status: 'DISTRICT_REVIEW' },
  QUALITY: { role: 'QUALITY_REVIEWER', status: 'QUALITY_REVIEW' },
  STATE: { role: 'STATE_OFFICER', status: 'STATE_REVIEW' },
} as const satisfies Record<ReviewStage, { role: Role; status: RevisionStatus }>;

export const districtThreshold = 2;
export const qualityThreshold = 50;

export function reviewerStage(role: Role) {
  switch (role) {
    case 'DISTRICT_OFFICER': return 'DISTRICT';
    case 'QUALITY_REVIEWER': return 'QUALITY';
    case 'STATE_OFFICER': return 'STATE';
    case 'TRAINING_CENTRE': throw new HttpError(403, 'REVIEW_FORBIDDEN', 'A reviewer account is required.');
  }
}

export function requireStageRole(role: Role, stage: ReviewStage) {
  if (reviewRules[stage].role !== role) {
    throw new HttpError(403, 'REVIEW_FORBIDDEN', 'Your role cannot decide at this review stage.');
  }
}

export function revisionVisibility(viewer: Principal): Prisma.BatchRevisionWhereInput {
  if (viewer.role === 'TRAINING_CENTRE') return {};
  const stage = reviewerStage(viewer.role);
  if (stage === 'DISTRICT') return { submittedAt: { not: null } };
  return {
    OR: [{ status: reviewRules[stage].status }, { decisions: { some: { stage } } }],
  };
}

export function workflowScope(viewer: Principal): Prisma.BatchWhereInput {
  const centre = centreScope(viewer);
  return viewer.role === 'TRAINING_CENTRE'
    ? { centre }
    : { centre, revisions: { some: revisionVisibility(viewer) } };
}
