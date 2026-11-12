import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { SESSION_COOKIE, createSession, hashPassword } from '../src/auth.ts';
import { openDb } from '../src/db.ts';
import type { Db } from '../src/db.ts';
import { ELEAD_SENDER } from '../src/lead/parseElead.ts';
import { receiveEmail } from '../src/lead/pipeline.ts';
import type { OutboundEmail } from '../src/lead/pipeline.ts';
import { TemplateError, cleanTemplate, newBlock, renderTemplate, standardTemplate } from '../src/lead/blocks.ts';
import { createTemplate, deleteTemplate, ensureDefault, saveTemplate, templateFor, useTemplate } from '../src/templates.ts';

const store = { name: 'Earnhardt Cadillac', website: 'earnhardtcadillac.com', salesPhone: '480-269-0992', servicePhone: '480-483-4000', address: '7901 E Frank Lloyd Wright Blvd' };
const lead = { firstName: 'Alex', year: 2027, make: 'Cadillac', model: 'Escalade', trim: 'V-Series', vin: '1GYS9HK92VR133820', stock: 'C27099', leadType: 'New Vehicle (VIN)' };
const photos = ['https://a.test/1.jpg', 'https://a.test/2.jpg'];

describe('building an email from blocks', () => {
  it('fills in the lead’s details', () => {
    const t = { blocks: [{ ...newBlock('text'), text: 'Hi {first_name}, your {vehicle} (stock {stock}) is at {dealership}.' }], style: standardTemplate().style } as any;
    const { html, text } = renderTemplate(store, t, lead, photos);
    expect(text).toBe('Hi Alex, your 2027 Cadillac Escalade V-Series (stock C27099) is at Earnhardt Cadillac.');
    expect(html).toContain('your 2027 Cadillac Escalade V-Series');
  });

  it('escapes everything typed into a template', () => {
    const t = { blocks: [{ ...newBlock('text'), text: '<script>alert(1)</script>' }], style: standardTemplate().style } as any;
    expect(renderTemplate(store, t, lead, photos).html).not.toContain('<script>');
  });

  it('shows each block only for the leads it is set to', () => {
    const t = {
      blocks: [
        { ...newBlock('text'), text: 'FOUND', showFor: 'vehicle' },
        { ...newBlock('text'), text: 'GONE', showFor: 'unavailable' },
        { ...newBlock('text'), text: 'SERVICE', showFor: 'service' },
      ],
      style: standardTemplate().style,
    } as any;
    expect(renderTemplate(store, t, lead, photos).text).toBe('FOUND');
    expect(renderTemplate(store, t, { ...lead, vin: '' }, []).text).toBe('GONE');
    expect(renderTemplate(store, t, { ...lead, leadType: 'Service' }, []).text).toBe('SERVICE');
  });

  it('the signature always comes from the dealership record', () => {
    const t = { blocks: [newBlock('signature')], style: standardTemplate().style } as any;
    const { text } = renderTemplate(store, t, lead, photos);
    expect(text).toContain('Earnhardt Cadillac');
    expect(text).toContain('480-269-0992 Sales');
    expect(text).toContain('7901 E Frank Lloyd Wright Blvd');
  });

  it('buttons put the vehicle in the link and are left out without a link', () => {
    const t = { blocks: [{ ...newBlock('buttons'), items: [{ label: 'See it', url: 'https://store.test/v?vin={vin}' }, { label: 'Dead', url: '' }] }], style: standardTemplate().style } as any;
    const { html } = renderTemplate(store, t, lead, photos);
    expect(html).toContain('https://store.test/v?vin=1GYS9HK92VR133820');
    expect(html).not.toContain('Dead');
  });

  it('uses the chosen font and colors', () => {
    const t = cleanTemplate({ blocks: [{ ...newBlock('buttons'), items: [{ label: 'Go', url: 'https://x.test' }] }], style: { font: 'Georgia', buttonColor: '#C8102E', background: '#f0f0f0' } });
    const { html } = renderTemplate(store, t, lead, photos);
    expect(html).toContain('font-family:Georgia,serif');
    expect(html).toContain('background:#c8102e');
    expect(html).toContain('background:#f0f0f0');
  });
});

describe('checking what the editor sends', () => {
  it('refuses links that are not https, naming where', () => {
    expect(() => cleanTemplate({ blocks: [{ type: 'image', url: 'http://x.test/a.jpg' }] })).toThrow(TemplateError);
    expect(() => cleanTemplate({ blocks: [{ type: 'buttons', items: [{ label: 'Go', url: 'javascript:alert(1)' }] }] })).toThrow('Button “Go”');
  });

  it('drops unknown blocks and fields, and fixes bad styles', () => {
    const t = cleanTemplate({ blocks: [{ type: 'script', html: '<b>' }, { type: 'divider', extra: 1 }], style: { font: 'Comic Sans', textColor: 'red', fontSize: 99 } });
    expect(t.blocks.map((b) => b.type)).toEqual(['divider']);
    expect(t.blocks[0]).not.toHaveProperty('extra');
    expect(t.style).toMatchObject({ font: 'Arial', textColor: '#111111', fontSize: 22 });
  });
});

describe('templates per dealership', () => {
  let db: Db;
  let storeId: number;
  beforeEach(async () => {
    db = await openDb();
    [{ id: storeId }] = await db.query(
      `INSERT INTO dealerships (name, mailbox, passthrough, crm, staff_phones, test_mode, google_status)
       VALUES ('Earnhardt Cadillac', 'store@etarsp.com', 'sales@store.example.com', 'Elead', '[]', FALSE, 'ok') RETURNING id`,
    );
  });

  it('a dealership’s first template is built from its older settings', async () => {
    await db.query(`INSERT INTO templates (dealership_id, reasons, logo_url) VALUES ($1, 'Family owned\nFree delivery', 'https://x.test/logo.png')`, [storeId]);
    const t = await templateFor(db, storeId);
    expect(t.name).toBe('Standard');
    expect(t.is_default).toBe(true);
    expect(t.blocks.find((b) => b.type === 'reasons')).toMatchObject({ items: ['Family owned', 'Free delivery'] });
    expect(t.blocks.find((b) => b.type === 'header')).toMatchObject({ logoUrl: 'https://x.test/logo.png' });
  });

  it('replies use the template chosen for the dealership', async () => {
    const def = await ensureDefault(db, storeId);
    const id = await createTemplate(db, storeId, 'Holiday');
    await saveTemplate(db, id, 'Holiday', { blocks: [{ ...newBlock('text'), text: 'Holiday pricing for {first_name}' } as any], style: def.style });
    await useTemplate(db, id);
    const emails: OutboundEmail[] = [];
    await receiveEmail(db, {
      sendEmail: async (_m, e) => { emails.push(e); }, wasSent: async () => false, sendText: async () => {},
      findPhotos: async () => ({ photos: [], pageUrl: '' }), writeGreeting: async () => '',
    }, storeId, { from: ELEAD_SENDER, subject: 'Deal IN: 9  New Customer', body: '<> Store Vehicle wanted: 2027 Cadillac Escalade Name: Alex Sample <>', messageId: '<m@x>', threadId: 't', receivedAt: new Date() });
    expect(emails[0]!.text).toBe('Holiday pricing for Alex');
  });

  it('deleting the template in use switches the dealership to its default', async () => {
    const def = await ensureDefault(db, storeId);
    const id = await createTemplate(db, storeId, 'Holiday');
    await useTemplate(db, id);
    expect(await deleteTemplate(db, id)).toBe('deleted');
    expect((await templateFor(db, storeId)).id).toBe(def.id);
  });

  it('the default template can’t be deleted', async () => {
    const def = await ensureDefault(db, storeId);
    expect(await deleteTemplate(db, def.id)).toBe('default');
    expect((await templateFor(db, storeId)).id).toBe(def.id);
  });

  it('duplicating copies the blocks', async () => {
    const def = await ensureDefault(db, storeId);
    const id = await createTemplate(db, storeId, 'Copy', def.id);
    const [copy] = await db.query('SELECT blocks FROM email_templates WHERE id = $1', [id]);
    expect(copy.blocks.map((b: any) => b.type)).toEqual(def.blocks.map((b) => b.type));
  });
});

describe('template addresses', () => {
  const config = { ownerEmail: 'o@example.com', ownerPasswordHash: hashPassword('x'), sessionSecret: 's'.repeat(40), port: 3000, production: true };
  const cookies = { [SESSION_COOKIE]: createSession('s'.repeat(40)) };

  it('names are required and unique per dealership; bad links and the default are refused', async () => {
    const db = await openDb();
    const app = await buildApp(config, { db });
    const [{ id: dealerId }] = await db.query(`INSERT INTO dealerships (name) VALUES ('Store') RETURNING id`);
    const def = await ensureDefault(db, dealerId);
    const post = (payload: object) => app.inject({ method: 'POST', url: '/api/email-templates', cookies, payload });
    expect((await post({ dealerId, name: ' ' })).json().error).toContain('name');
    expect((await post({ dealerId, name: 'standard' })).json().error).toContain('already has');
    const { id } = (await post({ dealerId, name: 'Holiday' })).json();
    const bad = await app.inject({ method: 'PUT', url: `/api/email-templates/${id}`, cookies, payload: { name: 'Holiday', blocks: [{ type: 'image', url: 'http://x.test' }] } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toContain('https://');
    expect((await app.inject({ method: 'DELETE', url: `/api/email-templates/${def.id}`, cookies })).statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: `/api/email-templates/${id}`, cookies })).statusCode).toBe(200);
  });
});
