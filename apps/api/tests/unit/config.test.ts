import { describe, expect, it } from 'vitest';
import { readApiConfig, readSeedConfig, readWorkerConfig } from '../../src/config.js';

const env = {
  DATABASE_URL: 'postgresql://localhost/certiflow_test',
  APP_ORIGIN: 'http://localhost:8080',
};

describe('environment configuration', () => {
  it('validates configuration and applies defaults', () => {
    expect(readApiConfig(env)).toMatchObject({ PORT: 3000, SESSION_HOURS: 12, TRUST_PROXY_HOPS: 0 });
  });

  it('reports invalid field names without leaking values', () => {
    expect(() => readApiConfig({
      ...env, DATABASE_URL: 'secret-value', PORT: '65536', TRUST_PROXY_HOPS: '25',
    })).toThrow(/^Invalid environment configuration: DATABASE_URL, PORT, TRUST_PROXY_HOPS$/);
  });

  it('rejects missing settings, noncanonical origins, and insecure production origins', () => {
    expect(() => readApiConfig({})).toThrow(/DATABASE_URL, APP_ORIGIN/);
    expect(() => readApiConfig({ ...env, DATABASE_URL: 'postgresql:/certiflow' })).toThrow(/DATABASE_URL/);
    expect(() => readApiConfig({ ...env, APP_ORIGIN: 'https://example.test/path' })).toThrow(/APP_ORIGIN/);
    expect(() => readApiConfig({ ...env, NODE_ENV: 'production' })).toThrow(/APP_ORIGIN/);
    expect(readApiConfig({ ...env, NODE_ENV: 'production', APP_ORIGIN: 'https://example.test' }).NODE_ENV)
      .toBe('production');
  });

  it('allows independent API startup and validates worker queue settings', () => {
    expect(() => readApiConfig(env)).not.toThrow();
    expect(() => readWorkerConfig({ ...env, REDIS_URL: 'http://localhost' })).toThrow(/REDIS_URL/);
    expect(() => readWorkerConfig({ ...env, REDIS_URL: 'redis:/0' })).toThrow(/REDIS_URL/);
    expect(readWorkerConfig({ ...env, REDIS_URL: 'redis://localhost:6379' }).REDIS_URL)
      .toBe('redis://localhost:6379');
  });

  it('rejects weak demo secrets and production seeding', () => {
    expect(() => readSeedConfig({ ...env, DEMO_PASSWORD: 'short' })).toThrow(/DEMO_PASSWORD/);
    expect(() => readSeedConfig({ ...env, NODE_ENV: 'production', DEMO_PASSWORD: 'x'.repeat(16) }))
      .toThrow(/NODE_ENV/);
  });
});
