BEGIN;

-- Prisma does not express these domain checks and partial indexes in the schema.
ALTER TABLE "User"
  ADD CONSTRAINT "User_email_normalized_check"
    CHECK ("email" = lower(btrim("email")) AND char_length("email") BETWEEN 3 AND 254),
  ADD CONSTRAINT "User_role_scope_check"
    CHECK (
      ("role" = 'TRAINING_CENTRE' AND "centreId" IS NOT NULL AND "districtId" IS NULL)
      OR ("role" = 'DISTRICT_OFFICER' AND "districtId" IS NOT NULL AND "centreId" IS NULL)
      OR ("role" IN ('QUALITY_REVIEWER', 'STATE_OFFICER') AND "centreId" IS NULL AND "districtId" IS NULL)
    );

ALTER TABLE "Session"
  ADD CONSTRAINT "Session_expiry_check" CHECK ("expiresAt" > "createdAt"),
  ADD CONSTRAINT "Session_token_hash_check" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "BatchRevision"
  ADD CONSTRAINT "BatchRevision_number_check" CHECK ("revision" >= 1),
  ADD CONSTRAINT "BatchRevision_submission_state_check"
    CHECK (("status" = 'DRAFT') = ("submittedAt" IS NULL));

CREATE UNIQUE INDEX "BatchRevision_one_live_revision_key"
  ON "BatchRevision" ("batchId")
  WHERE "status" NOT IN ('RETURNED', 'REJECTED');

ALTER TABLE "Candidate"
  ADD CONSTRAINT "Candidate_reference_check" CHECK ("reference" = btrim("reference") AND "reference" <> '');

ALTER TABLE "RevisionCandidate"
  ADD CONSTRAINT "RevisionCandidate_name_check" CHECK (btrim("fullName") <> ''),
  ADD CONSTRAINT "RevisionCandidate_phone_check" CHECK ("phoneE164" ~ '^[+][1-9][0-9]{1,14}$');

ALTER TABLE "Decision"
  ADD CONSTRAINT "Decision_reason_check"
    CHECK ("outcome" = 'APPROVE' OR ("reason" IS NOT NULL AND btrim("reason") <> ''));

CREATE UNIQUE INDEX "Decision_quality_or_state_once_key"
  ON "Decision" ("revisionId", "stage")
  WHERE "stage" IN ('QUALITY', 'STATE');

CREATE UNIQUE INDEX "Decision_district_resolution_key"
  ON "Decision" ("revisionId")
  WHERE "stage" = 'DISTRICT' AND "outcome" IN ('RETURN', 'REJECT');

ALTER TABLE "Certificate"
  ADD CONSTRAINT "Certificate_number_check" CHECK ("number" = btrim("number") AND "number" <> ''),
  ADD CONSTRAINT "Certificate_generation_state_check"
    CHECK (
      ("generationStatus" = 'READY' AND "objectKey" IS NOT NULL AND btrim("objectKey") <> '' AND "issuedAt" IS NOT NULL)
      OR ("generationStatus" <> 'READY' AND "objectKey" IS NULL AND "issuedAt" IS NULL)
    ),
  ADD CONSTRAINT "Certificate_revocation_check"
    CHECK (
      ("revokedAt" IS NULL AND "revokedById" IS NULL AND "revocationReason" IS NULL)
      OR ("generationStatus" = 'READY' AND "revokedAt" IS NOT NULL AND "revokedAt" >= "issuedAt"
        AND "revokedById" IS NOT NULL AND "revocationReason" IS NOT NULL AND btrim("revocationReason") <> '')
    );

ALTER TABLE "MessageDelivery"
  ADD CONSTRAINT "MessageDelivery_attempts_check" CHECK ("attempts" >= 0),
  ADD CONSTRAINT "MessageDelivery_state_check"
    CHECK (
      ("status" = 'DELIVERED' AND "providerReceipt" IS NOT NULL AND btrim("providerReceipt") <> ''
        AND "deliveredAt" IS NOT NULL AND "attempts" > 0)
      OR ("status" <> 'DELIVERED' AND "providerReceipt" IS NULL AND "deliveredAt" IS NULL)
    );

ALTER TABLE "OutboxEvent"
  ADD CONSTRAINT "OutboxEvent_attempts_check" CHECK ("attempts" >= 0);

COMMIT;
