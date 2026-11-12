import type { FastifyInstance } from 'fastify';
import type { Db } from './db.ts';
import { receiveCustomerMessage, sendToCustomer, setConversationStatus } from './conversations.ts';
import type { Channel, ConversationServices } from './conversations.ts';

export function registerConversations(app: FastifyInstance, db: Db, services: ConversationServices, dev: boolean) {
  app.get('/api/conversations', async () => {
    return db.query(
      `SELECT c.id, c.lead_id, c.status, c.handoff_reason, c.unread, c.updated_at, d.name AS dealer, d.test_mode,
              l.first_name, l.last_name, l.phone, l.email, l.year, l.make, l.model, l.trim,
              (SELECT body FROM messages m WHERE m.conversation_id = c.id ORDER BY id DESC LIMIT 1) AS last_body,
              (SELECT direction FROM messages m WHERE m.conversation_id = c.id ORDER BY id DESC LIMIT 1) AS last_direction,
              (SELECT count(*)::int FROM messages m WHERE m.conversation_id = c.id AND m.direction = 'in') AS customer_messages,
              (SELECT when_text FROM appointments a WHERE a.lead_id = c.lead_id ORDER BY id DESC LIMIT 1) AS appointment
         FROM conversations c JOIN leads l ON l.id = c.lead_id JOIN dealerships d ON d.id = c.dealership_id
        ORDER BY c.updated_at DESC LIMIT 500`,
    );
  });

  app.get<{ Params: { id: string } }>('/api/conversations/:id', async (request, reply) => {
    const id = Number(request.params.id);
    const [conv] = await db.query('SELECT * FROM conversations WHERE id = $1', [id]);
    if (!conv) return reply.code(404).send({ error: 'That conversation no longer exists.' });
    await db.query('UPDATE conversations SET unread = FALSE WHERE id = $1', [id]);
    const [messages, appointments] = await Promise.all([
      db.query('SELECT id, direction, channel, author, body, status, sent_to, at FROM messages WHERE conversation_id = $1 ORDER BY id', [id]),
      db.query('SELECT kind, when_text, starts_at, created_at FROM appointments WHERE lead_id = $1 ORDER BY id', [conv.lead_id]),
    ]);
    return { ...conv, unread: false, messages, appointments };
  });

  // A staff member writes to the customer. Taking part in the conversation
  // takes it over from Claude, so the two never answer at the same time.
  app.post<{ Params: { id: string }; Body: { channel?: string; body?: string } }>('/api/conversations/:id/reply', async (request, reply) => {
    const id = Number(request.params.id);
    const channel: Channel = request.body?.channel === 'email' ? 'email' : 'sms';
    const body = String(request.body?.body ?? '').trim();
    if (!body) return reply.code(400).send({ error: 'Write a message first.' });
    try {
      await setConversationStatus(db, id, 'staff');
      await sendToCustomer(db, services, id, channel, 'staff', body);
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message });
    }
    return { ok: true };
  });

  app.post<{ Params: { id: string }; Body: { status?: string } }>('/api/conversations/:id/status', async (request, reply) => {
    const status = request.body?.status;
    if (status !== 'ai' && status !== 'staff' && status !== 'closed') return reply.code(400).send({ error: 'Unknown status.' });
    await setConversationStatus(db, Number(request.params.id), status);
    return { ok: true };
  });

  // Only on your computer: pretend the customer wrote back, to try Claude out.
  if (dev) {
    app.post<{ Body: { leadId?: number; channel?: string; body?: string } }>('/api/dev/customer-reply', async (request, reply) => {
      const body = String(request.body?.body ?? '').trim();
      if (!body) return reply.code(400).send({ error: 'Write the customer’s message first.' });
      const id = await receiveCustomerMessage(db, services, Number(request.body?.leadId), request.body?.channel === 'email' ? 'email' : 'sms', body);
      if (!id) return reply.code(404).send({ error: 'That lead no longer exists.' });
      return { id };
    });
  }
}
