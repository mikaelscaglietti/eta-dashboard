import { createHmac, timingSafeEqual } from 'node:crypto';

// Turns what people type ("480-555-0100", "(480) 555 0100", "+1 480...") into
// the one format Twilio uses (+14805550100), so opt-outs always match.
// Returns '' when it can't be a phone number. Numbers without a country code
// are treated as US/Canada.
export function normalizePhone(input: string): string {
  const raw = String(input ?? '').trim();
  const digits = raw.replace(/\D/g, '');
  if (raw.startsWith('+')) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : '';
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return '';
}

// Twilio's standard opt-out and opt-in words.
const STOP_WORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'OPTOUT', 'REVOKE']);
const START_WORDS = new Set(['START', 'YES', 'UNSTOP']);

export function optKeyword(body: string): 'stop' | 'start' | null {
  const word = String(body ?? '').trim().toUpperCase().replace(/[^A-Z]/g, '');
  if (STOP_WORDS.has(word)) return 'stop';
  if (START_WORDS.has(word)) return 'start';
  return null;
}

// Twilio signs every request it sends us with the account's auth token. The
// signature covers the full address it called plus every form field, so a
// stranger can't fake a STOP or a delivery update.
export function twilioSignature(authToken: string, url: string, params: Record<string, unknown>): string {
  const data = Object.keys(params).sort().reduce((text, key) => text + key + String(params[key] ?? ''), url);
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

export function isGenuineTwilioRequest(
  authToken: string,
  url: string,
  params: Record<string, unknown>,
  signature: string | undefined,
): boolean {
  if (!signature) return false;
  const expected = Buffer.from(twilioSignature(authToken, url, params));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export interface TwilioSettings {
  accountSid: string;
  authToken: string;
  // Either a phone number (+1...) or a Messaging Service ID (MG...).
  from: string;
  // The app's public address, like https://app.etarsp.com. Used for delivery updates.
  publicUrl: string;
}

// Sends one text and returns Twilio's message ID.
export function twilioSender(settings: TwilioSettings, fetchImpl: typeof fetch = fetch) {
  const endpoint = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(settings.accountSid)}/Messages.json`;
  const auth = Buffer.from(`${settings.accountSid}:${settings.authToken}`).toString('base64');
  return async function sendText(to: string, body: string): Promise<string> {
    const form = new URLSearchParams({ To: to, Body: body, StatusCallback: `${settings.publicUrl}/twilio/status` });
    if (settings.from.startsWith('MG')) form.set('MessagingServiceSid', settings.from);
    else form.set('From', settings.from);
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { authorization: `Basic ${auth}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
      signal: AbortSignal.timeout(10_000),
    });
    const data: any = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Twilio refused the text: ${data.message || response.status}`);
    return String(data.sid ?? '');
  };
}

// Last four characters only: the dashboard never sees the full number or ID.
export const lastFour = (value: string) => (value ? `•••${value.slice(-4)}` : '');
