import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

export function connectDatabase(databaseUrl: string) {
  const adapter = new PrismaPg({
    connectionString: databaseUrl,
    max: 5,
    connectionTimeoutMillis: 3_000,
    statement_timeout: 5_000,
    query_timeout: 7_000,
  });
  return new PrismaClient({ adapter });
}
