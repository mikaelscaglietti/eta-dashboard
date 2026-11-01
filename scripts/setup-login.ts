// Creates the .env file with your dashboard login. Run: npm run setup-login
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { hashPassword } from '../src/auth.ts';

// Lowered for local testing at the owner's request. Raise before going live.
const MIN_PASSWORD_LENGTH = 8;

const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
async function ask(question: string): Promise<string> {
  process.stdout.write(question);
  const { value } = await lines.next();
  return String(value ?? '').trim();
}

const email = await ask('Email for signing in: ');
const password = await ask(`Choose a password (at least ${MIN_PASSWORD_LENGTH} characters): `);
process.stdin.pause();

if (!email.includes('@')) throw new Error('That does not look like an email address.');
if (password.length < MIN_PASSWORD_LENGTH) {
  throw new Error(`The password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
}

const managed: Record<string, string> = {
  OWNER_EMAIL: email,
  OWNER_PASSWORD_HASH: hashPassword(password),
  SESSION_SECRET: randomBytes(32).toString('hex'),
};

// Keeps any other settings already in .env.
const kept = existsSync('.env')
  ? readFileSync('.env', 'utf8').split('\n').filter((line) => {
      return line.trim() && !Object.keys(managed).some((key) => line.startsWith(`${key}=`));
    })
  : ['PORT=3000'];

const output = [...Object.entries(managed).map(([key, value]) => `${key}=${value}`), ...kept];
writeFileSync('.env', `${output.join('\n')}\n`, { mode: 0o600 });
console.log('Saved to .env. Start the app with: npm run dev');
