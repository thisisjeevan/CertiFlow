import { createHash, randomBytes } from 'node:crypto';
import type { PrismaClient, Role } from '../generated/prisma/client.js';
import type { Request, RequestHandler } from 'express';
import { HttpError } from '../http.js';

export const sessionCookie = 'certiflow_session';

export const principalFields = {
  id: true,
  email: true,
  displayName: true,
  role: true,
  centreId: true,
  districtId: true,
} as const;

export interface Principal {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  centreId: string | null;
  districtId: string | null;
}

declare module 'express-serve-static-core' {
  interface Request {
    principal?: Principal;
  }
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

export function readSessionHash(req: Request) {
  const values = (req.headers.cookie ?? '').split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith(sessionCookie + '='));
  if (values.length !== 1) return undefined;

  const token = values[0]?.slice(sessionCookie.length + 1);
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? hashToken(token) : undefined;
}

export async function createSession(db: PrismaClient, userId: string, lifetimeMs: number, previousHash?: string) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + lifetimeMs);
  await db.$transaction(async (tx) => {
    if (previousHash) await tx.session.deleteMany({ where: { tokenHash: previousHash } });
    await tx.session.create({ data: { tokenHash: hashToken(token), userId, expiresAt } });
  });
  return token;
}

export function authenticate(db: PrismaClient): RequestHandler {
  return async (req, _res, next) => {
    const tokenHash = readSessionHash(req);
    if (!tokenHash) throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in to continue.');

    const session = await db.session.findFirst({
      where: { tokenHash, expiresAt: { gt: new Date() }, user: { active: true } },
      select: { user: { select: principalFields } },
    });
    if (!session) throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in to continue.');

    req.principal = session.user;
    next();
  };
}

export function getPrincipal(req: Request): Principal {
  if (!req.principal) throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
  return req.principal;
}
