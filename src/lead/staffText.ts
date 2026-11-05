// What dealership staff get on their phones for each lead. Each dealership
// chooses Formatted (tidy lines) or Raw (the notification exactly as it came in).

export type StaffTextFormat = 'formatted' | 'raw';

// Twilio refuses texts longer than this.
export const MAX_TEXT_LENGTH = 1600;

interface LeadForText {
  first_name: string;
  last_name: string;
  lead_type: string;
  year: number | null;
  make: string;
  model: string;
  phone: string;
  email: string;
  raw: string;
}

function fit(text: string): string {
  return text.length <= MAX_TEXT_LENGTH ? text : `${text.slice(0, MAX_TEXT_LENGTH - 1).trimEnd()}…`;
}

export function staffText(format: StaffTextFormat, storeName: string, lead: LeadForText): string {
  if (format === 'raw' && lead.raw.trim()) return fit(lead.raw.trim());
  const lines: [string, string][] = [
    ['Type', lead.lead_type],
    ['Customer', [lead.first_name, lead.last_name].filter(Boolean).join(' ')],
    ['Vehicle', [lead.year, lead.make, lead.model].filter(Boolean).join(' ')],
    ['Phone', lead.phone],
    ['Email', lead.email],
  ];
  const body = lines.filter(([, value]) => value).map(([label, value]) => `${label}: ${value}`);
  return fit([`NEW LEAD - ${storeName}`, ...body].join('\n'));
}
