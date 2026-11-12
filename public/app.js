/* The screens from lead-responder-console.html, reading real saved data. */
const ZONE = 'America/Phoenix';
const LEAD_TYPES = ['New Vehicle', 'New Vehicle (VIN)', 'Used Vehicle', 'Used Vehicle (CPO)', 'General Inquiry', 'Service', 'OnStar Service'];
const CRMS = ['DealerSocket', 'DriveCentric', 'Elead', 'Ford Direct', 'ProMax', 'R&R', 'Tekion', 'VinSolutions'];
const AI_MODELS = { OpenAI: [['gpt-5.6-luna', 'GPT-5.6 Luna (fast, low cost)'], ['gpt-5.6-terra', 'GPT-5.6 Terra (balanced)'], ['gpt-5.6-sol', 'GPT-5.6 Sol (most capable)']], Anthropic: [['claude-haiku-5-5', 'Claude Haiku 5.5 (fast, low cost)'], ['claude-sonnet-5-5', 'Claude Sonnet 5.5 (balanced)'], ['claude-opus-5-5', 'Claude Opus 5.5 (most capable)']] };
const statusLabel = { replied: 'Replied', fallback: 'Replied (fallback)', failed: 'Failed', test: 'Test mode', held: 'Held (paused)', queued: 'Working' };

let dealers = [], tpl = {}, leads = [], alerts = [], cache = [], settings = {}, dev = false, sending = true, conns = { twilio: { connected: false, from: '' } };
let mon = null, monF = { range: 'today', d: 'all' };
let deactOpen = false; try { deactOpen = localStorage.getItem('deactOpen') === '1'; } catch {}
let filt = { d: 'all', s: 'all', q: '' }, logF = { q: '', d: 'all', t: 'all' }, tplSel = null, cacheQ = '', fold = { safety: true, ai: false, conn: true }, pvList = [];

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const dName = id => dealers.find(d => d.id === id)?.name ?? '';
function toast(m) { const t = $('#toast'); t.textContent = m; t.hidden = false; clearTimeout(toast.h); toast.h = setTimeout(() => t.hidden = true, 2400); }

async function api(method, url, body) {
  const r = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  if (r.redirected) { location.href = '/login'; throw new Error('Signed out'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || 'Something went wrong. Try again.'), { errors: data.errors });
  return data;
}
const dayOf = date => new Intl.DateTimeFormat('en-US', { timeZone: ZONE, month: 'short', day: 'numeric' }).format(date);
const timeOf = date => new Intl.DateTimeFormat('en-US', { timeZone: ZONE, hour: 'numeric', minute: '2-digit' }).format(date);

async function load() {
  const [s, m] = await Promise.all([api('GET', '/api/state'), loadMonitor()]);
  mon = m;
  settings = s.settings; sending = s.settings.sending; dev = s.dev; conns = s.connections || conns; cache = s.cache.map(c => ({ ...c, when: `${dayOf(new Date(c.last_scraped))}, ${timeOf(new Date(c.last_scraped))}` }));
  alerts = s.alerts.map(a => ({ ...a, sev: a.severity }));
  dealers = s.dealers.map(d => ({ id: d.id, name: d.name, mailbox: d.mailbox, passthrough: d.passthrough, site: d.website, staff: d.staff_phones, active: d.active, test: d.test_mode, sales: d.sales_phone, service: d.service_phone, address: d.address, google: d.google_status, crm: d.crm, textFormat: d.staff_text_format || 'formatted' }));
  tpl = Object.fromEntries(s.templates.map(t => [t.dealership_id, { reasons: t.reasons, buttons: t.buttons, logoUrl: t.logo_url, buildingPhotoUrl: t.building_photo_url, links: t.links }]));
  const today = dayOf(new Date());
  leads = s.leads.map(l => {
    const at = new Date(l.received_at), day = dayOf(at);
    const status = l.status === 'replied' && l.kind === 'fallback' ? 'fallback' : l.status || 'queued';
    return { id: l.id, t: timeOf(at), date: day === today ? null : day, day, d: l.dealership_id, first: l.first_name || 'Customer', full: [l.first_name, l.last_name].filter(Boolean).join(' '), email: l.email, phone: l.phone, vehicle: [l.year, l.make, l.model, l.trim].filter(Boolean).join(' ') || 'Vehicle not given', vin: l.vin, stock: l.stock, deal: l.deal_number || '', type: l.lead_type, src: l.lead_source, subject: l.subject, raw: l.raw, status, failure: l.failure, secs: l.seconds, photos: l.photo_count ?? 0, cache: l.photo_source || '', from: l.from_address, to: l.to_address, replySubject: l.reply_subject, html: l.html, events: s.events.filter(e => e.lead_id === l.id), texts: s.texts.filter(x => x.lead_id === l.id) };
  });
}

/* ---------- chrome ---------- */
const icons = {
  monitor: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
  leads: '<path d="M3 12h4l3-8 4 16 3-8h4"/>', log: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  alerts: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10 21a2 2 0 0 0 4 0"/>', dealerships: '<path d="M3 21V9l9-6 9 6v12"/><path d="M9 21v-6h6v6"/>',
  templates: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m3 8 9 6 9-6"/>', cache: '<rect x="3" y="3" width="18" height="14" rx="2"/><path d="m3 14 5-5 5 5 3-3 5 5"/><path d="M8 21h8"/>',
  controls: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/>'
};
const navItems = [['monitor', 'Monitor'], ['leads', 'Incoming leads'], ['log', 'Response log'], ['dealerships', 'Dealerships'], ['deactivated', 'Deactivated', 'sub'], ['templates', 'Templates'], ['cache', 'Vehicle cache'], ['controls', 'Settings'], ['alerts', 'Alerts']];
const sw = (on, id) => `<button class="sw" role="switch" aria-checked="${on}" data-sw="${id}" aria-label="toggle"></button>`;
const options = (list, current) => list.map(([v, l]) => `<option value="${esc(v)}" ${String(current) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('');

function renderChrome(route) {
  const open = alerts.length;
  if (route === 'deactivated') deactOpen = true;
  const link = ([k, l, s]) => `<a href="#${k}" ${s ? `class="subnav" id="sub-${k}" ${deactOpen ? '' : 'hidden'}` : ''} ${route === k ? 'aria-current="page"' : ''}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${icons[k] || ''}</svg>${l}${k === 'alerts' && open ? `<span class="badge">${open}</span>` : ''}</a>`;
  // Dealerships carries an arrow that shows or hides Deactivated underneath it.
  $('#nav').innerHTML = navItems.map(item => item[0] !== 'dealerships' ? link(item) : `<div class="navrow">${link(item)}<button class="navtoggle" id="deacttoggle" aria-expanded="${deactOpen}" aria-controls="sub-deactivated" aria-label="${deactOpen ? 'Hide' : 'Show'} deactivated dealerships" title="${deactOpen ? 'Hide' : 'Show'} deactivated dealerships"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></button></div>`).join('');
  $('#deacttoggle').onclick = () => { deactOpen = !deactOpen; try { localStorage.setItem('deactOpen', deactOpen ? '1' : ''); } catch {} renderChrome(route); };
  const s = $('#send'); s.className = 'send' + (sending ? '' : ' paused');
  s.innerHTML = `<b><span class="dot"></span>${sending ? 'Live' : 'Paused'}</b><div class="ctl"><button id="pausebtn" class="${sending ? '' : 'on-pause'}" aria-label="Pause all sending" aria-pressed="${!sending}" title="Pause all sending"><svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg></button><button id="playbtn" class="${sending ? 'on-play' : ''}" aria-label="Resume sending" aria-pressed="${sending}" title="Resume sending"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5z"/></svg></button></div>`;
  $('#pausebtn').onclick = () => { if (sending) askPause(); };
  $('#playbtn').onclick = () => { if (!sending) setSending(true); };
}
async function setSending(on) { await api('POST', '/api/sending', { sending: on }); toast(on ? 'Sending resumed' : 'All sending paused'); await refresh(); }

/* ---------- views ---------- */
function viewLeads() {
  const td = leads.filter(l => !l.date);
  const rows = td.filter(l => (filt.d === 'all' || l.d == filt.d) && (filt.s === 'all' || l.status === filt.s) && (!filt.q || (l.first + l.full + l.vehicle + l.vin).toLowerCase().includes(filt.q.toLowerCase())));
  const dayCount = td.filter(l => filt.d === 'all' || l.d == filt.d).length, dn = filt.d === 'all' ? 'All dealerships' : dName(+filt.d);
  return `<div class="head"><div><h1>Incoming leads</h1><p class="sub">Every lead received and how it was answered. Newest first.</p></div>${dev ? '<button class="btn primary" id="sim">Simulate a new lead</button>' : ''}</div>
  ${dev ? '<div class="demo">Running on your computer. “Simulate a new lead” sends the sample email through the real steps. Nothing leaves this computer.</div>' : ''}
  <div class="count" role="status" aria-live="polite"><b>${dayCount}</b><span>Leads received today<small>${esc(dn)}</small></span>${rows.length !== dayCount ? `<em>Showing ${rows.length} with the current filters</em>` : ''}</div>
  <div class="filters"><select id="fd" aria-label="Dealership"><option value="all">All dealerships</option>${options(dealers.filter(d => d.active).map(d => [d.id, d.name]), filt.d)}</select>
  <select id="fs" aria-label="Status"><option value="all">All statuses</option>${options(Object.entries(statusLabel), filt.s)}</select>
  <input id="fq" type="search" placeholder="Search name, vehicle, or VIN" value="${esc(filt.q)}"></div>
  <div class="tablewrap"><table><thead><tr><th>Received</th><th>Dealership</th><th>Customer</th><th>Vehicle</th><th>Status</th><th>Response time</th></tr></thead><tbody>
  ${rows.map(l => `<tr class="click" tabindex="0" data-go="lead-${l.id}"><td class="tnum">${l.t}</td><td>${esc(dName(l.d))}</td><td>${esc(l.first)}</td><td>${esc(l.vehicle)}</td><td><span class="chip ${l.status}">${statusLabel[l.status]}</span></td><td>${l.secs == null ? '<span class="muted">No reply</span>' : `<div class="rt ${l.secs > 6 ? 'slow' : ''}"><span class="tnum">${l.secs.toFixed(1)}s</span><i style="width:${Math.min(l.secs * 10, 80)}px"></i></div>`}</td></tr>`).join('')}
  </tbody></table>${rows.length ? '' : `<div class="empty">${td.length ? 'No leads match these filters. Clear a filter to see more.' : 'No leads yet today. New leads appear here as they arrive.'}</div>`}</div>`;
}
function replyBlock(l) { return l.html ? `<div class="hdrs"><div><b>From</b><span>${esc(l.from)}</span></div><div><b>To</b><span>${esc(l.to)}${l.status === 'test' ? ' (test mode)' : ''}</span></div><div><b>Subject</b><span>${esc(l.replySubject)}</span></div></div><div class="emailframe">${l.html}</div>` : ''; }
function viewLead(id) {
  const l = leads.find(x => x.id === id); if (!l) return '<p>Lead not found.</p>';
  const canSend = l.status === 'held' || l.status === 'failed';
  return `<a class="back" href="#leads">Back to incoming leads</a>
 <div class="head"><div><h1>${esc(l.first)}, ${esc(l.vehicle)}</h1><p class="sub">${esc(dName(l.d))} · Received ${l.date ? l.date + ', ' : ''}${l.t} · <span class="chip ${l.status}">${statusLabel[l.status]}</span></p></div>
 <div><button class="btn" data-resend="${l.id}" ${canSend && sending ? '' : 'disabled'}>Send reply</button></div></div>
 <div class="cols"><div class="stack">
  <section class="panel"><h2>What the app read</h2><dl class="kv"><dt>Customer</dt><dd>${esc(l.full || l.first)}</dd><dt>Email</dt><dd>${esc(l.email) || '<span class="muted">Not in this lead</span>'}</dd><dt>Phone</dt><dd>${esc(l.phone) || '<span class="muted">Not in this lead</span>'}</dd><dt>Vehicle</dt><dd>${esc(l.vehicle)}</dd><dt>VIN</dt><dd class="tnum">${esc(l.vin) || '<span class="muted">Not in this lead</span>'}</dd><dt>Stock number</dt><dd>${esc(l.stock) || '<span class="muted">Not in this lead</span>'}</dd><dt>Lead type</dt><dd>${esc(l.type)}</dd><dt>Lead ID</dt><dd>${esc(l.deal)}</dd><dt>Lead source</dt><dd>${esc(l.src)}</dd><dt>Photos</dt><dd>${l.photos} found${l.cache ? ' · ' + esc(l.cache) : ''}</dd></dl></section>
  <section class="panel"><h2>Original notification</h2><pre class="raw">${esc(l.raw)}</pre></section>
  <section class="panel"><h2>Timeline</h2><ol class="time">${l.events.map(e => `<li class="${esc(e.severity)}"><time>${timeOf(new Date(e.at))}</time>${esc(e.message)}</li>`).join('')}</ol></section>
  <section class="panel"><h2>Texts sent</h2>${l.texts.length ? l.texts.map(x => `<div class="sms"><small>To ${esc(x.recipient)} (${esc(x.audience)}, ${esc(x.status)}${x.failure ? ': ' + esc(x.failure) : ''})</small>${esc(x.body)}</div>`).join('') : '<div class="empty">No texts were sent for this lead.</div>'}</section>
 </div>
 <section class="panel"><h2>Reply that was sent</h2>${l.html ? replyBlock(l) : `<div class="banner" style="margin:0">${esc(l.failure || 'No reply has been sent for this lead.')}</div>`}</section></div>`;
}
function logMatches(l) {
  const d = dealers.find(x => x.id === l.d);
  if (logF.d !== 'all' && l.d !== +logF.d) return false;
  if (logF.t !== 'all' && l.type !== logF.t) return false;
  const q = logF.q.trim().toLowerCase(); if (!q) return true;
  return [l.full, l.first, l.email, l.phone, l.vehicle, l.vin, l.stock, l.deal, d?.name, l.type, l.src, statusLabel[l.status], l.subject].join(' ').toLowerCase().includes(q);
}
function drawLog() {
  const rows = leads.filter(logMatches);
  $('#logcount').textContent = 'Showing ' + rows.length + ' of ' + leads.length + ' responses';
  $('#daycount').textContent = leads.filter(l => !l.date && l.secs != null && (logF.d === 'all' || l.d === +logF.d)).length;
  $('#daylabel').textContent = logF.d === 'all' ? 'All dealerships' : dName(+logF.d);
  $('#logbody').innerHTML = rows.map(l => `<tr class="click" tabindex="0" data-go="lead-${l.id}"><td class="tnum">${l.day}, ${l.t}</td><td>${esc(dName(l.d))}</td><td>${esc(l.full || l.first)}</td><td>${esc(l.vehicle)}</td><td class="tnum">${esc(l.vin) || '<span class="muted">None</span>'}</td><td>${esc(l.type)}</td><td class="tnum">${esc(l.deal)}</td><td><span class="chip ${l.status}">${statusLabel[l.status]}</span></td><td class="tnum">${l.secs == null ? '<span class="muted">No reply</span>' : l.secs.toFixed(1) + 's'}</td><td><button class="btn sm" data-preview="${l.id}" aria-label="Preview response" title="Preview response"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:block"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg></button></td></tr>`).join('');
  $('#logempty').innerHTML = rows.length ? '' : leads.length ? '<div class="empty">No responses match. Try a different search, or <button class="btn sm" id="lclear">clear the filters</button>.</div>' : '<div class="empty">No responses yet. Every reply the app sends will be listed here.</div>';
  $('#logbody').querySelectorAll('[data-go]').forEach(e => { e.onclick = () => location.hash = e.dataset.go; e.onkeydown = ev => { if (ev.key === 'Enter') location.hash = e.dataset.go; }; });
  $('#logbody').querySelectorAll('[data-preview]').forEach(b => b.onclick = e => { e.stopPropagation(); showPreview(+b.dataset.preview); });
  const c = $('#lclear'); if (c) c.onclick = () => { logF = { q: '', d: 'all', t: 'all' }; router(); };
}
function viewLog() {
  return `<div class="head"><div><h1>Response log</h1><p class="sub">Every lead that was answered, across all dealerships. Click a row to see the reply that was sent.</p></div></div>
 <div class="count" role="status" aria-live="polite"><b id="daycount">0</b><span>Responses sent today<small id="daylabel"></small></span></div>
 <div class="filters"><select id="ld" aria-label="Dealership"><option value="all">All dealerships</option>${options(dealers.filter(d => d.active).map(d => [d.id, d.name]), logF.d)}</select>
 <select id="lt" aria-label="Lead type"><option value="all">All Lead Types</option>${options(LEAD_TYPES.map(t => [t, t]), logF.t)}</select>
 <input id="lq" type="search" placeholder="Search customer, VIN, vehicle, lead ID, or anything else" value="${esc(logF.q)}" aria-label="Search the response log" style="flex:1 1 280px"></div>
 <p class="muted" id="logcount" style="margin:0 0 10px"></p>
 <div class="tablewrap"><table style="min-width:1120px"><thead><tr><th>Received</th><th>Dealership</th><th>Customer</th><th>Vehicle</th><th>VIN</th><th>Lead type</th><th>Lead ID</th><th>Status</th><th>Response time</th><th></th></tr></thead><tbody id="logbody"></tbody></table><div id="logempty"></div></div>
 <p class="muted" style="margin-top:12px">The dealership list shows active stores only. Choosing “All dealerships” also includes past responses from stores that are now off.</p>`;
}
function viewAlerts() {
  return `<h1>Alerts</h1><p class="sub">Only problems to fix. Today’s numbers are on the Monitor.</p><div class="panel" style="padding:0">${alerts.length ? alerts.map(a => `<div class="alert"><span class="chip ${esc(a.sev)}">${a.sev === 'failed' ? 'Needs fixing' : 'Check'}</span><div><b>${esc(a.title)}</b><p>${esc(a.body)}</p></div><a class="btn sm" href="${esc(a.link)}" style="text-decoration:none;color:inherit">${esc(a.cta)}</a><button class="btn sm" data-dismiss="${a.id}">Dismiss</button></div>`).join('') : '<div class="empty">All clear. New problems will show up here.</div>'}</div>`;
}
const googleChip = g => g === 'ok' ? '<span class="chip replied">Connected</span>' : g === 'new' ? '<span class="chip test">Not connected</span>' : '<span class="chip failed">Expired</span>';
function viewDealers() {
  const list = dealers.filter(d => d.active);
  return `<div class="head"><div><h1>Dealerships</h1><p class="sub">Each store’s mailbox, CRM address, and staff phone numbers.</p></div><button class="btn primary" data-add>Add dealership</button></div>
 <div class="tablewrap"><table><thead><tr><th>Dealership</th><th>Notification mailbox</th><th>CRM</th><th>CRM passthrough</th><th>Google</th><th>Mode</th><th></th></tr></thead><tbody>
 ${list.map(d => `<tr class="click" tabindex="0" data-go="dealership-${d.id}"><td><b>${esc(d.name)}</b></td><td>${d.mailbox ? esc(d.mailbox) : '<span class="muted">Not set</span>'}</td><td>${esc(d.crm || 'Not set')}</td><td>${d.passthrough ? esc(d.passthrough) : '<span class="chip failed">Missing: sending blocked</span>'}</td><td>${googleChip(d.google)}</td><td>${d.test ? '<span class="chip test">Test mode</span>' : '<span class="chip replied">Live</span>'}</td><td><button class="btn sm danger" data-deact="${d.id}">Deactivate</button></td></tr>`).join('')}
 </tbody></table>${list.length ? '' : '<div class="empty">No dealerships yet. Press Add dealership to set up your first store.</div>'}</div>`;
}
function viewDeactivated() {
  const off = dealers.filter(d => !d.active);
  return `<div class="head"><div><h1>Deactivated</h1><p class="sub">Stores that are switched off. The app ignores their mailboxes and sends nothing. Their past leads stay in the logs.</p></div></div>
 <div class="tablewrap"><table><thead><tr><th>Dealership</th><th>Notification mailbox</th><th>CRM passthrough</th><th></th></tr></thead><tbody>
 ${off.map(d => `<tr class="click" tabindex="0" data-go="dealership-${d.id}"><td><b>${esc(d.name)}</b></td><td>${d.mailbox ? esc(d.mailbox) : '<span class="muted">Not set</span>'}</td><td>${d.passthrough ? esc(d.passthrough) : '<span class="muted">None</span>'}</td><td><button class="btn sm" data-react="${d.id}">Reactivate</button></td></tr>`).join('')}</tbody></table>${off.length ? '' : '<div class="empty">No deactivated dealerships. Stores you deactivate will appear here.</div>'}</div>`;
}
const connectBtn = label => `<button class="btn" type="button" data-google>${label}</button>`;
const withBtn = (input, btn) => btn ? `<div class="inl">${input}${btn}</div>` : input;
const field = (id, label, ph, hint, wide, btn) => `<div class="field ${wide ? 'full' : ''}" data-f="${id}"><label for="${id}">${label}</label>${withBtn(`<input id="${id}" placeholder="${ph}" autocomplete="off">`, btn)}${hint ? `<small>${hint}</small>` : ''}<span class="err-msg"></span></div>`;
function viewDealerNew() {
  return `<a class="back" href="#dealerships">Back to dealerships</a><div class="head"><div><h1>Add dealership</h1><p class="sub">New dealerships start in test mode, so nothing goes to the CRM or staff until you switch the store live.</p></div><button class="btn primary" id="adddealer">Add dealership</button></div>
 <div class="panel"><div class="form">
  ${field('name', 'Dealership name', 'Earnhardt Cadillac', 'Used in every email and text.')}
  ${field('site', 'Website', 'yourstore.com', 'Where the app looks up vehicle photos.')}
  ${field('mailbox', 'Notification mailbox', 'leads@yourstore.com', 'The Google Workspace inbox where this store’s lead notifications arrive. Press Connect to sign in with Google.', false, connectBtn('Connect'))}
  <div class="field" data-f="crm"><label for="crm">CRM (required)</label><select id="crm"><option value="">Select a CRM</option>${CRMS.map(c => `<option>${esc(c)}</option>`).join('')}</select><span class="err-msg"></span></div>
  ${field('passthrough', 'CRM passthrough address (required)', 'sales@yourstore.edealerhub.com', 'Replies go here so the CRM logs them. Never notify@eleadnotify.com.', true)}
  ${field('sales', 'Sales phone', '480-555-0100')}${field('service', 'Service phone', '480-555-0101')}
  ${field('address', 'Address', 'Street, city, state ZIP', '', true)}
  <div class="field full" data-f="staff"><label for="staff">Staff phone numbers for text alerts</label><textarea id="staff" style="min-height:80px"></textarea><small>One number per line. Only numbers covered by your approved Twilio campaign.</small><span class="err-msg"></span></div>
  <div class="field"><label for="textfmt">Staff text format</label><select id="textfmt">${options([['formatted', 'Formatted'], ['raw', 'Raw']], 'formatted')}</select><small>Formatted: tidy lines with the customer, vehicle, phone and email. Raw: the lead notification exactly as it came in (longer texts cost more).</small></div>
 </div></div>`;
}
function viewDealer(id) {
  const d = dealers.find(x => x.id === id); if (!d) return '<p>Not found.</p>';
  const googleText = d.google === 'ok' ? 'Connected. The app can read and send from this mailbox.' : d.google === 'new' ? 'Not connected yet. Connect Google so the app can read and send from this mailbox.' : 'Sign-in expired. Reconnect to resume replies.';
  const val = (i, label, v, hint, wide, btn) => `<div class="field ${wide ? 'full' : ''}" data-f="${i}"><label for="${i}">${label}</label>${withBtn(`<input id="${i}" value="${esc(v)}">`, btn)}${hint ? `<small>${hint}</small>` : ''}<span class="err-msg"></span></div>`;
  return `<a class="back" href="${d.active ? '#dealerships' : '#deactivated'}">${d.active ? 'Back to dealerships' : 'Back to deactivated'}</a><div class="head"><div><h1>${esc(d.name)}</h1><p class="sub">Changes here also update the email template, so the dealership name only lives in one place.</p></div><button class="btn primary" id="savedealer" data-id="${d.id}">Save changes</button></div>
 <div class="panel"><div class="form">
  ${val('name', 'Dealership name', d.name, 'Used in every email and text.')}${val('site', 'Website', d.site)}
  ${val('mailbox', 'Notification mailbox', d.mailbox, 'The Google Workspace inbox where lead notifications arrive.', false, connectBtn(d.google === 'new' ? 'Connect' : 'Reconnect'))}
  <div class="field"><label for="crm">CRM</label><select id="crm"><option value="">Select a CRM</option>${options(CRMS.map(c => [c, c]), d.crm)}</select><small>The system that receives replies at the passthrough address.</small></div>
  ${val('passthrough', 'CRM passthrough address (required)', d.passthrough, 'Replies go here so the CRM logs them. The app never sends to notify@eleadnotify.com.', true)}
  ${val('sales', 'Sales phone', d.sales)}${val('service', 'Service phone', d.service)}${val('address', 'Address', d.address, '', true)}
  <div class="field full" data-f="staff"><label for="staff">Staff phone numbers for text alerts</label><textarea id="staff" style="min-height:80px">${esc(d.staff.join('\n'))}</textarea><small>One number per line. Only numbers covered by your approved Twilio campaign.</small><span class="err-msg"></span></div>
  <div class="field"><label for="textfmt">Staff text format</label><select id="textfmt">${options([['formatted', 'Formatted'], ['raw', 'Raw']], d.textFormat)}</select><small>Formatted: tidy lines with the customer, vehicle, phone and email. Raw: the lead notification exactly as it came in (longer texts cost more).</small></div>
 </div>
 <div style="margin-top:12px">
  <div class="toggle"><div><b>${d.active ? 'Deactivate dealership' : 'Reactivate dealership'}</b><small>${d.active ? 'Stops replies and texts for this store and moves it to Deactivated. Past leads stay in the logs.' : 'This store is deactivated. Reactivate it to resume replies and texts.'}</small></div>${d.active ? `<button class="btn sm danger" data-deact="${d.id}">Deactivate</button>` : `<button class="btn sm" data-react="${d.id}">Reactivate</button>`}</div>
  <div class="toggle"><div><b>Test mode</b><small>Replies and texts go only to you, never to the CRM or staff.</small></div>${sw(d.test, 'test-' + d.id)}</div>
  <div class="toggle"><div><b>Google connection</b><small>${googleText}</small></div><button class="btn sm" data-google>${d.google === 'ok' ? 'Reconnect' : 'Connect Google'}</button></div>
  <div class="toggle"><div><b>Send test</b><small>Replies as this address to your test inbox before the store goes live.</small></div><button class="btn sm" disabled>Send test</button></div>
 </div></div>`;
}
function viewTemplates() {
  if (!dealers.length) return '<h1>Templates</h1><p class="sub">Edit the parts of the reply that stay the same.</p><div class="panel"><div class="empty">Add a dealership first. Its template appears here.</div></div>';
  if (!tpl[tplSel]) tplSel = dealers[0].id;
  const t = tpl[tplSel];
  return `<div class="head"><div><h1>Templates</h1><p class="sub">Edit the parts of the reply that stay the same. The preview updates as you type.</p></div><button class="btn primary" id="savetpl">Save template</button></div>
 <div class="filters"><select id="tsel" aria-label="Dealership">${options(dealers.map(x => [x.id, x.name]), tplSel)}</select></div>
 <div class="cols"><section class="panel"><div class="form" style="grid-template-columns:1fr">
  <div class="field"><label for="t-reasons">Reasons to buy</label><textarea id="t-reasons" style="min-height:170px">${esc(t.reasons)}</textarea><small>One per line. Each becomes a bullet.</small></div>
  <div class="field"><label for="t-btn">Buttons</label><input id="t-btn" value="${esc(t.buttons)}"><small>Separate with commas. The first is the dark button.</small></div>
  <div class="field"><label for="t-links">Button links</label><textarea id="t-links" style="min-height:110px" placeholder="Schedule Test Drive = https://yourstore.com/test-drive">${esc(t.links)}</textarea><small>One per line, as Button name = https link. Use {vin} and {stock} for links that change per vehicle. A button with no link is left out of the email.</small></div>
  <div class="field"><label for="t-logo">Logo image link</label><input id="t-logo" value="${esc(t.logoUrl)}" placeholder="https://yourstore.com/logo.png"></div>
  <div class="field"><label for="t-bldg">Building photo link</label><input id="t-bldg" value="${esc(t.buildingPhotoUrl)}" placeholder="https://yourstore.com/building.jpg"></div>
  <div class="field"><label>Name, phone numbers, and address</label><small>These come from the dealership page, not from this template. Edit them there.</small></div>
  <div class="field"><label for="t-lead">Preview with</label><select id="t-lead"><option value="full">Alex, 2027 Cadillac Escalade (photos found)</option><option value="fallback">Alex, no VIN (vehicle unavailable)</option></select></div>
 </div></section>
 <section class="panel"><h2>Preview</h2><div id="tprev" class="emailframe"></div></section></div>`;
}
function viewCache() {
  const rows = cache.filter(c => c.vin.toLowerCase().includes(cacheQ.trim().toLowerCase().replace(/\s+/g, '')));
  return `<div class="head"><div><h1>Vehicle cache</h1><p class="sub">Photo links the app already found. A repeat lead for the same VIN skips Firecrawl.</p></div><button class="btn danger" data-clearall ${cache.length ? '' : 'disabled'}>Clear all</button></div>
 <p class="stats" style="display:flex"><span class="stat"><b>${cache.length}</b><span>Vehicles saved</span></span><span class="stat"><b>${cache.reduce((a, c) => a + c.hits, 0)}</b><span>Firecrawl lookups avoided</span></span></p>
 <div class="filters"><input id="cq" type="search" placeholder="Search by VIN" value="${esc(cacheQ)}" aria-label="Search by VIN" style="max-width:420px"></div>
 <div class="tablewrap"><table><thead><tr><th>VIN</th><th>Vehicle</th><th>Photos</th><th>Last scraped</th><th>Reused</th><th></th></tr></thead><tbody>
 ${rows.map(c => `<tr><td class="tnum">${esc(c.vin)}</td><td>${esc(c.vehicle)}</td><td><div class="thumbs">${c.photos.map((u, i) => `<button class="thumb" data-view="${esc(c.vin)}" aria-label="View photos of ${esc(c.vehicle)}"><img src="${esc(u)}" alt="Vehicle photo ${i + 1}" style="width:100%;display:block"></button>`).join('')}</div></td><td>${c.when}</td><td>${c.hits} time${c.hits === 1 ? '' : 's'}</td><td><button class="btn sm" data-refresh="${esc(c.vin)}">Refresh</button> <button class="btn sm" data-del="${esc(c.vin)}">Remove</button></td></tr>`).join('')}</tbody></table>${rows.length ? '' : (cache.length ? '<div class="empty">No saved vehicle matches that VIN. Check the number or clear the search.</div>' : '<div class="empty">Nothing saved yet. Photos appear here after the first lead for each vehicle.</div>')}</div>
 <p class="muted" style="margin-top:12px">Only photo links are saved, never the image files. Every email shows the dealership’s real photos of that exact vehicle.</p>`;
}
function viewControls() {
  const connected = dealers.filter(d => d.active && d.google === 'ok').length, active = dealers.filter(d => d.active).length;
  const notYet = '<span class="chip test">Not connected</span>';
  return `<h1>Settings</h1><p class="sub">App-wide controls and connections.</p>
 <div class="setgrid"><div class="stack">
  <details class="panel fold" data-fold="safety" ${fold.safety ? 'open' : ''}><summary><span>Safety</span><span class="muted">${sending ? 'Sending is live' : 'Sending is paused'}</span></summary>
   <div class="toggle"><div><b>Sending</b><small>Turn off to hold every new lead without replying or texting.</small></div>${sw(sending, 'sending')}</div>
   <div class="toggle"><div><b>New dealerships start in test mode</b><small>You choose when each one goes live.</small></div><span class="chip replied">Locked on</span></div>
   <div class="toggle"><div><b>Block duplicate replies</b><small>The same deal number never gets two replies.</small></div><span class="chip replied">Locked on</span></div>
   <div class="toggle"><div><b>Text the customer</b><small>Send an SMS to the customer as well as dealership staff. Includes STOP handling.</small></div>${sw(settings.customer_texts, 'customerTexts')}</div>
   <div class="toggle"><div><b>Never reply to notify@eleadnotify.com</b><small>Always on. The sender refuses this address.</small></div><span class="chip replied">Locked on</span></div>
   <div class="form" style="margin-top:14px;grid-template-columns:1fr">
    <div class="field"><label for="s-mail">Your test inbox</label><input id="s-mail" type="email" value="${esc(settings.owner_test_email)}" placeholder="you@yourcompany.com"><small>Test-mode replies go here.</small></div>
    <div class="field"><label for="s-phone">Your test phone</label><input id="s-phone" value="${esc(settings.owner_test_phone)}" placeholder="+14805550100"><small>Test-mode texts go here.</small></div>
    <div class="field"><label for="s-photo">Photo search limit (seconds)</label><input id="s-photo" type="number" min="1" max="30" value="${settings.photo_timeout_seconds}"><small>If photos aren’t found by then, the reply goes out without them.</small></div>
   </div>
  </details>
  <details class="panel fold" data-fold="ai" ${fold.ai ? 'open' : ''}><summary><span>Conversational replies</span>${notYet}<span class="muted">${esc(settings.model_id)}</span></summary>
   <div class="toggle"><div><b>Write replies with the model</b><small>Off means every customer gets the standard template wording.</small></div>${sw(settings.model_enabled, 'modelEnabled')}</div>
   <div class="form" style="margin-top:14px;grid-template-columns:1fr">
    <div class="field"><label for="aiprov">Provider</label><select id="aiprov">${options(Object.keys(AI_MODELS).map(p => [p, p]), settings.model_provider)}</select></div>
    <div class="field"><label for="aimodel">Model</label><select id="aimodel">${options(AI_MODELS[settings.model_provider], settings.model_id)}</select><small>Model ID: ${esc(settings.model_id)}</small></div>
    <div class="field"><label for="aito">Fallback timeout (seconds)</label><input id="aito" type="number" min="1" max="10" value="${settings.model_timeout_seconds}"><small>If the model hasn’t answered by then, the standard reply goes out instead.</small></div>
   </div>
  </details>
 </div><div class="stack">
  <details class="panel fold" data-fold="conn" ${fold.conn ? 'open' : ''}><summary><span>Connections</span></summary>
   <div class="conn"><div><b>Google Workspace</b><small>${connected} of ${active} active mailboxes connected</small></div>${connected && connected === active ? '<span class="chip replied">Connected</span>' : notYet}</div>
   <div class="conn"><div><b>Twilio</b><small>${conns.twilio.connected ? `Texts send from ${esc(conns.twilio.from)}. STOP and START replies are handled.` : 'Staff texts and STOP handling'}</small></div>${conns.twilio.connected ? '<span class="chip replied">Connected</span>' : notYet}</div>
   <div class="conn"><div><b>Firecrawl</b><small>Photo search by VIN</small></div>${notYet}</div>
   <div class="conn"><div><b>${esc(settings.model_provider)} (conversational replies)</b><small>Key not added yet</small></div>${notYet}</div>
   <p class="muted" style="margin:12px 0 0">Keys live on the server, never on this screen.</p>
  </details>
 </div></div>`;
}

/* ---------- dialogs ---------- */
function showModal(html, focus) {
  const m = $('#modal'); m.hidden = false; m.innerHTML = html;
  const close = () => { m.hidden = true; m.innerHTML = ''; };
  m.querySelectorAll('[data-close]').forEach(b => b.onclick = close);
  (focus ? m.querySelector(focus) : m.querySelector('[data-close]'))?.focus();
  return close;
}
function confirmBox(title, body, yes, onYes) {
  const close = showModal(`<div class="dlg" role="alertdialog" aria-modal="true" aria-labelledby="dt"><h2 id="dt">${esc(title)}</h2><p>${esc(body)}</p><div class="acts"><button class="btn" data-close>Cancel</button><button class="btn danger" id="mp">${esc(yes)}</button></div></div>`);
  $('#mp').onclick = () => { close(); onYes(); };
}
const askPause = () => confirmBox('Pause sending for all dealerships?', 'New leads will be held. Nobody gets a reply or a text until you resume. Leads that arrive while paused will wait for you in the Leads list.', 'Pause sending', () => setSending(false));
const setFlag = async (id, flags) => { await api('POST', `/api/dealerships/${id}/flags`, flags); await load(); };
function askDeactivate(id) {
  const d = dealers.find(x => x.id === id);
  confirmBox(`Deactivate ${d.name}?`, 'The app will stop replying to leads and texting for this store. Past leads stay in the logs. You can reactivate it any time from Deactivated.', 'Deactivate', async () => { await setFlag(id, { active: false }); toast(d.name + ' deactivated'); location.hash = 'deactivated'; router(); });
}
function showPreview(id) {
  pvList = leads.filter(logMatches);
  // Closes only with its Close button, as the spec asks.
  const open = lid => {
    const l = leads.find(x => x.id === lid), pos = pvList.findIndex(x => x.id === lid), total = pvList.length;
    const close = showModal(`<div class="dlg wide" role="dialog" aria-modal="true" aria-labelledby="pv-t"><div class="head" style="margin-bottom:12px"><div><h2 id="pv-t" style="margin:0">Response preview</h2><div class="muted">${esc(l.full || l.first)}, ${esc(dName(l.d))} <span class="chip ${l.status}">${statusLabel[l.status]}</span></div></div><div style="display:flex;gap:8px;align-items:center"><button class="btn sm" id="pv-prev" aria-label="Previous response" ${pos <= 0 ? 'disabled' : ''}>&#8249;</button><span class="muted tnum">${pos + 1} of ${total}</span><button class="btn sm" id="pv-next" aria-label="Next response" ${pos >= total - 1 ? 'disabled' : ''}>&#8250;</button><button class="btn sm" id="pv-open">Open lead</button><button class="btn sm" id="mc" data-close>Close</button></div></div>${l.html ? replyBlock(l) : '<div class="empty">No reply was sent for this lead, so there is nothing to preview.</div>'}</div>`, '#mc');
    const nav = n => { const t = pvList[pos + n]; if (t) { document.onkeydown = null; open(t.id); } };
    document.onkeydown = e => { if (e.key === 'ArrowLeft') nav(-1); else if (e.key === 'ArrowRight') nav(1); };
    $('#pv-prev').onclick = () => nav(-1); $('#pv-next').onclick = () => nav(1);
    $('#mc').addEventListener('click', () => { document.onkeydown = null; });
    $('#pv-open').onclick = () => { document.onkeydown = null; close(); location.hash = 'lead-' + l.id; };
  };
  open(id);
}
function showPhotos(vin) {
  const c = cache.find(x => x.vin === vin);
  showModal(`<div class="dlg wide" role="dialog" aria-modal="true" aria-labelledby="ph-t"><div class="head" style="margin-bottom:12px"><div><h2 id="ph-t" style="margin:0">${esc(c.vehicle)}</h2><div class="muted tnum">${esc(c.vin)}, ${c.photos.length} photo${c.photos.length === 1 ? '' : 's'}, last scraped ${c.when}</div></div><button class="btn sm" data-close>Close</button></div><div class="bigphotos">${c.photos.map((u, i) => `<img src="${esc(u)}" alt="Vehicle photo ${i + 1}" style="width:100%;border-radius:6px">`).join('')}</div></div>`);
}

/* ---------- dropdowns in the dashboard font ---------- */
function closeAllDD() { document.querySelectorAll('.dd-list').forEach(l => { l.hidden = true; l.previousElementSibling?.setAttribute('aria-expanded', 'false'); }); }
document.addEventListener('mousedown', e => { if (!e.target.closest('.dd')) closeAllDD(); });
function enhanceSelects(root) {
  root.querySelectorAll('select').forEach(sel => {
    if (sel.dataset.dd) return; sel.dataset.dd = '1';
    const wrap = document.createElement('div'); wrap.className = 'dd';
    sel.parentNode.insertBefore(wrap, sel); wrap.appendChild(sel); sel.classList.add('dd-native'); sel.tabIndex = -1; sel.setAttribute('aria-hidden', 'true');
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'dd-btn'; btn.setAttribute('aria-haspopup', 'listbox'); btn.setAttribute('aria-expanded', 'false');
    const al = sel.getAttribute('aria-label'); if (al) btn.setAttribute('aria-label', al);
    const list = document.createElement('ul'); list.className = 'dd-list'; list.setAttribute('role', 'listbox'); list.hidden = true;
    wrap.append(btn, list);
    let act = -1;
    const label = () => { const o = sel.options[sel.selectedIndex]; btn.textContent = o ? o.textContent : ''; };
    const setAct = i => { act = Math.max(0, Math.min(sel.options.length - 1, i)); Array.from(list.children).forEach((li, j) => li.classList.toggle('act', j === act)); list.children[act]?.scrollIntoView({ block: 'nearest' }); };
    const close = () => { list.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
    const choose = i => { close(); if (i !== sel.selectedIndex) { sel.selectedIndex = i; label(); sel.dispatchEvent(new Event('change', { bubbles: true })); } btn.focus(); };
    const build = () => { list.innerHTML = ''; Array.from(sel.options).forEach((o, i) => { const li = document.createElement('li'); li.setAttribute('role', 'option'); li.textContent = o.textContent; li.setAttribute('aria-selected', String(i === sel.selectedIndex)); li.onmousedown = e => { e.preventDefault(); choose(i); }; list.appendChild(li); }); };
    const open = () => { closeAllDD(); build(); list.hidden = false; btn.setAttribute('aria-expanded', 'true'); setAct(sel.selectedIndex); };
    btn.onclick = () => { list.hidden ? open() : close(); };
    btn.onkeydown = e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (list.hidden) open(); else setAct(act + (e.key === 'ArrowDown' ? 1 : -1)); }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (list.hidden) open(); else choose(act); }
      else if (e.key === 'Escape' || e.key === 'Tab') close();
    };
    label();
  });
}

/* ---------- monitor ---------- */
const RANGE_LABEL = { today: 'Today', '7d': 'Last 7 days', '30d': 'Last 30 days' };
const loadMonitor = () => api('GET', `/api/monitor?range=${monF.range}${monF.d === 'all' ? '' : '&dealer=' + monF.d}`);
const secs = v => v == null ? '–' : `${Number(v).toFixed(1)}s`;
const hourName = h => `${h % 12 || 12}${h < 12 ? 'a' : 'p'}`;
const hourLong = h => `${h % 12 || 12}${h < 12 ? ' AM' : ' PM'}`;
function ago(at) {
  if (!at) return { text: 'No leads yet', quiet: true };
  const min = Math.round((Date.now() - new Date(at).getTime()) / 60000);
  const text = min < 1 ? 'Just now' : min < 60 ? `${min} min ago` : min < 1440 ? `${Math.round(min / 60)} hr ago` : `${Math.round(min / 1440)} day${min < 2880 ? '' : 's'} ago`;
  return { text, quiet: min >= 1440 };
}
// Clicking a number opens the list behind it. Incoming leads covers today; the Response log covers longer ranges.
function drill({ d = monF.d, s = 'all', t = 'all', log = false }) {
  if (log || monF.range !== 'today') { logF.d = String(d); logF.t = t; logF.q = ''; location.hash = 'log'; }
  else { filt.d = String(d); filt.s = s; filt.q = ''; location.hash = 'leads'; }
}
const dj = o => esc(JSON.stringify(o));
function tile(label, value, sub, target) {
  return `<div class="tile click" tabindex="0" role="link" data-drill="${dj(target)}"><span>${label}</span><b class="tnum">${value}</b><small>${sub}</small></div>`;
}
function typeChart(types) {
  const by = Object.fromEntries(types.map(t => [t.type, t]));
  const rows = [...LEAD_TYPES, ...types.map(t => t.type).filter(t => !LEAD_TYPES.includes(t))].map(t => ({ t: t || 'Unknown', r: by[t]?.received ?? 0, a: by[t]?.responded ?? 0 }));
  const max = Math.max(1, ...rows.map(x => x.r));
  return `<div class="legend"><span><i class="sw1"></i>Received</span><span><i class="sw2"></i>Responded</span></div>
  <div class="hbars">${rows.map(x => `<div class="hrow click" tabindex="0" role="link" data-drill="${dj({ t: x.t, log: true })}" data-tip="${esc(`${x.t}: ${x.r} received, ${x.a} responded`)}"><span class="hl">${esc(x.t)}</span>
   <div class="hb"><div class="bar s1" style="width:${x.r / max * 100}%"></div><em class="tnum">${x.r}</em></div>
   <div class="hb"><div class="bar s2" style="width:${x.a / max * 100}%"></div><em class="tnum">${x.a}</em></div></div>`).join('')}</div>`;
}
function hourChart(hours, fast) {
  const by = Object.fromEntries(hours.map(h => [h.hour, h]));
  const all = Array.from({ length: 24 }, (_, h) => ({ h, n: by[h]?.received ?? 0, avg: by[h]?.avg_seconds ?? null }));
  const max = Math.max(1, ...all.map(x => x.n)), slow = all.filter(x => x.avg != null && x.avg >= fast);
  return `<div class="legend"><span><i class="sw1"></i>Leads received</span>${slow.length ? `<span class="slowkey">▲ Average reply ${fast}s or slower</span>` : ''}</div>
  <div class="vchart"><div class="vgrid"><span class="tnum">${max}</span><span class="tnum">0</span></div><div class="vbars">${all.map(x => `<div class="vcol" tabindex="0" data-tip="${esc(`${hourLong(x.h)}: ${x.n} lead${x.n === 1 ? '' : 's'}${x.avg != null ? `, average reply ${x.avg.toFixed(1)}s` : ''}`)}">${x.avg != null && x.avg >= fast ? '<b class="slowmark" aria-label="slow">▲</b>' : ''}<div class="bar s1" style="height:${x.n / max * 100}%"></div></div>`).join('')}</div></div>
  <div class="vaxis">${all.map(x => `<span>${x.h % 3 === 0 ? hourName(x.h) : ''}</span>`).join('')}</div>
  <p class="muted small">${monF.range === 'today' ? 'Today, by hour (Arizona time).' : `${RANGE_LABEL[monF.range]}, added up by hour of the day (Arizona time).`}</p>`;
}
function viewMonitor() {
  if (!mon) return '<h1>Monitor</h1><div class="empty">Loading…</div>';
  const t = mon.totals, under = t.responded ? Math.round(t.fast / t.responded * 100) : null;
  const dn = monF.d === 'all' ? 'All dealerships' : dName(+monF.d);
  return `<div class="head"><div><h1>Monitor</h1><p class="sub">Is every dealership getting answered? ${esc(RANGE_LABEL[monF.range])} · ${esc(dn)}</p></div></div>
 <div class="filters"><div class="seg" role="group" aria-label="Time range">${Object.entries(RANGE_LABEL).map(([k, l]) => `<button class="${monF.range === k ? 'on' : ''}" aria-pressed="${monF.range === k}" data-range="${k}">${l}</button>`).join('')}</div>
  <select id="md" aria-label="Dealership"><option value="all">All dealerships</option>${options(dealers.filter(d => d.active).map(d => [d.id, d.name]), monF.d)}</select></div>
 <div class="tiles">
  ${tile('Leads received', t.received, esc(RANGE_LABEL[monF.range]), {})}
  ${tile('Responses sent', t.responded, t.received ? `${Math.round(t.responded / t.received * 100)}% of leads` : 'No leads yet', { log: true })}
  ${tile('Failed or held', t.failed + t.held, `${t.failed} failed · ${t.held} held`, { s: t.failed ? 'failed' : 'held' })}
  ${tile('Average response', secs(t.avg_seconds), 'From lead in to reply sent', { log: true })}
  ${tile(`Under ${mon.fastSeconds} seconds`, under == null ? '–' : under + '%', under == null ? 'No replies yet' : `${t.fast} of ${t.responded} replies`, { log: true })}
 </div>
 <section class="panel"><h2>Dealerships</h2><div class="tablewrap"><table><thead><tr><th>Dealership</th><th>Mode</th><th>Google</th><th class="num">Received</th><th class="num">Responded</th><th class="num">Failed</th><th class="num">Avg response</th><th>Last lead</th></tr></thead><tbody>
  ${mon.dealers.length ? mon.dealers.map(d => { const a = ago(d.last_lead); return `<tr class="click" tabindex="0" data-drill="${dj({ d: d.id })}"><td>${esc(d.name)}</td><td>${d.test_mode ? '<span class="chip test">Test</span>' : '<span class="chip replied">Live</span>'}</td><td>${googleChip(d.google_status)}</td><td class="num tnum">${d.received}</td><td class="num tnum">${d.responded}</td><td class="num tnum">${d.failed ? `<span class="chip failed">${d.failed}</span>` : 0}</td><td class="num tnum">${secs(d.avg_seconds)}</td><td>${a.quiet ? `<span class="chip fallback" title="No lead in the last 24 hours. Check the mailbox connection.">⚠ ${esc(a.text)}</span>` : esc(a.text)}</td></tr>`; }).join('') : '<tr><td colspan="8" class="empty">No active dealerships.</td></tr>'}
 </tbody></table></div></section>
 <div class="cols2">
  <section class="panel"><h2>By lead type</h2>${typeChart(mon.types)}</section>
  <section class="panel"><h2>Leads by hour</h2>${hourChart(mon.hours, mon.fastSeconds)}</section>
 </div>
 <section class="panel"><h2>Latest activity</h2>${mon.activity.length ? `<ol class="time act">${mon.activity.map(e => `<li class="${esc(e.severity)} click" tabindex="0" data-go="lead-${e.lead_id}"><time>${dayOf(new Date(e.at)) === dayOf(new Date()) ? '' : dayOf(new Date(e.at)) + ', '}${timeOf(new Date(e.at))}</time><span><b>${esc(e.dealer)}</b> · ${esc(e.first_name || 'Customer')} · ${esc(e.message)}</span></li>`).join('')}</ol>` : '<div class="empty">Nothing yet. Activity shows up here as leads arrive.</div>'}</section>`;
}
// One tooltip for every chart mark: follows the pointer, also shown on keyboard focus.
function bindTips(root) {
  let tip = $('#tip'); if (!tip) { tip = document.createElement('div'); tip.id = 'tip'; tip.className = 'tip'; tip.hidden = true; document.body.append(tip); }
  root.querySelectorAll('[data-tip]').forEach(el => {
    const show = (x, y) => { tip.textContent = el.dataset.tip; tip.hidden = false; const w = tip.offsetWidth; tip.style.left = Math.min(x + 12, innerWidth - w - 8) + 'px'; tip.style.top = (y + 14) + 'px'; };
    el.onmousemove = e => show(e.clientX, e.clientY);
    el.onmouseleave = el.onblur = () => { tip.hidden = true; };
    el.onfocus = () => { const r = el.getBoundingClientRect(); show(r.left, r.bottom - 10); };
  });
}

/* ---------- router + events ---------- */
function router() {
  const h = location.hash.slice(1) || 'monitor'; let route = h, html = '';
  if (h === 'monitor') html = viewMonitor();
  else if (h === 'leads') html = viewLeads();
  else if (/^lead-\d+$/.test(h)) { route = 'leads'; html = viewLead(+h.split('-')[1]); }
  else if (h === 'alerts') html = viewAlerts();
  else if (h === 'dealerships') html = viewDealers();
  else if (h === 'dealership-new') { route = 'dealerships'; html = viewDealerNew(); }
  else if (/^dealership-\d+$/.test(h)) { const dd = dealers.find(x => x.id === +h.split('-')[1]); route = dd && !dd.active ? 'deactivated' : 'dealerships'; html = viewDealer(+h.split('-')[1]); }
  else if (h === 'deactivated') html = viewDeactivated();
  else if (h === 'log') html = viewLog();
  else if (h === 'templates') html = viewTemplates();
  else if (h === 'cache') html = viewCache();
  else if (h === 'controls') html = viewControls();
  else { route = 'monitor'; html = viewMonitor(); }
  const held = leads.filter(l => l.status === 'held').length;
  $('#view').innerHTML = (sending ? '' : `<div class="banner">Sending is paused. ${held} lead${held === 1 ? ' is' : 's are'} being held and nobody is being texted. <button class="btn sm" id="resume">Resume sending</button></div>`) + html;
  renderChrome(route); bind(); enhanceSelects($('#view'));
}
async function refresh() { await load(); router(); }
const act = fn => async (...args) => { try { await fn(...args); } catch (e) { toast(e.message); } };
const formValues = () => ({ name: $('#name').value, site: $('#site').value, mailbox: $('#mailbox').value, crm: $('#crm').value, passthrough: $('#passthrough').value, sales: $('#sales').value, service: $('#service').value, address: $('#address').value, staff: $('#staff').value.split('\n'), textFormat: $('#textfmt').value });
function showErrors(errors) {
  document.querySelectorAll('.field.err').forEach(f => { f.classList.remove('err'); f.querySelector('.err-msg').textContent = ''; });
  Object.entries(errors || {}).forEach(([k, m]) => { const f = document.querySelector(`[data-f="${k}"]`); if (f) { f.classList.add('err'); f.querySelector('.err-msg').textContent = m; } });
  document.querySelector('.field.err input,.field.err .dd-btn')?.focus();
}
const saveForm = fn => async () => { try { await fn(); } catch (e) { if (e.errors) showErrors(e.errors); else toast(e.message); } };
const templateValues = () => ({ reasons: $('#t-reasons').value, buttons: $('#t-btn').value, links: $('#t-links').value, logoUrl: $('#t-logo').value, buildingPhotoUrl: $('#t-bldg').value });
async function drawPreview() { const r = await api('POST', '/api/templates/preview', { dealerId: tplSel, template: templateValues(), sample: $('#t-lead').value }); $('#tprev').innerHTML = r.html; }
const saveSettings = over => api('PUT', '/api/settings', { customerTexts: settings.customer_texts, testEmail: $('#s-mail')?.value ?? settings.owner_test_email, testPhone: $('#s-phone')?.value ?? settings.owner_test_phone, modelEnabled: settings.model_enabled, provider: settings.model_provider, model: settings.model_id, modelTimeout: $('#aito')?.value ?? settings.model_timeout_seconds, photoTimeout: $('#s-photo')?.value ?? settings.photo_timeout_seconds, ...over });

function bind() {
  const v = $('#view');
  const r = $('#resume'); if (r) r.onclick = act(() => setSending(true));
  v.querySelectorAll('[data-go]').forEach(e => { e.onclick = () => location.hash = e.dataset.go; e.onkeydown = ev => { if (ev.key === 'Enter') location.hash = e.dataset.go; }; });
  const fd = $('#fd'); if (fd) {
    fd.onchange = () => { filt.d = fd.value; router(); }; $('#fs').onchange = e => { filt.s = e.target.value; router(); };
    $('#fq').oninput = e => { filt.q = e.target.value; const p = e.target.selectionStart; router(); const q = $('#fq'); q.focus(); q.setSelectionRange(p, p); };
  }
  v.querySelectorAll('[data-range]').forEach(b => b.onclick = act(async () => { monF.range = b.dataset.range; mon = await loadMonitor(); router(); }));
  const md = $('#md'); if (md) md.onchange = act(async () => { monF.d = md.value; mon = await loadMonitor(); router(); });
  v.querySelectorAll('[data-drill]').forEach(e => { const go = () => drill(JSON.parse(e.dataset.drill)); e.onclick = go; e.onkeydown = ev => { if (ev.key === 'Enter') go(); }; });
  bindTips(v);
  const sim = $('#sim'); if (sim) sim.onclick = act(async () => { await api('POST', '/api/dev/sample-lead'); await refresh(); toast('Sample lead processed'); });
  v.querySelectorAll('[data-resend]').forEach(b => b.onclick = act(async () => { const r = await api('POST', `/api/leads/${b.dataset.resend}/send`); await refresh(); toast(r.status === 'failed' ? 'Reply failed: ' + r.failure : 'Reply sent'); }));
  v.querySelectorAll('[data-dismiss]').forEach(b => b.onclick = act(async () => { await api('POST', `/api/alerts/${b.dataset.dismiss}/dismiss`); await refresh(); toast('Alert dismissed'); }));
  v.querySelectorAll('[data-sw]').forEach(b => b.onclick = act(async () => {
    const k = b.dataset.sw, on = b.getAttribute('aria-checked') !== 'true';
    if (k === 'sending') { if (on) await setSending(true); else askPause(); return; }
    if (k.startsWith('test-')) { await setFlag(k.slice(5), { test: on }); router(); toast(on ? 'Test mode on' : 'Store is live'); return; }
    await saveSettings({ [k]: on }); await refresh(); toast('Saved');
  }));
  const nd = $('#adddealer'); if (nd) nd.onclick = saveForm(async () => { const { id } = await api('POST', '/api/dealerships', formValues()); await load(); toast($('#name').value + ' added in test mode'); location.hash = 'dealership-' + id; });
  const sv = $('#savedealer'); if (sv) sv.onclick = saveForm(async () => { await api('PUT', '/api/dealerships/' + sv.dataset.id, formValues()); await refresh(); toast($('#passthrough')?.value.trim() ? 'Changes saved' : 'Saved. Sending stays blocked until a CRM address is added'); });
  v.querySelectorAll('[data-google]').forEach(b => b.onclick = () => showModal(`<div class="dlg" role="dialog" aria-modal="true" aria-labelledby="gg"><h2 id="gg">Google isn’t set up yet</h2><p>This button opens a real Google sign-in once your Google Cloud project is ready.</p><div class="acts"><button class="btn" data-close>Close</button></div></div>`));
  v.querySelectorAll('[data-deact]').forEach(b => b.onclick = e => { e.stopPropagation(); askDeactivate(+b.dataset.deact); });
  v.querySelectorAll('[data-react]').forEach(b => b.onclick = act(async e => { e.stopPropagation(); await setFlag(+b.dataset.react, { active: true }); toast('Reactivated'); location.hash = 'dealerships'; router(); }));
  const ad = v.querySelector('[data-add]'); if (ad) ad.onclick = () => { location.hash = 'dealership-new'; };
  const ts = $('#tsel'); if (ts) {
    ts.onchange = () => { tplSel = +ts.value; router(); };
    ['t-reasons', 't-btn', 't-links', 't-logo', 't-bldg'].forEach(id => { $('#' + id).oninput = () => { clearTimeout(bind.t); bind.t = setTimeout(act(drawPreview), 250); }; });
    $('#t-lead').onchange = act(drawPreview);
    $('#savetpl').onclick = act(async () => { await api('PUT', '/api/templates/' + tplSel, templateValues()); await load(); toast('Template saved'); });
    act(drawPreview)();
  }
  const lq = $('#lq'); if (lq) {
    lq.oninput = e => { logF.q = e.target.value; drawLog(); };
    $('#ld').onchange = e => { logF.d = e.target.value; drawLog(); }; $('#lt').onchange = e => { logF.t = e.target.value; drawLog(); };
    drawLog();
  }
  v.querySelectorAll('[data-fold]').forEach(el => { el.ontoggle = () => { fold[el.dataset.fold] = el.open; }; });
  const ap = $('#aiprov'); if (ap) {
    ap.onchange = act(async () => { await saveSettings({ provider: ap.value, model: AI_MODELS[ap.value][0][0] }); await refresh(); });
    $('#aimodel').onchange = act(async e => { await saveSettings({ model: e.target.value }); await refresh(); toast('Model saved'); });
    ['aito', 's-mail', 's-phone', 's-photo'].forEach(id => { $('#' + id).onchange = act(async () => { await saveSettings({}); await load(); toast('Saved'); }); });
  }
  const cq = $('#cq'); if (cq) cq.oninput = e => { cacheQ = e.target.value; const p = e.target.selectionStart; router(); const q = $('#cq'); q.focus(); q.setSelectionRange(p, p); };
  v.querySelectorAll('[data-view]').forEach(b => b.onclick = () => showPhotos(b.dataset.view));
  v.querySelectorAll('[data-refresh]').forEach(b => b.onclick = act(async () => { await api('POST', `/api/cache/${b.dataset.refresh}/refresh`); await refresh(); toast('The next lead for this VIN will search again'); }));
  v.querySelectorAll('[data-del]').forEach(b => b.onclick = act(async () => { await api('DELETE', '/api/cache/' + b.dataset.del); await refresh(); toast('Removed from cache'); }));
  const ca = v.querySelector('[data-clearall]'); if (ca) ca.onclick = () => confirmBox('Clear all saved photo links?', 'Every vehicle will be searched again on its next lead, which uses Firecrawl credits.', 'Clear all', act(async () => { await api('DELETE', '/api/cache'); await refresh(); toast('Cache cleared'); }));
}
window.addEventListener('hashchange', router);
// Live screens update by themselves; forms are left alone so typing isn't lost.
setInterval(() => { const h = location.hash.slice(1) || 'monitor'; if ($('#modal').hidden && ['monitor', 'leads', 'log', 'alerts'].includes(h) && !document.activeElement?.matches('input')) act(refresh)(); }, 10000);
act(refresh)();
