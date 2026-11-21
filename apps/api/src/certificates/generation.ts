import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { PrismaClient } from '../generated/prisma/client.js';
import { renderCertificate } from './pdf.js';
import { storeCertificatePdf } from './storage.js';
import { finishWork, lockCertificate, lockWork, retryTime, type IssuanceSettings } from './work-context.js';

const batchPayload = z.object({ revisionId: z.uuid() });
const maxGenerationAttempts = 5;

export function expandApprovedBatch(db: PrismaClient, eventId: string) {
  return db.$transaction(async (tx) => {
    const event = await lockWork(tx, eventId, 'batch.approved');
    if (!event) return;
    const { revisionId } = batchPayload.parse(event.payload);
    const revision = await tx.batchRevision.findFirst({
      where: { id: revisionId, batchId: event.aggregateId, status: 'APPROVED' },
      select: {
        statusSince: true,
        batch: { select: { centreId: true, courseName: true } },
        candidates: {
          orderBy: { candidateId: 'asc' },
          select: { candidateId: true, candidate: { select: { reference: true, trainingCompletion: true } } },
        },
      },
    });
    if (!revision?.candidates.length) throw new Error('Approval event has no approved roster');
    const rows = revision.candidates.map(({ candidateId, candidate }) => {
      const completion = candidate.trainingCompletion;
      if (!completion?.passed || completion.candidateReference !== candidate.reference
        || completion.centreId !== revision.batch.centreId || completion.courseName !== revision.batch.courseName
        || completion.completedOn > revision.statusSince) {
        throw new Error('Approved roster contains an ineligible training completion');
      }
      return {
        candidateId, revisionId, trainingCompletionId: completion.id,
        number: 'CF-' + randomBytes(20).toString('hex').toUpperCase(),
      };
    });
    await tx.certificate.createMany({ data: rows, skipDuplicates: true });
    const certificates = await tx.certificate.findMany({
      where: { revisionId }, select: { id: true, candidateId: true, trainingCompletionId: true },
    });
    const memberships = new Map(certificates.map((certificate) => [certificate.candidateId, certificate.trainingCompletionId]));
    if (certificates.length !== rows.length || rows.some((row) => memberships.get(row.candidateId) !== row.trainingCompletionId)) {
      throw new Error('Certificate identities did not match the approved roster');
    }

    await tx.outboxEvent.createMany({
      data: certificates.map(({ id }) => ({
        type: 'certificate.generate', aggregateId: id, dedupeKey: 'certificate.generate:' + id,
        payload: { certificateId: id, approvalEventId: event.id, batchId: event.aggregateId, revisionId },
      })),
      skipDuplicates: true,
    });
    await finishWork(tx, event.id);
  }, { timeout: 10_000 });
}

export function generateCertificate(db: PrismaClient, eventId: string, settings: IssuanceSettings) {
  return db.$transaction(async (tx) => {
    const event = await lockWork(tx, eventId, 'certificate.generate');
    if (!event) return;
    await lockCertificate(tx, event.aggregateId);
    const certificate = await tx.certificate.findUniqueOrThrow({
      where: { id: event.aggregateId },
      include: {
        candidate: { select: { fullName: true, revision: { select: {
          batchId: true, batch: { select: { courseName: true, centre: { select: { name: true } } } },
        } } } },
      },
    });
    if (certificate.generationStatus !== 'PENDING') {
      await finishWork(tx, event.id);
      return;
    }

    const { candidate } = certificate;
    const generationAttempts = certificate.generationAttempts + 1;
    const issuedAt = certificate.createdAt;
    let stored: { objectKey: string; checksum: string };
    try {
      stored = await storeCertificatePdf(settings.directory, certificate.id, () => renderCertificate({
        number: certificate.number,
        fullName: candidate.fullName,
        courseName: candidate.revision.batch.courseName,
        centreName: candidate.revision.batch.centre.name,
        issuedAt,
      }, settings.origin));
    } catch {
      const exhausted = generationAttempts >= maxGenerationAttempts;
      await tx.certificate.update({
        where: { id: certificate.id },
        data: { generationAttempts, generationError: 'PDF_GENERATION_FAILED', generationStatus: exhausted ? 'FAILED' : 'PENDING' },
      });
      await tx.outboxEvent.update({
        where: { id: event.id },
        data: exhausted ? { completedAt: new Date() } : { nextAttemptAt: retryTime(settings, generationAttempts, new Date()) },
      });
      return;
    }

    await tx.certificate.update({
      where: { id: certificate.id },
      data: { ...stored, issuedAt, generationAttempts, generationError: null, generationStatus: 'READY' },
    });
    await tx.messageDelivery.upsert({
      where: { certificateId: certificate.id },
      update: {},
      create: { certificateId: certificate.id, idempotencyKey: 'whatsapp:' + certificate.id },
    });
    const trace = {
      certificateId: certificate.id, batchId: candidate.revision.batchId,
      revisionId: certificate.revisionId, generationEventId: event.id,
    };
    await tx.outboxEvent.upsert({
      where: { dedupeKey: 'certificate.deliver:' + certificate.id },
      update: {},
      create: {
        type: 'certificate.deliver', aggregateId: certificate.id,
        dedupeKey: 'certificate.deliver:' + certificate.id, payload: trace,
      },
    });
    await tx.auditEvent.create({
      data: {
        resourceType: 'Certificate', resourceId: certificate.id, action: 'CERTIFICATE_ISSUED',
        details: { ...trace, number: certificate.number, issuedAt: issuedAt.toISOString() },
      },
    });
    await finishWork(tx, event.id);
  }, { timeout: 10_000 });
}
