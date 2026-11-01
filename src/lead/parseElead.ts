export const ELEAD_SENDER = 'notify@eleadnotify.com';

export interface ParsedLead {
  dealerName: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  city: string;
  year: number | null;
  make: string;
  model: string;
  trim: string;
  vin: string;
  stock: string;
  dealNumber: string | null;
  leadType: string;
  leadSource: string;
  comments: string;
}

// The body is one run of "Label: value" pairs, always in this order. Comments
// comes last and is free text, so nothing inside it can be taken for a label.
const LABELS = [
  ['vehicle', 'Vehicle wanted:'],
  ['name', 'Name:'],
  ['city', 'City:'],
  ['phone', 'Phone:'],
  ['email', 'E-Mail:'],
  ['trim', 'Trim:'],
  ['comments', 'Comments:'],
] as const;

type Field = (typeof LABELS)[number][0];

function splitFields(body: string): { lead: string; fields: Partial<Record<Field, string>> } {
  const text = body.replace(/\s+/g, ' ').trim();
  const found: { key: Field; start: number; end: number }[] = [];
  const commentsAt = text.indexOf('Comments:');
  let from = 0;
  for (const [key, label] of LABELS) {
    const at = text.indexOf(label, from);
    if (at === -1 || (key !== 'comments' && commentsAt !== -1 && at > commentsAt)) continue;
    found.push({ key, start: at, end: at + label.length });
    from = at + label.length;
  }
  const fields: Partial<Record<Field, string>> = {};
  found.forEach((item, i) => {
    const stop = found[i + 1]?.start ?? text.length;
    fields[item.key] = text.slice(item.end, stop).replace(/<>\s*$/, '').trim();
  });
  const lead = text.slice(0, found[0]?.start ?? 0).replace(/^<>/, '').trim();
  return { lead, fields };
}

const VIN = /\b[A-HJ-NPR-Z0-9]{17}\b/;

// Provisional until the owner explains how lead types are told apart
// (Open questions, "Lead types"). Only the Roadster wording has been seen.
function classify(comments: string, vin: string): string {
  if (/onstar/i.test(comments)) return 'OnStar Service';
  if (/\bservice\b/i.test(comments)) return 'Service';
  if (/general inquiry/i.test(comments)) return 'General Inquiry';
  if (/certified|\bcpo\b/i.test(comments)) return 'Used Vehicle (CPO)';
  if (/\bused\b|pre-?owned/i.test(comments)) return 'Used Vehicle';
  return vin ? 'New Vehicle (VIN)' : 'New Vehicle';
}

function leadSource(comments: string): string {
  const known = ['Roadster', 'AutoTrader', 'Cars.com', 'CarGurus', 'OnStar'];
  const match = known.find((name) => comments.toLowerCase().includes(name.toLowerCase()));
  return `${match ?? 'Unknown source'} via eLead`;
}

// A notification must have at least the deal number or a customer and vehicle.
export function looksLikeLead(subject: string, body: string): boolean {
  if (/Deal IN:\s*\d+/.test(subject)) return true;
  return body.includes('Name:') && body.includes('Vehicle wanted:');
}

export function parseElead(subject: string, body: string): ParsedLead {
  const { lead, fields } = splitFields(body);
  const comments = fields.comments ?? '';
  const [firstName = '', ...rest] = (fields.name ?? '').split(' ').filter(Boolean);
  const vehicle = (fields.vehicle ?? '').match(/^(\d{4})\s+(\S+)\s*(.*)$/);
  const vin = subject.match(VIN)?.[0] ?? comments.match(VIN)?.[0] ?? '';
  return {
    dealerName: lead,
    firstName,
    lastName: rest.join(' '),
    email: fields.email ?? '',
    phone: fields.phone ?? '',
    city: fields.city ?? '',
    year: vehicle ? Number(vehicle[1]) : null,
    make: vehicle?.[2] ?? '',
    model: vehicle ? (vehicle[3] ?? '') : (fields.vehicle ?? ''),
    trim: fields.trim ?? '',
    vin,
    stock: comments.match(/#\s*([A-Za-z0-9-]+)/)?.[1] ?? '',
    dealNumber: subject.match(/Deal IN:\s*(\d+)/)?.[1] ?? null,
    leadType: classify(comments, vin),
    leadSource: leadSource(comments),
    comments,
  };
}
