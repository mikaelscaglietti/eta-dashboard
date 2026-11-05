import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

export interface Db {
  query<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS dealerships (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  website TEXT NOT NULL DEFAULT '',
  mailbox TEXT NOT NULL DEFAULT '',
  crm TEXT NOT NULL DEFAULT '',
  passthrough TEXT NOT NULL DEFAULT '',
  sales_phone TEXT NOT NULL DEFAULT '',
  service_phone TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  staff_phones JSONB NOT NULL DEFAULT '[]',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  test_mode BOOLEAN NOT NULL DEFAULT TRUE,
  google_status TEXT NOT NULL DEFAULT 'new',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS templates (
  dealership_id INTEGER PRIMARY KEY REFERENCES dealerships(id),
  reasons TEXT NOT NULL DEFAULT '',
  buttons TEXT NOT NULL DEFAULT 'Schedule Test Drive, Similar Vehicles',
  logo_url TEXT NOT NULL DEFAULT '',
  building_photo_url TEXT NOT NULL DEFAULT '',
  links TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS leads (
  id SERIAL PRIMARY KEY,
  received_at TIMESTAMPTZ NOT NULL,
  dealership_id INTEGER NOT NULL REFERENCES dealerships(id),
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  year INTEGER,
  make TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT '',
  trim TEXT NOT NULL DEFAULT '',
  vin TEXT NOT NULL DEFAULT '',
  stock TEXT NOT NULL DEFAULT '',
  lead_type TEXT NOT NULL DEFAULT '',
  lead_source TEXT NOT NULL DEFAULT '',
  deal_number TEXT,
  subject TEXT NOT NULL,
  message_id TEXT NOT NULL,
  thread_id TEXT NOT NULL DEFAULT '',
  raw TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'queued'
);
-- These two rules are what make a second reply to one deal impossible.
CREATE UNIQUE INDEX IF NOT EXISTS leads_one_per_deal ON leads (dealership_id, deal_number);
CREATE UNIQUE INDEX IF NOT EXISTS leads_one_per_message ON leads (dealership_id, message_id);
CREATE TABLE IF NOT EXISTS responses (
  lead_id INTEGER PRIMARY KEY REFERENCES leads(id),
  kind TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  failure TEXT NOT NULL DEFAULT '',
  sent_at TIMESTAMPTZ,
  seconds DOUBLE PRECISION,
  from_address TEXT NOT NULL DEFAULT '',
  to_address TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  html TEXT NOT NULL DEFAULT '',
  text_body TEXT NOT NULL DEFAULT '',
  photo_count INTEGER NOT NULL DEFAULT 0,
  photo_source TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS lead_events (
  id SERIAL PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads(id),
  at TIMESTAMPTZ NOT NULL DEFAULT now(),
  message TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS text_messages (
  id SERIAL PRIMARY KEY,
  lead_id INTEGER NOT NULL REFERENCES leads(id),
  recipient TEXT NOT NULL,
  audience TEXT NOT NULL,
  body TEXT NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL
);
-- Each dealership chooses how staff texts look: 'formatted' or 'raw'.
ALTER TABLE dealerships ADD COLUMN IF NOT EXISTS staff_text_format TEXT NOT NULL DEFAULT 'formatted';
-- Added for Twilio: its message ID links delivery updates back to the text.
ALTER TABLE text_messages ADD COLUMN IF NOT EXISTS twilio_sid TEXT NOT NULL DEFAULT '';
ALTER TABLE text_messages ADD COLUMN IF NOT EXISTS failure TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS text_messages_by_sid ON text_messages (twilio_sid);
CREATE TABLE IF NOT EXISTS opt_outs (
  phone TEXT PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS vehicle_cache (
  vin TEXT PRIMARY KEY,
  vehicle TEXT NOT NULL DEFAULT '',
  photos JSONB NOT NULL DEFAULT '[]',
  page_url TEXT NOT NULL DEFAULT '',
  last_scraped TIMESTAMPTZ NOT NULL DEFAULT now(),
  hits INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS alerts (
  id SERIAL PRIMARY KEY,
  dealership_id INTEGER REFERENCES dealerships(id),
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  link TEXT NOT NULL DEFAULT '#alerts',
  cta TEXT NOT NULL DEFAULT 'Review',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  dismissed_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  sending BOOLEAN NOT NULL DEFAULT TRUE,
  customer_texts BOOLEAN NOT NULL DEFAULT FALSE,
  owner_test_email TEXT NOT NULL DEFAULT '',
  owner_test_phone TEXT NOT NULL DEFAULT '',
  model_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  model_provider TEXT NOT NULL DEFAULT 'OpenAI',
  model_id TEXT NOT NULL DEFAULT 'gpt-5.6-luna',
  model_timeout_seconds INTEGER NOT NULL DEFAULT 3,
  photo_timeout_seconds INTEGER NOT NULL DEFAULT 5,
  sends_per_minute INTEGER NOT NULL DEFAULT 30
);
INSERT INTO settings (id) VALUES (1) ON CONFLICT DO NOTHING;
`;

// On the host this is the real Postgres database. On your computer, with no
// DATABASE_URL set, the same kind of database runs inside the app itself, so
// nothing else needs installing.
export async function openDb(databaseUrl?: string, localDir?: string): Promise<Db> {
  if (databaseUrl) {
    const pool = new pg.Pool({ connectionString: databaseUrl });
    await pool.query(SCHEMA);
    return {
      query: async (sql, params = []) => (await pool.query(sql, params as unknown[])).rows,
      close: () => pool.end(),
    };
  }
  const local = new PGlite(localDir);
  await local.exec(SCHEMA);
  return {
    query: async <T>(sql: string, params: unknown[] = []) =>
      (await local.query<T>(sql, params)).rows,
    close: () => local.close(),
  };
}
