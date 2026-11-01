import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.ts';
import type { Db } from '../src/db.ts';
import { ELEAD_SENDER, parseElead } from '../src/lead/parseElead.ts';
import { assertSafeRecipient, answerLead, receiveEmail, recoverInterrupted, resumeLeads } from '../src/lead/pipeline.ts';
import type { InboundEmail, OutboundEmail, Services } from '../src/lead/pipeline.ts';
import { buildReply, replySubject } from '../src/lead/replyEmail.ts';

// The real sample from the spec, with placeholder customer details.
const SUBJECT = 'Deal IN: 73127528  New Customer 1GYS9HK92VR133820';
const BODY = '<> Earnhardt Cadillac Vehicle wanted: 2027 Cadillac Escalade Name: Alex Sample City: SAMPLE CITY Phone: (555) 555-0100 E-Mail: alex@example.com Trim: V-Series 4dr 4x4 Comments: Unlock Inquiry - Roadster Online; 2027 Cadillac Escalade-V V-Series - #C27099 - 1GYS9HK92VR133820; https://dealers.roadster.com/earnhardtcadillac/customers/12345678? utm_medium=eLead&utm_source=crm <>';
const PASSTHROUGH = 'sales@earnhardtcadillac.edealerhub.com';
const MAILBOX = 'earnhardtcadillac@etarsp.com';

const sample = (over: Partial<InboundEmail> = {}): InboundEmail => ({
  from: ELEAD_SENDER, subject: SUBJECT, body: BODY, messageId: '<original@eleadnotify.com>',
  threadId: 'thread-1', receivedAt: new Date(), ...over,
});

function fakeServices(over: Partial<Services> = {}) {
  const emails: OutboundEmail[] = [];
  const texts: { to: string; body: string }[] = [];
  const services: Services = {
    sendEmail: async (_mailbox, email) => { emails.push(email); },
    wasSent: async () => false,
    sendText: async (to, body) => { texts.push({ to, body }); },
    findPhotos: async () => ({ photos: ['https://a.test/1.jpg', 'https://a.test/2.jpg', 'https://a.test/3.jpg', 'https://a.test/4.jpg'], pageUrl: 'https://a.test/car' }),
    writeGreeting: async () => '',
    ...over,
  };
  return { emails, texts, services };
}

let db: Db;
let storeId: number;

beforeEach(async () => {
  db = await openDb();
  const [store] = await db.query(
    `INSERT INTO dealerships (name, website, mailbox, passthrough, crm, staff_phones, test_mode, google_status)
     VALUES ('Earnhardt Cadillac', 'earnhardtcadillac.com', $1, $2, 'Elead', '["+15550001111"]', FALSE, 'ok') RETURNING id`,
    [MAILBOX, PASSTHROUGH],
  );
  storeId = store.id;
  await db.query(`INSERT INTO templates (dealership_id, reasons) VALUES ($1, 'Family owned')`, [storeId]);
  await db.query(`UPDATE settings SET owner_test_email = 'owner@example.com', owner_test_phone = '+15559990000'`);
});

describe('Elead parser, spec sample', () => {
  const lead = parseElead(SUBJECT, BODY);
  it('reads every expected value', () => {
    expect(lead.firstName).toBe('Alex');
    expect(lead.lastName).toBe('Sample');
    expect(lead.year).toBe(2027);
    expect(lead.make).toBe('Cadillac');
    expect(lead.model).toBe('Escalade');
    expect(lead.trim).toBe('V-Series 4dr 4x4');
    expect(lead.vin).toBe('1GYS9HK92VR133820');
    expect(lead.stock).toBe('C27099');
    expect(lead.dealNumber).toBe('73127528');
    expect(lead.leadSource).toBe('Roadster via eLead');
    expect(lead.dealerName).toBe('Earnhardt Cadillac');
    expect(lead.email).toBe('alex@example.com');
    expect(lead.phone).toBe('(555) 555-0100');
    expect(lead.city).toBe('SAMPLE CITY');
  });

  it.each(['Vehicle wanted:', 'Name:', 'City:', 'Phone:', 'E-Mail:', 'Trim:', 'Comments:'])(
    'survives %s being missing',
    (label) => {
      const next = /Name:|City:|Phone:|E-Mail:|Trim:|Comments:|<>$/g;
      const start = BODY.indexOf(label);
      next.lastIndex = start + label.length;
      const end = next.exec(BODY)?.index ?? BODY.length;
      expect(() => parseElead(SUBJECT, BODY.slice(0, start) + BODY.slice(end))).not.toThrow();
    },
  );

  it('survives an empty body and subject', () => {
    expect(parseElead('', '').firstName).toBe('');
  });

  it('does not read a label inside the comments as a field', () => {
    const body = '<> Store Vehicle wanted: 2027 Cadillac Escalade Comments: Name: Fake City: Nowhere <>';
    expect(parseElead(SUBJECT, body).firstName).toBe('');
  });
});

describe('reply to the spec sample', () => {
  it('goes from the mailbox to the passthrough with the exact subject and threading', async () => {
    const { emails, services } = fakeServices();
    await receiveEmail(db, services, storeId, sample());
    expect(emails).toHaveLength(1);
    const email = emails[0]!;
    expect(email.from).toBe(MAILBOX);
    expect(email.to).toBe(PASSTHROUGH);
    expect(email.subject).toBe('Re: Deal IN: 73127528  New Customer 1GYS9HK92VR133820');
    expect(email.inReplyTo).toBe('<original@eleadnotify.com>');
    expect(email.references).toBe('<original@eleadnotify.com>');
    expect(email.threadId).toBe('thread-1');
    expect(email.html).toContain('Hi Alex,');
  });

  it('keeps the subject byte for byte', () => {
    expect(replySubject(SUBJECT).slice(4)).toBe(SUBJECT);
  });

  it('uses at most 3 photos and web-safe fonts, with a clean plain-text part', async () => {
    const { emails, services } = fakeServices();
    await receiveEmail(db, services, storeId, sample());
    const email = emails[0]!;
    expect(email.html.match(/alt="Vehicle photo/g)).toHaveLength(3);
    expect(email.html).toContain('font-family:Arial');
    expect(email.html).not.toMatch(/Barlow|fonts\.googleapis/);
    expect(email.text).not.toMatch(/<[a-z]|@import|font-family/i);
    expect(email.text).toContain('Hi Alex,');
  });

  it('escapes customer text in the email', () => {
    const lead = { firstName: '<script>', year: 2027, make: 'A', model: 'B', trim: '', vin: 'V', stock: '', leadType: 'New Vehicle (VIN)' };
    const store = { name: 'S', website: '', salesPhone: '', servicePhone: '', address: '' };
    const { html } = buildReply(store, { reasons: '', buttons: '', logoUrl: '', buildingPhotoUrl: '', links: '' }, lead, []);
    expect(html).not.toContain('<script>');
  });
});

describe('simpler replies still go out at once', () => {
  const kindOf = async () => (await db.query('SELECT kind FROM responses'))[0].kind;

  it('no photos found', async () => {
    const { emails, services } = fakeServices({ findPhotos: async () => ({ photos: [], pageUrl: '' }) });
    await receiveEmail(db, services, storeId, sample());
    expect(emails).toHaveLength(1);
    expect(await kindOf()).toBe('no_photos');
  });

  it('failed photo lookup', async () => {
    const { emails, services } = fakeServices({ findPhotos: async () => { throw new Error('down'); } });
    await receiveEmail(db, services, storeId, sample());
    expect(emails).toHaveLength(1);
    expect(await kindOf()).toBe('no_photos');
  });

  it('slow photo lookup does not hold the reply past the limit', async () => {
    await db.query('UPDATE settings SET photo_timeout_seconds = 1');
    const { emails, services } = fakeServices({ findPhotos: () => new Promise(() => {}) });
    await receiveEmail(db, services, storeId, sample());
    expect(emails).toHaveLength(1);
    expect(await kindOf()).toBe('no_photos');
  });

  it('no VIN gets the fallback', async () => {
    const { emails, services } = fakeServices();
    await receiveEmail(db, services, storeId, sample({
      subject: 'Deal IN: 111  New Customer',
      body: '<> Earnhardt Cadillac Vehicle wanted: 2025 Cadillac Lyriq Name: Pat Sample <>',
    }));
    expect(await kindOf()).toBe('fallback');
    expect(emails[0]!.text).toContain('unavailable');
  });

  it('a failed model falls back to the standard greeting', async () => {
    await db.query('UPDATE settings SET model_enabled = TRUE');
    const { emails, services } = fakeServices({ writeGreeting: async () => { throw new Error('bad key'); } });
    await receiveEmail(db, services, storeId, sample());
    expect(emails[0]!.html).toContain('Hi Alex,');
    expect(await db.query('SELECT * FROM alerts')).toHaveLength(1);
  });
});

describe('safety rules', () => {
  it('never sends twice for one deal number', async () => {
    const { emails, texts, services } = fakeServices();
    await receiveEmail(db, services, storeId, sample());
    await receiveEmail(db, services, storeId, sample({ messageId: '<repeat@eleadnotify.com>' }));
    expect(emails).toHaveLength(1);
    expect(texts).toHaveLength(1);
  });

  it('refuses the notification sender in any form', () => {
    expect(() => assertSafeRecipient(ELEAD_SENDER)).toThrow();
    expect(() => assertSafeRecipient(` NOTIFY@ELEADNOTIFY.COM `)).toThrow();
    expect(() => assertSafeRecipient('')).toThrow();
  });

  it('refuses to send with no passthrough and raises an alert', async () => {
    await db.query(`UPDATE dealerships SET passthrough = ''`);
    const { emails, services } = fakeServices();
    await receiveEmail(db, services, storeId, sample());
    expect(emails).toHaveLength(0);
    expect((await db.query('SELECT status FROM responses'))[0].status).toBe('failed');
    expect(await db.query('SELECT * FROM alerts')).toHaveLength(1);
  });

  it('test mode reaches only the owner', async () => {
    await db.query('UPDATE dealerships SET test_mode = TRUE');
    await db.query('UPDATE settings SET customer_texts = TRUE');
    const { emails, texts, services } = fakeServices();
    await receiveEmail(db, services, storeId, sample());
    expect(emails.map((e) => e.to)).toEqual(['owner@example.com']);
    expect(texts.map((t) => t.to)).toEqual(['+15559990000']);
  });

  it('holds leads while paused, and sends nothing until resumed', async () => {
    await db.query('UPDATE settings SET sending = FALSE');
    const { emails, texts, services } = fakeServices();
    const id = await receiveEmail(db, services, storeId, sample());
    expect(emails).toHaveLength(0);
    expect(texts).toHaveLength(0);
    expect((await db.query('SELECT state FROM leads'))[0].state).toBe('held');
    await answerLead(db, services, id!);
    expect(emails).toHaveLength(0);
  });

  it('ignores its own replies and anything not from the CRM', async () => {
    const { emails, services } = fakeServices();
    await receiveEmail(db, services, storeId, sample({ subject: `Re: ${SUBJECT}` }));
    await receiveEmail(db, services, storeId, sample({ from: 'someone@example.com' }));
    expect(emails).toHaveLength(0);
  });

  it('skips a CRM email that is not a lead and raises an alert', async () => {
    const { emails, services } = fakeServices();
    await receiveEmail(db, services, storeId, sample({ subject: 'Your weekly report', body: 'Hello' }));
    expect(emails).toHaveLength(0);
    expect((await db.query('SELECT title FROM alerts'))[0].title).toBe('Email not recognized');
  });

  it('caps sends per minute and leaves the rest queued', async () => {
    await db.query('UPDATE settings SET sends_per_minute = 1');
    const { emails, services } = fakeServices();
    await receiveEmail(db, services, storeId, sample());
    await receiveEmail(db, services, storeId, sample({ subject: 'Deal IN: 2  New Customer', messageId: '<2@x>' }));
    expect(emails).toHaveLength(1);
    expect((await db.query(`SELECT count(*)::int AS n FROM leads WHERE state = 'queued'`))[0].n).toBe(1);
  });

  it('finishes after a restart without sending twice', async () => {
    const { emails, services } = fakeServices({ wasSent: async () => true });
    await receiveEmail(db, fakeServices({ sendEmail: async () => { throw new Error('stop'); } }).services, storeId, sample());
    await db.query(`DELETE FROM responses`);
    await db.query(`UPDATE leads SET state = 'sending'`);
    await recoverInterrupted(db);
    await resumeLeads(db, services);
    expect(emails).toHaveLength(0);
    expect((await db.query('SELECT state FROM leads'))[0].state).toBe('done');
  });

  it('leaves a lead alone while it is still being worked on', async () => {
    const { emails, services } = fakeServices();
    await receiveEmail(db, fakeServices({ sendEmail: async () => { throw new Error('stop'); } }).services, storeId, sample());
    await db.query(`UPDATE leads SET state = 'sending'`);
    await resumeLeads(db, services);
    expect(emails).toHaveLength(0);
    expect((await db.query('SELECT state FROM leads'))[0].state).toBe('sending');
  });

  it('does not text a number that opted out', async () => {
    await db.query(`INSERT INTO opt_outs (phone) VALUES ('+15550001111')`);
    const { texts, services } = fakeServices();
    await receiveEmail(db, services, storeId, sample());
    expect(texts).toHaveLength(0);
  });
});

describe('photo cache', () => {
  it('reuses saved links for the same VIN', async () => {
    let lookups = 0;
    const { services } = fakeServices({
      findPhotos: async () => { lookups += 1; return { photos: ['https://a.test/1.jpg'], pageUrl: '' }; },
    });
    await receiveEmail(db, services, storeId, sample());
    await receiveEmail(db, services, storeId, sample({ subject: `Deal IN: 2  New Customer 1GYS9HK92VR133820`, messageId: '<2@x>' }));
    expect(lookups).toBe(1);
    expect((await db.query('SELECT hits FROM vehicle_cache'))[0].hits).toBe(1);
  });
});
