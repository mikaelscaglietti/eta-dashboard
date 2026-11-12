import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/db.ts';
import type { Db } from '../src/db.ts';
import { monitorData } from '../src/monitor.ts';

let db: Db;
let a: number;
let b: number;

// Adds a lead received `hoursAgo` hours ago, answered in `seconds` with `status`.
async function lead(store: number, hoursAgo: number, status: string | null, seconds: number | null, type = 'New Vehicle') {
  const [row] = await db.query(
    `INSERT INTO leads (received_at, dealership_id, subject, message_id, lead_type, deal_number)
     VALUES (now() - make_interval(hours => $2), $1, 's', gen_random_uuid()::text, $3, gen_random_uuid()::text) RETURNING id`,
    [store, hoursAgo, type],
  );
  if (status) await db.query('INSERT INTO responses (lead_id, status, seconds) VALUES ($1, $2, $3)', [row.id, status, seconds]);
  await db.query(`INSERT INTO lead_events (lead_id, message) VALUES ($1, 'Lead notification received')`, [row.id]);
}

beforeEach(async () => {
  db = await openDb();
  [{ id: a }] = await db.query(`INSERT INTO dealerships (name, test_mode, google_status) VALUES ('Alpha Motors', FALSE, 'ok') RETURNING id`);
  [{ id: b }] = await db.query(`INSERT INTO dealerships (name) VALUES ('Bravo Auto') RETURNING id`);
  await db.query(`INSERT INTO dealerships (name, active) VALUES ('Closed Store', FALSE)`);
});

describe('Monitor numbers', () => {
  it('adds up received, responded, failed, held and speed', async () => {
    await lead(a, 0, 'replied', 4);
    await lead(a, 0, 'test', 12);
    await lead(a, 0, 'failed', null);
    await lead(a, 0, 'held', null);
    const m = await monitorData(db, '7d', null);
    expect(m.totals).toEqual({ received: 4, responded: 2, failed: 1, held: 1, avg_seconds: 8, fast: 1 });
  });

  it('lists every active dealership, including quiet ones, and hides deactivated ones', async () => {
    await lead(a, 0, 'replied', 3);
    const m = await monitorData(db, '7d', null);
    expect(m.dealers.map((d: any) => [d.name, d.received])).toEqual([['Alpha Motors', 1], ['Bravo Auto', 0]]);
    expect(m.dealers[1].last_lead).toBeNull();
  });

  it('shows the last lead even when it is older than the time range', async () => {
    await lead(b, 24 * 10, 'replied', 3);
    const m = await monitorData(db, '7d', null);
    expect(m.dealers.find((d: any) => d.name === 'Bravo Auto').received).toBe(0);
    expect(m.dealers.find((d: any) => d.name === 'Bravo Auto').last_lead).not.toBeNull();
  });

  it('time ranges include only leads inside them', async () => {
    await lead(a, 24 * 3, 'replied', 3);
    await lead(a, 24 * 20, 'replied', 3);
    await lead(a, 24 * 40, 'replied', 3);
    expect((await monitorData(db, 'today', null)).totals.received).toBe(0);
    expect((await monitorData(db, '7d', null)).totals.received).toBe(1);
    expect((await monitorData(db, '30d', null)).totals.received).toBe(2);
  });

  it('the dealership filter narrows every number', async () => {
    await lead(a, 0, 'replied', 3, 'Service');
    await lead(b, 0, 'replied', 5, 'Used Vehicle');
    const m = await monitorData(db, '7d', b);
    expect(m.totals.received).toBe(1);
    expect(m.dealers.map((d: any) => d.name)).toEqual(['Bravo Auto']);
    expect(m.types).toEqual([{ type: 'Used Vehicle', received: 1, responded: 1 }]);
    expect(m.activity).toHaveLength(1);
  });

  it('groups by lead type and by hour, with the average reply per hour', async () => {
    await lead(a, 0, 'replied', 2, 'Service');
    await lead(a, 0, 'replied', 4, 'Service');
    await lead(a, 0, null, null, 'New Vehicle');
    const m = await monitorData(db, '7d', null);
    const service = m.types.find((t: any) => t.type === 'Service');
    expect(service).toEqual({ type: 'Service', received: 2, responded: 2 });
    expect(m.hours).toHaveLength(1);
    expect(m.hours[0]).toMatchObject({ received: 3, avg_seconds: 3 });
  });

  it('latest activity shows at most ten events, newest first', async () => {
    for (let i = 0; i < 12; i++) await lead(a, 0, 'replied', 1);
    const m = await monitorData(db, 'today', null);
    expect(m.activity).toHaveLength(10);
    expect(m.activity[0].dealer).toBe('Alpha Motors');
  });
});
