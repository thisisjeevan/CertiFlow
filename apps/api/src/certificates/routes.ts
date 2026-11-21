import { Router, type RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { authenticate, getPrincipal } from '../auth/session.js';
import type { ApiConfig } from '../config.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { HttpError, requireSameOriginType } from '../http.js';
import { downloadPdf, issuedBatches, issuedCertificates, mockInbox, revokeCertificate, verifyCertificate } from './access.js';
import { downloadTokenPattern, numberPattern } from './tokens.js';

const noStore: RequestHandler = (_req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  next();
};

const limited = (limit: number) => rateLimit({
  windowMs: 60_000, limit, standardHeaders: 'draft-8', legacyHeaders: false,
  message: { error: { code: 'RATE_LIMIT', message: 'Too many requests. Try again shortly.' } },
});

function uuid(value: unknown) {
  const parsed = z.uuid().safeParse(value);
  if (!parsed.success) throw new HttpError(400, 'INVALID_CERTIFICATE_ID', 'Use a valid certificate or revision ID.');
  return parsed.data.toLowerCase();
}

const revocationBody = z.strictObject({
  reason: z.string().trim().min(1).max(500).refine((value) => !value.includes('\0')),
});

export function verificationRoutes(db: PrismaClient) {
  const router = Router();
  router.use(noStore, limited(120));
  router.get('/:number', async (req, res) => {
    const number = typeof req.params.number === 'string' ? req.params.number.toUpperCase() : '';
    const result = numberPattern.test(number) ? await verifyCertificate(db, number) : { status: 'NOT_FOUND' };
    res.status(result.status === 'NOT_FOUND' ? 404 : 200).json(result);
  });
  return router;
}

export function certificateRoutes(db: PrismaClient, config: ApiConfig) {
  const router = Router();
  router.use(noStore);
  router.get('/:certificateId/download', limited(60), async (req, res) => {
    const token = req.get('Authorization')?.match(/^Bearer +(\S+)$/i)?.[1];
    const parsed = z.uuid().safeParse(req.params.certificateId);
    if (!token || !downloadTokenPattern.test(token) || !parsed.success) {
      throw new HttpError(403, 'DOWNLOAD_FORBIDDEN', 'This download link is invalid, expired, or unavailable.');
    }
    const bytes = await downloadPdf(db, config.CERTIFICATE_STORAGE, parsed.data.toLowerCase(), token);
    res.attachment('certificate.pdf').send(bytes);
  });
  router.use(authenticate(db));
  router.get('/batches', async (req, res) => {
    res.json({ batches: await issuedBatches(db, getPrincipal(req)) });
  });
  router.get('/batches/:revisionId', async (req, res) => {
    res.json(await issuedCertificates(db, getPrincipal(req), uuid(req.params.revisionId)));
  });
  router.get('/batches/:revisionId/mock-messages', async (req, res) => {
    const messages = await mockInbox(db, getPrincipal(req), uuid(req.params.revisionId), config.APP_ORIGIN, config.CERTIFICATE_LINK_SECRET);
    res.json({ messages });
  });
  router.post('/:certificateId/revoke', requireSameOriginType(config.APP_ORIGIN, 'application/json'), async (req, res) => {
    const body = revocationBody.safeParse(req.body);
    if (!body.success) throw new HttpError(400, 'REVOCATION_REASON_REQUIRED', 'Provide a revocation reason of 1 to 500 characters.');
    res.json(await revokeCertificate(db, getPrincipal(req), uuid(req.params.certificateId), body.data.reason));
  });
  return router;
}
