import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';

const config = loadConfig(process.env);
const app = await buildApp(config, { logger: true });

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => void app.close().then(() => process.exit(0)));
}

await app.listen({ host: '0.0.0.0', port: config.port });
