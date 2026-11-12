import type { Db } from './db.ts';
import type { AgentContext, AgentResult, AgentTools, HandoffReason } from './agent.ts';
import { assertSafeRecipient, raiseAlert } from './lead/pipeline.ts';
import type { Services } from './lead/pipeline.ts';
import { replySubject } from './lead/replyEmail.ts';
import { ZONE } from './monitor.ts';
import { normalizePhone } from './sms.ts';

// Conversations with customers after the first reply. Customers write in by
// text or email; Claude Haiku 5.5 answers while the conversation is in 'ai'
// mode, and staff can read every thread and take over at any time.

export type Channel = 'sms' | 'email';

// The connections conversations need on top of the lead pipeline's. Either
// missing means "not connected yet": the customer is handed to staff.
export interface ConversationServices extends Services {
  answerCustomer?: (context: AgentContext, tools: AgentTools) => Promise<AgentResult>;
  scrapeVehicle?: (website: string, vin: string) => Promise<{ text: string; url: string }>;
}

const REASON_TEXT: Record<HandoffReason, string> = {
  pricing: 'asked about price, payments or trade-in',
  asks_for_person: 'asked for a person',
  not_found: 'asked something the website doesn’t answer',
  off_topic: 'asked about something else',
  other: 'needs a person',
};
const SMS_LIMIT = 480;
const EMAIL_LIMIT = 2000;

export async function conversationFor(db: Db, leadId: number) {
  const [lead] = await db.query('SELECT id, dealership_id FROM leads WHERE id = $1', [leadId]);
  if (!lead) return null;
  await db.query('INSERT INTO conversations (lead_id, dealership_id) VALUES ($1, $2) ON CONFLICT (lead_id) DO NOTHING', [lead.id, lead.dealership_id]);
  const [conv] = await db.query('SELECT * FROM conversations WHERE lead_id = $1', [leadId]);
  return conv;
}

export async function recordMessage(db: Db, conversationId: number, m: { direction: 'in' | 'out'; channel: Channel; author: string; body: string; status?: string; sentTo?: string }) {
  await db.query(
    'INSERT INTO messages (conversation_id, direction, channel, author, body, status, sent_to) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [conversationId, m.direction, m.channel, m.author, m.body, m.status ?? 'sent', m.sentTo ?? ''],
  );
  await db.query('UPDATE conversations SET updated_at = now(), unread = unread OR $2 WHERE id = $1', [conversationId, m.direction === 'in']);
}

// Texts every staff number for the store (in test mode, only the owner).
async function textStaff(db: Db, services: Services, store: any, body: string) {
  const [settings] = await db.query('SELECT owner_test_phone FROM settings');
  const numbers = store.test_mode ? [settings.owner_test_phone] : (store.staff_phones as string[]);
  const optedOut = new Set((await db.query('SELECT phone FROM opt_outs')).map((r) => r.phone));
  for (const raw of numbers) {
    const to = normalizePhone(raw);
    if (!to || optedOut.has(to)) continue;
    try { await services.sendText(to, body); } catch { /* the alert below still reaches the dashboard */ }
  }
}

async function loadThread(db: Db, conversationId: number) {
  const [conv] = await db.query('SELECT * FROM conversations WHERE id = $1', [conversationId]);
  const [lead] = await db.query('SELECT * FROM leads WHERE id = $1', [conv.lead_id]);
  const [store] = await db.query('SELECT * FROM dealerships WHERE id = $1', [conv.dealership_id]);
  const messages = await db.query('SELECT * FROM messages WHERE conversation_id = $1 ORDER BY id', [conversationId]);
  return { conv, lead, store, messages };
}

// Sends one message to the customer on a channel, with every safety rule:
// test mode goes to the owner only, opted-out numbers are never texted, and
// email never goes to the CRM's notification sender.
export async function sendToCustomer(db: Db, services: Services, conversationId: number, channel: Channel, author: string, body: string) {
  const { lead, store } = await loadThread(db, conversationId);
  const [settings] = await db.query('SELECT * FROM settings');
  const text = body.trim().slice(0, channel === 'sms' ? SMS_LIMIT : EMAIL_LIMIT);
  if (!text) throw new Error('The message is empty.');
  let to = '';
  if (channel === 'sms') {
    to = normalizePhone(store.test_mode ? settings.owner_test_phone : lead.phone);
    if (!to) throw new Error(store.test_mode ? 'No test phone is saved in Settings.' : 'This customer has no valid phone number.');
    const [opted] = await db.query('SELECT 1 FROM opt_outs WHERE phone = $1', [to]);
    if (opted) throw new Error('This number replied STOP, so it can’t be texted.');
    await services.sendText(to, text);
  } else {
    // Email follow-ups go the same way as the first reply: through the CRM's
    // passthrough address, so the CRM logs them and delivers them.
    to = store.test_mode ? settings.owner_test_email : store.passthrough;
    assertSafeRecipient(to);
    await services.sendEmail(store.mailbox, {
      from: store.mailbox, to, subject: replySubject(lead.subject), html: `<p>${text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`).replace(/\n/g, '<br>')}</p>`, text,
      inReplyTo: lead.message_id, references: lead.message_id, threadId: lead.thread_id,
    });
  }
  await recordMessage(db, conversationId, { direction: 'out', channel, author, body: text, sentTo: to });
}

async function handOff(db: Db, services: Services, conversationId: number, reason: HandoffReason, summary: string) {
  const { conv, lead, store } = await loadThread(db, conversationId);
  if (conv.status === 'staff') return;
  await db.query(`UPDATE conversations SET status = 'staff', handoff_reason = $2 WHERE id = $1`, [conversationId, reason]);
  const who = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || 'A customer';
  await textStaff(db, services, store, `${store.name}: ${who} ${REASON_TEXT[reason]}. ${summary} Open Conversations in the ETA dashboard to reply.`.slice(0, 480));
  await raiseAlert(db, {
    dealershipId: store.id, severity: 'fallback', title: `Customer needs a person: ${store.name}`,
    body: `${who} ${REASON_TEXT[reason]}. ${summary}`, link: `#conversation-${conversationId}`, cta: 'Open conversation',
  });
}

function arizonaToday(): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: ZONE, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date());
}

// Claude answers the customer's latest message. Any failure hands the
// customer to staff instead of leaving them without an answer.
export async function answerWithAi(db: Db, services: ConversationServices, conversationId: number, channel: Channel) {
  const { conv, lead, store, messages } = await loadThread(db, conversationId);
  const [settings] = await db.query('SELECT * FROM settings');
  if (conv.status !== 'ai' || !settings.sending || !settings.ai_conversations || !store.active) return;
  if (!services.answerCustomer) return handOff(db, services, conversationId, 'other', 'Claude isn’t connected yet, so this reply needs a person.');

  const vehicle = [lead.year, lead.make, lead.model, lead.trim].filter(Boolean).join(' ');
  const context: AgentContext = {
    channel,
    today: arizonaToday(),
    dealership: { name: store.name, website: store.website, salesPhone: store.sales_phone, servicePhone: store.service_phone, address: store.address },
    lead: { firstName: lead.first_name, vehicle, vin: lead.vin, stock: lead.stock, leadType: lead.lead_type },
    history: messages.map((m: any) => ({ from: m.direction === 'in' ? 'customer' as const : 'dealership' as const, text: m.body })),
  };
  const tools: AgentTools = {
    vehicleDetails: async () => {
      if (!lead.vin) return 'This lead has no VIN, so there is no vehicle page to read.';
      if (!services.scrapeVehicle) return 'The vehicle page can’t be read right now.';
      const page = await services.scrapeVehicle(store.website, lead.vin);
      return `Page: ${page.url}\n\n${page.text.slice(0, 12000)}`;
    },
    acceptAppointment: async ({ when, isoStart, kind }) => {
      const start = isoStart && !Number.isNaN(Date.parse(isoStart)) ? new Date(isoStart) : null;
      await db.query('INSERT INTO appointments (lead_id, dealership_id, kind, when_text, starts_at) VALUES ($1, $2, $3, $4, $5)', [lead.id, store.id, kind, when.slice(0, 120), start]);
      const who = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || 'A customer';
      await textStaff(db, services, store, `${store.name}: ${kind} booked. ${who}, ${when}, ${vehicle || 'vehicle not given'}. Phone ${lead.phone || 'not given'}.`);
      await raiseAlert(db, { dealershipId: store.id, severity: 'fallback', title: `New ${kind}: ${store.name}`, body: `${who} is coming in ${when} for the ${vehicle || 'vehicle'}.`, link: `#conversation-${conversationId}`, cta: 'Open conversation' });
      return `Accepted: ${kind} on ${when}. Staff have been told. Confirm it to the customer.`;
    },
    handOff: async ({ reason, summary }) => {
      await handOff(db, services, conversationId, reason, summary);
      return 'Staff have been told. Tell the customer a team member will follow up shortly.';
    },
  };

  let result: AgentResult;
  try {
    result = await services.answerCustomer(context, tools);
  } catch (error) {
    return handOff(db, services, conversationId, 'other', `Claude couldn’t answer (${(error as Error).message}).`);
  }
  const reply = result.reply.trim();
  // Last checks on what Claude wrote: no prices, and no links except the dealership's own site.
  const site = store.website.replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
  const links = reply.match(/https?:\/\/[^\s]+|www\.[^\s]+/gi) ?? [];
  if (!reply) return result.handedOff ? undefined : handOff(db, services, conversationId, 'other', 'Claude had no answer.');
  if (/\$\s?\d/.test(reply) || links.some((l) => !site || !l.toLowerCase().includes(site))) {
    return handOff(db, services, conversationId, 'other', 'Claude’s answer was held back by the app’s safety checks.');
  }
  try {
    await sendToCustomer(db, services, conversationId, channel, 'ai', reply);
  } catch (error) {
    await raiseAlert(db, { dealershipId: store.id, severity: 'failed', title: `Reply not sent: ${store.name}`, body: (error as Error).message, link: `#conversation-${conversationId}`, cta: 'Open conversation' });
  }
}

// One customer at a time per conversation, so two quick messages don't get two
// overlapping answers.
const queues = new Map<number, Promise<void>>();
function inTurn(conversationId: number, work: () => Promise<void>) {
  const next = (queues.get(conversationId) ?? Promise.resolve()).then(work, work);
  queues.set(conversationId, next.catch(() => {}));
  return next;
}

// A text from a customer. Matched to their most recent lead by phone number.
export async function receiveCustomerText(db: Db, services: ConversationServices, from: string, body: string) {
  const phone = normalizePhone(from);
  if (!phone || !body.trim()) return null;
  const leads = await db.query(`SELECT id, phone FROM leads WHERE received_at > now() - interval '60 days' ORDER BY received_at DESC LIMIT 2000`);
  const lead = leads.find((l: any) => normalizePhone(l.phone) === phone);
  // In test mode the "customer" is the owner's own phone: match the newest test-mode lead.
  let leadId = lead?.id;
  if (!leadId) {
    const [settings] = await db.query('SELECT owner_test_phone FROM settings');
    if (normalizePhone(settings.owner_test_phone) === phone) {
      [{ id: leadId } = { id: undefined }] = await db.query(`SELECT l.id FROM leads l JOIN dealerships d ON d.id = l.dealership_id WHERE d.test_mode ORDER BY l.received_at DESC LIMIT 1`);
    }
  }
  if (!leadId) return null;
  return receiveCustomerMessage(db, services, leadId, 'sms', body);
}

export async function receiveCustomerMessage(db: Db, services: ConversationServices, leadId: number, channel: Channel, body: string) {
  const conv = await conversationFor(db, leadId);
  if (!conv) return null;
  await recordMessage(db, conv.id, { direction: 'in', channel, author: 'customer', body: body.trim().slice(0, 4000), status: 'received' });
  if (conv.status === 'closed') await db.query(`UPDATE conversations SET status = 'ai' WHERE id = $1`, [conv.id]);
  await inTurn(conv.id, () => answerWithAi(db, services, conv.id, channel));
  return conv.id as number;
}

// Staff take over, hand back to Claude, or close a conversation.
export async function setConversationStatus(db: Db, conversationId: number, status: 'ai' | 'staff' | 'closed') {
  await db.query(`UPDATE conversations SET status = $2, handoff_reason = CASE WHEN $2 = 'ai' THEN '' ELSE handoff_reason END WHERE id = $1`, [conversationId, status]);
}
