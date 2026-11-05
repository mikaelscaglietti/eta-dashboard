import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from './db.ts';
import { raiseAlert } from './lead/pipeline.ts';
import { isGenuineTwilioRequest, normalizePhone, optKeyword } from './sms.ts';
import type { TwilioSettings } from './sms.ts';

// The addresses Twilio calls. They can't use the dashboard login, so each
// request must carry Twilio's signature instead.
export const TWILIO_PATHS = ['/twilio/sms', '/twilio/status'];

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

// Delivery updates can arrive out of order. A later step never goes backwards.
const STEP: Record<string, number> = { accepted: 1, queued: 1, sending: 1, sent: 2, delivered: 3, undelivered: 3, failed: 3 };
// Twilio error 21610: the person has already replied STOP to this sender.
const UNSUBSCRIBED = '21610';

export function registerTwilio(app: FastifyInstance, db: Db, twilio: TwilioSettings | undefined) {
  // Not set up yet: the addresses don't exist, so nothing can be faked.
  if (!twilio) return;

  const genuine = (request: FastifyRequest, reply: FastifyReply) => {
    const params = (request.body ?? {}) as Record<string, unknown>;
    const url = twilio.publicUrl + request.url;
    const signature = request.headers['x-twilio-signature'];
    if (isGenuineTwilioRequest(twilio.authToken, url, params, typeof signature === 'string' ? signature : undefined)) {
      return params;
    }
    request.log.warn('Refused a request that did not carry a valid Twilio signature');
    void reply.code(403).send('Forbidden');
    return null;
  };

  // A text sent to our number. Only STOP and START words change anything.
  app.post('/twilio/sms', async (request, reply) => {
    const params = genuine(request, reply);
    if (!params) return reply;
    const phone = normalizePhone(String(params.From ?? ''));
    const optType = String(params.OptOutType ?? '').toLowerCase();
    const keyword = optType === 'stop' || optType === 'start' ? optType : optKeyword(String(params.Body ?? ''));
    if (phone && keyword === 'stop') await optOut(db, phone);
    if (phone && keyword === 'start') await db.query('DELETE FROM opt_outs WHERE phone = $1', [phone]);
    // Twilio sends the standard STOP/START confirmation itself, so we answer with nothing.
    return reply.type('text/xml').send(EMPTY_TWIML);
  });

  // Delivery updates for texts we sent.
  app.post('/twilio/status', async (request, reply) => {
    const params = genuine(request, reply);
    if (!params) return reply;
    const sid = String(params.MessageSid ?? '');
    const status = String(params.MessageStatus ?? '').toLowerCase();
    const errorCode = String(params.ErrorCode ?? '');
    const [text] = sid ? await db.query('SELECT * FROM text_messages WHERE twilio_sid = $1', [sid]) : [];
    if (text && STEP[status] && STEP[status] >= (STEP[text.status] ?? 0)) {
      const failure = errorCode ? `Twilio error ${errorCode}` : '';
      await db.query('UPDATE text_messages SET status = $2, failure = $3 WHERE id = $1', [text.id, status, failure]);
      if (errorCode === UNSUBSCRIBED) await optOut(db, normalizePhone(text.recipient));
      if (status === 'failed' || status === 'undelivered') {
        const [lead] = await db.query('SELECT dealership_id FROM leads WHERE id = $1', [text.lead_id]);
        await raiseAlert(db, {
          dealershipId: lead?.dealership_id,
          severity: 'fallback',
          title: 'A lead text was not delivered',
          body: `The text to ${text.recipient} was not delivered${errorCode ? ` (Twilio error ${errorCode})` : ''}.`,
          link: lead ? `#dealership-${lead.dealership_id}` : '#alerts',
          cta: 'Check numbers',
        });
      }
    }
    return reply.code(204).send();
  });
}

async function optOut(db: Db, phone: string) {
  if (!phone) return;
  const [added] = await db.query('INSERT INTO opt_outs (phone) VALUES ($1) ON CONFLICT DO NOTHING RETURNING phone', [phone]);
  if (!added) return;
  // A staff member who opts out stops getting lead alerts, which the owner needs to know.
  const stores = await db.query('SELECT id, name, staff_phones FROM dealerships');
  for (const store of stores) {
    if ((store.staff_phones as string[]).some((number) => normalizePhone(number) === phone)) {
      await raiseAlert(db, {
        dealershipId: store.id,
        severity: 'fallback',
        title: `Staff number opted out: ${store.name}`,
        body: `${phone} replied STOP and will no longer get lead texts. They can reply START to turn texts back on.`,
        link: `#dealership-${store.id}`,
        cta: 'Review',
      });
    }
  }
}
