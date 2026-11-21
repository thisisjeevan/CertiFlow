import { Router } from 'express';
import { z } from 'zod';
import { authenticate, getPrincipal } from '../auth/session.js';
import type { ApiConfig } from '../config.js';
import { DecisionOutcome, ReviewStage, type PrismaClient } from '../generated/prisma/client.js';
import { HttpError, requireSameOriginType } from '../http.js';
import { recordDecision } from './decisions.js';
import { reviewBatch, reviewQueue, reviewTimeline } from './read.js';

const decisionBody = z.strictObject({
  stage: z.enum(ReviewStage),
  outcome: z.enum(DecisionOutcome),
  reason: z.string().trim().max(500).refine((value) => !value.includes('\0')).optional(),
});

function reviewId(value: unknown) {
  const match = z.uuid().safeParse(value);
  if (!match.success) throw new HttpError(400, 'INVALID_REVIEW_ID', 'Use a valid batch and revision ID.');
  return match.data.toLowerCase();
}

export function reviewRoutes(db: PrismaClient, config: ApiConfig) {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  }, authenticate(db));

  router.get('/', async (req, res) => {
    res.json({ queue: await reviewQueue(db, getPrincipal(req)) });
  });
  router.get('/:batchId/timeline', async (req, res) => {
    res.json(await reviewTimeline(db, getPrincipal(req), reviewId(req.params.batchId)));
  });
  router.get('/:batchId', async (req, res) => {
    res.json({ batch: await reviewBatch(db, getPrincipal(req), reviewId(req.params.batchId)) });
  });
  router.post('/:batchId/revisions/:revisionId/decisions', requireSameOriginType(config.APP_ORIGIN, 'application/json'),
    async (req, res) => {
      const input = decisionBody.safeParse(req.body);
      if (!input.success) throw new HttpError(400, 'INVALID_DECISION', 'Choose a review stage and decision. Keep the reason within 500 characters.');
      if (input.data.outcome !== 'APPROVE' && !input.data.reason) {
        throw new HttpError(400, 'REASON_REQUIRED', 'Enter a reason to return or reject this revision.');
      }
      const result = await recordDecision(db, getPrincipal(req), reviewId(req.params.batchId), reviewId(req.params.revisionId), input.data);
      res.status(201).json(result);
    });
  return router;
}

export function notificationRoutes(db: PrismaClient, config: ApiConfig) {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  }, authenticate(db));

  router.get('/', async (req, res) => {
    const entries = await db.notification.findMany({
      where: { userId: getPrincipal(req).id },
      orderBy: { id: 'desc' },
      take: 50,
      select: { id: true, type: true, resourceId: true, createdAt: true, readAt: true },
    });
    res.json({ notifications: entries.map(({ id, ...entry }) => ({ ...entry, id: id.toString() })) });
  });

  router.patch('/:id/read', requireSameOriginType(config.APP_ORIGIN, 'application/json'), async (req, res) => {
    const id = req.params.id;
    if (typeof id !== 'string' || !/^[1-9]\d{0,18}$/.test(id) || BigInt(id) > 9_223_372_036_854_775_807n) {
      throw new HttpError(404, 'NOTIFICATION_NOT_FOUND', 'This notification is unavailable.');
    }
    const where = { id: BigInt(id), userId: getPrincipal(req).id };
    const updated = await db.notification.updateMany({ where: { ...where, readAt: null }, data: { readAt: new Date() } });
    if (!updated.count && !await db.notification.findFirst({ where, select: { id: true } })) {
      throw new HttpError(404, 'NOTIFICATION_NOT_FOUND', 'This notification is unavailable.');
    }
    res.status(204).end();
  });
  return router;
}
