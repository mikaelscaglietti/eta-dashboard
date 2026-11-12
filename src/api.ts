import type { FastifyInstance } from 'fastify';
import type { Db } from './db.ts';
import { ELEAD_SENDER } from './lead/parseElead.ts';
import { answerLead } from './lead/pipeline.ts';
import type { Services } from './lead/pipeline.ts';
import { TemplateError, cleanTemplate, renderTemplate } from './lead/blocks.ts';
import { createTemplate, deleteTemplate, ensureDefault, listTemplates, saveTemplate, useTemplate } from './templates.ts';
import { normalizePhone } from './sms.ts';
import { RANGES, monitorData } from './monitor.ts';
import type { Range } from './monitor.ts';

const EMAIL = /^\S+@\S+\.\S+$/;

function storeInput(body: any) {
  return {
    name: String(body.name ?? '').trim(),
    website: String(body.site ?? '').trim(),
    mailbox: String(body.mailbox ?? '').trim(),
    crm: String(body.crm ?? '').trim(),
    passthrough: String(body.passthrough ?? '').trim(),
    sales: String(body.sales ?? '').trim(),
    service: String(body.service ?? '').trim(),
    address: String(body.address ?? '').trim(),
    textFormat: body.textFormat === 'raw' ? 'raw' : 'formatted',
    staffTyped: ((body.staff ?? []) as unknown[]).map((s) => String(s).trim()).filter(Boolean),
  };
}

// Staff numbers are saved in Twilio's format, so every comparison (like STOP) matches.
function staffNumbers(typed: string[]): { saved: string; error: string } {
  const bad = typed.filter((n) => !normalizePhone(n));
  if (bad.length) return { saved: '', error: `This doesn’t look like a phone number: ${bad[0]}. Use a 10-digit number like 480-555-0100.` };
  return { saved: JSON.stringify([...new Set(typed.map(normalizePhone))]), error: '' };
}

function refusedPassthrough(address: string): string {
  if (address.toLowerCase().includes(ELEAD_SENDER)) {
    return 'This is the notification sender. Replies must go to your CRM passthrough address instead.';
  }
  return '';
}

const PREVIEW_PHOTO = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 120"><rect width="160" height="120" fill="#d7dde6"/></svg>')}`;
const SAMPLE_LEAD = { firstName: 'Alex', year: 2027, make: 'Cadillac', model: 'Escalade', trim: 'V-Series 4dr 4x4', vin: '1GYS9HK92VR133820', stock: 'C27099', leadType: 'New Vehicle (VIN)' };

export interface Connections {
  twilio: { connected: boolean; from: string };
}

export function registerApi(app: FastifyInstance, db: Db, services: Services, dev: boolean, connections: Connections = { twilio: { connected: false, from: '' } }) {
  // Everything the screens show, in one request. Keys never appear here.
  app.get('/api/state', async () => {
    const [dealers, templates, leads, events, texts, alerts, cache, settings] = await Promise.all([
      db.query('SELECT * FROM dealerships ORDER BY name'),
      listTemplates(db),
      db.query(`SELECT l.*, r.kind, r.status, r.failure, r.seconds, r.from_address, r.to_address, r.subject AS reply_subject,
                  r.html, r.text_body, r.photo_count, r.photo_source
                FROM leads l LEFT JOIN responses r ON r.lead_id = l.id ORDER BY l.received_at DESC LIMIT 1000`),
      db.query('SELECT lead_id, at, message, severity FROM lead_events ORDER BY id'),
      db.query('SELECT lead_id, recipient, audience, body, status, failure FROM text_messages ORDER BY id'),
      db.query('SELECT * FROM alerts WHERE dismissed_at IS NULL ORDER BY created_at DESC'),
      db.query('SELECT * FROM vehicle_cache ORDER BY last_scraped DESC'),
      db.query('SELECT * FROM settings'),
    ]);
    return { dealers, templates, leads, events, texts, alerts, cache, settings: settings[0], dev, connections };
  });

  // The Monitor screen: totals for a time range, optionally for one dealership.
  app.get<{ Querystring: { range?: string; dealer?: string } }>('/api/monitor', async (request) => {
    const range = (RANGES as string[]).includes(request.query.range ?? '') ? (request.query.range as Range) : 'today';
    const dealer = Number(request.query.dealer);
    return monitorData(db, range, Number.isInteger(dealer) && dealer > 0 ? dealer : null);
  });

  app.post('/api/dealerships', async (request, reply) => {
    const d = storeInput(request.body);
    const errors: Record<string, string> = {};
    const all = await db.query('SELECT name, mailbox FROM dealerships');
    if (!d.name) errors.name = 'Enter the dealership name.';
    else if (all.some((row) => row.name.toLowerCase() === d.name.toLowerCase())) errors.name = 'A dealership with this name already exists.';
    if (!EMAIL.test(d.mailbox)) errors.mailbox = 'Enter a full email address, like leads@yourstore.com.';
    else if (all.some((row) => row.mailbox.toLowerCase() === d.mailbox.toLowerCase())) errors.mailbox = 'Another dealership already uses this mailbox.';
    if (!d.crm) errors.crm = 'Choose the CRM this store uses.';
    const refused = refusedPassthrough(d.passthrough);
    if (refused) errors.passthrough = refused;
    else if (!EMAIL.test(d.passthrough)) errors.passthrough = 'Enter the CRM passthrough address, like sales@yourstore.edealerhub.com.';
    const staff = staffNumbers(d.staffTyped);
    if (staff.error) errors.staff = staff.error;
    if (Object.keys(errors).length) return reply.code(400).send({ errors });

    // test_mode is left to its default on purpose: every new store starts in test mode.
    const [row] = await db.query(
      `INSERT INTO dealerships (name, website, mailbox, crm, passthrough, sales_phone, service_phone, address, staff_phones, staff_text_format)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [d.name, d.website, d.mailbox, d.crm, d.passthrough, d.sales, d.service, d.address, staff.saved, d.textFormat],
    );
    await ensureDefault(db, row.id);
    await db.query(
      `INSERT INTO alerts (dealership_id, severity, title, body, link, cta) VALUES ($1, 'fallback', $2, $3, $4, 'Connect')`,
      [row.id, `Connect Google: ${d.name}`, 'The app can’t read or reply from this mailbox until you connect Google.', `#dealership-${row.id}`],
    );
    return { id: row.id };
  });

  app.put<{ Params: { id: string } }>('/api/dealerships/:id', async (request, reply) => {
    const d = storeInput(request.body);
    const refused = refusedPassthrough(d.passthrough);
    if (refused) return reply.code(400).send({ errors: { passthrough: refused } });
    if (!d.name) return reply.code(400).send({ errors: { name: 'Enter the dealership name.' } });
    const staff = staffNumbers(d.staffTyped);
    if (staff.error) return reply.code(400).send({ errors: { staff: staff.error } });
    await db.query(
      `UPDATE dealerships SET name=$2, website=$3,
         google_status = CASE WHEN mailbox = $4 THEN google_status ELSE 'new' END, mailbox=$4,
         crm=$5, passthrough=$6, sales_phone=$7, service_phone=$8, address=$9, staff_phones=$10, staff_text_format=$11 WHERE id=$1`,
      [request.params.id, d.name, d.website, d.mailbox, d.crm, d.passthrough, d.sales, d.service, d.address, staff.saved, d.textFormat],
    );
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: { active?: boolean; test?: boolean } }>('/api/dealerships/:id/flags', async (request) => {
    const { active, test } = request.body as { active?: boolean; test?: boolean };
    if (typeof active === 'boolean') await db.query('UPDATE dealerships SET active = $2 WHERE id = $1', [request.params.id, active]);
    if (typeof test === 'boolean') await db.query('UPDATE dealerships SET test_mode = $2 WHERE id = $1', [request.params.id, test]);
    return { ok: true };
  });

  // The preview uses the same builder as real emails, so it can't drift from them.
  app.post<{ Body: any }>('/api/templates/preview', async (request, reply) => {
    const { dealerId, template, sample } = request.body as any;
    const [s] = await db.query('SELECT * FROM dealerships WHERE id = $1', [dealerId]);
    if (!s) return { html: '' };
    let clean;
    try { clean = cleanTemplate(template); } catch (error) {
      if (error instanceof TemplateError) return reply.code(400).send({ error: error.message });
      throw error;
    }
    const store = { name: s.name, website: s.website, salesPhone: s.sales_phone, servicePhone: s.service_phone, address: s.address };
    const lead = sample === 'unavailable' ? { ...SAMPLE_LEAD, vin: '', stock: '', leadType: 'New Vehicle' }
      : sample === 'service' ? { ...SAMPLE_LEAD, year: null, make: '', model: '', trim: '', vin: '', stock: '', leadType: 'Service' }
      : SAMPLE_LEAD;
    const photo = 'https://preview.invalid/photo.jpg';
    const { html } = renderTemplate(store, clean, lead, sample === 'vehicle' || !sample ? [photo, photo, photo] : []);
    return { html: html.replaceAll(photo, PREVIEW_PHOTO) };
  });

  const templateName = async (dealerId: number, name: unknown, exceptId = 0) => {
    const clean = String(name ?? '').trim().slice(0, 60);
    if (!clean) return { error: 'Give the template a name.' };
    const [taken] = await db.query('SELECT id FROM email_templates WHERE dealership_id = $1 AND lower(name) = lower($2) AND id <> $3', [dealerId, clean, exceptId]);
    return taken ? { error: 'This dealership already has a template with that name.' } : { name: clean };
  };

  app.post<{ Body: any }>('/api/email-templates', async (request, reply) => {
    const b = request.body as any;
    const dealerId = Number(b.dealerId);
    const [store] = await db.query('SELECT id FROM dealerships WHERE id = $1', [dealerId]);
    if (!store) return reply.code(404).send({ error: 'That dealership no longer exists.' });
    const named = await templateName(dealerId, b.name);
    if (named.error) return reply.code(400).send({ error: named.error });
    return { id: await createTemplate(db, dealerId, named.name!, Number(b.copyFrom) || undefined) };
  });

  app.put<{ Params: { id: string }; Body: any }>('/api/email-templates/:id', async (request, reply) => {
    const id = Number(request.params.id);
    const [t] = await db.query('SELECT dealership_id FROM email_templates WHERE id = $1', [id]);
    if (!t) return reply.code(404).send({ error: 'That template no longer exists.' });
    const b = request.body as any;
    const named = await templateName(t.dealership_id, b.name, id);
    if (named.error) return reply.code(400).send({ error: named.error });
    try {
      await saveTemplate(db, id, named.name!, cleanTemplate(b));
    } catch (error) {
      if (error instanceof TemplateError) return reply.code(400).send({ error: error.message });
      throw error;
    }
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/email-templates/:id/use', async (request, reply) => {
    if (!(await useTemplate(db, Number(request.params.id)))) return reply.code(404).send({ error: 'That template no longer exists.' });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/email-templates/:id', async (request, reply) => {
    const result = await deleteTemplate(db, Number(request.params.id));
    if (result === 'missing') return reply.code(404).send({ error: 'That template no longer exists.' });
    if (result === 'default') return reply.code(400).send({ error: 'The default template can’t be deleted. It is what each dealership falls back to.' });
    return { ok: true };
  });

  app.post<{ Body: { sending: boolean } }>('/api/sending', async (request) => {
    const on = Boolean((request.body as { sending: boolean }).sending);
    await db.query('UPDATE settings SET sending = $1', [on]);
    return { ok: true };
  });

  // Held leads are not sent automatically: that choice is still an open
  // question, so each one is answered by pressing Send on its own page.
  app.post<{ Params: { id: string } }>('/api/leads/:id/send', async (request, reply) => {
    const [settings] = await db.query('SELECT sending FROM settings');
    if (!settings.sending) return reply.code(409).send({ error: 'Sending is paused.' });
    const [lead] = await db.query(
      `UPDATE leads l SET state = 'queued' FROM responses r
       WHERE l.id = $1 AND r.lead_id = l.id AND r.status IN ('held', 'failed') RETURNING l.id`,
      [request.params.id],
    );
    if (!lead) return reply.code(409).send({ error: 'This lead already has a reply.' });
    await answerLead(db, services, lead.id);
    const [result] = await db.query('SELECT status, failure FROM responses WHERE lead_id = $1', [lead.id]);
    return result;
  });

  app.post<{ Params: { id: string } }>('/api/alerts/:id/dismiss', async (request) => {
    await db.query('UPDATE alerts SET dismissed_at = now() WHERE id = $1', [request.params.id]);
    return { ok: true };
  });

  app.delete<{ Params: { vin: string } }>('/api/cache/:vin', async (request) => {
    await db.query('DELETE FROM vehicle_cache WHERE vin = $1', [request.params.vin]);
    return { ok: true };
  });

  // Expiring the entry makes the next lead for this VIN look it up again.
  app.post<{ Params: { vin: string } }>('/api/cache/:vin/refresh', async (request) => {
    await db.query('UPDATE vehicle_cache SET expires_at = now() WHERE vin = $1', [request.params.vin]);
    return { ok: true };
  });

  app.delete('/api/cache', async () => {
    await db.query('DELETE FROM vehicle_cache');
    return { ok: true };
  });

  app.put<{ Body: any }>('/api/settings', async (request, reply) => {
    const s = request.body as any;
    const typedPhone = String(s.testPhone ?? '').trim();
    const testPhone = normalizePhone(typedPhone);
    if (typedPhone && !testPhone) return reply.code(400).send({ error: 'Your test phone doesn’t look like a phone number. Use a 10-digit number like 480-555-0100.' });
    await db.query(
      `UPDATE settings SET customer_texts=$1, owner_test_email=$2, owner_test_phone=$3, model_enabled=$4,
         model_provider=$5, model_id=$6, model_timeout_seconds=$7, photo_timeout_seconds=$8`,
      [Boolean(s.customerTexts), String(s.testEmail ?? '').trim(), testPhone, Boolean(s.modelEnabled),
        s.provider, s.model, Math.min(10, Math.max(1, Number(s.modelTimeout) || 3)), Math.min(30, Math.max(1, Number(s.photoTimeout) || 5))],
    );
    return { ok: true };
  });
}
