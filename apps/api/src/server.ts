import { createApp } from './app.js';
import { readApiConfig } from './config.js';
import { connectDatabase } from './db.js';
import { createLiveUpdates } from './live.js';

const config = readApiConfig();
const db = connectDatabase(config.DATABASE_URL);
const live = createLiveUpdates(db);
const server = createApp(config, db, live).listen(config.PORT, '0.0.0.0', () => {
  console.info(JSON.stringify({ event: 'api_listening', port: config.PORT }));
});

function shutdown() {
  const timeout = setTimeout(() => process.exit(1), 10_000);
  timeout.unref();
  server.close((error) => {
    void db.$disconnect().then(() => {
      clearTimeout(timeout);
      process.exitCode = error ? 1 : 0;
    }, () => { process.exitCode = 1; });
  });
  live.close();
}

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
