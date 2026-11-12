import type { Db } from './db.ts';

// The Monitor screen's numbers. The database does the adding up, so the screen
// stays quick with hundreds of dealerships and months of leads.

export const ZONE = 'America/Phoenix';
export type Range = 'today' | '7d' | '30d';
export const RANGES: Range[] = ['today', '7d', '30d'];
// A reply slower than this counts as slow on the Monitor.
export const FAST_SECONDS = 10;

const ANSWERED = `r.status IN ('replied', 'fallback', 'test')`;

// Start of the range, in Arizona days: Today is since local midnight.
const SINCE: Record<Range, string> = {
  today: `date_trunc('day', now() AT TIME ZONE '${ZONE}') AT TIME ZONE '${ZONE}'`,
  '7d': `(date_trunc('day', now() AT TIME ZONE '${ZONE}') - interval '6 days') AT TIME ZONE '${ZONE}'`,
  '30d': `(date_trunc('day', now() AT TIME ZONE '${ZONE}') - interval '29 days') AT TIME ZONE '${ZONE}'`,
};

export async function monitorData(db: Db, range: Range, dealerId: number | null) {
  const since = SINCE[range];
  // $1 is the dealership filter; null means every dealership.
  const where = `l.received_at >= ${since} AND ($1::int IS NULL OR l.dealership_id = $1)`;
  const params = [dealerId];

  const [totals, dealers, types, hours, activity] = await Promise.all([
    db.query(
      `SELECT count(*)::int AS received,
              count(*) FILTER (WHERE ${ANSWERED})::int AS responded,
              count(*) FILTER (WHERE r.status = 'failed')::int AS failed,
              count(*) FILTER (WHERE r.status = 'held' OR l.state = 'held')::int AS held,
              round(avg(r.seconds) FILTER (WHERE ${ANSWERED})::numeric, 1)::float AS avg_seconds,
              count(*) FILTER (WHERE ${ANSWERED} AND r.seconds < ${FAST_SECONDS})::int AS fast
         FROM leads l LEFT JOIN responses r ON r.lead_id = l.id
        WHERE ${where}`,
      params,
    ),
    // Every active dealership appears, even with no leads in the range, because a
    // store that has gone quiet is exactly what this table should reveal.
    db.query(
      `SELECT d.id, d.name, d.test_mode, d.google_status,
              count(l.id)::int AS received,
              count(l.id) FILTER (WHERE ${ANSWERED})::int AS responded,
              count(l.id) FILTER (WHERE r.status = 'failed')::int AS failed,
              round(avg(r.seconds) FILTER (WHERE ${ANSWERED})::numeric, 1)::float AS avg_seconds,
              (SELECT max(received_at) FROM leads WHERE dealership_id = d.id) AS last_lead
         FROM dealerships d
         LEFT JOIN leads l ON l.dealership_id = d.id AND l.received_at >= ${since}
         LEFT JOIN responses r ON r.lead_id = l.id
        WHERE d.active AND ($1::int IS NULL OR d.id = $1)
        GROUP BY d.id ORDER BY d.name`,
      params,
    ),
    db.query(
      `SELECT l.lead_type AS type, count(*)::int AS received, count(*) FILTER (WHERE ${ANSWERED})::int AS responded
         FROM leads l LEFT JOIN responses r ON r.lead_id = l.id
        WHERE ${where} GROUP BY l.lead_type`,
      params,
    ),
    // Hour of the day in Arizona time, across the whole range.
    db.query(
      `SELECT EXTRACT(hour FROM l.received_at AT TIME ZONE '${ZONE}')::int AS hour, count(*)::int AS received,
              round(avg(r.seconds) FILTER (WHERE ${ANSWERED})::numeric, 1)::float AS avg_seconds
         FROM leads l LEFT JOIN responses r ON r.lead_id = l.id
        WHERE ${where} GROUP BY 1 ORDER BY 1`,
      params,
    ),
    db.query(
      `SELECT e.at, e.message, e.severity, e.lead_id, l.first_name, d.name AS dealer
         FROM lead_events e JOIN leads l ON l.id = e.lead_id JOIN dealerships d ON d.id = l.dealership_id
        WHERE ($1::int IS NULL OR l.dealership_id = $1)
        ORDER BY e.at DESC, e.id DESC LIMIT 10`,
      params,
    ),
  ]);

  return { range, dealerId, fastSeconds: FAST_SECONDS, totals: totals[0], dealers, types, hours, activity };
}
