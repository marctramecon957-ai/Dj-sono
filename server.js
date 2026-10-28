const express = require('express'), fs = require('fs'), crypto = require('crypto'), nodemailer = require('nodemailer');
console.log('Démarrage… [build conformite v15]');
process.on('uncaughtException', e => console.error('ERREUR FATALE', e));
process.on('unhandledRejection', e => console.error('ERREUR PROMESSE', e));
const app = express();
// Le port est ouvert tout de suite (Render l'exige) ; les routes sont ajoutées ensuite
app.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log('Serveur ouvert sur le port', process.env.PORT || 3000));
const path = require('path');
app.use('/api/stripe/webhook', express.raw({ type: '*/*', limit: '1mb' }));
app.use(express.json());
app.use('/api', (_, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
const IDX = [path.join(__dirname, 'public', 'index.html'), path.join(__dirname, 'index.html')].find(p => fs.existsSync(p));
app.get('/', (_, res) => res.set('Cache-Control', 'no-store').sendFile(IDX));
app.get('/fonts/:f', (req, res) => { const f = String(req.params.f);
  if (!/^[a-z0-9-]+\.woff2$/.test(f)) return res.status(404).end(); const p = path.join(__dirname, 'fonts', f);
  if (!fs.existsSync(p)) return res.status(404).end(); res.set({ 'Content-Type': 'font/woff2', 'Cache-Control': 'public, max-age=31536000, immutable' }).sendFile(p); });
const BUILD = Date.now().toString(36);
app.get('/api/version', (_, res) => res.json({ build: 'conformite v15', id: BUILD, icones: readIcon('icon-512.png') ? 'fichiers PNG' : 'secours (ajoute les 3 fichiers PNG)' }));

// ---- Application installable (PWA) : icônes, manifeste, service worker ----
const readIcon = n => { try { return fs.readFileSync(path.join(__dirname, n)); } catch { return null; } };
const crc32 = b => { let c = 0xFFFFFFFF; for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xEDB88320 : c >>> 1; } return (c ^ 0xFFFFFFFF) >>> 0; };
const pngChunk = (t, d) => { const h = Buffer.alloc(8); h.writeUInt32BE(d.length, 0); h.write(t, 4, 'ascii'); const td = Buffer.concat([h.subarray(4), d]), c = Buffer.alloc(4); c.writeUInt32BE(crc32(td), 0); return Buffer.concat([h.subarray(0, 4), td, c]); };
const backupIcon = n => { // icône de secours si les fichiers PNG ne sont pas dans le dépôt
  const raw = Buffer.alloc(n * (n * 3 + 1)); let o = 0;
  for (let y = 0; y < n; y++) { raw[o++] = 0; for (let x = 0; x < n; x++) { const fy = y / n, fx = x / n, band = fx > .2 && fx < .8 && ((fy > .3 && fy < .34) || (fy > .66 && fy < .7)) || (fx > .44 && fx < .56 && fy > .44 && fy < .56); const rgb = band ? [255, 30, 45] : [11, 5, 7]; raw[o++] = rgb[0]; raw[o++] = rgb[1]; raw[o++] = rgb[2]; } }
  const ih = Buffer.alloc(13); ih.writeUInt32BE(n, 0); ih.writeUInt32BE(n, 4); ih[8] = 8; ih[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ih), pngChunk('IDAT', require('zlib').deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
};
const iconCache = {};
const sendIcon = (file, size) => (_, res) => res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' }).send(readIcon(file) || (iconCache[size] = iconCache[size] || backupIcon(size)));
app.get('/icon-192.png', sendIcon('icon-192.png', 192)); app.get('/icon-512.png', sendIcon('icon-512.png', 512)); app.get('/apple-touch-icon.png', sendIcon('apple-touch-icon.png', 180));
app.get('/manifest.webmanifest', (_, res) => res.set({ 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-cache' }).send(JSON.stringify({
  name: (D.site && D.site.title) || 'Sound & Light 03', short_name: 'Sound & Light', description: 'Sonorisation, DJ, artificier, lighter', lang: 'fr', start_url: '/', scope: '/', display: 'standalone',
  background_color: '#050507', theme_color: '#ff1e2d', orientation: 'any',
  icons: [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }] })));
app.get('/sw.js', (_, res) => res.set({ 'Content-Type': 'application/javascript', 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' }).send(`
const V = 'sl-' + '${BUILD}';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(k => Promise.all(k.filter(x => x !== V).map(x => caches.delete(x)))).then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api') || u.pathname === '/desabonner') return;
  if (r.mode === 'navigate') { e.respondWith(fetch(r).then(x => { const c = x.clone(); caches.open(V).then(h => h.put('/', c)); return x; }).catch(() => caches.match('/').then(x => x || new Response('Hors ligne', { status: 503 })))); return; }
  e.respondWith(caches.match(r).then(c => { const f = fetch(r).then(x => { if (x.ok) { const y = x.clone(); caches.open(V).then(h => h.put(r, y)); } return x; }).catch(() => c); return c || f; }));
});`));

// ---- État du site, maintenance et mise à jour ----
let deploying = null;
const maintNow = () => {
  const m = D.maint;
  if (m && m.on) return { on: true, kind: 'manuel', msg: m.msg || 'Maintenance en cours', left: m.until ? Math.max(0, m.until - Date.now()) : 0, est: m.until ? 1 : 0 };
  if (deploying && Date.now() < deploying.until + 15 * 60000) return { on: true, kind: 'maj', msg: deploying.msg, left: Math.max(0, deploying.until - Date.now()), est: 1 };
  return { on: false };
};
app.get('/api/status', (_, res) => res.json({ id: BUILD, maintenance: maintNow() }));
app.use('/api', (req, res, next) => {
  if (maintNow().on && req.method !== 'GET' && !/^(\/api)?\/(login|admin)/.test(req.path)) return res.status(503).json({ error: 'Le site est en maintenance, merci de réessayer dans quelques minutes.' });
  next();
});

const FILE = process.env.DATA_FILE || 'data.json';
let D = { site: { title: 'Sound & Light 03', hero: [] }, contacts: [], calendar: {}, dossiers: [], finances: [],
  legal: {
    mentions: 'Éditeur du site : Sound & Light 03 Sonorisation, entreprise individuelle (auto-entrepreneur).\nResponsable : Nathan Peurton.\nAdresse : 8 Rue Simone Léveillé.\nTéléphone : 06 59 84 39 52 — E-mail : soundlight03@gmail.com\nSIRET : en cours d’attribution.\nHébergement : Render Services, Inc., San Francisco, États-Unis.\nDonnées personnelles : les informations saisies dans les formulaires servent uniquement au traitement de votre demande. Vous pouvez demander leur suppression à tout moment par e-mail. L’inscription à la newsletter est facultative et la désinscription possible sur simple demande.\nCookies : le site n’utilise que des cookies techniques nécessaires à son fonctionnement.',
    cgv: 'Article 1 — Objet : les présentes conditions encadrent les prestations de sonorisation, DJ, éclairage et artifices proposées par Sound & Light 03 Sonorisation.\nArticle 2 — Devis et dossier : tout dossier déposé sur le site est une demande, qui n’est ferme qu’après acceptation par le prestataire.\nArticle 3 — Disponibilité : la prestation est soumise à la disponibilité de la date demandée.\nArticle 4 — Prix et paiement : le prix est celui convenu entre les parties. Le paiement peut être demandé en acompte puis en solde, selon l’accord conclu.\nArticle 5 — Annulation et remboursement : une demande de remboursement peut être faite depuis l’espace de suivi du dossier et est étudiée au cas par cas.\nArticle 6 — Responsabilité : le client fournit un lieu et une alimentation électrique adaptés, et respecte les règles de sécurité en vigueur, notamment pour les artifices.\nArticle 7 — Données personnelles : voir les mentions légales.\nArticle 8 — Droit applicable : droit français.',
    updated: null },
  newsletter: [], reviews: [], locations: ['Moulins', 'Saint-Étienne'], codes: [], gifts: [], giftSale: { on: false, amounts: [30, 50, 100], months: 12 }, maint: { on: false, until: 0, msg: '' } };
try { D = { ...D, ...JSON.parse(fs.readFileSync(FILE)) }; } catch {}
// Sauvegarde durable : Upstash Redis (gratuit, HTTPS) si configuré, sinon fichier local
const UP = process.env.UPSTASH_URL, UT = process.env.UPSTASH_TOKEN;
const up = body => fetch(UP, { method: 'POST', headers: { Authorization: 'Bearer ' + UT }, body: JSON.stringify(body) }).then(r => r.json()).then(j => { if (j.error) throw new Error(j.error); return j; });
let timer, ready = !UP;
const save = () => {
  try { fs.writeFileSync(FILE, JSON.stringify(D, null, 1)); } catch {}
  if (UP && ready) { clearTimeout(timer); timer = setTimeout(() => up(['SET', 'djdata', JSON.stringify(D)]).catch(e => console.error('ERREUR UPSTASH', e.message)), 300); }
};

// ---- Mail & SMS (Apps Script / Brevo / SMTP + Twilio) ----
const mailer = process.env.SMTP_HOST ? nodemailer.createTransport({ host: process.env.SMTP_HOST, port: +process.env.SMTP_PORT || 587, connectionTimeout: 8000,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } }) : null;
const mail = async (to, subject, text, html) => {
  if (process.env.MAIL_PREVIEW_DIR) { fs.writeFileSync(path.join(process.env.MAIL_PREVIEW_DIR, (to + '_' + subject).replace(/[^a-z0-9]+/gi, '_') + '.html'), html || text); return null; }
  try {
    text = text + sigText();
    if (process.env.MAIL_SCRIPT_URL) {
      const r = await fetch(process.env.MAIL_SCRIPT_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: process.env.MAIL_SCRIPT_SECRET || '', to, subject, text, name: process.env.MAIL_NAME || 'Sound & Light 03', html }) });
      const t = await r.text();
      if (t.trim() !== 'ok') throw new Error('Google Script : ' + t.slice(0, 200));
    } else if (process.env.BREVO_API_KEY) {
      if (!process.env.MAIL_FROM) return 'MAIL_FROM manquant dans Render';
      const r = await fetch('https://api.brevo.com/v3/smtp/email', { method: 'POST', headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sender: { name: process.env.MAIL_NAME || 'Sound & Light 03', email: process.env.MAIL_FROM }, to: [{ email: to }], subject, textContent: text, ...(html && { htmlContent: html }) }) });
      if (!r.ok) throw new Error('Brevo ' + r.status + ' ' + await r.text());
    } else if (mailer) await mailer.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to, subject, text, html });
    else return 'Aucun service mail configuré (MAIL_SCRIPT_URL ou BREVO_API_KEY manquant)';
    return null;
  } catch (e) { console.error('ERREUR MAIL', to, e.message); return e.message; }
};
const sms = async (to, body) => {
  try {
    const s = process.env.TWILIO_SID, t = process.env.TWILIO_TOKEN;
    if (!s) return console.log('SMS', to, body);
    await fetch(`https://api.twilio.com/2010-04-01/Accounts/${s}/Messages.json`, {
      method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(s + ':' + t).toString('base64') },
      body: new URLSearchParams({ To: to, From: process.env.TWILIO_FROM, Body: body }) });
  } catch (e) { console.error('sms', e.message); }
};
// ---- Modèles d'e-mails pro (HTML) ----
const E = x => String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fd = d => { try { return new Date(d + 'T12:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }); } catch { return d; } };
const eur = n => Number(n).toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
const CO = () => ({ name: process.env.COMPANY_NAME || process.env.MAIL_NAME || (D.site && D.site.title) || 'Sound & Light 03', email: process.env.COMPANY_EMAIL || process.env.ADMIN_EMAIL || '', addr: process.env.COMPANY_ADDRESS || '', siret: process.env.COMPANY_SIRET || '', tva: process.env.COMPANY_TVA || '', phone: process.env.COMPANY_PHONE || '', logo: process.env.COMPANY_LOGO || '' });
const sigText = () => { const c = CO(); return '\n\n--\n' + [c.name, c.addr, c.phone && 'Tél. ' + c.phone, c.email, c.siret && 'SIRET ' + c.siret, c.tva && 'TVA ' + c.tva].filter(Boolean).join('\n'); };
const p = t => `<p style="font:14px/1.6 Arial,Helvetica,sans-serif;margin:0 0 10px;color:#cbb8bb">${t}</p>`;
const rows = a => `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:16px 0 4px;border-top:1px solid #2b1519">${a.map(r => `<tr><td style="padding:11px 0;border-bottom:1px solid #2b1519;color:#a89599;font:14px Arial,Helvetica,sans-serif">${E(r[0])}</td><td align="right" style="padding:11px 0 11px 12px;border-bottom:1px solid #2b1519;color:#ffffff;font:bold 14px Arial,Helvetica,sans-serif">${E(r[1])}</td></tr>`).join('')}</table>`;
const card = h => h;
const TRK = ['Reçu', 'Validation', 'Accepté', 'Payé'];
const tracker = st => {
  const m = { pending: { d: 1, c: 1 }, accepted: { d: 3, c: 3 }, paid: { d: 4 }, refused: { d: 1, f: 1 }, refund_requested: { d: 4 }, refunded: { d: 4 } }[st]; if (!m) return '';
  const R = '#d4121f', G = '#3a2227';
  const bar = c => `<td width="50%" valign="middle" style="padding:0;font-size:0;line-height:0">${c ? `<div style="height:3px;line-height:3px;font-size:0;background:${c}">&nbsp;</div>` : ''}</td>`;
  const col = i => {
    const done = i < m.d && m.f !== i, cur = i === m.c, fail = m.f === i;
    const bg = fail ? '#7a0b13' : done ? R : cur ? '#e8a317' : '#0b0507', bd = fail ? R : done ? R : cur ? '#e8a317' : '#4a2a30';
    const lb = i === 0 ? '' : (i - 1 < m.d && m.f !== i - 1 ? R : G), rb = i === 3 ? '' : (i < m.d && m.f !== i ? R : G);
    return `<td width="25%" align="center" valign="top"><table width="100%" cellpadding="0" cellspacing="0"><tr>${bar(lb)}<td width="26" valign="middle"><div style="width:26px;height:26px;border-radius:16px;background:${bg};border:2px solid ${bd};color:#ffffff;font:bold 12px/22px Arial,Helvetica,sans-serif;text-align:center">${fail ? '✕' : done ? '✓' : i + 1}</div></td>${bar(rb)}</tr></table><div style="font:12px Arial,Helvetica,sans-serif;color:${fail ? '#ff6b76' : (done || cur) ? '#ffffff' : '#7d676b'};margin-top:6px">${fail ? 'Refusé' : TRK[i]}</div></td>`;
  };
  return `<table width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0 22px"><tr>${[0, 1, 2, 3].map(col).join('')}</tr></table>`;
};
const unsubSig = e => crypto.createHmac('sha256', process.env.ADMIN_PASSWORD || 'x').update('unsub:' + e).digest('hex').slice(0, 20);
const gcal = d => { const st = String(d.date).replace(/-/g, ''), t = new Date(d.date + 'T12:00:00'); t.setDate(t.getDate() + 1); const en = t.toISOString().slice(0, 10).replace(/-/g, '');
  return 'https://calendar.google.com/calendar/render?action=TEMPLATE&text=' + encodeURIComponent(CO().name + ' — ' + d.service) + '&dates=' + st + '/' + en + '&location=' + encodeURIComponent(d.address || ''); };
const tpl = (title, inner, o = {}) => {
  const c = CO(), site = (process.env.SITE_URL || '').replace(/\/$/, ''), ban = process.env.COMPANY_BANNER || '', nm = c.name.replace(/\s*sonorisation\s*$/i, '');
  const pre = E(o.pre || o.sub || title);
  const cta = o.cta && site ? `<table width="100%" cellpadding="0" cellspacing="0" style="margin:22px 0 4px"><tr><td align="center" bgcolor="#d4121f" style="border-radius:4px"><a href="${E(o.ctaUrl || site)}" style="display:block;padding:14px;color:#ffffff;font:bold 15px Arial,Helvetica,sans-serif;text-decoration:none">${E(o.cta)}</a></td></tr></table>` : '';
  const lk = o.link && o.linkUrl ? `<div style="text-align:center;margin-top:12px"><a href="${E(o.linkUrl)}" style="color:#ff6b76;font:13px Arial,Helvetica,sans-serif;text-decoration:underline">${E(o.link)}</a></div>` : '';
  const a = (t, u) => site ? `<a href="${E(u)}" style="color:#ff6b76;text-decoration:none">${t}</a>` : t;
  const un = o.unsub && site ? ` · <a href="${E(site + '/desabonner?e=' + encodeURIComponent(o.unsub) + '&s=' + unsubSig(o.unsub))}" style="color:#ff6b76;text-decoration:none">Se désabonner</a>` : '';
  const head = c.logo ? `<img src="${E(c.logo)}" alt="${E(nm)}" height="44" style="display:block;border:0;height:44px">` : `<div style="font:italic bold 20px Arial,Helvetica,sans-serif;color:#ffffff;text-transform:uppercase;letter-spacing:1px">${E(nm)}</div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"></head><body style="margin:0;background:#050507;font-family:Arial,Helvetica,sans-serif;color:#eeeeee"><div style="display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;color:#050507">${pre}</div><table width="100%" cellpadding="0" cellspacing="0" bgcolor="#050507"><tr><td align="center" style="padding:20px 10px"><table width="600" cellpadding="0" cellspacing="0" bgcolor="#0b0507" style="max-width:600px;width:100%;border-radius:8px;overflow:hidden"><tr><td ${ban ? `background="${E(ban)}"` : ''} bgcolor="#0b0507" style="padding:20px 22px 16px;border-bottom:3px solid #d4121f${ban ? `;background-image:url('${E(ban)}');background-size:cover` : ''}">${head}<div style="font:11px Arial,Helvetica,sans-serif;color:#d4121f;letter-spacing:5px;margin-top:3px">SONORISATION</div></td></tr><tr><td style="padding:24px 22px 8px"><div style="font:bold 24px/1.2 Arial,Helvetica,sans-serif;color:#ffffff">${E(title)}</div>${o.sub ? `<div style="font:14px/1.5 Arial,Helvetica,sans-serif;color:#a89599;margin:6px 0 22px">${E(o.sub)}</div>` : '<div style="height:18px"></div>'}${tracker(o.st)}${inner}${cta}${lk}</td></tr><tr><td style="padding:18px 22px 22px;border-top:1px solid #2b1519;font:12px/1.7 Arial,Helvetica,sans-serif;color:#7d676b"><b style="color:#cbb8bb">${E(c.name)}</b><br>${[c.addr, c.phone, c.email].filter(Boolean).map(E).join(' · ')}${c.siret || c.tva ? '<br>' + [c.siret && 'SIRET ' + c.siret, c.tva && 'TVA ' + c.tva].filter(Boolean).map(E).join(' · ') : ''}<br>${a('Mentions légales', site + '/#legal')} · ${a('CGV', site + '/#legal')}${un}</td></tr></table></td></tr></table></body></html>`;
};
const both = (m, ph, sub, txt, html) => { Promise.all([m && mail(m, sub, txt, html), ph && sms(ph, txt.slice(0, 300))]).catch(() => {}); };

// ---- Auth admin ----
const sign = exp => crypto.createHmac('sha256', process.env.ADMIN_PASSWORD || '').update(String(exp)).digest('hex');
const okTok = t => { const [exp, sig] = String(t || '').split('.'); if (!exp || !sig || +exp < Date.now() || !process.env.ADMIN_PASSWORD) return false;
  const a = Buffer.from(sig), b = Buffer.from(sign(exp)); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const adm = (req, res, next) => okTok(req.headers['x-token']) ? next() : res.status(401).json({ error: 'Non autorisé' });
app.post('/api/login', (req, res) => {
  if (!process.env.ADMIN_PASSWORD || req.body.password !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'Mot de passe incorrect' });
  const exp = Date.now() + 14 * 864e5; res.json({ token: exp + '.' + sign(exp) });
});

// ---- Suivi de dossier (code unique client) ----
const genCode = () => crypto.randomBytes(5).toString('hex').toUpperCase();
const nextNum = y => { const re = new RegExp('^SL-' + y + '-(\\d+)$'); let mx = 0; for (const x of D.dossiers) { const m = re.exec(x.num || ''); if (m) mx = Math.max(mx, +m[1]); } return 'SL-' + y + '-' + String(mx + 1).padStart(3, '0'); };
const assignNums = () => { let ch = false;
  for (const d of [...D.dossiers].sort((a, b) => String(a.created || a.date).localeCompare(String(b.created || b.date)))) {
    if (!d.trackCode) { let c; do c = genCode(); while (D.dossiers.some(x => x.trackCode === c)); d.trackCode = c; ch = true; }
    if (!d.num) { d.num = nextNum(String(d.created || d.date || new Date().toISOString()).slice(0, 4)); ch = true; }
  } return ch; };
app.post('/api/suivi', (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  const d = D.dossiers.find(x => x.trackCode === code);
  if (!d) return res.status(404).json({ error: 'Code introuvable' });
  res.json({ dossier: { num: d.num, service: d.service, date: d.date, city: d.city || '', lastName: d.lastName, status: d.status, total: d.total || null, refund: d.refund || null, pay: { ...payOptions(d), enabled: !!SK() } } });
});
// ---- Paiement en ligne : Stripe Checkout (l'argent est versé sur ton compte bancaire via Stripe) ----
const SK = () => process.env.STRIPE_SECRET_KEY || '';
const stripe = async (method, url, form) => {
  const r = await fetch('https://api.stripe.com/v1' + url, { method, headers: { Authorization: 'Bearer ' + SK(), 'Content-Type': 'application/x-www-form-urlencoded' }, body: form ? new URLSearchParams(form).toString() : undefined });
  const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error((j.error && j.error.message) || ('Stripe ' + r.status)); return j;
};
const r2 = n => Math.round(n * 100) / 100;
const creditOf = d => r2((d.credits || []).reduce((a, c) => a + (+c.amount || 0), 0));
const payOptions = d => { const price = r2(+d.price || 0), credit = Math.min(creditOf(d), price), net = r2(price - credit), dep = r2(+d.deposit || 0), paid = r2(+d.paidTotal || 0), left = r2(Math.max(0, net - paid));
  return { price, credit, net, deposit: dep, paid, left, depositDue: dep > 0 && paid < dep && left > 0 ? Math.min(r2(dep - paid), left) : 0, credits: (d.credits || []).map(c => ({ label: c.label, amount: c.amount })) }; };
const recordPayment = async (d, cents, ref, label) => {
  if ((d.payments || []).some(p => p.ref === ref)) return false;
  const amount = cents / 100; d.payments = d.payments || []; d.payments.push({ ref, amount, label, at: new Date().toISOString() });
  confirmCredits(d); d.paidTotal = Math.round(((+d.paidTotal || 0) + amount) * 100) / 100; d.total = d.paidTotal;
  const full = d.price > 0 && d.paidTotal >= payOptions(d).net - 0.005; d.status = full || !(d.deposit > 0) ? 'paid' : 'accepted';
  D.finances.push({ id: crypto.randomUUID(), type: 'revenue', name: d.lastName, amount, date: new Date().toISOString().slice(0, 10), note: 'Stripe — ' + label + ' — ' + d.num });
  save();
  const site = (process.env.SITE_URL || '').replace(/\/$/, ''), no = 'R-' + String(ref).slice(-8).toUpperCase();
  const ticket = rows([['Dossier n°', d.num], ['Reçu n°', no], ['Date', new Date().toLocaleDateString('fr-FR')], ['Prestation', d.service + ' — ' + fd(d.date) + (d.city ? ' — ' + d.city : '')], [label, eur(amount)]]) + (d.status === 'paid' ? '' : rows([['Reste à payer', eur(payOptions(d).left)]]));
  both(d.email, d.phone, 'Paiement reçu — ' + no, `Bonjour ${d.lastName}, paiement de ${eur(amount)} bien reçu (${label}). Reçu ${no}.`,
    tpl(d.status === 'paid' ? 'Paiement reçu' : 'Acompte reçu', p(`Bonjour ${E(d.lastName)}, merci ! Votre paiement a bien été reçu.`) + ticket, { st: d.status === 'paid' ? 'paid' : 'accepted', sub: 'Reçu n° ' + no, cta: site ? 'Voir mon dossier' : undefined, ctaUrl: site ? site + '/#suivi' : undefined, pre: 'Paiement de ' + eur(amount) + ' bien reçu. Merci !' }));
  both(process.env.ADMIN_EMAIL, process.env.ADMIN_PHONE, 'Paiement reçu — ' + d.lastName, `${d.lastName} a payé ${eur(amount)} (${label}) pour le dossier ${d.num}.`,
    tpl('Paiement reçu', p(`<b>${E(d.lastName)}</b> vient de payer en ligne.`) + rows([['Dossier n°', d.num], ['Montant', eur(amount)], ['Type', label], ['Total payé', eur(d.paidTotal)]]), { st: 'paid', sub: d.num }));
  return true;
};
// ---- Codes de réduction et cartes cadeaux ----
const normCode = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const genGift = () => { const al = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let c; do { c = 'SL'; const b = crypto.randomBytes(8); for (let k = 0; k < 8; k++) c += al[b[k] % al.length]; } while ((D.gifts || []).some(g => g.code === c)); return c; };
const prettyGift = c => c.replace(/^(.{2})(.{4})(.{4})$/, '$1-$2-$3');
const addMonths = (dt, m) => { const x = new Date(dt); x.setMonth(x.getMonth() + m); return x.toISOString(); };
const today = () => new Date().toISOString().slice(0, 10);
const giftState = g => g.status === 'used' ? 'used' : g.status === 'cancelled' ? 'cancelled' : g.status === 'pending' ? 'pending' : (g.expires && g.expires.slice(0, 10) < today()) ? 'expired' : 'active';
const codeProblem = (c, d) => { if (!c || c.active === false) return 'Ce code n’est pas valable.';
  if (c.expires && c.expires < today()) return 'Ce code a expiré.';
  if (c.max > 0 && (c.used || 0) >= c.max) return 'Ce code a déjà été utilisé le nombre maximum de fois.';
  if (c.min > 0 && (+d.price || 0) < c.min) return 'Ce code s’applique à partir de ' + eur(c.min) + '.';
  if (c.service && c.service !== d.service) return 'Ce code ne s’applique pas à cette prestation.'; return ''; };
const codeValue = (c, d) => { const price = +d.price || 0; return r2(c.type === 'percent' ? price * Math.min(+c.value, 100) / 100 : Math.min(+c.value, price)); };
const releaseHolds = () => { const now = Date.now(); for (const g of D.gifts || []) if (g.hold && g.hold.until < now) delete g.hold; };
const giftAvail = g => giftState(g) === 'active' && !g.hold;
// crédits "réservés" : on les applique au dossier quand le client lance le paiement, et on les libère s'il abandonne
const clearPending = d => { d.credits = (d.credits || []).filter(c => !c.pending); for (const g of D.gifts || []) if (g.hold && g.hold.dossier === d.id) delete g.hold; };
app.post('/api/suivi/code', (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase(), d = D.dossiers.find(x => x.trackCode === code); if (!d) return res.status(404).json({ error: 'Dossier introuvable' });
  if (d.status !== 'accepted') return res.status(400).json({ error: 'Le code est utilisable une fois le dossier accepté.' });
  if (!(d.price > 0)) return res.status(400).json({ error: 'Le montant du dossier n’est pas encore défini.' });
  const n = normCode(req.body.promo); if (!n) return res.status(400).json({ error: 'Entrez un code.' });
  releaseHolds();
  // un crédit en attente dont la réservation a expiré est retiré ; sinon on refuse un 2e code
  d.credits = (d.credits || []).filter(c => !(c.pending && c.kind === 'gift' && !(D.gifts || []).some(g => g.id === c.ref && g.hold && g.hold.dossier === d.id)));
  if ((d.credits || []).length) return res.status(400).json({ error: 'Un code est déjà appliqué à ce dossier. Retirez-le pour en essayer un autre.' });
  const promo = (D.codes || []).find(c => normCode(c.code) === n);
  if (promo) {
    const pb = codeProblem(promo, d); if (pb) return res.status(400).json({ error: pb });
    const v = codeValue(promo, d); if (!(v > 0)) return res.status(400).json({ error: 'Ce code ne donne aucune réduction.' });
    d.credits = d.credits || []; d.credits.push({ kind: 'promo', ref: promo.id, label: 'Code ' + promo.code, amount: v, pending: true }); save();
    return res.json({ ok: 1, message: 'Code appliqué : − ' + eur(v) });
  }
  const gift = (D.gifts || []).find(g => g.code === n);
  if (gift) {
    const st = giftState(gift); if (st === 'used') return res.status(400).json({ error: 'Cette carte cadeau a déjà été utilisée.' });
    if (st === 'expired') return res.status(400).json({ error: 'Cette carte cadeau a expiré.' });
    if (st !== 'active') return res.status(400).json({ error: 'Cette carte cadeau n’est pas valable.' });
    if (gift.hold && gift.hold.dossier !== d.id) return res.status(400).json({ error: 'Cette carte cadeau est en cours d’utilisation.' });
    const v = r2(Math.min(gift.amount, +d.price || 0)); gift.hold = { dossier: d.id, until: Date.now() + 30 * 60000 };
    d.credits = d.credits || []; d.credits.push({ kind: 'gift', ref: gift.id, label: 'Carte cadeau', amount: v, pending: true }); save();
    return res.json({ ok: 1, message: 'Carte cadeau appliquée : − ' + eur(v) });
  }
  res.status(400).json({ error: 'Code inconnu. Vérifiez la saisie.' });
});
app.post('/api/suivi/code/retirer', (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase(), d = D.dossiers.find(x => x.trackCode === code); if (!d) return res.status(404).json({ error: 'Dossier introuvable' });
  if ((d.credits || []).some(c => !c.pending)) return res.status(400).json({ error: 'Ce code a déjà été utilisé pour un paiement.' }); clearPending(d); save(); res.json({ ok: 1 });
});
// quand un paiement Stripe est confirmé : on valide les crédits réservés (le code est consommé)
const confirmCredits = d => { let ch = false;
  for (const c of d.credits || []) if (c.pending) { delete c.pending; ch = true;
    if (c.kind === 'promo') { const p = (D.codes || []).find(x => x.id === c.ref); if (p) p.used = (p.used || 0) + 1; }
    if (c.kind === 'gift') { const g = (D.gifts || []).find(x => x.id === c.ref); if (g) { g.status = 'used'; g.usedAt = new Date().toISOString(); g.usedFor = d.num; delete g.hold; } } }
  return ch; };
// dossier entièrement couvert par un code ou une carte (rien à payer par carte bancaire)
app.post('/api/suivi/valider-credit', async (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase(), d = D.dossiers.find(x => x.trackCode === code); if (!d) return res.status(404).json({ error: 'Dossier introuvable' });
  if (d.status !== 'accepted') return res.status(400).json({ error: 'Dossier non disponible' });
  if (req.body.cgv !== true) return res.status(400).json({ error: 'Vous devez accepter les conditions générales avant de commander.' });
  d.cgvAt = new Date().toISOString();
  const o = payOptions(d); if (o.left > 0.005 || !(o.price > 0) || !(d.credits || []).length) return res.status(400).json({ error: 'Il reste un montant à payer.' });
  confirmCredits(d); d.status = 'paid'; d.total = o.price; d.paidTotal = d.paidTotal || 0; save();
  D.finances.push({ id: crypto.randomUUID(), type: 'revenue', name: d.lastName, amount: 0, date: today(), note: 'Dossier couvert par ' + d.credits.map(c => c.label).join(' + ') + ' — ' + d.num }); save();
  both(d.email, d.phone, 'Dossier confirmé — ' + d.num, `Bonjour ${d.lastName}, votre dossier ${d.num} est réglé grâce à votre code.`, tpl('Dossier réglé', p(`Bonjour ${E(d.lastName)}, votre dossier est entièrement réglé.`) + rows([['Dossier n°', d.num], ['Prestation', d.service + ' — ' + fd(d.date) + (d.city ? ' — ' + d.city : '')], ['Réglé par', d.credits.map(c => c.label).join(' + ')]]), { st: 'paid', sub: d.num }));
  res.json({ ok: 1 });
});
app.get('/api/suivi/paiement-info', (req, res) => res.json({ enabled: !!SK() }));
app.post('/api/suivi/paiement', async (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  const d = D.dossiers.find(x => x.trackCode === code); if (!d) return res.status(404).json({ error: 'Code introuvable' });
  if (d.status !== 'accepted') return res.status(400).json({ error: 'Le paiement n’est pas disponible pour ce dossier' });
  if (req.body.cgv !== true) return res.status(400).json({ error: 'Vous devez accepter les conditions générales avant de commander.' });
  d.cgvAt = new Date().toISOString();
  if (!SK()) return res.status(503).json({ error: 'Le paiement en ligne n’est pas encore activé. Contactez-nous pour régler.' });
  releaseHolds(); const o = payOptions(d); if (!(o.price > 0)) return res.status(400).json({ error: 'Le montant de votre dossier n’est pas encore défini. Nous vous contactons très vite.' });
  if (o.left <= 0.005 && o.credit > 0) return res.status(400).json({ error: 'Votre dossier est couvert par votre code : validez-le sans paiement.' });
  const kind = req.body.kind === 'deposit' && o.depositDue > 0 ? 'deposit' : 'balance', amount = kind === 'deposit' ? o.depositDue : o.left;
  if (!(amount >= 0.5)) return res.status(400).json({ error: 'Rien à payer pour ce dossier.' });
  const label = kind === 'deposit' ? 'Acompte' : (o.paid > 0 ? 'Solde' : 'Paiement'), site = (process.env.SITE_URL || (req.headers.origin || '')).replace(/\/$/, '');
  if (!site) return res.status(500).json({ error: 'SITE_URL manquant dans Render' });
  try {
    const f = { mode: 'payment', 'line_items[0][quantity]': '1', 'line_items[0][price_data][currency]': 'eur', 'line_items[0][price_data][unit_amount]': String(Math.round(amount * 100)),
      'line_items[0][price_data][product_data][name]': label + ' — ' + d.service + ' le ' + fd(d.date) + ' (' + d.num + ')', client_reference_id: d.id, 'metadata[dossier]': d.id, 'metadata[label]': label, 'metadata[credits]': String(o.credit),
      success_url: site + '/?paiement=ok#suivi', cancel_url: site + '/?paiement=annule#suivi', 'payment_intent_data[metadata][dossier]': d.id, 'payment_intent_data[metadata][label]': label };
    if (/^\S+@\S+\.\S+$/.test(d.email)) f.customer_email = d.email;
    for (const c of d.credits || []) if (c.kind === 'gift' && c.pending) { const g = (D.gifts || []).find(x => x.id === c.ref); if (g) g.hold = { dossier: d.id, until: Date.now() + 60 * 60000 }; } save();
    const s2 = await stripe('POST', '/checkout/sessions', f); res.json({ url: s2.url });
  } catch (e) { console.error('ERREUR STRIPE', e.message); res.status(502).json({ error: 'Impossible de lancer le paiement : ' + e.message }); }
});
// Stripe prévient le serveur quand un paiement est réellement encaissé (signature vérifiée)
app.post('/api/stripe/webhook', async (req, res) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET; if (!secret) return res.status(503).send('webhook non configuré');
  try {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {})), sh = String(req.headers['stripe-signature'] || '');
    const t = (/t=(\d+)/.exec(sh) || [])[1], sigs = [...sh.matchAll(/v1=([a-f0-9]+)/g)].map(m => m[1]);
    const exp = crypto.createHmac('sha256', secret).update(t + '.' + raw.toString('utf8')).digest('hex');
    const ok = t && Math.abs(Date.now() / 1000 - +t) < 600 && sigs.some(x => x.length === exp.length && crypto.timingSafeEqual(Buffer.from(x), Buffer.from(exp)));
    if (!ok) return res.status(400).send('signature invalide');
    const ev = JSON.parse(raw.toString('utf8')), o = ev.data && ev.data.object;
    if (ev.type === 'checkout.session.completed' && o && o.payment_status === 'paid') {
      const d = (o.metadata && o.metadata.gift) ? null : D.dossiers.find(x => x.id === (o.metadata && o.metadata.dossier || o.client_reference_id));
      if (d) await recordPayment(d, o.amount_total, o.payment_intent || o.id, (o.metadata && o.metadata.label) || 'Paiement');
      if (o.metadata && o.metadata.gift) await activateGift(o.metadata.gift, o.payment_intent || o.id);
    }
    res.json({ received: true });
  } catch (e) { console.error('ERREUR WEBHOOK', e.message); res.status(400).send('erreur'); }
});
// Retour du client après paiement : on vérifie auprès de Stripe (au cas où le webhook tarde)
app.post('/api/suivi/verifier', async (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase(), d = D.dossiers.find(x => x.trackCode === code); if (!d || !SK()) return res.json({ ok: 0 });
  try { const l = await stripe('GET', '/checkout/sessions?limit=10&payment_intent_data=&client_reference_id=' + encodeURIComponent(d.id)).catch(() => null);
    const arr = (l && l.data) || []; for (const o of arr) if (o.payment_status === 'paid' && !(o.metadata && o.metadata.gift)) await recordPayment(d, o.amount_total, o.payment_intent || o.id, (o.metadata && o.metadata.label) || 'Paiement');
  } catch {} res.json({ ok: 1 });
});
// Admin : fixer le prix et l'acompte d'un dossier
app.post('/api/admin/prix/:id', adm, (req, res) => {
  const d = D.dossiers.find(x => x.id === req.params.id); if (!d) return res.status(404).json({ error: 'Introuvable' });
  const price = +req.body.price, dep = +req.body.deposit || 0;
  if (!(price >= 0) || !(dep >= 0) || dep > price) return res.status(400).json({ error: 'Montants invalides (l’acompte ne peut pas dépasser le prix)' });
  d.price = Math.round(price * 100) / 100; d.deposit = Math.round(dep * 100) / 100; save(); res.json({ ok: 1 });
});
// ---- Vente de cartes cadeaux en ligne (désactivée tant que tu ne l'actives pas dans l'admin) ----
const giftSaleInfo = () => { const g = D.giftSale || {}; return { on: !!g.on && !!SK(), amounts: (g.amounts || []).slice(0, 8), months: g.months || 12 }; };
const giftMail = (g, to, buyer) => {
  const site = (process.env.SITE_URL || '').replace(/\/$/, ''), exp = g.expires ? fd(g.expires.slice(0, 10)) : '';
  const rowsH = rows([['Montant', eur(g.amount)], ['Code', prettyGift(g.code)], ['Valable jusqu’au', exp], ['Utilisation', 'Une seule fois, sur toute prestation']]);
  const html = tpl('Une carte cadeau pour vous', p('Bonjour,') + p((g.from ? E(g.from) + ' vous offre' : 'Vous avez reçu') + ' une carte cadeau <b>Sound &amp; Light</b> à utiliser pour votre prochaine soirée.') + (g.message ? p('« ' + E(g.message) + ' »') : '') + rowsH + p('<span style="font-size:13px">Pour l’utiliser : déposez un dossier sur notre site, puis entrez ce code dans « Suivi de dossier » avant de payer.</span>'),
    { sub: eur(g.amount) + ' à valoir sur votre soirée', cta: site ? 'Déposer un dossier' : undefined, ctaUrl: site ? site + '/#dossier' : undefined, pre: 'Votre carte cadeau de ' + eur(g.amount) + ' est arrivée.' });
  const text = `Vous avez reçu une carte cadeau Sound & Light de ${eur(g.amount)}.\nCode : ${prettyGift(g.code)}\nValable jusqu'au ${exp}. Utilisable une seule fois.` + (g.message ? `\n"${g.message}"` : '') + (site ? `\n${site}` : '');
  return mail(to, 'Votre carte cadeau Sound & Light', text, html); };
app.post('/api/cadeau/acheter', async (req, res) => {
  const gs = giftSaleInfo(); if (!gs.on) return res.status(503).json({ error: 'La vente de cartes cadeaux n’est pas ouverte pour le moment.' });
  const amount = +req.body.amount; if (!gs.amounts.includes(amount)) return res.status(400).json({ error: 'Montant non proposé.' });
  if (req.body.cgv !== true) return res.status(400).json({ error: 'Vous devez accepter les conditions générales avant de commander.' });

  const buyer = String(req.body.buyerEmail || '').trim().toLowerCase(), to = String(req.body.toEmail || buyer).trim().toLowerCase(), re = /^\S+@\S+\.\S+$/;
  if (!re.test(buyer) || !re.test(to)) return res.status(400).json({ error: 'Adresse e-mail invalide.' });
  const site = (process.env.SITE_URL || '').replace(/\/$/, ''); if (!site) return res.status(500).json({ error: 'SITE_URL manquant dans Render' });
  const g = { id: crypto.randomUUID(), code: genGift(), amount, status: 'pending', from: String(req.body.from || '').trim().slice(0, 60), message: String(req.body.message || '').trim().slice(0, 300), to, buyer, created: new Date().toISOString(), months: gs.months, source: 'web', cgvAt: new Date().toISOString() };
  D.gifts.unshift(g); save();
  try { const f = { mode: 'payment', 'line_items[0][quantity]': '1', 'line_items[0][price_data][currency]': 'eur', 'line_items[0][price_data][unit_amount]': String(Math.round(amount * 100)), 'line_items[0][price_data][product_data][name]': 'Carte cadeau Sound & Light — ' + eur(amount),
      client_reference_id: g.id, 'metadata[gift]': g.id, 'metadata[label]': 'Carte cadeau', success_url: site + '/?cadeau=ok#cadeau', cancel_url: site + '/?cadeau=annule#cadeau', customer_email: buyer };
    const s2 = await stripe('POST', '/checkout/sessions', f); res.json({ url: s2.url });
  } catch (e) { D.gifts = D.gifts.filter(x => x.id !== g.id); save(); console.error('ERREUR STRIPE', e.message); res.status(502).json({ error: 'Impossible de lancer le paiement : ' + e.message }); }
});
const activateGift = async (id, ref) => { const g = (D.gifts || []).find(x => x.id === id); if (!g || g.status !== 'pending') return false;
  g.status = 'active'; g.paidRef = ref; g.activated = new Date().toISOString(); g.expires = addMonths(g.activated, g.months || 12);
  D.finances.push({ id: crypto.randomUUID(), type: 'revenue', name: 'Carte cadeau', amount: g.amount, date: today(), note: 'Stripe — carte cadeau ' + prettyGift(g.code) }); save();
  await giftMail(g, g.to, g.buyer);
  if (g.buyer && g.buyer !== g.to) both(g.buyer, null, 'Votre achat de carte cadeau', `Votre carte cadeau de ${eur(g.amount)} a été envoyée à ${g.to}.`, tpl('Carte cadeau envoyée', p('Merci pour votre achat ! La carte cadeau a bien été envoyée à son destinataire.') + rows([['Montant', eur(g.amount)], ['Envoyée à', g.to]]), { st: 'paid', sub: eur(g.amount) }));
  both(process.env.ADMIN_EMAIL, null, 'Carte cadeau vendue', `Carte cadeau de ${eur(g.amount)} vendue.`, tpl('Carte cadeau vendue', rows([['Montant', eur(g.amount)], ['Code', prettyGift(g.code)], ['Acheteur', g.buyer]]), { st: 'admin' }));
  return true; };
app.post('/api/cadeau/verifier', async (req, res) => { try { if (!SK()) return res.json({ ok: 0 });
  const l = await stripe('GET', '/checkout/sessions?limit=20'); for (const o of (l.data || [])) if (o.payment_status === 'paid' && o.metadata && o.metadata.gift) await activateGift(o.metadata.gift, o.payment_intent || o.id); } catch {} res.json({ ok: 1 }); });
// --- Admin : codes de réduction
app.get('/api/admin/codes', adm, (_, res) => { releaseHolds(); res.json({ codes: D.codes || [], gifts: (D.gifts || []).map(g => ({ ...g, state: giftState(g), hold: undefined })), giftSale: D.giftSale, stripe: !!SK() }); });
app.post('/api/admin/codes', adm, (req, res) => {
  const b = req.body, code = normCode(b.code) || ('PROMO' + crypto.randomBytes(2).toString('hex').toUpperCase()), type = b.type === 'percent' ? 'percent' : 'amount', value = +b.value;
  if (!(value > 0) || (type === 'percent' && value > 100)) return res.status(400).json({ error: type === 'percent' ? 'Le pourcentage doit être entre 1 et 100.' : 'Le montant doit être supérieur à 0.' });
  if ((D.codes || []).some(c => normCode(c.code) === code) || (D.gifts || []).some(g => g.code === code)) return res.status(400).json({ error: 'Ce code existe déjà.' });
  const exp = /^\d{4}-\d{2}-\d{2}$/.test(String(b.expires || '')) ? b.expires : '';
  D.codes = D.codes || []; D.codes.unshift({ id: crypto.randomUUID(), code, type, value, expires: exp, max: Math.max(0, Math.floor(+b.max || 0)), min: Math.max(0, +b.min || 0), service: ['DJ', 'Artificier', 'Lighter'].includes(b.service) ? b.service : '', used: 0, active: true, created: new Date().toISOString() }); save(); res.json({ ok: 1, code });
});
app.post('/api/admin/codes/:id', adm, (req, res) => { const c = (D.codes || []).find(x => x.id === req.params.id); if (!c) return res.status(404).json({ error: 'Introuvable' });
  if (req.body.delete) D.codes = D.codes.filter(x => x.id !== c.id); else if (typeof req.body.active === 'boolean') c.active = req.body.active; save(); res.json({ ok: 1 }); });
// --- Admin : cartes cadeaux
app.post('/api/admin/cadeaux', adm, async (req, res) => {
  const amount = +req.body.amount, months = Math.min(Math.max(Math.floor(+req.body.months) || 12, 1), 60), email = String(req.body.email || '').trim().toLowerCase();
  if (!(amount >= 1 && amount <= 5000)) return res.status(400).json({ error: 'Montant invalide (entre 1 et 5000 €).' });
  if (email && !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Adresse e-mail invalide.' });
  const now = new Date().toISOString(), g = { id: crypto.randomUUID(), code: genGift(), amount, status: 'active', from: String(req.body.from || '').trim().slice(0, 60), message: String(req.body.message || '').trim().slice(0, 300), to: email, created: now, activated: now, expires: addMonths(now, months), months, source: 'admin' };
  D.gifts.unshift(g); save(); let sent = false, err = '';
  if (email) { err = await giftMail(g, email) || ''; sent = !err; }
  res.json({ ok: 1, code: prettyGift(g.code), sent, error: err || undefined });
});
app.post('/api/admin/cadeaux/:id', adm, async (req, res) => { const g = (D.gifts || []).find(x => x.id === req.params.id); if (!g) return res.status(404).json({ error: 'Introuvable' });
  if (req.body.cancel) g.status = 'cancelled'; else if (req.body.delete && g.status !== 'active') D.gifts = D.gifts.filter(x => x.id !== g.id);
  else if (req.body.resend && g.to) { const err = await giftMail(g, g.to); save(); return res.json(err ? { error: err } : { ok: 1 }); }
  save(); res.json({ ok: 1 }); });
app.post('/api/admin/cadeaux-vente', adm, (req, res) => { const a = (Array.isArray(req.body.amounts) ? req.body.amounts : []).map(Number).filter(n => n >= 5 && n <= 5000).slice(0, 8);
  D.giftSale = { on: !!req.body.on, amounts: a.length ? a : [30, 50, 100], months: Math.min(Math.max(Math.floor(+req.body.months) || 12, 1), 60) }; save(); res.json({ ok: 1 }); });

app.post('/api/suivi/remboursement', async (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  const d = D.dossiers.find(x => x.trackCode === code); if (!d) return res.status(404).json({ error: 'Code introuvable' });
  if (d.status !== 'paid') return res.status(400).json({ error: 'Remboursement possible uniquement après paiement' });
  d.status = 'refund_requested'; d.refund = { reason: String(req.body.reason || '').slice(0, 300), asked: new Date().toISOString() }; save();
  both(process.env.ADMIN_EMAIL, process.env.ADMIN_PHONE, `Demande de remboursement — ${d.lastName}`,
    `${d.lastName} demande un remboursement pour ${d.service} du ${fd(d.date)}.\nMotif : ${d.refund.reason || '(non précisé)'}`,
    tpl('Demande de remboursement', p(`<b>${E(d.lastName)}</b> demande un remboursement pour <b>${E(d.service)}</b> du ${E(fd(d.date))}.`) + (d.refund.reason ? p('Motif : ' + E(d.refund.reason)) : ''), { st: 'refund_requested', sub: 'À traiter dans l’espace admin.', cta: 'Ouvrir l’espace admin' }));
  res.json({ ok: 1 });
});

// ---- Localisations (villes d'intervention) ----
app.post('/api/admin/lieux', adm, (req, res) => {
  const list = [...new Set((Array.isArray(req.body.locations) ? req.body.locations : []).map(x => String(x || '').trim().slice(0, 40)).filter(x => x.length >= 2))].slice(0, 12);
  if (!list.length) return res.status(400).json({ error: 'Il faut au moins une localisation.' });
  D.locations = list; save(); res.json({ ok: 1, locations: list });
});
// ---- Avis clients (publiés après validation par l'admin) ----
const initials = n => String(n || '?').trim().slice(0, 1).toUpperCase();
const reviewsPublic = () => { const ok = (D.reviews || []).filter(r => r.status === 'approved').sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const avg = ok.length ? Math.round(ok.reduce((a, r) => a + r.rating, 0) / ok.length * 10) / 10 : 0;
  return { avg, count: ok.length, list: ok.slice(0, 30).map(r => ({ name: r.name, service: r.service, rating: r.rating, text: r.text, at: r.at, reply: r.reply || '' })) }; };
app.post('/api/suivi/avis', (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase(), d = D.dossiers.find(x => x.trackCode === code); if (!d) return res.status(404).json({ error: 'Code introuvable' });
  if (!['paid', 'accepted'].includes(d.status)) return res.status(400).json({ error: 'L’avis est possible une fois le dossier accepté.' });
  if (d.date > new Date().toISOString().slice(0, 10)) return res.status(400).json({ error: 'Vous pourrez laisser votre avis après la date de la prestation.' });
  if ((D.reviews || []).some(r => r.dossier === d.id)) return res.status(409).json({ error: 'Vous avez déjà laissé un avis pour ce dossier. Merci !' });
  const rating = Math.round(+req.body.rating), text = String(req.body.text || '').trim().slice(0, 800);
  if (!(rating >= 1 && rating <= 5)) return res.status(400).json({ error: 'Choisissez une note de 1 à 5 étoiles.' });
  if (text.length < 5) return res.status(400).json({ error: 'Écrivez quelques mots pour votre avis.' });
  D.reviews = D.reviews || []; D.reviews.unshift({ id: crypto.randomUUID(), dossier: d.id, name: d.lastName, service: d.service, rating, text, status: 'pending', at: new Date().toISOString() }); save();
  both(process.env.ADMIN_EMAIL, null, 'Nouvel avis client — ' + d.lastName, `${d.lastName} a laissé un avis ${rating}/5 : ${text}`,
    tpl('Nouvel avis client', p(`<b>${E(d.lastName)}</b> a laissé un avis <b>${rating}/5</b>.`) + p('« ' + E(text) + ' »') + p('Il sera publié après ta validation dans l’espace admin.'), { st: 'admin', sub: d.num, cta: 'Ouvrir l’espace admin' }));
  res.json({ ok: 1 });
});
app.get('/api/admin/avis', adm, (_, res) => res.json({ reviews: D.reviews || [] }));
app.post('/api/admin/avis/:id', adm, (req, res) => {
  const r = (D.reviews || []).find(x => x.id === req.params.id); if (!r) return res.status(404).json({ error: 'Introuvable' });
  if (req.body.delete) D.reviews = D.reviews.filter(x => x.id !== r.id);
  else { if (['approved', 'pending', 'hidden'].includes(req.body.status)) r.status = req.body.status; if (typeof req.body.reply === 'string') r.reply = req.body.reply.slice(0, 400); }
  save(); res.json({ ok: 1 });
});

// ---- Public ----
const svc = () => ({ DJ: true, Artificier: true, Lighter: true, ...(D.site.services || {}) });
app.get('/api/public', (_, res) => res.json({ site: { ...D.site, services: svc() }, contacts: D.contacts, calendar: D.calendar, legal: D.legal, reviews: reviewsPublic(), locations: D.locations, giftSale: giftSaleInfo(), upload: { cloud: process.env.CLOUDINARY_CLOUD || '', preset: process.env.CLOUDINARY_PRESET || '' } }));

// ---- Newsletter ----
app.post('/api/newsletter', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'E-mail invalide' });
  if (!D.newsletter.includes(email)) { D.newsletter.push(email); save(); }
  res.json({ ok: 1 });
});
app.get('/desabonner', (req, res) => {
  const e = String(req.query.e || '').trim().toLowerCase(), ok = String(req.query.s || '') === unsubSig(e);
  if (ok) { D.newsletter = D.newsletter.filter(x => x !== e); save(); }
  res.send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="background:#0b0507;color:#fff;font-family:Arial,sans-serif;text-align:center;padding:60px 20px"><h2>${ok ? 'Vous êtes désinscrit de la newsletter.' : 'Lien invalide.'}</h2><a style="color:#ff6b76" href="/">Retour au site</a></body>`);
});
app.post('/api/newsletter/desinscription', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  D.newsletter = D.newsletter.filter(e => e !== email); save();
  res.json({ ok: 1 });
});

app.post('/api/dossier', async (req, res) => {
  const b = req.body, s = String;
  const d = { id: crypto.randomUUID(), trackCode: genCode(), num: nextNum(String(new Date().getFullYear())), created: new Date().toISOString(), service: s(b.service).slice(0, 20), date: s(b.date), lastName: s(b.lastName).slice(0, 60),
    budgetMin: +b.budgetMin, budgetMax: +b.budgetMax, email: s(b.email).slice(0, 120), phone: s(b.phone).slice(0, 30), address: s(b.address).slice(0, 200), city: s(b.city || '').trim().slice(0, 40) };
  if (!['DJ', 'Artificier', 'Lighter'].includes(d.service) || svc()[d.service] === false || !/^\d{4}-\d{2}-\d{2}$/.test(d.date) || !d.lastName || !d.email || !d.phone || !d.address || !(d.budgetMax >= d.budgetMin) || (d.city && !D.locations.includes(d.city)))
    return res.status(400).json({ error: 'Formulaire incomplet ou invalide' });
  const busy = D.calendar[d.date];
  d.status = busy ? 'refused' : 'pending';
  D.dossiers.unshift(d); save();
  const resume = `${d.service} le ${fd(d.date)} — ${d.lastName}\nBudget : ${d.budgetMin}–${d.budgetMax} €\nLieu : ${d.address}\nTel : ${d.phone} / ${d.email}\nVotre code de suivi : ${d.trackCode}`;
  const budget = eur(d.budgetMin) + ' – ' + eur(d.budgetMax);
  const summary = card(rows([['Dossier n°', d.num], ['Prestation', d.service], ['Date', fd(d.date)], ...(d.city ? [['Localisation', d.city]] : []), ['Lieu', d.address], ['Budget', budget]]));
  const full = card(rows([['Dossier n°', d.num], ['Prestation', d.service], ['Date', fd(d.date)], ['Nom', d.lastName], ['Budget', budget], ...(d.city ? [['Localisation', d.city]] : []), ['Lieu', d.address], ['Téléphone', d.phone], ['E-mail', d.email]]));
  const codeBox = card(rows([['Dossier n°', d.num], ['Code de suivi', d.trackCode]]));
  const site = process.env.SITE_URL || '';
  both(process.env.ADMIN_EMAIL, process.env.ADMIN_PHONE, `Nouveau dossier ${d.lastName}`, `Nouveau dossier${busy ? ' (date indisponible)' : ''}\n${resume}`,
    tpl('Nouveau dossier', p(busy ? 'Un client a déposé un dossier pour une <b>date indisponible</b> : un refus automatique lui a été envoyé.' : 'Un client vient de déposer un dossier. Tu peux l’accepter ou le refuser dans l’espace admin.') + full, { st: 'admin', sub: `${d.lastName} · ${d.service} · ${fd(d.date)}`, cta: 'Ouvrir l’espace admin' }));
  both(d.email, d.phone, busy ? 'Date non disponible' : 'Dossier bien reçu',
    busy ? `Bonjour ${d.lastName}, nous ne sommes malheureusement pas disponibles le ${fd(d.date)}.` : `Bonjour ${d.lastName}, votre dossier est bien reçu. Réponse très prochainement.\n${resume}`,
    busy ? tpl('Date non disponible', p(`Bonjour ${E(d.lastName)},`) + p(`Merci pour votre demande. Nous ne sommes malheureusement <b>pas disponibles le ${E(fd(d.date))}</b>. N’hésitez pas à nous proposer une autre date, nous ferons le maximum pour vous aider.`) + summary, { st: 'refused', sub: 'Nous ne pouvons pas assurer cette date.', cta: 'Proposer une autre date' })
      : tpl('Dossier bien reçu', p(`Bonjour ${E(d.lastName)},`) + p('Merci pour votre confiance ! Nous avons bien reçu votre dossier. Nous vérifions notre disponibilité et revenons vers vous très rapidement.') + summary + p('Conservez précieusement le code ci-dessous : il vous permet de suivre votre dossier et de payer en ligne une fois accepté.') + codeBox, { st: 'pending', sub: 'Votre dossier est en attente de validation.', cta: site ? 'Suivre mon dossier' : undefined, ctaUrl: site ? site + '/#suivi' : undefined }));
  res.json({ ok: true, status: d.status, trackCode: d.trackCode });
});

// ---- Admin ----
app.get('/api/admin/all', adm, (_, res) => res.json({ dossiers: D.dossiers, finances: D.finances }));
app.put('/api/admin/site', adm, (req, res) => { const sv = req.body.services || {};
  D.site = { title: String(req.body.title || 'Sound & Light 03'), hero: (req.body.hero || []).map(String), about: String(req.body.about || '').slice(0, 3000),
    services: { DJ: sv.DJ !== false, Artificier: sv.Artificier !== false, Lighter: sv.Lighter !== false } }; save(); res.json({ ok: 1 }); });
app.put('/api/admin/contacts', adm, (req, res) => { D.contacts = req.body.map(c => ({ name: String(c.name), role: String(c.role || ''), phone: String(c.phone || ''), email: String(c.email || ''), photo: String(c.photo || '') })); save(); res.json({ ok: 1 }); });
app.put('/api/admin/calendar', adm, (req, res) => { D.calendar = req.body; save(); res.json({ ok: 1 }); });

// ---- Admin : conditions générales & mentions légales (envoi newsletter à la mise à jour) ----
app.get('/api/admin/legal', adm, (_, res) => res.json({ legal: D.legal, abonnes: D.newsletter.length }));
app.put('/api/admin/legal', adm, async (req, res) => {
  D.legal = { cgv: String(req.body.cgv || '').slice(0, 20000), mentions: String(req.body.mentions || '').slice(0, 20000), updated: new Date().toISOString() };
  save();
  let warn = '';
  if (!UP) warn = 'Upstash n’est pas configuré (UPSTASH_URL / UPSTASH_TOKEN) : ces textes seront perdus au prochain déploiement.';
  else { try { await up(['SET', 'djdata', JSON.stringify(D)]); } catch (e) { warn = 'Sauvegarde durable impossible (Upstash) : ' + e.message; console.error('ERREUR UPSTASH', e.message); } }
  if (req.body.notifier && D.newsletter.length) {
    const site = process.env.SITE_URL || '';
    const mk = em => tpl('Mise à jour de nos conditions', p('Nos conditions générales et/ou nos mentions légales viennent d’être mises à jour.') + p('Nous vous invitons à en prendre connaissance sur notre site.'), { sub: 'Merci de votre confiance.', cta: site ? 'Consulter les conditions' : undefined, ctaUrl: site ? site + '/#legal' : undefined, unsub: em });
    const text = 'Nos conditions générales et/ou nos mentions légales viennent d’être mises à jour. Consultez-les sur notre site.' + (site ? '\n' + site : '');
    for (const email of D.newsletter) { mail(email, 'Mise à jour de nos conditions', text, mk(email)).catch(() => {}); }
  }
  res.json({ ok: 1, warn, notifies: req.body.notifier ? D.newsletter.length : 0 });
});

app.post('/api/admin/decision/:id', adm, async (req, res) => {
  const d = D.dossiers.find(x => x.id === req.params.id); if (!d) return res.status(404).json({ error: 'Introuvable' });
  d.status = req.body.accept ? 'accepted' : 'refused'; save();
  const ok = d.status === 'accepted', dt = fd(d.date), site = process.env.SITE_URL || '';
  const sm = card(rows([['Dossier n°', d.num], ['Prestation', d.service], ['Date', dt], ['Lieu', d.address]]));
  both(d.email, d.phone, ok ? 'Dossier accepté' : 'Date non disponible',
    ok ? `Bonjour ${d.lastName}, bonne nouvelle : nous sommes disponibles le ${dt} et votre dossier est accepté ! Code de suivi : ${d.trackCode}` : `Bonjour ${d.lastName}, nous ne sommes malheureusement pas disponibles le ${dt}.`,
    tpl(ok ? 'Dossier accepté' : 'Date non disponible', p(`Bonjour ${E(d.lastName)},`) + (ok ? p(`Bonne nouvelle : nous sommes <b>disponibles le ${E(dt)}</b> et votre dossier <b>${E(d.service)}</b> est accepté. Vous pouvez désormais régler en ligne depuis l’espace suivi avec votre code <b>${E(d.trackCode)}</b>.`) : p(`Merci pour votre demande. Nous ne sommes malheureusement <b>pas disponibles le ${E(dt)}</b>. N’hésitez pas à nous proposer une autre date.`)) + sm,
      { st: ok ? 'accepted' : 'refused', sub: ok ? 'En attente du paiement et de la prestation.' : 'Nous ne pouvons pas assurer cette date.', cta: ok ? 'Payer mon dossier' : 'Proposer une autre date', ctaUrl: ok && site ? site + '/#suivi' : undefined, link: ok ? 'Ajouter à mon agenda' : undefined, linkUrl: ok ? gcal(d) : undefined, pre: ok ? 'Bonne nouvelle : nous sommes disponibles le ' + dt + '.' : undefined }));
  res.json({ ok: 1 });
});

// Paiement admin : reçu type ticket de caisse + revenu ajouté automatiquement
app.post('/api/admin/pay/:id', adm, async (req, res) => {
  const d = D.dossiers.find(x => x.id === req.params.id); if (!d) return res.status(404).json({ error: 'Introuvable' });
  const lines = (req.body.lines || []).map(l => ({ label: String(l.label), amount: +l.amount })).filter(l => l.label && l.amount > 0);
  if (!lines.length) return res.status(400).json({ error: 'Aucune ligne' });
  const total = lines.reduce((a, l) => a + l.amount, 0), no = 'R-' + Date.now().toString(36).toUpperCase();
  const pad = (a, b) => a.slice(0, 28).padEnd(30, '.') + b.padStart(10);
  const ticket = ['=== ' + (D.site.title || 'Sound & Light 03') + ' ===', 'REÇU N° ' + no, new Date().toLocaleString('fr-FR'), '',
    'Client : ' + d.lastName, 'Prestation : ' + d.service + ' (' + fd(d.date) + ')', '', ...lines.map(l => pad(l.label, l.amount.toFixed(2) + ' €')), '-'.repeat(40), pad('TOTAL PAYÉ', total.toFixed(2) + ' €'), '', 'Merci de votre confiance !'].join('\n');
  d.status = 'paid'; d.total = total; D.finances.push({ id: crypto.randomUUID(), type: 'revenue', name: d.lastName, amount: total, date: new Date().toISOString().slice(0, 10), note: 'Reçu ' + no });
  save();
  const ticketHtml = rows([['Dossier n°', d.num], ['Reçu n°', no], ['Date', new Date().toLocaleDateString('fr-FR')], ['Client', d.lastName], ['Prestation', d.service + ' — ' + fd(d.date) + (d.city ? ' — ' + d.city : '')]]) + rows(lines.map(l => [l.label, eur(l.amount)])) + `<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px"><tr><td style="font:bold 16px Arial,Helvetica,sans-serif;color:#ffffff;padding:6px 0">Total payé</td><td align="right" style="font:bold 22px Arial,Helvetica,sans-serif;color:#ffffff;padding:6px 0">${eur(total)}</td></tr></table>`;
  both(d.email, d.phone, 'Votre reçu ' + no, ticket, tpl('Paiement reçu', p(`Bonjour ${E(d.lastName)}, merci pour votre confiance ! Voici le reçu de votre paiement.`) + ticketHtml + p('<span style="font-size:13px">Ce message fait office de reçu de paiement. Conservez-le.</span>'), { st: 'paid', sub: 'Reçu n° ' + no, cta: 'Voir mon dossier', ctaUrl: (process.env.SITE_URL || '') + '/#suivi', pre: 'Paiement de ' + eur(total) + ' bien reçu. Merci !' })); res.json({ ok: 1 });
});

app.post('/api/admin/remboursement/:id', adm, async (req, res) => {
  const d = D.dossiers.find(x => x.id === req.params.id); if (!d) return res.status(404).json({ error: 'Introuvable' });
  if (req.body.accept) {
    d.status = 'refunded'; D.finances.push({ id: crypto.randomUUID(), type: 'expense', name: d.lastName, amount: d.total || 0, date: new Date().toISOString().slice(0, 10), note: 'Remboursement' });
  } else d.status = 'paid';
  save();
  both(d.email, d.phone, req.body.accept ? 'Remboursement effectué' : 'Demande de remboursement refusée',
    req.body.accept ? `Bonjour ${d.lastName}, votre remboursement a été effectué.` : `Bonjour ${d.lastName}, votre demande de remboursement a été refusée.`,
    tpl(req.body.accept ? 'Remboursement effectué' : 'Demande refusée', p(`Bonjour ${E(d.lastName)},`) + p(req.body.accept ? 'Votre remboursement a bien été effectué.' : 'Après vérification, votre demande de remboursement a été refusée. N’hésitez pas à nous contacter pour en discuter.'), { st: req.body.accept ? 'refunded' : 'paid' }));
  res.json({ ok: 1 });
});

app.post('/api/admin/finance', adm, (req, res) => {
  const b = req.body; if (!['revenue', 'expense', 'budget'].includes(b.type) || !(+b.amount >= 0) || !/^\d{4}-\d{2}-\d{2}$/.test(b.date)) return res.status(400).json({ error: 'Invalide' });
  D.finances.push({ id: crypto.randomUUID(), type: b.type, name: String(b.name).slice(0, 80), amount: +b.amount, date: b.date, note: String(b.note || '').slice(0, 120) }); save(); res.json({ ok: 1 });
});
app.delete('/api/admin/finance/:id', adm, (req, res) => { D.finances = D.finances.filter(f => f.id !== req.params.id); save(); res.json({ ok: 1 }); });

app.get('/api/admin/maintenance', adm, (_, res) => res.json({ maint: D.maint || { on: false }, canDeploy: !!process.env.RENDER_DEPLOY_HOOK, deploying: !!(deploying && Date.now() < deploying.until + 15 * 60000) }));
app.post('/api/admin/maintenance', adm, (req, res) => {
  const on = !!req.body.on, min = Math.min(Math.max(+req.body.minutes || 15, 1), 1440);
  D.maint = { on, until: on ? Date.now() + min * 60000 : 0, msg: String(req.body.msg || '').slice(0, 200) }; save(); res.json({ ok: 1 });
});
app.post('/api/admin/deploy', adm, async (req, res) => {
  const hook = process.env.RENDER_DEPLOY_HOOK;
  if (!hook) return res.status(400).json({ error: 'RENDER_DEPLOY_HOOK n’est pas configuré dans Render.' });
  const min = Math.min(Math.max(+req.body.minutes || 3, 1), 30);
  try { const r = await fetch(hook, { method: 'POST' }); if (!r.ok) throw new Error('Render a répondu ' + r.status); } catch (e) { return res.status(500).json({ error: 'Impossible de contacter Render : vérifie le lien RENDER_DEPLOY_HOOK (' + e.message + ').' }); }
  deploying = { until: Date.now() + min * 60000, msg: 'Mise à jour du site en cours' }; res.json({ ok: 1 });
});

// ---- Mail d'information unique : numéro de dossier + code de suivi ----
const noticeGroups = () => { const g = {}; for (const d of D.dossiers) { const e = String(d.email || '').trim().toLowerCase(); if (!e) continue; (g[e] = g[e] || []).push(d); } return g; };
const noticeMail = (email, ds) => {
  const site = (process.env.SITE_URL || '').replace(/\/$/, ''), list = ds.slice(0, 5), name = list[0].lastName;
  const blocks = list.map(d => rows([['Dossier n°', d.num], ['Prestation', d.service + ' — ' + fd(d.date) + (d.city ? ' — ' + d.city : '')], ['Code de suivi', d.trackCode]])).join('<div style="height:16px"></div>');
  const text = `Bonjour ${name}, notre site a été mis à jour : chaque dossier a maintenant un numéro et un code de suivi personnel.\n\n` + list.map(d => `Dossier n° ${d.num} — ${d.service} le ${fd(d.date)}\nCode de suivi : ${d.trackCode}`).join('\n\n') + (site ? `\n\nSuivre mon dossier : ${site}/#suivi` : '') + '\n\nCe message est envoyé une seule fois.';
  const html = tpl('Votre dossier a un numéro', p(`Bonjour ${E(name)},`) + p('Nous avons mis à jour notre site : chaque dossier a désormais un <b>numéro</b> et un <b>code de suivi</b> personnel. Avec ce code, vous suivez l’avancement de votre dossier à tout moment et vous pouvez régler en ligne dès qu’il est accepté.') + blocks + p('<span style="font-size:13px">Conservez ce code, il est personnel. Ce message est envoyé une seule fois.</span>'),
    { sub: 'Un numéro et un code de suivi pour chaque dossier.', cta: site ? 'Suivre mon dossier' : undefined, ctaUrl: site ? site + '/#suivi' : undefined, pre: 'Voici le numéro et le code de suivi de votre dossier.' });
  return { text, html };
};
app.get('/api/admin/notice', adm, (_, res) => { const g = noticeGroups(), n = D.notice || {}; const sent = new Set(n.sentTo || []);
  res.json({ clients: Object.keys(g).length, remaining: Object.keys(g).filter(e => !sent.has(e)).length, sent: sent.size, failed: n.failed || 0, running: !!n.running, at: n.at || null, lastError: n.lastError || '' }); });
app.post('/api/admin/notice', adm, async (req, res) => {
  const g = noticeGroups();
  if (req.body.test) { const to = process.env.ADMIN_EMAIL; if (!to) return res.status(400).json({ error: 'ADMIN_EMAIL manquant dans Render' });
    const ds = D.dossiers.slice(0, 1); if (!ds.length) return res.status(400).json({ error: 'Aucun dossier pour faire un exemple' });
    const m = noticeMail(to, ds); const err = await mail(to, 'Votre dossier a un numéro (exemple)', m.text, m.html); return res.json({ ok: !err, error: err || undefined, to }); }
  if (D.notice && D.notice.running) return res.status(409).json({ error: 'Un envoi est déjà en cours' });
  const done = new Set((D.notice && D.notice.sentTo) || []), todo = Object.keys(g).filter(e => !done.has(e));
  if (!todo.length) return res.status(409).json({ error: 'Tous les clients ont déjà reçu ce mail.' });
  D.notice = { at: (D.notice && D.notice.at) || new Date().toISOString(), sentTo: [...done], failed: 0, running: true, lastError: '' }; save();
  res.json({ ok: 1, total: todo.length, warn: todo.length > 90 ? 'Gmail limite l’envoi à environ 100 mails par jour : les clients restants pourront être prévenus demain avec le même bouton.' : '' });
  (async () => { for (const e of todo) { const m = noticeMail(e, g[e]); const err = await mail(e, 'Votre dossier a un numéro de suivi', m.text, m.html);
      if (err) { D.notice.failed++; D.notice.lastError = err; } else D.notice.sentTo.push(e); save(); await new Promise(r => setTimeout(r, 400)); }
    D.notice.running = false; save(); })().catch(e => { D.notice.running = false; D.notice.lastError = e.message; save(); });
});

app.post('/api/admin/test-mail', adm, async (_, res) => {
  const to = process.env.ADMIN_EMAIL; if (!to) return res.json({ error: 'ADMIN_EMAIL manquant dans Render' });
  res.json({ to, error: await mail(to, 'Test du site', 'Si tu lis ce message, les mails fonctionnent ✅', tpl('Test réussi ✅', p('Si tu lis ce message, les mails de ton site fonctionnent.'), { st: 'ok' })) });
});

(async () => {
  if (UP) { try { const r = await up(['GET', 'djdata']); if (r.result) D = { ...D, ...JSON.parse(r.result) }; console.log('Données chargées depuis Upstash'); } catch (e) { console.error('ERREUR UPSTASH', e.message); } ready = true; }
  if (!Array.isArray(D.locations) || !D.locations.length) { D.locations = ['Moulins', 'Saint-Étienne']; save(); }
  if (assignNums()) { save(); console.log('Numéros de dossier attribués'); }
  console.log('Routes prêtes — fichier complet');
})();
