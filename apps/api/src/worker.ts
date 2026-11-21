import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { readWorkerConfig } from './config.js';
import { startCertification } from './certificates/dispatcher.js';
import { connectDatabase } from './db.js';
import { startEscalationScanner } from './workflow/escalation.js';

const config = readWorkerConfig();
if (!config.CERTIFICATE_LINK_SECRET) throw new Error('CERTIFICATE_LINK_SECRET is required for the worker');
const db = connectDatabase(config.DATABASE_URL);
const stopEscalation = startEscalationScanner(db, report);
const certification = startCertification(db, {
  redisUrl: config.REDIS_URL, prefix: config.CERTIFICATION_QUEUE_PREFIX,
  directory: config.CERTIFICATE_STORAGE, origin: config.APP_ORIGIN,
  linkSecret: config.CERTIFICATE_LINK_SECRET, mockMode: config.MOCK_WHATSAPP_MODE,
}, report);
const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
const queueName = 'maintenance';
const sweepJob = 'expire-sessions';

const queue = new Queue(queueName, { connection });
const worker = new Worker(queueName, async (job) => {
  if (job.name !== sweepJob) throw new Error('Unexpected maintenance job');
  const { count } = await db.session.deleteMany({ where: { expiresAt: { lte: new Date() } } });
  console.info(JSON.stringify({ event: 'sessions_swept', jobId: job.id, count }));
}, { connection });

function report(event: string, error: unknown) {
  console.error(JSON.stringify({ event, error: error instanceof Error ? error.name : 'UnknownError' }));
}

worker.on('error', (error) => report('worker_error', error));
worker.on('failed', (_job, error) => report('job_failed', error));
queue.on('error', (error) => report('queue_error', error));
connection.on('error', (error) => report('redis_error', error));

async function registerSweep() {
  await queue.upsertJobScheduler(sweepJob, { every: 15 * 60 * 1000 }, {
    name: sweepJob,
    data: {},
    opts: { attempts: 3, backoff: { type: 'exponential', delay: 2_000 }, removeOnComplete: 50, removeOnFail: 100 },
  });
  console.info(JSON.stringify({ event: 'worker_ready', queue: queueName }));
}

connection.on('ready', () => {
  void registerSweep().catch((error: unknown) => report('scheduler_registration_failed', error));
});

async function shutdown() {
  const timeout = setTimeout(() => process.exit(1), 10_000);
  timeout.unref();
  try {
    await Promise.all([certification.stop(), stopEscalation()]);
    await worker.close();
    await queue.close();
    connection.disconnect();
    await db.$disconnect();
    clearTimeout(timeout);
  } catch (error) {
    report('worker_shutdown_failed', error);
    process.exitCode = 1;
  }
}

process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
