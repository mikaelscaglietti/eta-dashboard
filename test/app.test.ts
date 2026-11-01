import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { SESSION_COOKIE, SESSION_HOURS, createSession, hashPassword, isValidSession, verifyPassword } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import type { Config } from '../src/config.ts';

const PASSWORD = 'test-only-password';
const SECRET = 'x'.repeat(40);

const config: Config = {
  ownerEmail: 'owner@example.com',
  ownerPasswordHash: hashPassword(PASSWORD),
  sessionSecret: SECRET,
  port: 3000,
  production: true,
};

function signIn(app: Awaited<ReturnType<typeof buildApp>>, email: string, password: string) {
  return app.inject({
    method: 'POST',
    url: '/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ email, password }).toString(),
  });
}

describe('health check', () => {
  it('answers without a login and reveals nothing else', async () => {
    const app = await buildApp(config);
    const response = await app.inject({ url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });
});

describe('dashboard login', () => {
  it('sends visitors who are not signed in to the login page', async () => {
    const app = await buildApp(config);
    for (const url of ['/', '/leads', '/anything/else']) {
      const response = await app.inject({ url });
      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe('/login');
    }
  });

  it('rejects a wrong password and a wrong email the same way', async () => {
    const app = await buildApp(config);
    const wrongPassword = await signIn(app, config.ownerEmail, 'not-the-password');
    const wrongEmail = await signIn(app, 'someone@example.com', PASSWORD);
    expect(wrongPassword.statusCode).toBe(401);
    expect(wrongEmail.statusCode).toBe(401);
    expect(wrongPassword.body).toBe(wrongEmail.body);
    expect(wrongPassword.headers['set-cookie']).toBeUndefined();
  });

  it('lets the owner in with a secure cookie', async () => {
    const app = await buildApp(config);
    const response = await signIn(app, 'OWNER@example.com', PASSWORD);
    expect(response.statusCode).toBe(303);
    const cookie = String(response.headers['set-cookie']);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');

    const value = response.cookies[0]?.value ?? '';
    const home = await app.inject({ url: '/', cookies: { [SESSION_COOKIE]: value } });
    expect(home.statusCode).toBe(200);
    expect(home.body).toContain('ETA DASHBOARD');
  });

  it('refuses forged and expired sessions', async () => {
    const app = await buildApp(config);
    const forged = createSession('y'.repeat(40));
    const response = await app.inject({ url: '/', cookies: { [SESSION_COOKIE]: forged } });
    expect(response.statusCode).toBe(302);

    const issued = Date.now();
    const token = createSession(SECRET, issued);
    const justBefore = issued + SESSION_HOURS * 60 * 60 * 1000 - 1;
    expect(isValidSession(token, SECRET, justBefore)).toBe(true);
    expect(isValidSession(token, SECRET, justBefore + 2)).toBe(false);
  });

  it('refuses a session whose expiry was changed', () => {
    const [, signature] = createSession(SECRET).split('.');
    expect(isValidSession(`9999999999999.${signature}`, SECRET)).toBe(false);
  });

  it('signs out', async () => {
    const app = await buildApp(config);
    const response = await app.inject({
      method: 'POST',
      url: '/logout',
      cookies: { [SESSION_COOKIE]: createSession(SECRET) },
    });
    expect(response.headers.location).toBe('/login');
    expect(response.cookies[0]?.value).toBe('');
  });

  it('blocks repeated guessing', async () => {
    const app = await buildApp(config);
    for (let i = 0; i < 5; i++) await signIn(app, config.ownerEmail, 'wrong');
    const response = await signIn(app, config.ownerEmail, PASSWORD);
    expect(response.statusCode).toBe(429);
  });
});

describe('passwords', () => {
  it('never stores the password itself', () => {
    const stored = hashPassword(PASSWORD);
    expect(stored).not.toContain(PASSWORD);
    expect(verifyPassword(PASSWORD, stored)).toBe(true);
    expect(verifyPassword('wrong', stored)).toBe(false);
    expect(verifyPassword(PASSWORD, 'not-a-real-hash')).toBe(false);
  });
});

describe('settings and secrets', () => {
  const good = { OWNER_EMAIL: 'a@b.co', OWNER_PASSWORD_HASH: 'salt.hash', SESSION_SECRET: SECRET };

  it('refuses to start with a missing or weak setting', () => {
    expect(() => loadConfig({ ...good, OWNER_EMAIL: '' })).toThrow('OWNER_EMAIL');
    expect(() => loadConfig({ ...good, OWNER_PASSWORD_HASH: undefined })).toThrow('OWNER_PASSWORD_HASH');
    expect(() => loadConfig({ ...good, SESSION_SECRET: 'short' })).toThrow('SESSION_SECRET');
  });

  it('keeps .env out of git', () => {
    const output = execFileSync('git', ['check-ignore', '.env']).toString().trim();
    expect(output).toBe('.env');
  });
});
