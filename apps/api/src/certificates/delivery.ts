import { randomUUID } from 'node:crypto';
import type { MockWhatsAppMessage, Prisma, PrismaClient } from '../generated/prisma/client.js';
import { grantDigest, grantToken } from './tokens.js';
import { finishWork, lockCertificate, lockWork, retryTime, type IssuanceSettings, type MockMode } from './work-context.js';

const maxDeliveryAttempts = 5;

function mockOutcome(mode: MockMode, reference: string, certificateId: string, attempt: number) {
  if (mode === 'reject_always') return 'REJECTED';
  if (attempt > 1) return 'ACCEPTED';
  const suffix = reference.match(/\d+$/)?.[0]?.slice(-6);
  const bucket = (suffix ? Number(suffix) : Number.parseInt(certificateId.slice(-2), 16)) % 5;
  if (mode === 'reject_once' || (mode === 'mixed' && bucket === 0)) return 'REJECTED';
  if (mode === 'timeout_after_acceptance' || (mode === 'mixed' && bucket === 1)) return 'TIMEOUT_AFTER_ACCEPTANCE';
  return 'ACCEPTED';
}

async function acknowledge(
  tx: Prisma.TransactionClient, eventId: string, certificateId: string,
  receipt: MockWhatsAppMessage, attempts: number,
) {
  await tx.messageDelivery.update({
    where: { id: receipt.deliveryId },
    data: {
      status: 'DELIVERED', providerReceipt: receipt.id, deliveredAt: receipt.acceptedAt,
      attempts, nextAttemptAt: null, lastError: null,
    },
  });
  await tx.auditEvent.create({
    data: {
      resourceType: 'Certificate', resourceId: certificateId, action: 'MOCK_WHATSAPP_DELIVERED',
      details: { deliveryId: receipt.deliveryId, deliveryEventId: eventId, receiptId: receipt.id, attempts },
    },
  });
  await finishWork(tx, eventId);
}

// The mock commits its receipt with the attempt. Acknowledgement happens in a separate transaction.
async function send(db: PrismaClient, eventId: string, settings: IssuanceSettings) {
  return db.$transaction(async (tx) => {
    const event = await lockWork(tx, eventId, 'certificate.deliver');
    if (!event) return false;
    await lockCertificate(tx, event.aggregateId);
    const delivery = await tx.messageDelivery.findUniqueOrThrow({
      where: { certificateId: event.aggregateId },
      include: {
        mockMessage: true,
        certificate: { select: {
          revokedAt: true, generationStatus: true,
          candidate: { select: { candidate: { select: { reference: true } } } },
        } },
      },
    });
    if (delivery.status !== 'PENDING') {
      await finishWork(tx, event.id);
      return false;
    }
    if (delivery.certificate.revokedAt) {
      await tx.messageDelivery.update({
        where: { id: delivery.id }, data: { status: 'CANCELLED', nextAttemptAt: null, lastError: 'CERTIFICATE_REVOKED' },
      });
      await finishWork(tx, event.id);
      return false;
    }
    if (delivery.certificate.generationStatus !== 'READY') throw new Error('Delivery was queued before issuance');

    const now = new Date();
    if (delivery.nextAttemptAt && delivery.nextAttemptAt > now) {
      await tx.outboxEvent.update({ where: { id: event.id }, data: { nextAttemptAt: delivery.nextAttemptAt } });
      return false;
    }

    const attempt = delivery.attempts + 1;
    if (delivery.mockMessage) {
      await tx.deliveryAttempt.create({ data: { deliveryId: delivery.id, attempt, outcome: 'RECEIPT_RECOVERED', createdAt: now } });
      await acknowledge(tx, event.id, event.aggregateId, delivery.mockMessage, attempt);
      return false;
    }

    const outcome = mockOutcome(settings.mockMode, delivery.certificate.candidate.candidate.reference, event.aggregateId, attempt);
    const errorCode = outcome === 'REJECTED' ? 'MOCK_PROVIDER_REJECTED'
      : outcome === 'TIMEOUT_AFTER_ACCEPTANCE' ? 'MOCK_PROVIDER_TIMEOUT' : null;
    const exhausted = outcome === 'REJECTED' && attempt >= maxDeliveryAttempts;
    const nextAttemptAt = exhausted ? null : retryTime(settings, attempt, now);

    if (outcome !== 'REJECTED') {
      const receiptId = randomUUID();
      const expiresAt = new Date(now.getTime() + (settings.linkTtlMs ?? 24 * 60 * 60 * 1000));
      await tx.mockWhatsAppMessage.create({
        data: {
          id: receiptId, deliveryId: delivery.id, idempotencyKey: delivery.idempotencyKey,
          grantDigest: grantDigest(grantToken(settings.linkSecret, receiptId, expiresAt)),
          expiresAt, acceptedAt: now,
        },
      });
    }
    await tx.deliveryAttempt.create({ data: { deliveryId: delivery.id, attempt, outcome, errorCode, createdAt: now } });
    await tx.messageDelivery.update({
      where: { id: delivery.id },
      data: { attempts: attempt, nextAttemptAt, lastError: errorCode, status: exhausted ? 'FAILED' : 'PENDING' },
    });
    await tx.outboxEvent.update({
      where: { id: event.id }, data: nextAttemptAt ? { nextAttemptAt } : { completedAt: now },
    });
    return outcome === 'ACCEPTED';
  });
}

export async function deliverCertificate(db: PrismaClient, eventId: string, settings: IssuanceSettings) {
  if (!await send(db, eventId, settings)) return;

  await db.$transaction(async (tx) => {
    const event = await lockWork(tx, eventId, 'certificate.deliver');
    if (!event) return;
    await lockCertificate(tx, event.aggregateId);
    const delivery = await tx.messageDelivery.findUniqueOrThrow({
      where: { certificateId: event.aggregateId },
      include: { mockMessage: true, certificate: { select: { revokedAt: true } } },
    });
    if (delivery.status !== 'PENDING' || delivery.certificate.revokedAt) {
      await finishWork(tx, event.id);
      return;
    }
    if (!delivery.mockMessage) throw new Error('Mock provider receipt is missing');
    await acknowledge(tx, event.id, event.aggregateId, delivery.mockMessage, delivery.attempts);
  });
}
