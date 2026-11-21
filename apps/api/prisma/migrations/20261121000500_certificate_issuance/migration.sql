BEGIN;

ALTER TYPE "DeliveryStatus" ADD VALUE 'CANCELLED';
CREATE TYPE "DeliveryAttemptOutcome" AS ENUM ('ACCEPTED', 'REJECTED', 'TIMEOUT_AFTER_ACCEPTANCE', 'RECEIPT_RECOVERED');

ALTER TABLE "Certificate"
  ADD COLUMN "trainingCompletionId" UUID,
  ADD COLUMN "generationAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "generationError" TEXT,
  ADD COLUMN "checksum" CHAR(64),
  ADD CONSTRAINT "Certificate_trainingCompletionId_fkey" FOREIGN KEY ("trainingCompletionId")
    REFERENCES "TrainingCompletion" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "Certificate_generationAttempts_check" CHECK ("generationAttempts" >= 0),
  ADD CONSTRAINT "Certificate_checksum_check" CHECK (
    ("checksum" IS NULL OR "checksum" ~ '^[0-9a-f]{64}$')
    AND ("generationStatus" <> 'READY' OR "trainingCompletionId" IS NULL OR "checksum" IS NOT NULL)
  );

CREATE UNIQUE INDEX "Certificate_trainingCompletionId_key" ON "Certificate" ("trainingCompletionId");

ALTER TABLE "MessageDelivery"
  ADD COLUMN "nextAttemptAt" TIMESTAMPTZ(3),
  ADD COLUMN "lastError" TEXT;

CREATE TABLE "DeliveryAttempt" (
  "id" BIGSERIAL PRIMARY KEY,
  "deliveryId" UUID NOT NULL,
  "attempt" INTEGER NOT NULL CHECK ("attempt" > 0),
  "outcome" "DeliveryAttemptOutcome" NOT NULL,
  "errorCode" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DeliveryAttempt_deliveryId_fkey" FOREIGN KEY ("deliveryId")
    REFERENCES "MessageDelivery" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "DeliveryAttempt_deliveryId_attempt_key" ON "DeliveryAttempt" ("deliveryId", "attempt");

CREATE TABLE "MockWhatsAppMessage" (
  "id" UUID PRIMARY KEY,
  "deliveryId" UUID NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "grantDigest" CHAR(64) NOT NULL CHECK ("grantDigest" ~ '^[0-9a-f]{64}$'),
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "acceptedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ("expiresAt" > "acceptedAt"),
  CONSTRAINT "MockWhatsAppMessage_deliveryId_fkey" FOREIGN KEY ("deliveryId")
    REFERENCES "MessageDelivery" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "MockWhatsAppMessage_deliveryId_key" ON "MockWhatsAppMessage" ("deliveryId");
CREATE UNIQUE INDEX "MockWhatsAppMessage_idempotencyKey_key" ON "MockWhatsAppMessage" ("idempotencyKey");
CREATE UNIQUE INDEX "MockWhatsAppMessage_grantDigest_key" ON "MockWhatsAppMessage" ("grantDigest");

CREATE INDEX "OutboxEvent_certificate_due_idx" ON "OutboxEvent" ("nextAttemptAt", "createdAt")
  WHERE "completedAt" IS NULL AND "type" IN ('batch.approved', 'certificate.generate', 'certificate.deliver');

COMMIT;
