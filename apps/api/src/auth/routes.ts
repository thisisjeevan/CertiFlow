import type { PrismaClient } from '../generated/prisma/client.js';
import { Router, type CookieOptions } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import type { ApiConfig } from '../config.js';
import { HttpError, requireSameOriginType } from '../http.js';
import { verifyPassword } from './password.js';
import {
  authenticate, createSession, getPrincipal, principalFields, readSessionHash, sessionCookie,
} from './session.js';

const loginBody = z.strictObject({
  email: z.string().trim().toLowerCase().max(254).pipe(z.email()),
  password: z.string().min(1).max(128),
});

export function authRoutes(db: PrismaClient, config: ApiConfig) {
  const router = Router();
  const cookie: CookieOptions = {
    httpOnly: true,
    secure: config.NODE_ENV === 'production' || config.APP_ORIGIN.startsWith('https://'),
    sameSite: 'lax',
    path: '/',
  };
  const lifetimeMs = config.SESSION_HOURS * 60 * 60 * 1000;
  const sameOriginJson = requireSameOriginType(config.APP_ORIGIN, 'application/json');

  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  router.post('/login', sameOriginJson, rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, _res, next) => next(new HttpError(429, 'LOGIN_RATE_LIMIT', 'Try signing in again later.')),
  }), async (req, res) => {
    const body = loginBody.safeParse(req.body);
    if (!body.success) throw new HttpError(400, 'INVALID_LOGIN', 'Enter a valid email address and password.');

    const user = await db.user.findUnique({
      where: { email: body.data.email },
      select: { ...principalFields, passwordHash: true, active: true },
    });
    const correct = await verifyPassword(body.data.password, user?.passwordHash);
    if (!user?.active || !correct) {
      throw new HttpError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
    }

    const token = await createSession(db, user.id, lifetimeMs, readSessionHash(req));
    const { id, email, displayName, role, centreId, districtId } = user;
    res.cookie(sessionCookie, token, { ...cookie, maxAge: lifetimeMs });
    res.json({ user: { id, email, displayName, role, centreId, districtId } });
  });

  router.get('/me', authenticate(db), (req, res) => {
    res.json({ user: getPrincipal(req) });
  });

  router.post('/logout', sameOriginJson, async (req, res) => {
    const tokenHash = readSessionHash(req);
    if (tokenHash) await db.session.deleteMany({ where: { tokenHash } });
    res.clearCookie(sessionCookie, cookie).status(204).end();
  });

  return router;
}
