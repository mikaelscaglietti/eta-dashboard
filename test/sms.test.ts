import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { SESSION_COOKIE, createSession, hashPassword } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';
import type { Config } from '../src/config.ts';
import { openDb } from '../src/db.ts';
import type { Db } from '../src/db.ts';
import { ELEAD_SENDER } from '../src/lead/parseElead.ts';
import { receiveEmail } from '../src/lead/pipeline.ts';
import type { Services } from '../src/lead/pipeline.ts';
import { MAX_TEXT_LENGTH, staffText } from '../src/lead/staffText.ts';
import { isGenuineTwilioRequest, normalizePhone, optKeyword, twilioSender, twilioSignature } from '../src/sms.ts';
import type { TwilioSettings } from '../src/sms.ts';

// Made-up values in Twilio's shapes. Nothing here is a real account.
const TWILIO: TwilioSettings = {
  accountSid: 'AC' + '0'.repeat(32),
  authToken: 'test-auth-token',
  from: '+14805550199',
  publicUrl: 'https://app.example.com',
};

const config: Config = {
  ownerEmail: 'owner@example.com',
  ownerPasswordHash: hashPassword('test-only-password'),
  sessionSecret: 'x'.repeat(40),
  port: 3000,
  production: true,
  twilio: TWILIO,
};

describe('phone numbers', () => {
  it('turns common ways of typing a US number into one format', () => {
    for (const typed of ['480-555-0100', '(480) 555-0100', '480.555.0100', '4805550100', '1 480 555 0100', '+1 (480) 555-0100']) {
      expect(normalizePhone(typed)).toBe('+14805550100');
    }
  });

  it('rejects things that are not phone numbers', () => {
    for (const typed of ['', 'call me', '555-0100', '12345', '+12']) expect(normalizePhone(typed)).toBe('');
  });
});

describe('STOP and START words', () => {
  it('recognises the standard words in any case or with punctuation', () => {
    for (const word of ['STOP', 'stop', ' Stop. ', 'unsubscribe', 'Cancel', 'END', 'quit', 'STOPALL']) expect(optKeyword(word)).toBe('stop');
    for (const word of ['START', 'start', 'Yes', 'unstop']) expect(optKeyword(word)).toBe('start');
  });

  it('ignores ordinary replies', () => {
    for (const word of ['Thanks', 'stop texting me please', 'Is it still available?', '']) expect(optKeyword(word)).toBeNull();
  });
});

describe('Twilio signature check', () => {
  const url = 'https://app.example.com/twilio/sms';
  const params = { From: '+14805550100', Body: 'STOP', MessageSid: 'SM1' };

  it('accepts a request Twilio signed', () => {
    expect(isGenuineTwilioRequest(TWILIO.authToken, url, params, twilioSignature(TWILIO.authToken, url, params))).toBe(true);
  });

  it('refuses a missing, forged or altered signature', () => {
    const signature = twilioSignature(TWILIO.authToken, url, params);
    expect(isGenuineTwilioRequest(TWILIO.authToken, url, params, undefined)).toBe(false);
    expect(isGenuineTwilioRequest(TWILIO.authToken, url, params, twilioSignature('wrong-token', url, params))).toBe(false);
    expect(isGenuineTwilioRequest(TWILIO.authToken, url, { ...params, From: '+19995550000' }, signature)).toBe(false);
    expect(isGenuineTwilioRequest(TWILIO.authToken, 'https://evil.example.com/twilio/sms', params, signature)).toBe(false);
  });
});

describe('sending a text through Twilio', () => {
  it('sends the number, message and delivery-update address, and returns the message ID', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ sid: 'SM123' }), { status: 201 });
    }) as unknown as typeof fetch;
    const sid = await twilioSender(TWILIO, fakeFetch)('+14805550100', 'New lead: Alex');
    expect(sid).toBe('SM123');
    expect(calls[0]!.url).toBe(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO.accountSid}/Messages.json`);
    const form = new URLSearchParams(String(calls[0]!.init.body));
    expect(form.get('To')).toBe('+14805550100');
    expect(form.get('From')).toBe(TWILIO.from);
    expect(form.get('Body')).toBe('New lead: Alex');
    expect(form.get('StatusCallback')).toBe('https://app.example.com/twilio/status');
    const auth = (calls[0]!.init.headers as Record<string, string>).authorization;
    expect(auth).toBe('Basic ' + Buffer.from(`${TWILIO.accountSid}:${TWILIO.authToken}`).toString('base64'));
  });

  it('uses a Messaging Service when one is given', async () => {
    let form = new URLSearchParams();
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      form = new URLSearchParams(String(init.body));
      return new Response(JSON.stringify({ sid: 'SM1' }), { status: 201 });
    }) as unknown as typeof fetch;
    await twilioSender({ ...TWILIO, from: 'MG' + 'a'.repeat(32) }, fakeFetch)('+14805550100', 'Hi');
    expect(form.get('MessagingServiceSid')).toBe('MG' + 'a'.repeat(32));
    expect(form.get('From')).toBeNull();
  });

  it('reports Twilio’s reason when it refuses', async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ message: 'Attempt to send to unsubscribed recipient' }), { status: 400 })) as unknown as typeof fetch;
    await expect(twilioSender(TWILIO, fakeFetch)('+14805550100', 'Hi')).rejects.toThrow('unsubscribed recipient');
  });
});

describe('Twilio settings', () => {
  const base = { OWNER_EMAIL: 'o@example.com', OWNER_PASSWORD_HASH: 'h', SESSION_SECRET: 'x'.repeat(40) };

  it('leaves texting off when nothing is filled in', () => {
    expect(loadConfig(base).twilio).toBeUndefined();
  });

  it('refuses to start when only some settings are filled in', () => {
    expect(() => loadConfig({ ...base, TWILIO_ACCOUNT_SID: TWILIO.accountSid })).toThrow('partly set up');
  });

  it('reads complete settings', () => {
    const loaded = loadConfig({ ...base, TWILIO_ACCOUNT_SID: TWILIO.accountSid, TWILIO_AUTH_TOKEN: 't', TWILIO_FROM: '+14805550199', PUBLIC_URL: 'https://app.example.com/' });
    expect(loaded.twilio).toEqual({ accountSid: TWILIO.accountSid, authToken: 't', from: '+14805550199', publicUrl: 'https://app.example.com' });
  });
});

describe('Twilio webhooks', () => {
  let db: Db;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let storeId: number;

  beforeEach(async () => {
    db = await openDb();
    app = await buildApp(config, { db });
    const [store] = await db.query(
      `INSERT INTO dealerships (name, mailbox, passthrough, crm, staff_phones, test_mode, google_status)
       VALUES ('Earnhardt Cadillac', 'store@etarsp.com', 'sales@store.example.com', 'Elead', '["+14805550100"]', FALSE, 'ok') RETURNING id`,
    );
    storeId = store.id;
  });

  const post = (path: string, params: Record<string, string>, signature = twilioSignature(TWILIO.authToken, TWILIO.publicUrl + path, params)) =>
    app.inject({
      method: 'POST',
      url: path,
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': signature },
      payload: new URLSearchParams(params).toString(),
    });

  it('refuses requests without Twilio’s signature, and changes nothing', async () => {
    const response = await post('/twilio/sms', { From: '+14805550100', Body: 'STOP' }, 'forged');
    expect(response.statusCode).toBe(403);
    expect(await db.query('SELECT * FROM opt_outs')).toHaveLength(0);
  });

  it('STOP opts the number out and warns you when it is a staff number', async () => {
    const response = await post('/twilio/sms', { From: '+14805550100', Body: 'Stop' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/xml');
    expect((await db.query('SELECT phone FROM opt_outs')).map((r) => r.phone)).toEqual(['+14805550100']);
    const alerts = await db.query('SELECT title FROM alerts');
    expect(alerts.map((a) => a.title)).toEqual(['Staff number opted out: Earnhardt Cadillac']);
  });

  it('START turns texts back on', async () => {
    await db.query(`INSERT INTO opt_outs (phone) VALUES ('+14805550100')`);
    await post('/twilio/sms', { From: '+14805550100', Body: 'START' });
    expect(await db.query('SELECT * FROM opt_outs')).toHaveLength(0);
  });

  it('ignores ordinary replies', async () => {
    await post('/twilio/sms', { From: '+14805550100', Body: 'Thanks, on it' });
    expect(await db.query('SELECT * FROM opt_outs')).toHaveLength(0);
  });

  it('records delivery updates and never moves a text backwards', async () => {
    const [lead] = await db.query(
      `INSERT INTO leads (received_at, dealership_id, subject, message_id) VALUES (now(), $1, 's', 'm') RETURNING id`, [storeId]);
    await db.query(`INSERT INTO text_messages (lead_id, recipient, audience, body, status, twilio_sid) VALUES ($1, '+14805550100', 'staff', 'Hi', 'sent', 'SM9')`, [lead.id]);
    expect((await post('/twilio/status', { MessageSid: 'SM9', MessageStatus: 'delivered' })).statusCode).toBe(204);
    await post('/twilio/status', { MessageSid: 'SM9', MessageStatus: 'sent' });
    expect((await db.query('SELECT status FROM text_messages'))[0].status).toBe('delivered');
  });

  it('a failed delivery raises an alert, and an unsubscribed number is opted out', async () => {
    const [lead] = await db.query(
      `INSERT INTO leads (received_at, dealership_id, subject, message_id) VALUES (now(), $1, 's', 'm') RETURNING id`, [storeId]);
    await db.query(`INSERT INTO text_messages (lead_id, recipient, audience, body, status, twilio_sid) VALUES ($1, '+14805550100', 'staff', 'Hi', 'sent', 'SM7')`, [lead.id]);
    await post('/twilio/status', { MessageSid: 'SM7', MessageStatus: 'undelivered', ErrorCode: '21610' });
    const [text] = await db.query('SELECT status, failure FROM text_messages');
    expect(text).toEqual({ status: 'undelivered', failure: 'Twilio error 21610' });
    expect(await db.query('SELECT * FROM opt_outs')).toHaveLength(1);
    expect((await db.query('SELECT title FROM alerts')).map((a) => a.title)).toContain('A lead text was not delivered');
  });

  it('the addresses do not exist until Twilio is set up', async () => {
    const plain = await buildApp({ ...config, twilio: undefined }, { db });
    expect((await plain.inject({ method: 'POST', url: '/twilio/sms', payload: {} })).statusCode).toBe(404);
  });
});

describe('lead texts', () => {
  let db: Db;
  let storeId: number;
  const BODY = '<> Earnhardt Cadillac Vehicle wanted: 2027 Cadillac Escalade Name: Alex Sample City: SAMPLE CITY Phone: (555) 555-0100 E-Mail: alex@example.com Trim: V-Series 4dr 4x4 Comments: Unlock Inquiry - Roadster Online; 2027 Cadillac Escalade-V V-Series - #C27099 - 1GYS9HK92VR133820; https://dealers.roadster.com/x <>';

  beforeEach(async () => {
    db = await openDb();
    const [store] = await db.query(
      `INSERT INTO dealerships (name, mailbox, passthrough, crm, staff_phones, test_mode, google_status)
       VALUES ('Earnhardt Cadillac', 'store@etarsp.com', 'sales@store.example.com', 'Elead', '["480-555-0100", "(480) 555-0101"]', FALSE, 'ok') RETURNING id`,
    );
    storeId = store.id;
    await db.query(`INSERT INTO templates (dealership_id) VALUES ($1)`, [storeId]);
  });

  function services(over: Partial<Services> = {}) {
    const sent: string[] = [];
    const all: Services = {
      sendEmail: async () => {},
      wasSent: async () => false,
      sendText: async (to) => { sent.push(to); return `SM-${to}`; },
      findPhotos: async () => ({ photos: [], pageUrl: '' }),
      writeGreeting: async () => '',
      ...over,
    };
    return { sent, all };
  }

  const lead = () => ({ from: ELEAD_SENDER, subject: 'Deal IN: 111  New Customer 1GYS9HK92VR133820', body: BODY, messageId: '<a@b>', threadId: 't', receivedAt: new Date() });

  it('texts staff in Twilio’s format and keeps the message ID for delivery updates', async () => {
    const { sent, all } = services();
    await receiveEmail(db, all, storeId, lead());
    expect(sent).toEqual(['+14805550100', '+14805550101']);
    expect((await db.query('SELECT twilio_sid FROM text_messages ORDER BY id')).map((r) => r.twilio_sid)).toEqual(['SM-+14805550100', 'SM-+14805550101']);
  });

  it('skips an opted-out number even if it was typed differently, and logs why', async () => {
    await db.query(`INSERT INTO opt_outs (phone) VALUES ('+14805550100')`);
    const { sent, all } = services();
    await receiveEmail(db, all, storeId, lead());
    expect(sent).toEqual(['+14805550101']);
    expect((await db.query('SELECT status FROM text_messages ORDER BY id')).map((r) => r.status)).toEqual(['opted out', 'sent']);
  });

  it('a failed text is recorded with the reason and raises an alert, and the reply still counts', async () => {
    const { all } = services({ sendText: async () => { throw new Error('Twilio refused the text: invalid number'); } });
    await receiveEmail(db, all, storeId, lead());
    const texts = await db.query('SELECT status, failure FROM text_messages');
    expect(texts[0]).toEqual({ status: 'failed', failure: 'Twilio refused the text: invalid number' });
    expect((await db.query('SELECT title FROM alerts')).map((a) => a.title)).toContain('Text failed: Earnhardt Cadillac');
    expect((await db.query('SELECT status FROM responses'))[0].status).toBe('replied');
  });
});

describe('saving staff numbers', () => {
  it('rejects a mistyped number and saves good ones in one format', async () => {
    const db = await openDb();
    const app = await buildApp(config, { db });
    const cookies = { [SESSION_COOKIE]: createSession(config.sessionSecret) };
    const store = { name: 'Test Store', mailbox: 'test@etarsp.com', crm: 'Elead', passthrough: 'sales@test.example.com' };
    const bad = await app.inject({ method: 'POST', url: '/api/dealerships', cookies, payload: { ...store, staff: ['480-555-0100', '555-01'] } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().errors.staff).toContain('555-01');
    const good = await app.inject({ method: 'POST', url: '/api/dealerships', cookies, payload: { ...store, staff: ['480-555-0100', '(480) 555-0100', '480.555.0101'] } });
    expect(good.statusCode).toBe(200);
    expect((await db.query('SELECT staff_phones FROM dealerships'))[0].staff_phones).toEqual(['+14805550100', '+14805550101']);
  });
});

describe('staff text format', () => {
  const lead = {
    first_name: 'Iliana', last_name: 'Munoz', lead_type: 'New Vehicle', year: 2026, make: 'Cadillac', model: 'CT4',
    phone: '602-555-0100', email: 'iliana@example.com', raw: '<> Vehicle: 2026 Name: Iliana Munoz Phone: 602-555-0100 <>',
  };

  it('Formatted matches the layout staff get today', () => {
    expect(staffText('formatted', 'Earnhardt Chandler Cadillac', lead)).toBe(
      'NEW LEAD - Earnhardt Chandler Cadillac\nType: New Vehicle\nCustomer: Iliana Munoz\nVehicle: 2026 Cadillac CT4\nPhone: 602-555-0100\nEmail: iliana@example.com',
    );
  });

  it('Formatted leaves out lines the lead didn’t include', () => {
    expect(staffText('formatted', 'Store', { ...lead, phone: '', email: '' })).not.toMatch(/Phone|Email/);
  });

  it('Raw sends the notification exactly as it came in', () => {
    expect(staffText('raw', 'Store', lead)).toBe(lead.raw);
  });

  it('never goes over Twilio’s length limit', () => {
    const long = staffText('raw', 'Store', { ...lead, raw: 'x'.repeat(5000) });
    expect(long.length).toBe(MAX_TEXT_LENGTH);
    expect(long.endsWith('…')).toBe(true);
  });

  it('each dealership’s choice is used for its leads', async () => {
    const db = await openDb();
    const [store] = await db.query(
      `INSERT INTO dealerships (name, mailbox, passthrough, crm, staff_phones, test_mode, google_status, staff_text_format)
       VALUES ('Raw Store', 'raw@etarsp.com', 'sales@raw.example.com', 'Elead', '["4805550100"]', FALSE, 'ok', 'raw') RETURNING id`,
    );
    await db.query(`INSERT INTO templates (dealership_id) VALUES ($1)`, [store.id]);
    const bodies: string[] = [];
    const body = '<> Raw Store Vehicle wanted: 2027 Cadillac Escalade Name: Alex Sample Phone: (555) 555-0100 <>';
    await receiveEmail(db, {
      sendEmail: async () => {}, wasSent: async () => false, findPhotos: async () => ({ photos: [], pageUrl: '' }), writeGreeting: async () => '',
      sendText: async (_to, text) => { bodies.push(text); },
    }, store.id, { from: ELEAD_SENDER, subject: 'Deal IN: 222  New Customer', body, messageId: '<r@b>', threadId: 't', receivedAt: new Date() });
    expect(bodies).toEqual([body]);
  });
});
