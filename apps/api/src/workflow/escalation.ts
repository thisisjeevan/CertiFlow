import type { PrismaClient, ReviewStage } from '../generated/prisma/client.js';

const thresholdHours = 24;
const scanInterval = 60_000;

interface Overdue {
  id: string;
  batchId: string;
  stage: ReviewStage;
  statusSince: Date;
}

export function escalateOverdueReviews(db: PrismaClient, now = new Date()) {
  const cutoff = new Date(now.getTime() - thresholdHours * 60 * 60 * 1_000);
  return db.$transaction(async (tx) => {
    const overdue = await tx.$queryRaw<Overdue[]>`
      SELECT r.id, r."batchId", r."statusSince", pending.stage
      FROM "BatchRevision" r
      CROSS JOIN LATERAL (VALUES (
        CASE r.status WHEN 'DISTRICT_REVIEW' THEN 'DISTRICT'::"ReviewStage"
          WHEN 'QUALITY_REVIEW' THEN 'QUALITY'::"ReviewStage" WHEN 'STATE_REVIEW' THEN 'STATE'::"ReviewStage" END
      )) AS pending(stage)
      WHERE r.status IN ('DISTRICT_REVIEW', 'QUALITY_REVIEW', 'STATE_REVIEW')
        AND r."statusSince" < ${cutoff}
        AND NOT EXISTS (
          SELECT FROM "ReviewEscalation" e WHERE e."revisionId" = r.id AND e.stage = pending.stage
        )
      ORDER BY r."statusSince", r.id
      LIMIT 100 FOR UPDATE OF r SKIP LOCKED
    `;
    if (!overdue.length) return 0;

    // Hold current recipients' account rows through the notification write.
    const recipients = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "User" WHERE active AND role = 'STATE_OFFICER' ORDER BY id FOR SHARE
    `;
    if (!recipients.length) return 0;
    const escalations = await tx.reviewEscalation.createManyAndReturn({
      data: overdue.map(({ id, stage, statusSince }) => ({
        revisionId: id, stage, stageStartedAt: statusSince, thresholdHours, createdAt: now,
      })),
      skipDuplicates: true,
    });
    if (!escalations.length) return 0;
    const batches = new Map(overdue.map(({ id, batchId }) => [id, batchId]));
    await tx.auditEvent.createMany({
      data: escalations.map(({ id, revisionId, stage, stageStartedAt }) => ({
        resourceType: 'BatchRevision', resourceId: revisionId, action: 'REVIEW_ESCALATED',
        createdAt: now,
        details: { escalationId: id, batchId: batches.get(revisionId)!, revisionId, stage, thresholdHours,
          stageStartedAt: stageStartedAt.toISOString(), escalatedAt: now.toISOString() },
      })),
    });
    await tx.notification.createMany({
      data: recipients.flatMap(({ id: userId }) => escalations.map(({ id, revisionId, stage }) => ({
        userId, type: 'REVIEW_ESCALATED', resourceId: batches.get(revisionId)!,
        dedupeKey: 'review.escalated:' + revisionId + ':' + stage, escalationId: id, createdAt: now,
      }))),
    });
    return escalations.length;
  }, { timeout: 10_000 });
}

export function startEscalationScanner(db: PrismaClient, report: (event: string, error: unknown) => void) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  let pending: Promise<void>;
  function scan() {
    pending = escalateOverdueReviews(db).then((count) => {
      if (count) console.info(JSON.stringify({ event: 'reviews_escalated', count }));
    }).catch((error: unknown) => report('review_escalation_failed', error)).finally(() => {
      if (!stopped) timer = setTimeout(scan, scanInterval);
    });
  }
  scan();
  return async () => {
    stopped = true;
    clearTimeout(timer);
    await pending;
  };
}
