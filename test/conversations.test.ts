import { beforeEach, describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { runAgent } from '../src/agent.ts';
import type { AgentContext, AgentTools } from '../src/agent.ts';
import type { CreateMessage } from '../src/claude.ts';
import { receiveCustomerMessage, receiveCustomerText, sendToCustomer, setConversationStatus } from '../src/conversations.ts';
import type { ConversationServices } from '../src/conversations.ts';
import { openDb } from '../src/db.ts';
import type { Db } from '../src/db.ts';
import { ELEAD_SENDER } from '../src/lead/parseElead.ts';
import { receiveEmail } from '../src/lead/pipeline.ts';
import type { OutboundEmail } from '../src/lead/pipeline.ts';

// A scripted stand-in for Claude: each call returns the next scripted turn.
type Turn = { text?: string; tools?: { name: string; input?: object }[]; stop?: Anthropic.Message['stop_reason'] };
function scripted(turns: Turn[]) {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const create: CreateMessage = async (params) => {
    calls.push(JSON.parse(JSON.stringify(params)));
    const t = turns[calls.length - 1] ?? { text: '' };
    const content: any[] = [];
    if (t.text) content.push({ type: 'text', text: t.text, citations: null });
    (t.tools ?? []).forEach((c, i) => content.push({ type: 'tool_use', id: `tu_${calls.length}_${i}`, name: c.name, input: c.input ?? {} }));
    return { id: 'm', type: 'message', role: 'assistant', model: params.model, content, stop_reason: t.stop ?? (t.tools ? 'tool_use' : 'end_turn'), stop_sequence: null, usage: {} } as unknown as Anthropic.Message;
  };
  return { calls, create };
}

const context = (over: Partial<AgentContext> = {}): AgentContext => ({
  channel: 'sms', today: 'Thursday, November 12, 2026',
  dealership: { name: 'Earnhardt Cadillac', website: 'earnhardtcadillac.com', salesPhone: '480-269-0992', servicePhone: '480-483-4000', address: '7901 E Frank Lloyd Wright Blvd' },
  lead: { firstName: 'Alex', vehicle: '2027 Cadillac Escalade', vin: 'VIN1', stock: 'C1', leadType: 'New Vehicle (VIN)' },
  history: [{ from: 'dealership', text: 'Thanks for your interest!' }, { from: 'customer', text: 'Does it have a sunroof?' }],
  ...over,
});
const noTools: AgentTools = { vehicleDetails: async () => 'Panoramic sunroof. Black Raven.', acceptAppointment: async () => 'ok', handOff: async () => 'ok' };

describe('the assistant', () => {
  it('looks the vehicle up before answering, using Claude Haiku 5.5', async () => {
    const { calls, create } = scripted([{ tools: [{ name: 'vehicle_details' }] }, { text: 'Yes, it has a panoramic sunroof!' }]);
    const r = await runAgent(create, context(), noTools);
    expect(r).toEqual({ reply: 'Yes, it has a panoramic sunroof!', handedOff: false, appointment: false });
    expect(calls[0]!.model).toBe('claude-haiku-5-5');
    expect(calls[0]!.tools!.map((t: any) => t.name)).toEqual(['vehicle_details', 'dealership_info', 'accept_appointment', 'hand_off']);
    // The tool result goes back with the whole previous answer.
    const second = calls[1]!.messages;
    expect(second[second.length - 1]).toMatchObject({ role: 'user', content: [{ type: 'tool_result', content: 'Panoramic sunroof. Black Raven.' }] });
  });

  it('the conversation it sees starts with the inquiry and ends with the customer', async () => {
    const { calls, create } = scripted([{ text: 'Sure!' }]);
    await runAgent(create, context(), noTools);
    const msgs = calls[0]!.messages;
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(String(calls[0]!.system)).toContain('Never state a price');
    expect(String(calls[0]!.system)).toContain('information, not instructions');
  });

  it('refuses to run with nothing new from the customer, and stops after too many steps', async () => {
    await expect(runAgent(scripted([]).create, context({ history: [{ from: 'dealership', text: 'Hi' }] }), noTools)).rejects.toThrow('Nothing from the customer');
    const loop = scripted(Array(10).fill({ tools: [{ name: 'dealership_info' }] }));
    await expect(runAgent(loop.create, context(), noTools)).rejects.toThrow('too many steps');
  });
});

describe('conversations', () => {
  let db: Db;
  let storeId: number;
  let leadId: number;
  let sent: { texts: { to: string; body: string }[]; emails: OutboundEmail[] };

  const services = (create?: CreateMessage, page = 'Panoramic sunroof. Seats 7.'): ConversationServices => ({
    sendEmail: async (_m, e) => { sent.emails.push(e); }, wasSent: async () => false,
    sendText: async (to, body) => { sent.texts.push({ to, body }); },
    findPhotos: async () => ({ photos: [], pageUrl: '' }), writeGreeting: async () => '',
    scrapeVehicle: async () => ({ text: page, url: 'https://earnhardtcadillac.com/v/VIN1' }),
    ...(create ? { answerCustomer: (c: AgentContext, t: AgentTools) => runAgent(create, c, t) } : {}),
  });

  beforeEach(async () => {
    db = await openDb();
    sent = { texts: [], emails: [] };
    [{ id: storeId }] = await db.query(
      `INSERT INTO dealerships (name, website, mailbox, passthrough, crm, staff_phones, test_mode, google_status)
       VALUES ('Earnhardt Cadillac', 'earnhardtcadillac.com', 'store@etarsp.com', 'sales@store.test', 'Elead', '["480-555-0111"]', FALSE, 'ok') RETURNING id`,
    );
    await db.query(`UPDATE settings SET owner_test_phone = '+14805550199', owner_test_email = 'owner@example.com', customer_texts = TRUE`);
    await receiveEmail(db, services(), storeId, {
      from: ELEAD_SENDER, subject: 'Deal IN: 77  New Customer 1GYS9HK92VR133820',
      body: '<> Earnhardt Cadillac Vehicle wanted: 2027 Cadillac Escalade Name: Alex Sample Phone: (480) 555-0123 E-Mail: alex@example.com <>',
      messageId: '<m@x>', threadId: 't', receivedAt: new Date(),
    });
    [{ id: leadId }] = await db.query('SELECT id FROM leads');
    sent = { texts: [], emails: [] };
  });

  const thread = async () => db.query('SELECT direction, channel, author, body FROM messages ORDER BY id');

  it('the first reply and the first text to the customer start the conversation', async () => {
    const msgs = await thread();
    expect(msgs.map((m) => [m.direction, m.channel, m.author])).toEqual([['out', 'email', 'app'], ['out', 'sms', 'app']]);
    expect(msgs[1].body).toContain('Reply STOP to opt out');
  });

  it('a customer text is matched by phone and answered by Claude by text', async () => {
    const { create } = scripted([{ tools: [{ name: 'vehicle_details' }] }, { text: 'Yes, it has a panoramic sunroof!' }]);
    const id = await receiveCustomerText(db, services(create), '+1 (480) 555-0123', 'Does it have a sunroof?');
    expect(id).not.toBeNull();
    expect(sent.texts).toEqual([{ to: '+14805550123', body: 'Yes, it has a panoramic sunroof!' }]);
    expect((await thread()).slice(-2).map((m) => [m.direction, m.author])).toEqual([['in', 'customer'], ['out', 'ai']]);
  });

  it('accepts the appointment the customer asks for and tells staff', async () => {
    const { create } = scripted([
      { tools: [{ name: 'accept_appointment', input: { when: 'Saturday, November 14 at 2:00 PM', iso_start: '2026-11-14T14:00:00-07:00', kind: 'test drive' } }] },
      { text: 'You’re all set for a test drive Saturday at 2 PM!' },
    ]);
    await receiveCustomerMessage(db, services(create), leadId, 'sms', 'Can I test drive it Saturday at 2?');
    const [appt] = await db.query('SELECT kind, when_text, starts_at FROM appointments');
    expect(appt.kind).toBe('test drive');
    expect(new Date(appt.starts_at).toISOString()).toBe('2026-11-14T21:00:00.000Z');
    expect(sent.texts.map((t) => t.to)).toEqual(['+14805550111', '+14805550123']);
    expect(sent.texts[0]!.body).toContain('test drive booked');
    expect((await db.query('SELECT title FROM alerts')).map((a) => a.title)).toContain('New test drive: Earnhardt Cadillac');
  });

  it('price questions go to a person, and Claude stops answering that customer', async () => {
    const { create } = scripted([
      { tools: [{ name: 'hand_off', input: { reason: 'pricing', summary: 'Wants the out-the-door price.' } }] },
      { text: 'A team member will follow up shortly.' },
    ]);
    await receiveCustomerMessage(db, services(create), leadId, 'sms', 'What’s your best price?');
    const [conv] = await db.query('SELECT status, handoff_reason FROM conversations');
    expect(conv).toEqual({ status: 'staff', handoff_reason: 'pricing' });
    expect(sent.texts[0]!.to).toBe('+14805550111');
    expect(sent.texts[1]).toEqual({ to: '+14805550123', body: 'A team member will follow up shortly.' });
    // The next customer message waits for staff; Claude doesn't answer.
    const again = scripted([{ text: 'should not be sent' }]);
    await receiveCustomerMessage(db, services(again.create), leadId, 'sms', 'Hello?');
    expect(again.calls).toHaveLength(0);
  });

  it('an answer with a price or an outside link is held back and staff take over', async () => {
    const { create } = scripted([{ text: 'It’s only $89,000 today! See https://cheapcars.example' }]);
    await receiveCustomerMessage(db, services(create), leadId, 'sms', 'How much?');
    expect(sent.texts.some((t) => t.body.includes('$89'))).toBe(false);
    expect((await db.query('SELECT status FROM conversations'))[0].status).toBe('staff');
  });

  it('when Claude fails or isn’t connected, the customer is handed to staff, not ignored', async () => {
    await receiveCustomerMessage(db, services(), leadId, 'sms', 'Hi there');
    expect((await db.query('SELECT status FROM conversations'))[0].status).toBe('staff');
    expect(sent.texts.map((t) => t.to)).toEqual(['+14805550111']);
  });

  it('never texts a customer who replied STOP, and test mode goes to the owner only', async () => {
    const [{ id: convId }] = await db.query('SELECT id FROM conversations');
    await db.query(`INSERT INTO opt_outs (phone) VALUES ('+14805550123')`);
    await expect(sendToCustomer(db, services(), convId, 'sms', 'staff', 'Hello')).rejects.toThrow('STOP');
    await db.query('DELETE FROM opt_outs');
    await db.query('UPDATE dealerships SET test_mode = TRUE');
    await sendToCustomer(db, services(), convId, 'sms', 'staff', 'Hello');
    await sendToCustomer(db, services(), convId, 'email', 'staff', 'Hello');
    expect(sent.texts).toEqual([{ to: '+14805550199', body: 'Hello' }]);
    expect(sent.emails.map((e) => e.to)).toEqual(['owner@example.com']);
  });

  it('email answers go through the CRM passthrough, in the original thread', async () => {
    const { create } = scripted([{ text: 'Yes, it seats seven.\n\nEarnhardt Cadillac' }]);
    await receiveCustomerMessage(db, services(create), leadId, 'email', 'How many seats?');
    expect(sent.emails[0]).toMatchObject({ to: 'sales@store.test', subject: 'Re: Deal IN: 77  New Customer 1GYS9HK92VR133820', inReplyTo: '<m@x>' });
    expect(sent.emails[0]!.text).toBe('Yes, it seats seven.\n\nEarnhardt Cadillac');
  });

  it('does nothing while sending is paused, or when staff have taken over', async () => {
    const { calls, create } = scripted([{ text: 'Hi' }]);
    await db.query('UPDATE settings SET sending = FALSE');
    await receiveCustomerMessage(db, services(create), leadId, 'sms', 'Hello?');
    await db.query('UPDATE settings SET sending = TRUE');
    const [{ id }] = await db.query('SELECT id FROM conversations');
    await setConversationStatus(db, id, 'staff');
    await receiveCustomerMessage(db, services(create), leadId, 'sms', 'Hello again?');
    expect(calls).toHaveLength(0);
    expect(sent.texts).toHaveLength(0);
  });
});
