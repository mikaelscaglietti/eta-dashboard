import { mkdirSync } from 'node:fs';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { recoverInterrupted, resumeLeads } from './lead/pipeline.ts';
import type { Services } from './lead/pipeline.ts';
import { notConnected } from './services.ts';
import { twilioSender } from './sms.ts';
import { anthropicAgent, anthropicGreeting } from './claude.ts';
import type { ConversationServices } from './conversations.ts';

const config = loadConfig(process.env);
if (!process.env.DATABASE_URL) mkdirSync('.data', { recursive: true });
const db = await openDb(process.env.DATABASE_URL, '.data/local');

// Each outside service is switched on only once its settings are filled in.
const services: ConversationServices = {
  ...notConnected,
  ...(config.twilio ? { sendText: twilioSender(config.twilio) } : {}),
  ...(config.anthropicKey ? { writeGreeting: anthropicGreeting(config.anthropicKey), answerCustomer: anthropicAgent(config.anthropicKey) } : {}),
};
const app = await buildApp(config, { logger: true, db, services });

// Finishes anything a restart interrupted, then keeps checking for queued leads.
const pass = () => resumeLeads(db, services).catch((error) => app.log.error(error));
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
