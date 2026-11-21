import type { OutboxEvent, Prisma } from '../generated/prisma/client.js';

export type MockMode = 'mixed' | 'success' | 'reject_once' | 'timeout_after_acceptance' | 'reject_always';

export interface IssuanceSettings {
  origin: string;
  directory: string;
  linkSecret: string;
  mockMode: MockMode;
  retryBaseMs?: number;
  linkTtlMs?: number;
}

export const handledTypes = ['batch.approved', 'certificate.generate', 'certificate.deliver'] as const;
export type WorkType = (typeof handledTypes)[number];

export async function lockWork(tx: Prisma.TransactionClient, id: string, type: WorkType) {
  const [event] = await tx.$queryRaw<OutboxEvent[]>`
    SELECT * FROM "OutboxEvent" WHERE id = ${id}::uuid AND "completedAt" IS NULL AND type = ${type} FOR UPDATE
  `;
  return event;
}

export async function lockCertificate(tx: Prisma.TransactionClient, id: string) {
  const [row] = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Certificate" WHERE id = ${id}::uuid FOR UPDATE`;
  if (!row) throw new Error('Missing certificate for work event');
}

export function finishWork(tx: Prisma.TransactionClient, id: string, completedAt = new Date()) {
  return tx.outboxEvent.update({ where: { id }, data: { completedAt } });
}

export function retryTime(settings: IssuanceSettings, attempts: number, now: Date) {
  const backoff = Math.min(60_000, (settings.retryBaseMs ?? 1_000) * 2 ** Math.max(0, attempts - 1));
  return new Date(now.getTime() + backoff);
}
