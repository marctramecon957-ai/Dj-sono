const express = require('express'), fs = require('fs'), crypto = require('crypto'), nodemailer = require('nodemailer');
console.log('Démarrage…');
process.on('uncaughtException', e => console.error('ERREUR FATALE', e));
process.on('unhandledRejection', e => console.error('ERREUR PROMESSE', e));
const app = express();
// Le port est ouvert tout de suite (Render l'exige) ; les routes sont ajoutées ensuite
app.listen(process.env.PORT || 3000, '0.0.0.0', () => console.log('Serveur ouvert sur le port', process.env.PORT || 3000));
const path = require('path');
app.use(express.json());
app.use('/api', (_, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
const IDX = [path.join(__dirname, 'public', 'index.html'), path.join(__dirname, 'index.html')].find(p => fs.existsSync(p));
app.get('/', (_, res) => res.set('Cache-Control', 'no-store').sendFile(IDX));

const FILE = process.env.DATA_FILE || 'data.json';
let D = { site: { title: 'Sound & Light', hero: [] }, contacts: [], calendar: {}, dossiers: [], finances: [] };
try { D = { ...D, ...JSON.parse(fs.readFileSync(FILE)) }; } catch {}
// Sauvegarde durable : Upstash Redis (gratuit, HTTPS) si configuré, sinon fichier local
const UP = process.env.UPSTASH_URL, UT = process.env.UPSTASH_TOKEN;
const up = body => fetch(UP, { method: 'POST', headers: { Authorization: 'Bearer ' + UT }, body: JSON.stringify(body) }).then(r => r.json());
let timer, ready = !UP;
const save = () => {
  try { fs.writeFileSync(FILE, JSON.stringify(D, null, 1)); } catch {}
  if (UP && ready) { clearTimeout(timer); timer = setTimeout(() => up(['SET', 'djdata', JSON.stringify(D)]).catch(e => console.error('ERREUR UPSTASH', e.message)), 300); }
};

// ---- Mail & SMS (SMTP + Twilio). Sans config : affichés dans les logs ----
const mailer = process.env.SMTP_HOST ? nodemailer.createTransport({ host: process.env.SMTP_HOST, port: +process.env.SMTP_PORT || 587, connectionTimeout: 8000,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } }) : null;
// Render (offre gratuite) bloque le SMTP : on envoie par l'API HTTPS de Brevo
const mail = async (to, subject, text, html) => {
  try {
    text = text + sigText();
    if (process.env.MAIL_SCRIPT_URL) {
      const r = await fetch(process.env.MAIL_SCRIPT_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret: process.env.MAIL_SCRIPT_SECRET || '', to, subject, text, name: process.env.MAIL_NAME || 'Sound & Light', html }) });
      const t = await r.text();
      if (t.trim() !== 'ok') throw new Error('Google Script : ' + t.slice(0, 200));
    } else if (process.env.BREVO_API_KEY) {
      if (!process.env.MAIL_FROM) return 'MAIL_FROM manquant dans Render';
      const r = await fetch('https://api.brevo.com/v3/smtp/email', { method: 'POST', headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sender: { name: process.env.MAIL_NAME || 'Sound & Light', email: process.env.MAIL_FROM }, to: [{ email: to }], subject, textContent: text, ...(html && { htmlContent: html }) }) });
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
const CO = () => ({ name: process.env.COMPANY_NAME || process.env.MAIL_NAME || (D.site && D.site.title) || 'Sound & Light', email: process.env.COMPANY_EMAIL || process.env.ADMIN_EMAIL || '', addr: process.env.COMPANY_ADDRESS || '', siret: process.env.COMPANY_SIRET || '', tva: process.env.COMPANY_TVA || '', phone: process.env.COMPANY_PHONE || '', logo: process.env.COMPANY_LOGO || '' });
const sigText = () => { const c = CO(); return '\n\n--\n' + [c.name, c.addr, c.phone && 'Tél. ' + c.phone, c.email, c.siret && 'SIRET ' + c.siret, c.tva && 'TVA ' + c.tva].filter(Boolean).join('\n'); };
const p = t => `<p style="font-size:15px;line-height:1.6;margin:0 0 12px">${t}</p>`;
const rows = a => `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:12px 0">${a.map(r => `<tr><td style="padding:9px 0;border-bottom:1px solid #eee;color:#777;width:38%">${E(r[0])}</td><td style="padding:9px 0;border-bottom:1px solid #eee;font-weight:bold">${E(r[1])}</td></tr>`).join('')}</table>`;
const tpl = (title, inner) => { const c = CO(); return `<!doctype html><html><body style="margin:0;background:#f3f3f5;font-family:Arial,Helvetica,sans-serif;color:#1a1a1f"><table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f3f5;padding:24px 0"><tr><td align="center"><table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#fff;border-radius:10px;overflow:hidden"><tr><td style="background:#0b0507;padding:26px 24px;text-align:center;border-bottom:4px solid #ff1e2d">${c.logo ? `<img src="${E(c.logo)}" alt="${E(c.name)}" style="max-height:70px">` : `<div style="font:italic 900 30px 'Arial Black',Arial,sans-serif;color:#fff;letter-spacing:1px;text-transform:uppercase">${E(c.name.replace(/\s*sonorisation\s*$/i, ''))}</div><div style="color:#ff1e2d;letter-spacing:6px;font-size:12px;margin-top:6px">SONORISATION</div>`}</td></tr><tr><td style="padding:28px 28px 8px"><h1 style="margin:0 0 14px;font-size:22px;color:#b30012">${E(title)}</h1>${inner}</td></tr><tr><td style="padding:18px 28px 26px;font-size:12px;color:#777;border-top:1px solid #eee"><b style="color:#444;font-size:13px">${E(c.name)}</b>${c.addr ? '<br>' + E(c.addr) : ''}${c.phone ? '<br>Tél. ' + E(c.phone) : ''}${c.email ? '<br>' + E(c.email) : ''}${c.siret ? '<br>SIRET ' + E(c.siret) : ''}${c.tva ? ' · TVA ' + E(c.tva) : ''}</td></tr></table></td></tr></table></body></html>`; };
const both = (m, ph, sub, txt, html) => { Promise.all([m && mail(m, sub, txt, html), ph && sms(ph, txt.slice(0, 300))]).catch(() => {}); };

// ---- Auth admin ----
const tokens = new Set();
const adm = (req, res, next) => tokens.has(req.headers['x-token']) ? next() : res.status(401).json({ error: 'Non autorisé' });
app.post('/api/login', (req, res) => {
  if (!process.env.ADMIN_PASSWORD || req.body.password !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'Mot de passe incorrect' });
  const t = crypto.randomBytes(24).toString('hex'); tokens.add(t); res.json({ token: t });
});

// ---- Public ----
const svc = () => ({ DJ: true, Artificier: true, Lighter: true, ...(D.site.services || {}) });
app.get('/api/public', (_, res) => res.json({ site: { ...D.site, services: svc() }, contacts: D.contacts, calendar: D.calendar, upload: { cloud: process.env.CLOUDINARY_CLOUD || '', preset: process.env.CLOUDINARY_PRESET || '' } }));

app.post('/api/dossier', async (req, res) => {
  const b = req.body, s = String;
  const d = { id: crypto.randomUUID(), created: new Date().toISOString(), service: s(b.service).slice(0, 20), date: s(b.date), lastName: s(b.lastName).slice(0, 60),
    budgetMin: +b.budgetMin, budgetMax: +b.budgetMax, email: s(b.email).slice(0, 120), phone: s(b.phone).slice(0, 30), address: s(b.address).slice(0, 200) };
  if (!['DJ', 'Artificier', 'Lighter'].includes(d.service) || svc()[d.service] === false || !/^\d{4}-\d{2}-\d{2}$/.test(d.date) || !d.lastName || !d.email || !d.phone || !d.address || !(d.budgetMax >= d.budgetMin))
    return res.status(400).json({ error: 'Formulaire incomplet ou invalide' });
  const busy = D.calendar[d.date];
  d.status = busy ? 'refused' : 'pending';
  D.dossiers.unshift(d); save();
  const resume = `${d.service} le ${fd(d.date)} — ${d.lastName}\nBudget : ${d.budgetMin}–${d.budgetMax} €\nLieu : ${d.address}\nTel : ${d.phone} / ${d.email}`;
  const tbl = rows([['Prestation', d.service], ['Date', fd(d.date)], ['Nom', d.lastName], ['Budget', eur(d.budgetMin) + ' – ' + eur(d.budgetMax)], ['Lieu', d.address], ['Téléphone', d.phone], ['E-mail', d.email]]);
  both(process.env.ADMIN_EMAIL, process.env.ADMIN_PHONE, `Nouveau dossier ${d.lastName}`, `Nouveau dossier${busy ? ' (date indisponible)' : ''}\n${resume}`,
    tpl('Nouveau dossier', p(busy ? 'Un client a déposé un dossier pour une <b>date indisponible</b> (un refus automatique lui a été envoyé).' : 'Un client vient de déposer un dossier. Tu peux l’accepter ou le refuser dans l’espace admin.') + tbl));
  both(d.email, d.phone, busy ? 'Date non disponible' : 'Dossier bien reçu',
    busy ? `Bonjour ${d.lastName}, nous ne sommes malheureusement pas disponibles le ${fd(d.date)}.` : `Bonjour ${d.lastName}, votre dossier est bien reçu. Réponse très prochainement.\n${resume}`,
    tpl(busy ? 'Date non disponible' : 'Dossier bien reçu', p(`Bonjour ${E(d.lastName)},`) + (busy ? p(`Merci pour votre demande. Nous ne sommes malheureusement <b>pas disponibles le ${E(fd(d.date))}</b>. N’hésitez pas à nous proposer une autre date.`) : p('Nous avons bien reçu votre dossier. Nous revenons vers vous très rapidement pour confirmer notre disponibilité.') + tbl)));
  res.json({ ok: true, status: d.status });
});

// ---- Admin ----
app.get('/api/admin/all', adm, (_, res) => res.json({ dossiers: D.dossiers, finances: D.finances }));
app.put('/api/admin/site', adm, (req, res) => { const sv = req.body.services || {};
  D.site = { title: String(req.body.title || 'Sound & Light'), hero: (req.body.hero || []).map(String), about: String(req.body.about || '').slice(0, 3000),
    services: { DJ: sv.DJ !== false, Artificier: sv.Artificier !== false, Lighter: sv.Lighter !== false } }; save(); res.json({ ok: 1 }); });
app.put('/api/admin/contacts', adm, (req, res) => { D.contacts = req.body.map(c => ({ name: String(c.name), role: String(c.role || ''), phone: String(c.phone || ''), email: String(c.email || ''), photo: String(c.photo || '') })); save(); res.json({ ok: 1 }); });
app.put('/api/admin/calendar', adm, (req, res) => { D.calendar = req.body; save(); res.json({ ok: 1 }); });

app.post('/api/admin/decision/:id', adm, async (req, res) => {
  const d = D.dossiers.find(x => x.id === req.params.id); if (!d) return res.status(404).json({ error: 'Introuvable' });
  d.status = req.body.accept ? 'accepted' : 'refused'; save();
  const ok = d.status === 'accepted', dt = fd(d.date);
  both(d.email, d.phone, ok ? 'Dossier accepté' : 'Date non disponible',
    ok ? `Bonjour ${d.lastName}, bonne nouvelle : nous sommes disponibles le ${dt} et votre dossier est accepté !` : `Bonjour ${d.lastName}, nous ne sommes malheureusement pas disponibles le ${dt}.`,
    tpl(ok ? 'Dossier accepté ✔' : 'Date non disponible', p(`Bonjour ${E(d.lastName)},`) + (ok ? p(`Bonne nouvelle : nous sommes <b>disponibles le ${E(dt)}</b> et votre dossier <b>${E(d.service)}</b> est accepté. Nous vous contactons pour finaliser les détails.`) : p(`Merci pour votre demande. Nous ne sommes malheureusement <b>pas disponibles le ${E(dt)}</b>.`))));
  res.json({ ok: 1 });
});

// Paiement : reçu type ticket de caisse + revenu ajouté automatiquement
app.post('/api/admin/pay/:id', adm, async (req, res) => {
  const d = D.dossiers.find(x => x.id === req.params.id); if (!d) return res.status(404).json({ error: 'Introuvable' });
  const lines = (req.body.lines || []).map(l => ({ label: String(l.label), amount: +l.amount })).filter(l => l.label && l.amount > 0);
  if (!lines.length) return res.status(400).json({ error: 'Aucune ligne' });
  const total = lines.reduce((a, l) => a + l.amount, 0), no = 'R-' + Date.now().toString(36).toUpperCase();
  const pad = (a, b) => a.slice(0, 28).padEnd(30, '.') + b.padStart(10);
  const ticket = ['=== ' + (D.site.title || 'Sound & Light') + ' ===', 'REÇU N° ' + no, new Date().toLocaleString('fr-FR'), '',
    'Client : ' + d.lastName, 'Prestation : ' + d.service + ' (' + fd(d.date) + ')', '', ...lines.map(l => pad(l.label, l.amount.toFixed(2) + ' €')), '-'.repeat(40), pad('TOTAL PAYÉ', total.toFixed(2) + ' €'), '', 'Merci de votre confiance !'].join('\n');
  d.status = 'paid'; D.finances.push({ id: crypto.randomUUID(), type: 'revenue', name: d.lastName, amount: total, date: new Date().toISOString().slice(0, 10), note: 'Reçu ' + no });
  save(); const lignes = lines.map(l => `<tr><td style="padding:9px 0;border-bottom:1px solid #eee">${E(l.label)}</td><td align="right" style="padding:9px 0;border-bottom:1px solid #eee">${eur(l.amount)}</td></tr>`).join('');
  both(d.email, d.phone, 'Votre reçu ' + no, ticket, tpl('Reçu de paiement', p(`Bonjour ${E(d.lastName)}, merci pour votre confiance. Voici votre reçu.`) + rows([['Reçu n°', no], ['Date', new Date().toLocaleDateString('fr-FR')], ['Prestation', d.service + ' — ' + fd(d.date)]]) + `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:10px 0">${lignes}<tr><td style="padding:14px 0;font-weight:bold;font-size:17px">TOTAL PAYÉ</td><td align="right" style="padding:14px 0;font-weight:bold;font-size:17px;color:#b30012">${eur(total)}</td></tr></table>` + p('Ce message fait office de reçu de paiement.'))); res.json({ ok: 1 });
});

app.post('/api/admin/finance', adm, (req, res) => {
  const b = req.body; if (!['revenue', 'expense', 'budget'].includes(b.type) || !(+b.amount >= 0) || !/^\d{4}-\d{2}-\d{2}$/.test(b.date)) return res.status(400).json({ error: 'Invalide' });
  D.finances.push({ id: crypto.randomUUID(), type: b.type, name: String(b.name).slice(0, 80), amount: +b.amount, date: b.date, note: String(b.note || '').slice(0, 120) }); save(); res.json({ ok: 1 });
});
app.delete('/api/admin/finance/:id', adm, (req, res) => { D.finances = D.finances.filter(f => f.id !== req.params.id); save(); res.json({ ok: 1 }); });

app.post('/api/admin/test-mail', adm, async (_, res) => {
  const to = process.env.ADMIN_EMAIL; if (!to) return res.json({ error: 'ADMIN_EMAIL manquant dans Render' });
  res.json({ to, error: await mail(to, 'Test du site', 'Si tu lis ce message, les mails fonctionnent ✅', tpl('Test réussi ✅', p('Si tu lis ce message, les mails de ton site fonctionnent.'))) });
});

(async () => {
  if (UP) { try { const r = await up(['GET', 'djdata']); if (r.result) D = { ...D, ...JSON.parse(r.result) }; console.log('Données chargées depuis Upstash'); } catch (e) { console.error('ERREUR UPSTASH', e.message); } ready = true; }
  console.log('Routes prêtes — fichier complet');
})();
