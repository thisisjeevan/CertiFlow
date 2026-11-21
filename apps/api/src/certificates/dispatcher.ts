import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import { deliverCertificate } from './delivery.js';
import { expandApprovedBatch, generateCertificate } from './generation.js';
import { handledTypes, type IssuanceSettings } from './work-context.js';

const queueName = 'certification';
export const jobIdentity = (eventId: string) => 'work-' + eventId;
type Reporter = (event: string, error: unknown) => void;

interface RuntimeSettings extends IssuanceSettings {
  redisUrl: string;
  prefix: string;
  leaseMs?: number;
  pollMs?: number;
  lockDuration?: number;
  stalledInterval?: number;
}

export async function processCertificateWork(db: PrismaClient, eventId: string, settings: IssuanceSettings) {
  const event = await db.outboxEvent.findUnique({
    where: { id: eventId }, select: { type: true, completedAt: true },
  });
  if (!event || event.completedAt) return;
  switch (event.type) {
    case 'batch.approved': return expandApprovedBatch(db, eventId);
    case 'certificate.generate': return generateCertificate(db, eventId, settings);
    case 'certificate.deliver': return deliverCertificate(db, eventId, settings);
  }
}

export async function dispatchDueCertificateWork(db: PrismaClient, queue: Queue, leaseMs = 6_000) {
  const now = new Date();
  const lease = new Date(now.getTime() + leaseMs);
  const events = await db.$queryRaw<{ id: string; type: string }[]>`
    WITH due AS (
      SELECT id FROM "OutboxEvent"
      WHERE "completedAt" IS NULL AND "nextAttemptAt" <= ${now}
        AND type IN (${Prisma.join(handledTypes)})
      ORDER BY "nextAttemptAt", "createdAt", id
      LIMIT 100 FOR UPDATE SKIP LOCKED
    )
    UPDATE "OutboxEvent" AS work
    SET "nextAttemptAt" = ${lease}, attempts = attempts + 1
    FROM due WHERE work.id = due.id
    RETURNING work.id, work.type
  `;
  if (!events.length) return 0;

  try {
    await queue.addBulk(events.map((event) => ({
      name: event.type, data: { eventId: event.id },
      opts: { jobId: jobIdentity(event.id), removeOnComplete: true, removeOnFail: true },
    })));
  } catch (error) {
    await db.outboxEvent.updateMany({
      where: { id: { in: events.map(({ id }) => id) }, completedAt: null, nextAttemptAt: lease },
      data: { nextAttemptAt: new Date(Date.now() + 1_000) },
    });
    throw error;
  }
  // Only a handler transaction can complete a database event.
  return events.length;
}

export function startCertification(db: PrismaClient, settings: RuntimeSettings, report: Reporter) {
  const producer = new Redis(settings.redisUrl, { maxRetriesPerRequest: 1, enableOfflineQueue: false, commandTimeout: 2_000 });
  const consumer = new Redis(settings.redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue(queueName, { connection: producer, prefix: settings.prefix });
  const worker = new Worker<{ eventId: string }>(queueName,
    (job) => processCertificateWork(db, job.data.eventId, settings), {
      connection: consumer, prefix: settings.prefix, concurrency: 3,
      lockDuration: settings.lockDuration ?? 15_000, stalledInterval: settings.stalledInterval ?? 5_000,
    });
  producer.on('error', (error) => report('certificate_redis_producer_error', error));
  consumer.on('error', (error) => report('certificate_redis_consumer_error', error));
  queue.on('error', (error) => report('certificate_queue_error', error));
  worker.on('error', (error) => report('certificate_worker_error', error));
  worker.on('failed', (job, error) => report('certificate_job_failed:' + (job?.id ?? 'unknown'), error));

  let pending: Promise<void> | undefined;
  const poll = () => {
    if (producer.status !== 'ready' || pending) return;
    pending = dispatchDueCertificateWork(db, queue, settings.leaseMs)
      .then(() => undefined)
      .catch((error: unknown) => report('certificate_outbox_dispatch_failed', error))
      .finally(() => { pending = undefined; });
  };
  const timer = setInterval(poll, settings.pollMs ?? 500);

  return {
    worker, queue,
    async stop(force = false) {
      clearInterval(timer);
      await pending;
      await worker.close(force);
      await queue.close();
      producer.disconnect();
      consumer.disconnect();
    },
  };
}
