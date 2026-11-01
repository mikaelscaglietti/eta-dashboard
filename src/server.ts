import { mkdirSync } from 'node:fs';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { recoverInterrupted, resumeLeads } from './lead/pipeline.ts';
import { notConnected } from './services.ts';

const config = loadConfig(process.env);
if (!process.env.DATABASE_URL) mkdirSync('.data', { recursive: true });
const db = await openDb(process.env.DATABASE_URL, '.data/local');
const app = await buildApp(config, { logger: true, db, services: notConnected });

// Finishes anything a restart interrupted, then keeps checking for queued leads.
const pass = () => resumeLeads(db, notConnected).catch((error) => app.log.error(error));
await recoverInterrupted(db);
await pass();
const timer = setInterval(pass, 5000);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    clearInterval(timer);
    void app.close().then(() => db.close()).then(() => process.exit(0));
  });
}

await app.listen({ host: '0.0.0.0', port: config.port });
