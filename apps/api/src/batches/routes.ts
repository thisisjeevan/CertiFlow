import { Router, raw, type Request } from 'express';
import { z } from 'zod';
import { authenticate, getPrincipal } from '../auth/session.js';
import type { ApiConfig } from '../config.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { HttpError, requireSameOriginType } from '../http.js';
import { csvByteLimit } from './csv.js';
import {
  createBatch, editBatch, getBatch, importCandidates, listBatches, startCorrection, submitBatch, type CentreOwner,
} from './service.js';

const courseName = z.string().trim().min(1).max(120).regex(/^[^\p{Cc}\p{Zl}\p{Zp}]+$/u);
const createBody = z.strictObject({ centreId: z.uuid().transform((id) => id.toLowerCase()), courseName });
const editBody = z.strictObject({ courseName });
const submitBody = z.strictObject({});
const correctionBody = z.strictObject({ revisionId: z.uuid().transform((id) => id.toLowerCase()) });

function owner(req: Request): CentreOwner {
  const principal = getPrincipal(req);
  if (principal.role !== 'TRAINING_CENTRE' || !principal.centreId) {
    throw new HttpError(403, 'FORBIDDEN', 'A training-centre account is required.');
  }
  return { id: principal.id, centreId: principal.centreId };
}

function batchId(req: Request) {
  const id = z.uuid().safeParse(req.params.id);
  if (!id.success) throw new HttpError(400, 'INVALID_BATCH_ID', 'Enter a valid batch ID.');
  return id.data.toLowerCase();
}

function draftVersion(req: Request) {
  const version = req.get('X-Draft-Version');
  if (!version) throw new HttpError(428, 'DRAFT_VERSION_REQUIRED', 'Open the batch to get its current draft version.');
  if (!/^[a-f0-9-]{36}:\d{1,10}$/.test(version)) {
    throw new HttpError(400, 'INVALID_DRAFT_VERSION', 'Use the draft version returned by the batch API.');
  }
  return version;
}

export function batchRoutes(db: PrismaClient, config: ApiConfig) {
  const router = Router();
  const json = requireSameOriginType(config.APP_ORIGIN, 'application/json');
  const csv = requireSameOriginType(config.APP_ORIGIN, 'text/csv');
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  }, authenticate(db), (req, _res, next) => {
    owner(req);
    next();
  });

  router.get('/', async (req, res) => {
    res.json({ batches: await listBatches(db, owner(req)) });
  });

  router.get('/:id', async (req, res) => {
    res.json({ batch: await getBatch(db, owner(req), batchId(req)) });
  });

  router.post('/', json, async (req, res) => {
    const input = createBody.safeParse(req.body);
    if (!input.success) throw new HttpError(400, 'INVALID_BATCH', 'Enter a centre ID and a course name of 1–120 characters.');
    const batch = await createBatch(db, owner(req), input.data);
    res.location('/api/batches/' + batch.id).status(201).json({ batch });
  });

  router.patch('/:id', json, async (req, res) => {
    const input = editBody.safeParse(req.body);
    if (!input.success) throw new HttpError(400, 'INVALID_BATCH', 'Enter a course name of 1–120 characters.');
    const batch = await editBatch(db, owner(req), batchId(req), draftVersion(req), input.data.courseName);
    res.json({ batch });
  });

  router.put('/:id/candidates', csv, raw({ type: 'text/csv', limit: csvByteLimit, inflate: false }), async (req, res) => {
    if (!Buffer.isBuffer(req.body)) throw new HttpError(400, 'INVALID_CSV', 'Choose a UTF-8 CSV file.');
    const batch = await importCandidates(db, owner(req), batchId(req), draftVersion(req), req.body);
    res.json({ batch });
  });

  router.post('/:id/correction', json, async (req, res) => {
    const input = correctionBody.safeParse(req.body);
    if (!input.success) throw new HttpError(400, 'INVALID_CORRECTION', 'Provide the returned revision ID.');
    const batch = await startCorrection(db, owner(req), batchId(req), input.data.revisionId);
    res.status(201).json({ batch });
  });

  router.post('/:id/submit', json, async (req, res) => {
    if (!submitBody.safeParse(req.body).success) throw new HttpError(400, 'INVALID_SUBMISSION', 'Send an empty JSON object.');
    const batch = await submitBatch(db, owner(req), batchId(req), draftVersion(req));
    res.json({ batch });
  });

  return router;
}
