import type { TwilioSettings } from './sms.ts';

export interface Config {
  ownerEmail: string;
  ownerPasswordHash: string;
  sessionSecret: string;
  port: number;
  production: boolean;
  // Present only when all Twilio settings are filled in. Until then, no text can leave.
  twilio?: TwilioSettings;
}

const TWILIO_KEYS = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM', 'PUBLIC_URL'] as const;

function loadTwilio(env: Record<string, string | undefined>): TwilioSettings | undefined {
  const values = TWILIO_KEYS.map((key) => env[key]?.trim() ?? '');
  if (values.every((value) => !value)) return undefined;
  const missing = TWILIO_KEYS.filter((_, i) => !values[i]);
  // Half-filled settings are a mistake, so say so instead of quietly sending nothing.
  if (missing.length) throw new Error(`Twilio is partly set up. Also set: ${missing.join(', ')}.`);
  const [accountSid, authToken, from, publicUrl] = values as [string, string, string, string];
  if (!/^AC[0-9a-f]{32}$/i.test(accountSid)) throw new Error('TWILIO_ACCOUNT_SID should start with AC followed by 32 letters and numbers.');
  if (!/^(\+\d{8,15}|MG[0-9a-f]{32})$/i.test(from)) throw new Error('TWILIO_FROM should be a phone number like +14805550100 or a Messaging Service ID starting with MG.');
  if (!/^https:\/\/[^/]+/.test(publicUrl)) throw new Error('PUBLIC_URL should be the app’s https address, like https://app.etarsp.com.');
  return { accountSid, authToken, from, publicUrl: publicUrl.replace(/\/+$/, '') };
}

// Refuses to start with missing or weak settings, so a bad deploy fails
// loudly instead of running without a working login.
export function loadConfig(env: Record<string, string | undefined>): Config {
  const ownerEmail = env.OWNER_EMAIL?.trim().toLowerCase();
  const ownerPasswordHash = env.OWNER_PASSWORD_HASH?.trim();
  const sessionSecret = env.SESSION_SECRET?.trim();

  if (!ownerEmail) throw new Error('OWNER_EMAIL is not set.');
  if (!ownerPasswordHash) throw new Error('OWNER_PASSWORD_HASH is not set.');
  if (!sessionSecret || sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters.');
  }

  return {
    ownerEmail,
    ownerPasswordHash,
    sessionSecret,
    port: Number(env.PORT) || 3000,
    production: env.NODE_ENV === 'production',
    twilio: loadTwilio(env),
  };
}
