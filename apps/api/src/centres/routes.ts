import type { PrismaClient } from '../generated/prisma/client.js';
import { Router } from 'express';
import { z } from 'zod';
import { centreScope } from '../auth/policy.js';
import { authenticate, getPrincipal } from '../auth/session.js';
import { HttpError } from '../http.js';

const centreFields = {
  id: true,
  code: true,
  name: true,
  district: { select: { id: true, name: true } },
} as const;

export function centreRoutes(db: PrismaClient) {
  const router = Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  }, authenticate(db));

  router.get('/', async (req, res) => {
    const centres = await db.trainingCentre.findMany({
      where: centreScope(getPrincipal(req)),
      orderBy: { code: 'asc' },
      select: centreFields,
    });
    res.json({ centres });
  });

  router.get('/:id', async (req, res) => {
    const id = z.uuid().safeParse(req.params.id);
    if (!id.success) throw new HttpError(404, 'CENTRE_NOT_FOUND', 'Training centre not found.');

    const centre = await db.trainingCentre.findFirst({
      where: { AND: [centreScope(getPrincipal(req)), { id: id.data }] },
      select: centreFields,
    });

    if (!centre) throw new HttpError(404, 'CENTRE_NOT_FOUND', 'Training centre not found.');
    res.json({ centre });
  });

  return router;
}
