import type { Db } from '../db.ts';
import { ELEAD_SENDER, looksLikeLead, parseElead } from './parseElead.ts';
import { NON_VEHICLE_TYPES, buildReply, replySubject } from './replyEmail.ts';
import { normalizePhone } from '../sms.ts';
import { staffText } from './staffText.ts';

export interface InboundEmail {
  from: string;
  subject: string;
  body: string;
  messageId: string;
  threadId: string;
  receivedAt: Date;
}

export interface OutboundEmail {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  inReplyTo: string;
  references: string;
  threadId: string;
}

// The outside services. Each is swapped for a stand-in during tests and for
// the real connection once its account details are supplied.
export interface Services {
  sendEmail(mailbox: string, email: OutboundEmail): Promise<void>;
  // After a crash mid-send: did this reply already leave?
  wasSent(mailbox: string, threadId: string, to: string): Promise<boolean>;
  // Returns the text service's message ID when it has one.
  sendText(to: string, body: string): Promise<string | void>;
  findPhotos(website: string, vin: string): Promise<{ photos: string[]; pageUrl: string }>;
  writeGreeting(lead: { firstName: string; vehicle: string }): Promise<string>;
}

export class ForbiddenRecipient extends Error {}

const CACHE_DAYS = 30; // Provisional: "Photo cache expiry" is an open question.

// The last check before anything leaves, so no setting or bug can get around it.
export function assertSafeRecipient(to: string): void {
  const address = to.trim().toLowerCase();
  if (!address) throw new ForbiddenRecipient('No CRM passthrough address is saved.');
  if (address.includes(ELEAD_SENDER)) throw new ForbiddenRecipient(`Refused to send to ${ELEAD_SENDER}.`);
}

function withTimeout<T>(work: Promise<T>, seconds: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Timed out')), seconds * 1000);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

const event = (db: Db, leadId: number, message: string, severity = '') =>
  db.query('INSERT INTO lead_events (lead_id, message, severity) VALUES ($1, $2, $3)', [leadId, message, severity]);

export const raiseAlert = (
  db: Db,
  alert: { dealershipId?: number | null; severity: string; title: string; body: string; link?: string; cta?: string },
) =>
  db.query(
    'INSERT INTO alerts (dealership_id, severity, title, body, link, cta) VALUES ($1, $2, $3, $4, $5, $6)',
    [alert.dealershipId ?? null, alert.severity, alert.title, alert.body, alert.link ?? '#alerts', alert.cta ?? 'Review'],
  );

async function setResponse(db: Db, leadId: number, fields: { status: string; failure?: string }) {
  await db.query(
    `INSERT INTO responses (lead_id, status, failure) VALUES ($1, $2, $3)
     ON CONFLICT (lead_id) DO UPDATE SET status = $2, failure = $3`,
    [leadId, fields.status, fields.failure ?? ''],
  );
}

// Step 1 and 2: decide whether an email is a lead and save it exactly once.
export async function receiveEmail(db: Db, services: Services, dealershipId: number, email: InboundEmail) {
  const [store] = await db.query('SELECT * FROM dealerships WHERE id = $1', [dealershipId]);
  if (!store?.active) return null;

  const sender = email.from.toLowerCase();
  // Loop protection: only the CRM's own notifications start a reply. Anything
  // else, including a reply bounced back, is ignored.
  if (!sender.includes(ELEAD_SENDER) || /^\s*re:/i.test(email.subject)) return null;

  if (!looksLikeLead(email.subject, email.body)) {
    await raiseAlert(db, {
      dealershipId,
      severity: 'fallback',
      title: 'Email not recognized',
      body: `A message to ${store.mailbox} did not look like a lead and was skipped.`,
    });
    return null;
  }

  const lead = parseElead(email.subject, email.body);
  const [settings] = await db.query('SELECT sending FROM settings');
  const [saved] = await db.query(
    `INSERT INTO leads (received_at, dealership_id, first_name, last_name, email, phone, city, year, make, model, trim,
       vin, stock, lead_type, lead_source, deal_number, subject, message_id, thread_id, raw, state)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
     ON CONFLICT DO NOTHING RETURNING id`,
    [email.receivedAt, dealershipId, lead.firstName, lead.lastName, lead.email, lead.phone, lead.city, lead.year, lead.make,
      lead.model, lead.trim, lead.vin, lead.stock, lead.leadType, lead.leadSource, lead.dealNumber, email.subject,
      email.messageId, email.threadId, email.body, settings.sending ? 'queued' : 'held'],
  );
  if (!saved) return null; // A repeat notification: no second reply or text.

  await event(db, saved.id, `Lead notification received from ${ELEAD_SENDER}`);
  await event(db, saved.id, 'Customer details and vehicle read from the message');
  if (!settings.sending) {
    await setResponse(db, saved.id, { status: 'held' });
    await event(db, saved.id, 'Sending is paused. Lead held for you.', 'warn');
    return saved.id as number;
  }
  await answerLead(db, services, saved.id);
  return saved.id as number;
}

async function photosFor(db: Db, services: Services, website: string, lead: any, seconds: number) {
  const [cached] = await db.query('SELECT * FROM vehicle_cache WHERE vin = $1 AND expires_at > now()', [lead.vin]);
  if (cached) {
    await db.query('UPDATE vehicle_cache SET hits = hits + 1 WHERE vin = $1', [lead.vin]);
    return { photos: cached.photos as string[], source: 'From cache' };
  }
  const found = await withTimeout(services.findPhotos(website, lead.vin), seconds);
  const photos = found.photos.slice(0, 3);
  if (photos.length) {
    const vehicle = [lead.year, lead.make, lead.model, lead.trim].filter(Boolean).join(' ');
    await db.query(
      `INSERT INTO vehicle_cache (vin, vehicle, photos, page_url, expires_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(days => ${CACHE_DAYS}))
       ON CONFLICT (vin) DO UPDATE SET photos = $3, page_url = $4, last_scraped = now(), expires_at = EXCLUDED.expires_at`,
      [lead.vin, vehicle, JSON.stringify(photos), found.pageUrl],
    );
  }
  return { photos, source: 'Scraped' };
}

async function fail(db: Db, store: any, leadId: number, reason: string) {
  await setResponse(db, leadId, { status: 'failed', failure: reason });
  await db.query(`UPDATE leads SET state = 'done' WHERE id = $1`, [leadId]);
  await event(db, leadId, `Reply blocked: ${reason}`, 'bad');
  await raiseAlert(db, {
    dealershipId: store.id,
    severity: 'failed',
    title: `Reply failed: ${store.name}`,
    body: reason,
    link: `#dealership-${store.id}`,
    cta: 'Fix dealership',
  });
}

// Steps 3 to 7. Safe to call again after a restart.
export async function answerLead(db: Db, services: Services, leadId: number): Promise<void> {
  const [settings] = await db.query('SELECT * FROM settings');
  if (!settings.sending) return;

  const [{ count }] = await db.query(`SELECT count(*)::int AS count FROM responses WHERE sent_at > now() - interval '1 minute'`);
  if (count >= settings.sends_per_minute) return; // Stays queued for the next pass.

  const [before] = await db.query('SELECT state FROM leads WHERE id = $1', [leadId]);
  const resuming = before?.state === 'resume';

  // Only one worker can win this. A lead left in 'sending' means a crash.
  const [claimed] = await db.query(
    `UPDATE leads SET state = 'sending' WHERE id = $1 AND state IN ('queued', 'resume') RETURNING *`,
    [leadId],
  );
  if (!claimed) return;
  const lead = claimed;
  const [store] = await db.query('SELECT * FROM dealerships WHERE id = $1', [lead.dealership_id]);
  const [template] = await db.query('SELECT * FROM templates WHERE dealership_id = $1', [store.id]);

  const testMode = store.test_mode as boolean;
  const to = testMode ? settings.owner_test_email : store.passthrough;
  const missing = testMode ? 'No test inbox is saved in Settings.' : 'No CRM passthrough address is saved for this dealership.';
  try {
    assertSafeRecipient(to);
  } catch (error) {
    return fail(db, store, lead.id, to ? (error as Error).message : missing);
  }
  if (store.google_status !== 'ok') {
    return fail(db, store, lead.id, 'Google is not connected for this mailbox.');
  }

  const started = lead.received_at as Date;
  const vehicle = [lead.year, lead.make, lead.model, lead.trim].filter(Boolean).join(' ');
  const needsPhotos = Boolean(lead.vin) && !NON_VEHICLE_TYPES.includes(lead.lead_type);

  // Photos and wording run side by side. Each has a time limit, and if either
  // is slow or fails the reply simply goes out without it.
  const [photoResult, greetingResult] = await Promise.allSettled([
    needsPhotos
      ? photosFor(db, services, store.website, lead, settings.photo_timeout_seconds)
      : Promise.resolve({ photos: [] as string[], source: lead.vin ? 'Not needed' : 'No VIN' }),
    settings.model_enabled
      ? withTimeout(services.writeGreeting({ firstName: lead.first_name, vehicle }), settings.model_timeout_seconds)
      : Promise.resolve(''),
  ]);

  const photos = photoResult.status === 'fulfilled' ? photoResult.value.photos : [];
  const photoSource = photoResult.status === 'fulfilled' ? photoResult.value.source : 'Lookup failed';
  if (photoResult.status === 'rejected') {
    await event(db, lead.id, 'Photo search was slow or failed. Sent the reply without photos.', 'warn');
  } else if (needsPhotos) {
    await event(db, lead.id, photoSource === 'From cache' ? 'Photos found in cache, no Firecrawl credits used' : `Searched ${store.website} for the VIN. Found ${photos.length} photo${photos.length === 1 ? '' : 's'}`, photos.length ? '' : 'warn');
  } else if (!lead.vin && !NON_VEHICLE_TYPES.includes(lead.lead_type)) {
    await event(db, lead.id, 'No VIN in the lead. Used the fallback reply.', 'warn');
  } else {
    await event(db, lead.id, 'No vehicle photos needed for this lead type');
  }
  if (greetingResult.status === 'rejected') {
    await raiseAlert(db, { severity: 'fallback', title: 'Model reply failed', body: 'The model was slow or failed, so the standard reply went out.', link: '#controls', cta: 'Check settings' });
  }

  const reply = buildReply(
    { name: store.name, website: store.website, salesPhone: store.sales_phone, servicePhone: store.service_phone, address: store.address },
    { reasons: template?.reasons ?? '', buttons: template?.buttons ?? '', logoUrl: template?.logo_url ?? '', buildingPhotoUrl: template?.building_photo_url ?? '', links: template?.links ?? '' },
    { firstName: lead.first_name, year: lead.year, make: lead.make, model: lead.model, trim: lead.trim, vin: lead.vin, stock: lead.stock, leadType: lead.lead_type },
    photos,
    greetingResult.status === 'fulfilled' ? greetingResult.value : '',
  );
  const subject = replySubject(lead.subject);

  try {
    const already = resuming && (await services.wasSent(store.mailbox, lead.thread_id, to));
    if (!already) {
      assertSafeRecipient(to);
      await services.sendEmail(store.mailbox, {
        from: store.mailbox, to, subject, html: reply.html, text: reply.text,
        inReplyTo: lead.message_id, references: lead.message_id, threadId: lead.thread_id,
      });
    }
  } catch (error) {
    return fail(db, store, lead.id, (error as Error).message);
  }

  const sentAt = new Date();
  const seconds = (sentAt.getTime() - started.getTime()) / 1000;
  await db.query(
    `INSERT INTO responses (lead_id, kind, status, sent_at, seconds, from_address, to_address, subject, html, text_body, photo_count, photo_source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (lead_id) DO UPDATE SET kind=$2, status=$3, failure='', sent_at=$4, seconds=$5, from_address=$6, to_address=$7, subject=$8, html=$9, text_body=$10, photo_count=$11, photo_source=$12`,
    [lead.id, reply.kind, testMode ? 'test' : 'replied', sentAt, seconds, store.mailbox, to, subject, reply.html, reply.text, photos.length, photoSource],
  );
  await event(db, lead.id, `${testMode ? 'Test mode: reply sent to you only' : 'Reply sent to the CRM passthrough'} in ${seconds.toFixed(1)} seconds`);
  await db.query(`UPDATE leads SET state = 'done' WHERE id = $1`, [lead.id]);

  await sendTexts(db, services, store, settings, lead, vehicle, seconds, testMode);
}

async function sendTexts(db: Db, services: Services, store: any, settings: any, lead: any, vehicle: string, seconds: number, testMode: boolean) {
  const staffBody = staffText(store.staff_text_format === 'raw' ? 'raw' : 'formatted', store.name, lead);
  const targets: { to: string; audience: string; body: string }[] = testMode
    ? settings.owner_test_phone ? [{ to: settings.owner_test_phone, audience: 'staff', body: staffBody }] : []
    : (store.staff_phones as string[]).map((to) => ({ to, audience: 'staff', body: staffBody }));
  if (!testMode && settings.customer_texts && lead.phone) {
    targets.push({ to: lead.phone, audience: 'customer', body: `Hi ${lead.first_name}, thanks for contacting ${store.name}. Reply STOP to opt out.` });
  }
  const optedOut = new Set((await db.query('SELECT phone FROM opt_outs')).map((row) => normalizePhone(row.phone)));
  let sent = 0;
  let failed = 0;
  for (const target of targets) {
    const to = normalizePhone(target.to);
    let status = 'sent';
    let failure = '';
    let sid = '';
    if (!to) {
      status = 'failed';
      failure = 'Not a valid phone number';
    } else if (optedOut.has(to)) {
      // Never text a number that replied STOP. Logged so you can see why.
      status = 'opted out';
    } else {
      try {
        sid = String((await services.sendText(to, target.body)) ?? '');
        sent += 1;
      } catch (error) {
        status = 'failed';
        failure = (error as Error).message;
      }
    }
    if (status === 'failed') failed += 1;
    await db.query(
      'INSERT INTO text_messages (lead_id, recipient, audience, body, status, twilio_sid, failure) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [lead.id, to || target.to, target.audience, target.body, status, sid, failure],
    );
  }
  const noun = `${sent} text${sent === 1 ? '' : 's'}`;
  await event(db, lead.id, testMode ? `Test mode: ${noun} sent to you only` : `${noun} sent`);
  if (failed) {
    await event(db, lead.id, `${failed} text${failed === 1 ? '' : 's'} could not be sent`, 'warn');
    await raiseAlert(db, {
      dealershipId: store.id,
      severity: 'fallback',
      title: `Text failed: ${store.name}`,
      body: 'A lead text could not be sent. Open the lead to see why, and check the staff phone numbers.',
      link: `#dealership-${store.id}`,
      cta: 'Check numbers',
    });
  }
}

// Runs once at startup, before any new work: a lead still marked 'sending' at
// that moment can only have been cut off. Running this later would catch leads
// that are simply in progress and risk a second reply.
export async function recoverInterrupted(db: Db): Promise<void> {
  await db.query(`UPDATE leads SET state = 'resume' WHERE state = 'sending'`);
}

// Runs on a timer: finishes queued leads and any recovered after a restart.
export async function resumeLeads(db: Db, services: Services): Promise<void> {
  const pending = await db.query(`SELECT id FROM leads WHERE state IN ('queued', 'resume') ORDER BY received_at`);
  for (const { id } of pending) await answerLead(db, services, id);
}
