import type { Db } from './db.ts';
import { cleanTemplate, standardTemplate } from './lead/blocks.ts';
import type { BlockTemplate } from './lead/blocks.ts';

export interface StoredTemplate extends BlockTemplate {
  id: number;
  dealership_id: number;
  name: string;
  is_default: boolean;
}

const fromRow = (row: any): StoredTemplate => ({ ...row, ...cleanTemplate({ blocks: row.blocks, style: row.style }) });

// Makes sure a dealership has its protected default template. The first time,
// it is built from the dealership's older single template, so nothing changes
// for stores set up before templates could be edited.
export async function ensureDefault(db: Db, dealershipId: number): Promise<StoredTemplate> {
  const [existing] = await db.query('SELECT * FROM email_templates WHERE dealership_id = $1 AND is_default', [dealershipId]);
  if (existing) return fromRow(existing);
  const [old] = await db.query('SELECT * FROM templates WHERE dealership_id = $1', [dealershipId]);
  const t = standardTemplate(old ? { reasons: old.reasons, buttons: old.buttons, links: old.links, logoUrl: old.logo_url, buildingPhotoUrl: old.building_photo_url } : {});
  const [row] = await db.query(
    `INSERT INTO email_templates (dealership_id, name, is_default, blocks, style) VALUES ($1, 'Standard', TRUE, $2, $3)
     ON CONFLICT (dealership_id) WHERE is_default DO NOTHING RETURNING *`,
    [dealershipId, JSON.stringify(t.blocks), JSON.stringify(t.style)],
  );
  if (!row) return ensureDefault(db, dealershipId); // Another request created it first.
  await db.query('UPDATE dealerships SET active_template_id = COALESCE(active_template_id, $2) WHERE id = $1', [dealershipId, row.id]);
  return fromRow(row);
}

// The template a dealership's replies use right now.
export async function templateFor(db: Db, dealershipId: number): Promise<StoredTemplate> {
  const [active] = await db.query(
    `SELECT t.* FROM email_templates t JOIN dealerships d ON d.active_template_id = t.id AND t.dealership_id = d.id WHERE d.id = $1`,
    [dealershipId],
  );
  if (active) return fromRow(active);
  const fallback = await ensureDefault(db, dealershipId);
  await db.query('UPDATE dealerships SET active_template_id = $2 WHERE id = $1', [dealershipId, fallback.id]);
  return fallback;
}

export async function listTemplates(db: Db): Promise<StoredTemplate[]> {
  const stores = await db.query('SELECT id FROM dealerships');
  for (const s of stores) await ensureDefault(db, s.id);
  return (await db.query('SELECT * FROM email_templates ORDER BY dealership_id, is_default DESC, name')).map(fromRow);
}

export async function createTemplate(db: Db, dealershipId: number, name: string, copyFrom?: number): Promise<number> {
  const base = copyFrom
    ? (await db.query('SELECT * FROM email_templates WHERE id = $1 AND dealership_id = $2', [copyFrom, dealershipId]))[0]
    : await ensureDefault(db, dealershipId);
  if (!base) throw new Error('That template no longer exists.');
  const t = cleanTemplate(base);
  const [row] = await db.query(
    'INSERT INTO email_templates (dealership_id, name, blocks, style) VALUES ($1, $2, $3, $4) RETURNING id',
    [dealershipId, name, JSON.stringify(t.blocks), JSON.stringify(t.style)],
  );
  return row.id;
}

export async function saveTemplate(db: Db, id: number, name: string, template: BlockTemplate): Promise<boolean> {
  const rows = await db.query(
    'UPDATE email_templates SET name = $2, blocks = $3, style = $4, updated_at = now() WHERE id = $1 RETURNING id',
    [id, name, JSON.stringify(template.blocks), JSON.stringify(template.style)],
  );
  return rows.length > 0;
}

export async function useTemplate(db: Db, id: number): Promise<boolean> {
  const rows = await db.query(
    'UPDATE dealerships d SET active_template_id = t.id FROM email_templates t WHERE t.id = $1 AND d.id = t.dealership_id RETURNING d.id',
    [id],
  );
  return rows.length > 0;
}

// Deleting the template in use switches that dealership back to its default.
export async function deleteTemplate(db: Db, id: number): Promise<'deleted' | 'default' | 'missing'> {
  const [t] = await db.query('SELECT * FROM email_templates WHERE id = $1', [id]);
  if (!t) return 'missing';
  if (t.is_default) return 'default';
  const fallback = await ensureDefault(db, t.dealership_id);
  await db.query('UPDATE dealerships SET active_template_id = $2 WHERE active_template_id = $1', [id, fallback.id]);
  await db.query('DELETE FROM email_templates WHERE id = $1', [id]);
  return 'deleted';
}
