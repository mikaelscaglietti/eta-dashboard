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

const esc = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const safeUrl = (url: string) => (/^https:\/\//i.test(url) ? url : '');

function vehicleName(lead: ReplyLead): string {
  return [lead.year, lead.make, lead.model, lead.trim].filter(Boolean).join(' ');
}

// Template lines look like "Schedule Test Drive = https://..." and may use
// {vin} and {stock}. A button with no link is left out rather than sent dead.
export function buttonLinks(template: Template, lead: ReplyLead): { label: string; url: string }[] {
  const links = new Map<string, string>();
  for (const line of template.links.split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) links.set(line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim());
  }
  return template.buttons
    .split(',')
    .map((label) => label.trim())
    .filter(Boolean)
    .flatMap((label) => {
      const url = safeUrl(links.get(label.toLowerCase()) ?? '')
        .replaceAll('{vin}', encodeURIComponent(lead.vin))
        .replaceAll('{stock}', encodeURIComponent(lead.stock));
      return url ? [{ label, url }] : [];
    });
}

function opening(kind: ReplyKind, store: Store, lead: ReplyLead): string {
  const thanks = `Thank you for contacting ${store.name}.`;
  if (kind === 'non_vehicle') return `${thanks} A member of our team will reach out to you shortly about your request.`;
  if (kind === 'fallback') {
    return `${thanks} Unfortunately the vehicle you requested is unavailable, however someone from the dealership will contact you shortly to go over your options.`;
  }
  return `${thanks} The ${vehicleName(lead)} you’re looking at is available here at ${store.name}. Let us know if you’d like to schedule a time to come see it or if you have any questions.`;
}

const closing = (store: Store) =>
  `A certified sales consultant will be contacting you shortly to provide you with the information you requested and would like to set an appointment for you to come experience the ${store.name} difference. When would be the best day and time for you?`;

export function buildReply(
  store: Store,
  template: Template,
  lead: ReplyLead,
  photos: string[],
  greeting?: string,
): { kind: ReplyKind; html: string; text: string } {
  const usable = photos.map(safeUrl).filter(Boolean).slice(0, 3);
  const kind = chooseKind(lead, usable.length);
  const hello = greeting || (lead.firstName ? `Hi ${lead.firstName},` : 'Hi there,');
  const reasons = template.reasons.split('\n').map((r) => r.trim()).filter(Boolean);
  const buttons = buttonLinks(template, lead);
  const intro = opening(kind, store, lead);
  const noun = usable.length === 1 ? 'is a picture' : 'are pictures';
  const photoLine = kind === 'full' ? `Here ${noun} of your ${[lead.model, lead.trim].filter(Boolean).join(' ')}.` : '';
  const fallbackLine = kind === 'fallback' ? 'Take a look at similar vehicles we have right now.' : '';
  const website = store.website ? `https://${store.website.replace(/^https?:\/\//, '')}` : '';

  const p = (html: string) => `<p style="margin:0 0 14px">${html}</p>`;
  const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#ffffff">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.45;color:#111111"><tr><td style="padding:20px">
${safeUrl(template.logoUrl) ? `<div style="text-align:center;padding-bottom:14px;border-bottom:1px solid #e5e5e5;margin-bottom:14px"><img src="${esc(template.logoUrl)}" alt="${esc(store.name)}" style="max-width:260px;height:auto"></div>` : `<div style="text-align:center;font-size:20px;letter-spacing:3px;padding-bottom:14px;border-bottom:1px solid #e5e5e5;margin-bottom:14px">${esc(store.name.toUpperCase())}</div>`}
${p(esc(hello))}${p(esc(intro))}
${reasons.length ? `${p(`Here are a few reasons you should only buy from ${esc(store.name)}:`)}<ul style="margin:0 0 14px 20px;padding:0">${reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
${photoLine ? p(`<b>${esc(photoLine)}</b>`) : ''}${fallbackLine ? p(`<b>${esc(fallbackLine)}</b>`) : ''}
${kind === 'full' ? `<div style="margin:0 0 14px">${usable.map((src, i) => `<img src="${esc(src)}" alt="Vehicle photo ${i + 1}" width="180" style="width:180px;max-width:32%;height:auto;margin:0 4px 4px 0">`).join('')}</div>` : ''}
${buttons.length ? `<div style="text-align:center;margin:0 0 14px">${buttons.map((b, i) => `<a href="${esc(b.url)}" style="display:inline-block;margin:0 4px 8px;padding:9px 14px;border-radius:6px;background:${i === 0 ? '#1a1a1a' : '#2563eb'};color:#ffffff;font-weight:bold;font-size:13px;text-decoration:none">${esc(b.label)}</a>`).join('')}</div>` : ''}
${safeUrl(template.buildingPhotoUrl) ? `<img src="${esc(template.buildingPhotoUrl)}" alt="${esc(store.name)}" width="560" style="width:100%;height:auto;margin:0 0 14px">` : ''}
${p(esc(closing(store)))}
${p(`Thank you again for your interest in ${esc(store.name)}.`)}
${p(`Respectfully,<br><b>${esc(store.name)}</b>`)}
${p(`${esc(store.salesPhone)} Sales<br>${esc(store.servicePhone)} Service`)}
${p(`${esc(store.address)}${website ? `<br><a href="${esc(website)}" style="color:#1a5fd0">${esc(store.website)}</a>` : ''}`)}
</td></tr></table></td></tr></table></body></html>`;

  // Written separately rather than stripped from the HTML, so it stays clean.
  const text = [
    hello,
    intro,
    reasons.length ? `Here are a few reasons you should only buy from ${store.name}:\n${reasons.map((r) => `- ${r}`).join('\n')}` : '',
    photoLine || fallbackLine,
    kind === 'full' ? usable.join('\n') : '',
    buttons.map((b) => `${b.label}: ${b.url}`).join('\n'),
    closing(store),
    `Thank you again for your interest in ${store.name}.`,
    `Respectfully,\n${store.name}`,
    `${store.salesPhone} Sales\n${store.servicePhone} Service`,
    [store.address, store.website].filter(Boolean).join('\n'),
  ].filter(Boolean).join('\n\n');

  return { kind, html, text };
}
