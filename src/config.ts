export interface Config {
  ownerEmail: string;
  ownerPasswordHash: string;
  sessionSecret: string;
  port: number;
  production: boolean;
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
  };
}
