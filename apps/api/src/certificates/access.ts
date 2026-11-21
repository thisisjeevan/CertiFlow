import type { Principal } from '../auth/session.js';
import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import { HttpError } from '../http.js';
import { certificateKey, readCertificatePdf } from './storage.js';
import { downloadLink, grantDigest, grantToken } from './tokens.js';

function scope(viewer: Principal): Prisma.BatchRevisionWhereInput {
  if (viewer.role === 'STATE_OFFICER') return { status: 'APPROVED' };
  if (viewer.role === 'TRAINING_CENTRE' && viewer.centreId) {
    return { status: 'APPROVED', batch: { centreId: viewer.centreId } };
  }
  throw new HttpError(403, 'CERTIFICATES_FORBIDDEN', 'This certificate workspace is unavailable to your account.');
}

const batchFields = {
  id: true, revision: true, statusSince: true,
  _count: { select: { candidates: true } },
  batch: { select: { id: true, courseName: true, centre: { select: { name: true } } } },
} as const;

export function issuedBatches(db: PrismaClient, viewer: Principal) {
  return db.$transaction(async (tx) => {
    const revisions = await tx.batchRevision.findMany({
      where: scope(viewer), select: batchFields, orderBy: [{ statusSince: 'desc' }, { id: 'asc' }], take: 100,
    });
    const counts = revisions.length ? await tx.$queryRaw<{
      revisionId: string; ready: number; failed: number; delivered: number; revoked: number;
    }[]>`
      SELECT c."revisionId", count(*) FILTER (WHERE c."generationStatus" = 'READY')::int AS ready,
        count(*) FILTER (WHERE c."generationStatus" = 'FAILED')::int AS failed,
        count(*) FILTER (WHERE d.status = 'DELIVERED')::int AS delivered,
        count(*) FILTER (WHERE c."revokedAt" IS NOT NULL)::int AS revoked
      FROM "Certificate" c LEFT JOIN "MessageDelivery" d ON d."certificateId" = c.id
      WHERE c."revisionId" IN (${Prisma.join(revisions.map(({ id }) => Prisma.sql`${id}::uuid`))})
      GROUP BY c."revisionId"
    ` : [];
    const summaries = new Map(counts.map(({ revisionId, ...summary }) => [revisionId, summary]));
    return revisions.map(({ id, revision, statusSince, batch, _count }) => ({
      batch, revisionId: id, revision, approvedAt: statusSince, candidates: _count.candidates,
      ...(summaries.get(id) ?? { ready: 0, failed: 0, delivered: 0, revoked: 0 }),
    }));
  }, { isolationLevel: 'RepeatableRead' });
}

export function issuedCertificates(db: PrismaClient, viewer: Principal, revisionId: string) {
  return db.$transaction(async (tx) => {
    const revision = await tx.batchRevision.findFirst({
      where: { id: revisionId, ...scope(viewer) }, select: batchFields,
    });
    if (!revision) throw new HttpError(403, 'CERTIFICATES_FORBIDDEN', 'This revision is unavailable to your account.');

    const certificates = await tx.certificate.findMany({
      where: { revisionId },
      orderBy: { candidate: { fullName: 'asc' } },
      select: {
        id: true, number: true, generationStatus: true, generationAttempts: true, generationError: true,
        issuedAt: true, revokedAt: true, revocationReason: true, candidate: { select: { fullName: true } },
        delivery: { select: { status: true, attempts: true, deliveredAt: true, lastError: true } },
      },
    });
    return { ...revision.batch, revision: revision.revision, candidateCount: revision._count.candidates, certificates };
  }, { isolationLevel: 'RepeatableRead' });
}

export async function verifyCertificate(db: PrismaClient, number: string) {
  const certificate = await db.certificate.findFirst({
    where: { number, generationStatus: 'READY' },
    select: {
      number: true, issuedAt: true, revokedAt: true,
      candidate: { select: { revision: { select: { batch: { select: {
        courseName: true, centre: { select: { name: true } },
      } } } } } },
    },
  });
  if (!certificate) return { status: 'NOT_FOUND' as const };
  if (certificate.revokedAt) return { status: 'REVOKED' as const, number: certificate.number };
  const { batch } = certificate.candidate.revision;
  return {
    status: 'VALID' as const, number: certificate.number, issuedAt: certificate.issuedAt,
    courseName: batch.courseName, centreName: batch.centre.name,
  };
}

const inaccessibleDownload = () => new HttpError(403, 'DOWNLOAD_FORBIDDEN', 'This download link is invalid, expired, or unavailable.');

export function downloadPdf(db: PrismaClient, directory: string, id: string, token: string) {
  return db.$transaction(async (tx) => {
    const [locked] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "Certificate" WHERE id = ${id}::uuid
        AND "revokedAt" IS NULL AND "generationStatus" = 'READY' FOR SHARE
    `;
    if (!locked) throw inaccessibleDownload();
    const grant = await tx.mockWhatsAppMessage.findFirst({
      where: { grantDigest: grantDigest(token), expiresAt: { gt: new Date() }, delivery: { certificateId: id } },
      select: { delivery: { select: { certificate: { select: { objectKey: true } } } } },
    });
    if (!grant || grant.delivery.certificate.objectKey !== certificateKey(id)) throw inaccessibleDownload();
    try {
      return await readCertificatePdf(directory, id);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      throw new HttpError(503, 'PRIVATE_FILE_UNAVAILABLE', 'The certificate file is temporarily unavailable.');
    }
  });
}

function requireState(viewer: Principal) {
  if (viewer.role !== 'STATE_OFFICER') throw new HttpError(403, 'STATE_OFFICER_REQUIRED', 'A state officer account is required.');
}

export function revokeCertificate(db: PrismaClient, viewer: Principal, id: string, reason: string) {
  requireState(viewer);
  return db.$transaction(async (tx) => {
    const [actor] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "User" WHERE id = ${viewer.id}::uuid AND role = 'STATE_OFFICER' AND active FOR SHARE
    `;
    if (!actor) throw new HttpError(403, 'STATE_OFFICER_REQUIRED', 'A state officer account is required.');
    const [certificate] = await tx.$queryRaw<{ id: string; revisionId: string; generationStatus: string; revokedAt: Date | null }[]>`
      SELECT id, "revisionId", "generationStatus", "revokedAt" FROM "Certificate" WHERE id = ${id}::uuid FOR UPDATE
    `;
    if (!certificate) throw new HttpError(404, 'CERTIFICATE_NOT_FOUND', 'This certificate is unavailable.');
    if (certificate.revokedAt) throw new HttpError(409, 'ALREADY_REVOKED', 'This certificate is already revoked.');
    if (certificate.generationStatus !== 'READY') throw new HttpError(409, 'CERTIFICATE_NOT_ISSUED', 'Only an issued certificate can be revoked.');

    const revokedAt = new Date();
    await tx.certificate.update({ where: { id }, data: { revokedAt, revokedById: actor.id, revocationReason: reason } });
    await tx.messageDelivery.updateMany({
      where: { certificateId: id, status: 'PENDING' },
      data: { status: 'CANCELLED', nextAttemptAt: null, lastError: 'CERTIFICATE_REVOKED' },
    });
    await tx.auditEvent.create({
      data: {
        resourceType: 'Certificate', resourceId: id, actorId: actor.id, action: 'CERTIFICATE_REVOKED',
        details: { revisionId: certificate.revisionId, reason, revokedAt: revokedAt.toISOString() }, createdAt: revokedAt,
      },
    });
    return { id, status: 'REVOKED', revokedAt };
  });
}

export async function mockInbox(db: PrismaClient, viewer: Principal, revisionId: string, origin: string, secret?: string) {
  requireState(viewer);
  const records = await db.mockWhatsAppMessage.findMany({
    where: { delivery: { certificate: { revisionId } } },
    orderBy: { acceptedAt: 'desc' },
    select: {
      id: true, grantDigest: true, expiresAt: true, acceptedAt: true,
      delivery: { select: {
        status: true, attempts: true,
        history: { orderBy: { attempt: 'asc' }, select: { attempt: true, outcome: true, errorCode: true, createdAt: true } },
        certificate: { select: { id: true, number: true, revokedAt: true, candidate: { select: { fullName: true } } } },
      } },
    },
  });
  const now = new Date();
  return records.map(({ id, expiresAt, acceptedAt, delivery, grantDigest: digest }) => {
    const { certificate, ...progress } = delivery;
    const token = secret && !certificate.revokedAt && expiresAt > now ? grantToken(secret, id, expiresAt) : undefined;
    return {
      receiptId: id, acceptedAt, expiresAt, ...progress, number: certificate.number, candidateName: certificate.candidate.fullName,
      downloadUrl: token && grantDigest(token) === digest ? downloadLink(origin, certificate.id, token) : null,
    };
  });
}
