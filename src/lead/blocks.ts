// Email templates built from blocks. The visual editor arranges these blocks;
// this file turns them into the reply email and its plain-text part.
//
// Safety rules that no template can break:
// - Every typed word is escaped, so a template can't inject HTML.
// - Links and images must be https.
// - Colors must be #rrggbb and fonts come from a web-safe list.
// - The signature (name, phones, address, website) always comes from the
//   dealership record, never from template text.

import { chooseKind } from './replyEmail.ts';
import type { ReplyKind, ReplyLead, Store } from './replyEmail.ts';

// Which kind of lead a block appears for.
export type ShowFor = 'all' | 'vehicle' | 'unavailable' | 'service';

interface Base { id: string; showFor?: ShowFor }
export type Block = Base & (
  | { type: 'header'; logoUrl: string; align: 'left' | 'center'; logoWidth: number }
  | { type: 'greeting' }
  | { type: 'message'; vehicle: string; unavailable: string; service: string }
  | { type: 'reasons'; intro: string; items: string[] }
  | { type: 'photos'; caption: string; fallbackCaption: string }
  | { type: 'buttons'; items: { label: string; url: string }[] }
  | { type: 'image'; url: string; alt: string }
  | { type: 'text'; text: string; bold: boolean; align: 'left' | 'center' }
  | { type: 'closing'; text: string; thanks: string }
  | { type: 'signature'; signoff: string }
  | { type: 'divider' }
  | { type: 'spacer'; size: number }
);
export type BlockType = Block['type'];

export interface TemplateStyle {
  font: string;
  fontSize: number;
  textColor: string;
  linkColor: string;
  background: string;
  buttonColor: string;
  buttonColor2: string;
}

export interface BlockTemplate { blocks: Block[]; style: TemplateStyle }

export const FONTS = ['Arial', 'Helvetica', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Georgia', 'Times New Roman'];
const FONT_STACK: Record<string, string> = {
  Arial: 'Arial,Helvetica,sans-serif', Helvetica: 'Helvetica,Arial,sans-serif', Verdana: 'Verdana,Geneva,sans-serif',
  Tahoma: 'Tahoma,Geneva,sans-serif', 'Trebuchet MS': "'Trebuchet MS',Helvetica,sans-serif",
  Georgia: 'Georgia,serif', 'Times New Roman': "'Times New Roman',Times,serif",
};

// Words that are swapped for each lead's details.
export const PLACEHOLDERS = ['{first_name}', '{vehicle}', '{model}', '{dealership}', '{vin}', '{stock}'];

export const DEFAULT_STYLE: TemplateStyle = {
  font: 'Arial', fontSize: 16, textColor: '#111111', linkColor: '#1a5fd0', background: '#ffffff', buttonColor: '#1a1a1a', buttonColor2: '#2563eb',
};

const DEFAULT_TEXT = {
  vehicle: 'Thank you for contacting {dealership}. The {vehicle} you’re looking at is available here at {dealership}. Let us know if you’d like to schedule a time to come see it or if you have any questions.',
  unavailable: 'Thank you for contacting {dealership}. Unfortunately the vehicle you requested is unavailable, however someone from the dealership will contact you shortly to go over your options.',
  service: 'Thank you for contacting {dealership}. A member of our team will reach out to you shortly about your request.',
  reasonsIntro: 'Here are a few reasons you should only buy from {dealership}:',
  caption: 'Here are pictures of your {model}.',
  fallbackCaption: 'Take a look at similar vehicles we have right now.',
  closing: 'A certified sales consultant will be contacting you shortly to provide you with the information you requested and would like to set an appointment for you to come experience the {dealership} difference. When would be the best day and time for you?',
  thanks: 'Thank you again for your interest in {dealership}.',
};

let counter = 0;
export const newId = () => `b${Date.now().toString(36)}${(counter++).toString(36)}`;

// A fresh block of each type, as the editor's "Add block" menu creates them.
export function newBlock(type: BlockType): Block {
  const id = newId();
  switch (type) {
    case 'header': return { id, type, logoUrl: '', align: 'center', logoWidth: 260 };
    case 'greeting': return { id, type };
    case 'message': return { id, type, vehicle: DEFAULT_TEXT.vehicle, unavailable: DEFAULT_TEXT.unavailable, service: DEFAULT_TEXT.service };
    case 'reasons': return { id, type, intro: DEFAULT_TEXT.reasonsIntro, items: [] };
    case 'photos': return { id, type, caption: DEFAULT_TEXT.caption, fallbackCaption: DEFAULT_TEXT.fallbackCaption };
    case 'buttons': return { id, type, items: [] };
    case 'image': return { id, type, url: '', alt: '' };
    case 'text': return { id, type, text: '', bold: false, align: 'left' };
    case 'closing': return { id, type, text: DEFAULT_TEXT.closing, thanks: DEFAULT_TEXT.thanks };
    case 'signature': return { id, type, signoff: 'Respectfully,' };
    case 'divider': return { id, type };
    case 'spacer': return { id, type, size: 16 };
  }
}

// The standard layout every dealership starts with. It matches the reply the
// app sent before templates could be edited.
export function standardTemplate(old: { reasons?: string; buttons?: string; links?: string; logoUrl?: string; buildingPhotoUrl?: string } = {}): BlockTemplate {
  const links = new Map<string, string>();
  for (const line of (old.links ?? '').split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) links.set(line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim());
  }
  const buttons = (old.buttons ?? 'Schedule Test Drive, Similar Vehicles').split(',').map((l) => l.trim()).filter(Boolean)
    .map((label) => ({ label, url: links.get(label.toLowerCase()) ?? '' }));
  const header = newBlock('header') as Extract<Block, { type: 'header' }>;
  header.logoUrl = old.logoUrl ?? '';
  const reasons = newBlock('reasons') as Extract<Block, { type: 'reasons' }>;
  reasons.items = (old.reasons ?? '').split('\n').map((r) => r.trim()).filter(Boolean);
  const blocks: Block[] = [
    header, newBlock('greeting'), newBlock('message'), reasons, newBlock('photos'),
    { ...(newBlock('buttons') as Extract<Block, { type: 'buttons' }>), items: buttons },
  ];
  if (old.buildingPhotoUrl) blocks.push({ id: newId(), type: 'image', url: old.buildingPhotoUrl, alt: '{dealership}' });
  blocks.push(newBlock('closing'), newBlock('signature'));
  return { blocks, style: { ...DEFAULT_STYLE } };
}

/* ---------- checking what the editor sends ---------- */

const str = (v: unknown, max = 2000) => String(v ?? '').slice(0, max);
const color = (v: unknown, fallback: string) => (/^#[0-9a-f]{6}$/i.test(String(v)) ? String(v).toLowerCase() : fallback);
const num = (v: unknown, min: number, max: number, fallback: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const SHOW: ShowFor[] = ['all', 'vehicle', 'unavailable', 'service'];

export class TemplateError extends Error {}

// Rebuilds a template from what the browser sent, keeping only known fields.
// Bad links are reported instead of silently dropped, so the owner can fix them.
export function cleanTemplate(input: any): BlockTemplate {
  const raw = Array.isArray(input?.blocks) ? input.blocks.slice(0, 60) : [];
  const blocks: Block[] = [];
  const badLink = (url: string, where: string) => {
    if (url && !/^https:\/\/\S+$/i.test(url.trim())) throw new TemplateError(`${where}: links must start with https://`);
    return url.trim();
  };
  for (const b of raw) {
    const base = { id: /^[a-z0-9]{1,40}$/i.test(String(b?.id)) ? String(b.id) : newId(), showFor: SHOW.includes(b?.showFor) ? b.showFor : 'all' as ShowFor };
    switch (b?.type) {
      case 'header': blocks.push({ ...base, type: 'header', logoUrl: badLink(str(b.logoUrl), 'Logo'), align: b.align === 'left' ? 'left' : 'center', logoWidth: num(b.logoWidth, 60, 560, 260) }); break;
      case 'greeting': blocks.push({ ...base, type: 'greeting' }); break;
      case 'message': blocks.push({ ...base, type: 'message', vehicle: str(b.vehicle), unavailable: str(b.unavailable), service: str(b.service) }); break;
      case 'reasons': blocks.push({ ...base, type: 'reasons', intro: str(b.intro, 300), items: (Array.isArray(b.items) ? b.items : []).map((x: unknown) => str(x, 300).trim()).filter(Boolean).slice(0, 20) }); break;
      case 'photos': blocks.push({ ...base, type: 'photos', caption: str(b.caption, 300), fallbackCaption: str(b.fallbackCaption, 300) }); break;
      case 'buttons': blocks.push({ ...base, type: 'buttons', items: (Array.isArray(b.items) ? b.items : []).slice(0, 6).map((x: any) => ({ label: str(x?.label, 60).trim(), url: badLink(str(x?.url), `Button “${str(x?.label, 60)}”`) })).filter((x: { label: string }) => x.label) }); break;
      case 'image': blocks.push({ ...base, type: 'image', url: badLink(str(b.url), 'Image'), alt: str(b.alt, 200) }); break;
      case 'text': blocks.push({ ...base, type: 'text', text: str(b.text), bold: Boolean(b.bold), align: b.align === 'center' ? 'center' : 'left' }); break;
      case 'closing': blocks.push({ ...base, type: 'closing', text: str(b.text), thanks: str(b.thanks, 300) }); break;
      case 'signature': blocks.push({ ...base, type: 'signature', signoff: str(b.signoff, 60) }); break;
      case 'divider': blocks.push({ ...base, type: 'divider' }); break;
      case 'spacer': blocks.push({ ...base, type: 'spacer', size: num(b.size, 4, 80, 16) }); break;
    }
  }
  const s = input?.style ?? {};
  const style: TemplateStyle = {
    font: FONTS.includes(s.font) ? s.font : DEFAULT_STYLE.font,
    fontSize: num(s.fontSize, 12, 22, DEFAULT_STYLE.fontSize),
    textColor: color(s.textColor, DEFAULT_STYLE.textColor),
    linkColor: color(s.linkColor, DEFAULT_STYLE.linkColor),
    background: color(s.background, DEFAULT_STYLE.background),
    buttonColor: color(s.buttonColor, DEFAULT_STYLE.buttonColor),
    buttonColor2: color(s.buttonColor2, DEFAULT_STYLE.buttonColor2),
  };
  return { blocks, style };
}

/* ---------- turning blocks into the email ---------- */

const esc = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const https = (url: string) => (/^https:\/\/\S+$/i.test(url.trim()) ? url.trim() : '');

function shows(block: Block, kind: ReplyKind): boolean {
  const show = block.showFor ?? 'all';
  if (show === 'all') return true;
  if (show === 'service') return kind === 'non_vehicle';
  if (show === 'unavailable') return kind === 'fallback';
  return kind === 'full' || kind === 'no_photos';
}

export function renderTemplate(
  store: Store,
  template: BlockTemplate,
  lead: ReplyLead,
  photos: string[],
  greeting?: string,
): { kind: ReplyKind; html: string; text: string } {
  const usable = photos.map(https).filter(Boolean).slice(0, 3);
  const kind = chooseKind(lead, usable.length);
  const st = template.style;
  const vehicle = [lead.year, lead.make, lead.model, lead.trim].filter(Boolean).join(' ');
  const values: Record<string, string> = {
    '{first_name}': lead.firstName || 'there', '{vehicle}': vehicle || 'vehicle', '{model}': [lead.model, lead.trim].filter(Boolean).join(' ') || 'vehicle',
    '{dealership}': store.name, '{vin}': lead.vin, '{stock}': lead.stock,
  };
  const fill = (t: string) => t.replace(/\{(first_name|vehicle|model|dealership|vin|stock)\}/g, (m) => values[m] ?? m);
  const fillUrl = (u: string) => https(u.replace(/\{(vin|stock)\}/g, (m) => encodeURIComponent(values[m] ?? '')));
  const p = (html: string, extra = '') => `<p style="margin:0 0 14px${extra}">${html}</p>`;
  // Several lines typed in one box stay as separate lines.
  const lines = (t: string) => esc(fill(t)).replace(/\n/g, '<br>');
  const website = store.website ? `https://${store.website.replace(/^https?:\/\//, '')}` : '';

  const html: string[] = [];
  const text: string[] = [];
  let buttonSeen = false;
  for (const b of template.blocks) {
    if (!shows(b, kind)) continue;
    switch (b.type) {
      case 'header': {
        const logo = https(b.logoUrl);
        html.push(`<div style="text-align:${b.align};padding-bottom:14px;border-bottom:1px solid #e5e5e5;margin-bottom:14px">${logo
          ? `<img src="${esc(logo)}" alt="${esc(store.name)}" width="${b.logoWidth}" style="max-width:${b.logoWidth}px;width:100%;height:auto">`
          : `<span style="font-size:20px;letter-spacing:3px">${esc(store.name.toUpperCase())}</span>`}</div>`);
        if (!logo) text.push(store.name.toUpperCase());
        break;
      }
      case 'greeting': {
        const hello = greeting || (lead.firstName ? `Hi ${lead.firstName},` : 'Hi there,');
        html.push(p(esc(hello)));
        text.push(hello);
        break;
      }
      case 'message': {
        const t = kind === 'non_vehicle' ? b.service : kind === 'fallback' ? b.unavailable : b.vehicle;
        if (t.trim()) { html.push(p(lines(t))); text.push(fill(t)); }
        break;
      }
      case 'reasons':
        if (b.items.length) {
          html.push(`${b.intro.trim() ? p(lines(b.intro)) : ''}<ul style="margin:0 0 14px 20px;padding:0">${b.items.map((r) => `<li>${esc(fill(r))}</li>`).join('')}</ul>`);
          text.push([fill(b.intro), ...b.items.map((r) => `- ${fill(r)}`)].filter(Boolean).join('\n'));
        }
        break;
      case 'photos':
        if (kind === 'full') {
          const caption = usable.length === 1 ? b.caption.replace(/^Here are pictures/, 'Here is a picture') : b.caption;
          if (caption.trim()) { html.push(p(`<b>${lines(caption)}</b>`)); text.push(fill(caption)); }
          html.push(`<div style="margin:0 0 14px">${usable.map((src, i) => `<img src="${esc(src)}" alt="Vehicle photo ${i + 1}" width="180" style="width:180px;max-width:32%;height:auto;margin:0 4px 4px 0">`).join('')}</div>`);
          text.push(usable.join('\n'));
        } else if (kind === 'fallback' && b.fallbackCaption.trim()) {
          html.push(p(`<b>${lines(b.fallbackCaption)}</b>`));
          text.push(fill(b.fallbackCaption));
        }
        break;
      case 'buttons': {
        // A button with no working link is left out rather than sent dead.
        const items = b.items.map((x) => ({ label: fill(x.label), url: fillUrl(x.url) })).filter((x) => x.url);
        if (items.length) {
          html.push(`<div style="text-align:center;margin:0 0 14px">${items.map((x, i) => `<a href="${esc(x.url)}" style="display:inline-block;margin:0 4px 8px;padding:9px 14px;border-radius:6px;background:${!buttonSeen && i === 0 ? st.buttonColor : st.buttonColor2};color:#ffffff;font-weight:bold;font-size:13px;text-decoration:none">${esc(x.label)}</a>`).join('')}</div>`);
          text.push(items.map((x) => `${x.label}: ${x.url}`).join('\n'));
          buttonSeen = true;
        }
        break;
      }
      case 'image': {
        const url = https(b.url);
        if (url) html.push(`<img src="${esc(url)}" alt="${esc(fill(b.alt) || store.name)}" width="560" style="width:100%;height:auto;margin:0 0 14px;display:block">`);
        break;
      }
      case 'text':
        if (b.text.trim()) {
          const inner = b.bold ? `<b>${lines(b.text)}</b>` : lines(b.text);
          html.push(p(inner, b.align === 'center' ? ';text-align:center' : ''));
          text.push(fill(b.text));
        }
        break;
      case 'closing':
        if (b.text.trim()) { html.push(p(lines(b.text))); text.push(fill(b.text)); }
        if (b.thanks.trim()) { html.push(p(lines(b.thanks))); text.push(fill(b.thanks)); }
        break;
      case 'signature':
        html.push(p(`${b.signoff.trim() ? `${esc(b.signoff)}<br>` : ''}<b>${esc(store.name)}</b>`));
        html.push(p(`${esc(store.salesPhone)} Sales<br>${esc(store.servicePhone)} Service`));
        html.push(p(`${esc(store.address)}${website ? `<br><a href="${esc(website)}" style="color:${st.linkColor}">${esc(store.website)}</a>` : ''}`));
        text.push([b.signoff, store.name].filter((x) => x.trim()).join('\n'), `${store.salesPhone} Sales\n${store.servicePhone} Service`, [store.address, store.website].filter(Boolean).join('\n'));
        break;
      case 'divider':
        html.push('<hr style="border:0;border-top:1px solid #e5e5e5;margin:0 0 14px">');
        break;
      case 'spacer':
        html.push(`<div style="height:${b.size}px;line-height:${b.size}px;font-size:1px">&nbsp;</div>`);
        break;
    }
  }

  const page = `<!DOCTYPE html><html><body style="margin:0;padding:0;background:${st.background}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${st.background}"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;font-family:${FONT_STACK[st.font] ?? FONT_STACK.Arial};font-size:${st.fontSize}px;line-height:1.45;color:${st.textColor}"><tr><td style="padding:20px">
${html.join('\n')}
</td></tr></table></td></tr></table></body></html>`;

  return { kind, html: page, text: text.filter((t) => t.trim()).join('\n\n') };
}
