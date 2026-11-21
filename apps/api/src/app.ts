import type { PrismaClient } from './generated/prisma/client.js';
import express from 'express';
import helmet from 'helmet';
import { authRoutes } from './auth/routes.js';
import { batchRoutes } from './batches/routes.js';
import { centreRoutes } from './centres/routes.js';
import type { ApiConfig } from './config.js';
import { handleError, notFound, requestId } from './http.js';

export function createApp(config: ApiConfig, db: PrismaClient) {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', config.TRUST_PROXY_HOPS);
  app.use(requestId);
  app.use(helmet(config.NODE_ENV === 'production' ? {} : { strictTransportSecurity: false }));
  app.use(express.json({ limit: '8kb' }));

  app.get('/health/live', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ status: 'live' });
  });

  app.get('/health/ready', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      await db.$queryRaw`SELECT 1 FROM "Session" LIMIT 1`;
      res.json({ status: 'ready', database: 'up' });
    } catch {
      res.status(503).json({ status: 'unavailable', database: 'down' });
    }
  });

  app.use('/api/auth', authRoutes(db, config));
  app.use('/api/centres', centreRoutes(db));
  app.use('/api/batches', batchRoutes(db, config));
  app.use(notFound);
  app.use(handleError);

  return app;
}
