import { connectDatabase } from '../../src/db.js';

export function testDatabase() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url || !URL.canParse(url) || !/^\/[^/]*_test$/.test(new URL(url).pathname)) {
    throw new Error('Set TEST_DATABASE_URL to a dedicated PostgreSQL database ending in _test.');
  }
  return connectDatabase(url);
}
