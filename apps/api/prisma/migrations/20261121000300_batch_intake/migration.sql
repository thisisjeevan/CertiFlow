BEGIN;

ALTER TABLE "BatchRevision"
  ADD COLUMN "editVersion" INTEGER NOT NULL DEFAULT 0,
  ADD CONSTRAINT "BatchRevision_editVersion_check" CHECK ("editVersion" >= 0);

CREATE TABLE "TrainingCompletion" (
  "id" UUID NOT NULL,
  "centreId" UUID NOT NULL,
  "reference" TEXT NOT NULL,
  "candidateReference" TEXT NOT NULL,
  "courseName" TEXT NOT NULL,
  "completedOn" DATE NOT NULL,
  "passed" BOOLEAN NOT NULL,
  CONSTRAINT "TrainingCompletion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TrainingCompletion_centreId_fkey" FOREIGN KEY ("centreId")
    REFERENCES "TrainingCentre" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "TrainingCompletion_reference_check"
    CHECK ("reference" ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$'),
  CONSTRAINT "TrainingCompletion_candidateReference_check"
    CHECK ("candidateReference" ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$'),
  CONSTRAINT "TrainingCompletion_courseName_check"
    CHECK ("courseName" = btrim("courseName") AND char_length("courseName") BETWEEN 1 AND 120)
);

CREATE UNIQUE INDEX "TrainingCompletion_centreId_reference_key"
  ON "TrainingCompletion" ("centreId", "reference");

ALTER TABLE "Candidate"
  ADD COLUMN "trainingCompletionId" UUID,
  ADD CONSTRAINT "Candidate_trainingCompletionId_fkey" FOREIGN KEY ("trainingCompletionId")
    REFERENCES "TrainingCompletion" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "Candidate_trainingCompletionId_key" ON "Candidate" ("trainingCompletionId");

CREATE UNIQUE INDEX "AuditEvent_batch_submission_once_key"
  ON "AuditEvent" ("resourceId")
  WHERE "resourceType" = 'BatchRevision' AND "action" = 'BATCH_SUBMITTED';

COMMIT;
