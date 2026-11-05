import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import rateLimit from '@fastify/rate-limit';
import { timingSafeEqual } from 'node:crypto';
import { SESSION_COOKIE, SESSION_HOURS, createSession, isValidSession, verifyPassword } from './auth.ts';
import { readFile } from 'node:fs/promises';
import { registerApi } from './api.ts';
import type { Config } from './config.ts';
import { openDb } from './db.ts';
import type { Db } from './db.ts';
import { receiveEmail } from './lead/pipeline.ts';
import type { Services } from './lead/pipeline.ts';
import { loginPage } from './pages.ts';
import { notConnected, simulated } from './services.ts';
import { lastFour } from './sms.ts';
import { TWILIO_PATHS, registerTwilio } from './twilioRoutes.ts';

const PUBLIC_PATHS = new Set(['/health', '/login', ...TWILIO_PATHS]);

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; connect-src 'self'; img-src https: data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

const publicFile = (name: string) => readFile(new URL(`../public/${name}`, import.meta.url), 'utf8');

export async function buildApp(
  config: Config,
  options: { logger?: boolean; db?: Db; services?: Services } = {},
) {
  // trustProxy: the host's front door passes on each visitor's real address,
  // which the sign-in attempt limit depends on.
  const app = Fastify({ logger: options.logger ?? false, trustProxy: true });

  await app.register(cookie);
  await app.register(formbody);
  await app.register(rateLimit, { global: false });

  app.addHook('onSend', async (_request, reply) => {
    reply.headers(SECURITY_HEADERS);
  });

  // Everything is private unless it is listed in PUBLIC_PATHS, so a new
  // screen can't be exposed by forgetting to protect it.
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0] ?? '';
    if (PUBLIC_PATHS.has(path)) return;
    if (isValidSession(request.cookies[SESSION_COOKIE], config.sessionSecret)) return;
    return reply.redirect('/login');
  });

  // Public on purpose: the host and uptime monitor call this. It reveals nothing.
  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/login', async (request, reply) => {
    if (isValidSession(request.cookies[SESSION_COOKIE], config.sessionSecret)) {
      return reply.redirect('/');
    }
    return reply.type('text/html').send(loginPage());
  });

  app.post<{ Body: { email?: string; password?: string } }>(
    '/login',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const email = String(request.body?.email ?? '').trim().toLowerCase();
      const password = String(request.body?.password ?? '');
      // The password is always checked, so a wrong email takes just as long.
      const passwordOk = verifyPassword(password, config.ownerPasswordHash);
      if (!sameText(email, config.ownerEmail) || !passwordOk) {
        return reply.code(401).type('text/html').send(loginPage(true));
      }
      reply.setCookie(SESSION_COOKIE, createSession(config.sessionSecret), {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: config.production,
        maxAge: SESSION_HOURS * 60 * 60,
      });
      return reply.redirect('/', 303);
    },
  );

  app.post('/logout', async (_request, reply) => {
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.redirect('/login', 303);
  });

  const db = options.db ?? (await openDb());
  const services = options.services ?? notConnected;
  registerApi(app, db, services, !config.production, {
    twilio: config.twilio ? { connected: true, from: lastFour(config.twilio.from) } : { connected: false, from: '' },
  });
  registerTwilio(app, db, config.twilio);

  app.get('/', async (_request, reply) => reply.type('text/html').send(await publicFile('index.html')));
  app.get('/app.js', async (_request, reply) => reply.type('text/javascript').send(await publicFile('app.js')));
  app.get('/app.css', async (_request, reply) => reply.type('text/css').send(await publicFile('app.css')));

  // Only exists on your computer: runs the spec's sample through the real steps.
  if (!config.production) {
    app.post('/api/dev/sample-lead', async () => {
      let [store] = await db.query(`SELECT id FROM dealerships WHERE name = 'Earnhardt Cadillac'`);
      if (!store) {
        [store] = await db.query(
          `INSERT INTO dealerships (name, website, mailbox, crm, passthrough, sales_phone, service_phone, address, google_status)
           VALUES ('Earnhardt Cadillac', 'earnhardtcadillac.com', 'earnhardtcadillac@etarsp.com', 'Elead',
             'sales@earnhardtcadillac.edealerhub.com', '480-269-0992', '480-483-4000',
             '7901 East Frank Lloyd Wright Boulevard, Scottsdale, AZ 85260', 'ok') RETURNING id`,
        );
        await db.query(
          `INSERT INTO templates (dealership_id, reasons) VALUES ($1, $2)`,
          [store.id, 'We offer the most competitive prices around.\nComplete the entire buying process online plus free home delivery.\nComplimentary loaner vehicles\nFree concierge service\nCadillac roadside service\nFamily owned and operated since 1951'],
        );
      }
      await db.query(`UPDATE settings SET owner_test_email = 'test-inbox@example.com' WHERE owner_test_email = ''`);
      const deal = String(70000000 + Math.floor(Math.random() * 9999999));
      const id = await receiveEmail(db, simulated, store.id, {
        from: 'notify@eleadnotify.com',
        subject: `Deal IN: ${deal}  New Customer 1GYS9HK92VR133820`,
        body: '<> Earnhardt Cadillac Vehicle wanted: 2027 Cadillac Escalade Name: Alex Sample City: SAMPLE CITY Phone: (555) 555-0100 E-Mail: alex@example.com Trim: V-Series 4dr 4x4 Comments: Unlock Inquiry - Roadster Online; 2027 Cadillac Escalade-V V-Series - #C27099 - 1GYS9HK92VR133820; https://dealers.roadster.com/earnhardtcadillac/customers/12345678? utm_medium=eLead&utm_source=crm <>',
        messageId: `<${deal}@eleadnotify.com>`,
        threadId: deal,
        receivedAt: new Date(),
      });
      return { id };
    });
  }

  app.addHook('onClose', async () => {
    if (!options.db) await db.close();
  });

  return app;
}
