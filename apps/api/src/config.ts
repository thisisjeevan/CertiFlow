import { z } from 'zod';

const database = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(?:ql)?$/ }).refine((value) => {
    const url = URL.parse(value);
    return url !== null && url.hostname.length > 0 && url.pathname.length > 1;
  }, 'A PostgreSQL host and database name are required'),
});

const runtime = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

const origin = z.url({ protocol: /^https?$/ }).refine((value) => URL.parse(value)?.origin === value,
  'Use an HTTP origin without a trailing slash, path, or credentials');

const certificateStorage = z.object({
  CERTIFICATE_STORAGE: z.string().min(1).default('tmp/certificates'),
  CERTIFICATE_LINK_SECRET: z.string().min(32).optional(),
});

const api = database.extend(runtime.shape).extend(certificateStorage.shape).extend({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  APP_ORIGIN: origin,
  SESSION_HOURS: z.coerce.number().int().min(1).max(168).default(12),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
}).superRefine((value, context) => {
  if (value.NODE_ENV === 'production' && !value.APP_ORIGIN.startsWith('https://')) {
    context.addIssue({ code: 'custom', path: ['APP_ORIGIN'], message: 'HTTPS is required in production' });
  }
});

const worker = database.extend(certificateStorage.shape).extend({
  APP_ORIGIN: origin.default('http://localhost:8080'),
  MOCK_WHATSAPP_MODE: z.enum(['mixed', 'success', 'reject_once', 'timeout_after_acceptance', 'reject_always']).default('mixed'),
  CERTIFICATION_QUEUE_PREFIX: z.string().min(1).default('certiflow'),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }).refine((value) => Boolean(URL.parse(value)?.hostname),
    'A Redis host is required'),
});

const seed = database.extend(runtime.shape).extend({
  DEMO_PASSWORD: z.string().min(16).max(128),
}).superRefine((value, context) => {
  if (value.NODE_ENV === 'production') {
    context.addIssue({ code: 'custom', path: ['NODE_ENV'], message: 'Demo seeding is disabled in production' });
  }
});

function parse<T>(schema: z.ZodType<T>, env: NodeJS.ProcessEnv): T {
  const result = schema.safeParse(env);
  if (result.success) return result.data;

  const fields = [...new Set(result.error.issues.map(({ path }) => path.join('.')))];
  throw new Error('Invalid environment configuration: ' + fields.join(', '));
}

export type ApiConfig = z.infer<typeof api>;
export type WorkerConfig = z.infer<typeof worker>;
export const readApiConfig = (env = process.env) => parse(api, env);
export const readWorkerConfig = (env = process.env) => parse(worker, env);
export const readSeedConfig = (env = process.env) => parse(seed, env);
