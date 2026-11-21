BEGIN;

-- Each review stage may transition at most once per revision.
CREATE UNIQUE INDEX "AuditEvent_review_transition_once_key"
  ON "AuditEvent" ("resourceId", ("details"->>'previousStatus'))
  WHERE "resourceType" = 'BatchRevision' AND "action" = 'BATCH_REVIEW_TRANSITION';

COMMIT;
