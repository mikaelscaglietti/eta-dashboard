import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import rateLimit from '@fastify/rate-limit';
import { timingSafeEqual } from 'node:crypto';
import { SESSION_COOKIE, SESSION_HOURS, createSession, isValidSession, verifyPassword } from './auth.ts';
import type { Config } from './config.ts';
import { homePage, loginPage } from './pages.ts';

const PUBLIC_PATHS = new Set(['/health', '/login']);

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function buildApp(config: Config, options: { logger?: boolean } = {}) {
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

  app.get('/', async (_request, reply) => reply.type('text/html').send(homePage()));

  return app;
}
