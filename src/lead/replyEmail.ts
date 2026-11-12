import { renderTemplate, standardTemplate } from './blocks.ts';

export type ReplyKind = 'full' | 'no_photos' | 'fallback' | 'non_vehicle';

export interface Store {
  name: string;
  website: string;
  salesPhone: string;
  servicePhone: string;
  address: string;
}

export interface Template {
  reasons: string;
  buttons: string;
  logoUrl: string;
  buildingPhotoUrl: string;
  links: string;
}

export interface ReplyLead {
  firstName: string;
  year: number | null;
  make: string;
  model: string;
  trim: string;
  vin: string;
  stock: string;
  leadType: string;
}

export const NON_VEHICLE_TYPES = ['Service', 'OnStar Service', 'General Inquiry'];

export function chooseKind(lead: ReplyLead, photoCount: number): ReplyKind {
  if (NON_VEHICLE_TYPES.includes(lead.leadType)) return 'non_vehicle';
  if (!lead.vin) return 'fallback';
  return photoCount > 0 ? 'full' : 'no_photos';
}

// The owner still has to confirm the exact form: the spec's rule and its worked
// example differ. This matches the worked example and the design file.
export function replySubject(original: string): string {
  return `Re: ${original}`;
}

// The original single-template reply, kept for anything still using the old
// template fields. It now goes through the block engine, so there is only one
// way an email gets built.
export function buildReply(
  store: Store,
  template: Template,
  lead: ReplyLead,
  photos: string[],
  greeting?: string,
): { kind: ReplyKind; html: string; text: string } {
  return renderTemplate(store, standardTemplate(template), lead, photos, greeting);
}
