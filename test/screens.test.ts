// @vitest-environment node
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { SESSION_COOKIE, createSession, hashPassword } from '../src/auth.ts';

const secret = 's'.repeat(40);
const config = { ownerEmail: 'o@example.com', ownerPasswordHash: hashPassword('x'), sessionSecret: secret, port: 3000, production: false };

async function openDashboard() {
  const app = await buildApp(config);
  const errors: string[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push(String(e)));
  const html = readFileSync('public/index.html', 'utf8').replace(/<script.*<\/script>/, '').replace(/<link[^>]*>/g, '');
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  const w = dom.window as any;
  w.Element.prototype.scrollIntoView = () => {};
  w.fetch = async (url: string, init: any = {}) => {
    const response = await app.inject({
      url, method: init.method ?? 'GET', headers: init.headers ?? {}, payload: init.body,
      cookies: { [SESSION_COOKIE]: createSession(secret) },
    });
    return { ok: response.statusCode < 400, redirected: false, json: async () => response.json() };
  };
  w.addEventListener('error', (e: any) => errors.push(e.message));
  w.addEventListener('unhandledrejection', (e: any) => errors.push(String(e.reason)));
  w.eval(readFileSync('public/app.js', 'utf8'));
  const settle = () => new Promise((resolve) => setTimeout(resolve, 60));
  await settle();
  return { w, errors, settle, close: async () => { w.close(); await app.close(); } };
}

const go = async (s: any, hash: string) => { s.w.location.hash = hash; await s.settle(); };
const title = (s: any) => s.w.document.querySelector('#view h1')?.textContent;

describe('dashboard screens', () => {
  it('shows the menu in the order the spec asks for', async () => {
    const s = await openDashboard();
    const labels = [...s.w.document.querySelectorAll('nav a')].map((a: any) => a.textContent);
    expect(labels).toEqual(['Monitor', 'Incoming leads', 'Response log', 'Dealerships', 'Deactivated', 'Templates', 'Vehicle cache', 'Settings', 'Alerts']);
    await s.close();
  });

  it('opens every screen, empty and with a lead, without errors', async () => {
    const s = await openDashboard();
    const screens: [string, string][] = [
      ['monitor', 'Monitor'], ['leads', 'Incoming leads'], ['log', 'Response log'], ['dealerships', 'Dealerships'], ['deactivated', 'Deactivated'],
      ['dealership-new', 'Add dealership'], ['templates', 'Templates'], ['cache', 'Vehicle cache'], ['controls', 'Settings'], ['alerts', 'Alerts'],
    ];
    for (const [hash, heading] of screens) {
      await go(s, hash);
      expect(title(s)).toBe(heading);
    }

    await go(s, 'leads');
    s.w.document.querySelector('#sim').click();
    await s.settle();
    await s.settle();
    expect(s.w.document.querySelector('.count b').textContent).toBe('1');
    expect(s.w.document.querySelector('tbody').textContent).toContain('2027 Cadillac Escalade');

    for (const [hash, heading] of screens) {
      await go(s, hash);
      expect(title(s)).toBe(heading);
    }
    await go(s, 'lead-1');
    expect(title(s)).toContain('Alex');
    expect(s.w.document.querySelector('#view').textContent).toContain('Test mode: reply sent to you only');
    expect(s.w.document.querySelector('.emailframe').textContent).toContain('Hi Alex,');
    await go(s, 'dealership-1');
    expect(title(s)).toBe('Earnhardt Cadillac');

    await go(s, 'log');
    s.w.document.querySelector('[data-preview]').click();
    expect(s.w.document.querySelector('#modal').hidden).toBe(false);
    expect(s.w.document.querySelector('#pv-t').textContent).toBe('Response preview');

    expect(s.errors).toEqual([]);
    await s.close();
  });

  it('hides Deactivated under an arrow on Dealerships, and opens it on its own screen', async () => {
    const s = await openDashboard();
    const sub = () => s.w.document.querySelector('#sub-deactivated');
    const toggle = () => s.w.document.querySelector('#deacttoggle');
    expect(sub().hidden).toBe(true);
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    toggle().click();
    expect(sub().hidden).toBe(false);
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    toggle().click();
    expect(sub().hidden).toBe(true);
    await go(s, 'deactivated');
    expect(sub().hidden).toBe(false);
    expect(s.errors).toEqual([]);
    await s.close();
  });

  it('opens on the Monitor, and its numbers, filters and links work', async () => {
    const s = await openDashboard();
    expect(title(s)).toBe('Monitor');
    expect(s.w.document.querySelector('.tile b').textContent).toBe('0');
    await go(s, 'leads');
    s.w.document.querySelector('#sim').click();
    await s.settle();
    await s.settle();
    await go(s, 'monitor');
    await s.settle();
    const tiles = [...s.w.document.querySelectorAll('.tile b')].map((b: any) => b.textContent);
    expect(tiles.slice(0, 3)).toEqual(['1', '1', '0']);
    expect(s.w.document.querySelector('#view tbody').textContent).toContain('Earnhardt Cadillac');
    expect(s.w.document.querySelectorAll('.hrow')).toHaveLength(7);
    expect(s.w.document.querySelectorAll('.vcol')).toHaveLength(24);
    expect(s.w.document.querySelector('.act').textContent).toContain('Earnhardt Cadillac');

    s.w.document.querySelector('[data-range="7d"]').click();
    await s.settle();
    expect(s.w.document.querySelector('[data-range="7d"]').getAttribute('aria-pressed')).toBe('true');
    expect(s.w.document.querySelector('#view .sub').textContent).toContain('Last 7 days');

    s.w.document.querySelector('[data-range="today"]').click();
    await s.settle();
    s.w.document.querySelector('#view tbody tr').click();
    await s.settle();
    expect(title(s)).toBe('Incoming leads');
    expect(s.errors).toEqual([]);
    await s.close();
  });

  it('pauses after a confirmation and shows the banner on every screen', async () => {
    const s = await openDashboard();
    s.w.document.querySelector('#pausebtn').click();
    expect(s.w.document.querySelector('#dt').textContent).toContain('Pause sending');
    s.w.document.querySelector('#mp').click();
    await s.settle();
    for (const hash of ['leads', 'templates', 'controls']) {
      await go(s, hash);
      expect(s.w.document.querySelector('#view .banner').textContent).toContain('Sending is paused');
    }
    expect(s.w.document.querySelector('#send b').textContent).toBe('Paused');
    expect(s.errors).toEqual([]);
    await s.close();
  });

  it('puts a Connect button next to the notification mailbox', async () => {
    const s = await openDashboard();
    const button = () => s.w.document.querySelector('[data-f="mailbox"] .inl [data-google]');
    await go(s, 'dealership-new');
    expect(button().textContent).toBe('Connect');
    button().click();
    expect(s.w.document.querySelector('#gg').textContent).toContain('Google isn’t set up yet');
    await go(s, 'leads');
    s.w.document.querySelector('#sim').click();
    await s.settle();
    await s.settle();
    await go(s, 'dealership-1');
    expect(button().textContent).toBe('Reconnect');
    expect(s.errors).toEqual([]);
    await s.close();
  });

  it('adds a dealership in test mode and shows form errors', async () => {
    const s = await openDashboard();
    await go(s, 'dealership-new');
    s.w.document.querySelector('#adddealer').click();
    await s.settle();
    expect(s.w.document.querySelector('[data-f="name"] .err-msg').textContent).toContain('Enter the dealership name');
    const set = (id: string, value: string) => { s.w.document.querySelector('#' + id).value = value; };
    set('name', 'Test Store'); set('mailbox', 'a@b.co'); set('passthrough', 's@b.co');
    s.w.document.querySelector('#crm').value = 'Elead';
    s.w.document.querySelector('#adddealer').click();
    await s.settle();
    await s.settle();
    expect(title(s)).toBe('Test Store');
    await go(s, 'dealerships');
    expect(s.w.document.querySelector('tbody').textContent).toContain('Test mode');
    expect(s.errors).toEqual([]);
    await s.close();
  });
});
