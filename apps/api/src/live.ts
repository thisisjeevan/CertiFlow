import { Router, type Response } from 'express';
import { authenticate, getPrincipal, readSessionHash, type Principal } from './auth/session.js';
import { Prisma, type PrismaClient, type Role } from './generated/prisma/client.js';
import { HttpError } from './http.js';

interface Snapshot {
  tokenHash: string;
  role: Role;
  centreId: string | null;
  districtId: string | null;
  workflow: bigint;
  certificates: bigint;
  notifications: bigint;
}

const scopes = ['workflow', 'certificates', 'notifications'] as const;

interface Stream {
  tokenHash: string;
  principal: Principal;
  response: Response;
  snapshot?: Snapshot;
  lastWrite: number;
}

export function createLiveUpdates(db: PrismaClient) {
  const streams = new Set<Stream>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let polling = false;

  function send(stream: Stream, frame: string) {
    stream.lastWrite = Date.now();
    if (!stream.response.write(frame)) stream.response.end();
  }

  function schedule(delay = 1_000) {
    if (!streams.size || timer || polling) return;
    timer = setTimeout(() => {
      timer = undefined;
      void poll();
    }, delay);
    timer.unref();
  }

  async function poll() {
    if (!streams.size) return;
    polling = true;
    const pending = [...streams];
    try {
      // One read per API instance. Each stream's session and current scope are resolved in that same snapshot.
      const hashes = [...new Set(pending.map(({ tokenHash }) => tokenHash))];
      const rows = await db.$queryRaw<Snapshot[]>`
        SELECT s."tokenHash", u.role, u."centreId", u."districtId",
          COALESCE(w.version, 0) AS workflow, COALESCE(c.version, 0) AS certificates,
          COALESCE(n.version, 0) AS notifications
        FROM "Session" s JOIN "User" u ON u.id = s."userId"
        LEFT JOIN "LiveVersion" w ON w.scope = CASE u.role
          WHEN 'TRAINING_CENTRE' THEN 'workflow:centre:' || u."centreId"
          WHEN 'DISTRICT_OFFICER' THEN 'workflow:district:' || u."districtId"
          WHEN 'QUALITY_REVIEWER' THEN 'workflow:quality'
          WHEN 'STATE_OFFICER' THEN 'workflow:state'
        END
        LEFT JOIN "LiveVersion" c ON c.scope = CASE u.role
          WHEN 'TRAINING_CENTRE' THEN 'certificates:centre:' || u."centreId"
          WHEN 'STATE_OFFICER' THEN 'certificates:state'
        END
        LEFT JOIN "LiveVersion" n ON n.scope = 'notifications:' || u.id
        WHERE s."tokenHash" IN (${Prisma.join(hashes)}) AND s."expiresAt" > now() AND u.active
      `;
      const snapshots = new Map(rows.map((row) => [row.tokenHash, row]));
      for (const stream of pending) {
        if (!streams.has(stream)) continue;
        const current = snapshots.get(stream.tokenHash);
        const { role, centreId, districtId } = stream.principal;
        if (!current || current.role !== role || current.centreId !== centreId || current.districtId !== districtId) {
          stream.response.end('event: session-ended\ndata: {}\n\n');
          continue;
        }
        const previous = stream.snapshot;
        const canSeeCertificates = role === 'TRAINING_CENTRE' || role === 'STATE_OFFICER';
        const changed = scopes.filter((scope) => (scope !== 'certificates' || canSeeCertificates)
          && (!previous || previous[scope] !== current[scope]));
        stream.snapshot = current;
        if (changed.length) send(stream, 'event: sync\ndata: ' + JSON.stringify(changed) + '\n\n');
        else if (Date.now() - stream.lastWrite >= 15_000) send(stream, ': keep-alive\n\n');
      }
    } catch (error) {
      // Close on an authorization-read failure. Reconnect obtains a new snapshot after recovery.
      console.error(JSON.stringify({ event: 'live_updates_failed', error: error instanceof Error ? error.name : 'UnknownError' }));
      for (const { response } of pending) response.end();
    } finally {
      polling = false;
      schedule();
    }
  }

  return {
    routes(origin: string) {
      const router = Router();
      router.get('/', (req, _res, next) => {
        const source = req.get('Origin');
        if (source && source !== origin) throw new HttpError(403, 'FORBIDDEN_ORIGIN', 'The request origin is not allowed.');
        next();
      }, authenticate(db), (req, res) => {
        const tokenHash = readSessionHash(req);
        if (!tokenHash) throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
        const stream = { tokenHash, principal: getPrincipal(req), response: res, lastWrite: Date.now() };
        res.set({
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'private, no-store, no-transform',
          'X-Accel-Buffering': 'no',
        });
        res.on('close', () => {
          streams.delete(stream);
          if (!streams.size) {
            clearTimeout(timer);
            timer = undefined;
          }
        });
        streams.add(stream);
        send(stream, 'retry: 1500\n\n');
        schedule(0);
      });
      return router;
    },
    close() {
      clearTimeout(timer);
      timer = undefined;
      for (const { response } of streams) response.end();
      streams.clear();
    },
  };
}
