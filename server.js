const express = require('express'), fs = require('fs'), crypto = require('crypto'), nodemailer = require('nodemailer');
console.log('Démarrage… [build legal-newsletter v4]');
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
app.get('/api/version', (_, res) => res.json({ build: 'legal-newsletter v4' }));

const FILE = process.env.DATA_FILE || 'data.json';
let D = { site: { title: 'Sound & Light 03', hero: [] }, contacts: [], calendar: {}, dossiers: [], finances: [],
  legal: {
    mentions: 'Éditeur du site : Sound & Light 03 Sonorisation, entreprise individuelle (auto-entrepreneur).\nResponsable : Nathan Peurton.\nAdresse : 8 Rue Simone Léveillé.\nTéléphone : 06 59 84 39 52 — E-mail : soundlight03@gmail.com\nSIRET : en cours d’attribution.\nHébergement : Render Services, Inc., San Francisco, États-Unis.\nDonnées personnelles : les informations saisies dans les formulaires servent uniquement au traitement de votre demande. Vous pouvez demander leur suppression à tout moment par e-mail. L’inscription à la newsletter est facultative et la désinscription possible sur simple demande.\nCookies : le site n’utilise que des cookies techniques nécessaires à son fonctionnement.',
    cgv: 'Article 1 — Objet : les présentes conditions encadrent les prestations de sonorisation, DJ, éclairage et artifices proposées par Sound & Light 03 Sonorisation.\nArticle 2 — Devis et dossier : tout dossier déposé sur le site est une demande, qui n’est ferme qu’après acceptation par le prestataire.\nArticle 3 — Disponibilité : la prestation est soumise à la disponibilité de la date demandée.\nArticle 4 — Prix et paiement : le prix est celui convenu entre les parties. Le paiement peut être demandé en acompte puis en solde, selon l’accord conclu.\nArticle 5 — Annulation et remboursement : une demande de remboursement peut être faite depuis l’espace de suivi du dossier et est étudiée au cas par cas.\nArticle 6 — Responsabilité : le client fournit un lieu et une alimentation électrique adaptés, et respecte les règles de sécurité en vigueur, notamment pour les artifices.\nArticle 7 — Données personnelles : voir les mentions légales.\nArticle 8 — Droit applicable : droit français.',
    updated: null },
  newsletter: [] };
try { D = { ...D, ...JSON.parse(fs.readFileSync(FILE)) }; } catch {}
// Sauvegarde durable : Upstash Redis (gratuit, HTTPS) si configuré, sinon fichier local
const UP = process.env.UPSTASH_URL, UT = process.env.UPSTASH_TOKEN;
const up = body => fetch(UP, { method: 'POST', headers: { Authorization: 'Bearer ' + UT }, body: JSON.stringify(body) }).then(r => r.json());
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
const p = t => `<p style="font-size:15px;line-height:1.6;margin:0 0 12px;color:#e6e6ea">${t}</p>`;
const rows = a => `<table width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${a.map((r, k) => `<tr><td style="padding:11px 0;${k ? 'border-top:1px solid #2c2c34;' : ''}color:#a9a9b3;width:36%;font-size:14px">${E(r[0])}</td><td style="padding:11px 0;${k ? 'border-top:1px solid #2c2c34;' : ''}font-weight:bold;color:#ffffff;font-size:14px">${E(r[1])}</td></tr>`).join('')}</table>`;
const card = h => `<table width="100%" cellpadding="0" cellspacing="0" style="margin:14px 0;background:#1b1b21;border:1px solid #2c2c34;border-radius:12px"><tr><td style="padding:6px 20px">${h}</td></tr></table>`;
const TRK = ['Dossier reçu', 'Validation', 'Accepté', 'Payé'];
const tracker = st => {
  const m = { pending: { d: 1, c: 1 }, accepted: { d: 3, c: 3 }, paid: { d: 4 }, refused: { d: 1, f: 1 }, refund_requested: { d: 4 }, refunded: { d: 4 } }[st]; if (!m) return '';
  const col = i => m.f === i ? '#e5384a' : i < m.d ? '#2bb673' : i === m.c ? '#f5a623' : '#3a3a42';
  const bar = i => i < 0 || i > 2 ? 'transparent' : m.f === i + 1 ? '#e5384a' : (i < m.d && (i + 1 < m.d || i + 1 === m.c)) ? '#2bb673' : '#3a3a42';
  const seg = c => `<td style="padding:0 3px"><div style="height:4px;line-height:4px;font-size:0;border-radius:2px;background:${c}">&nbsp;</div></td>`;
  const cell = i => `<td width="25%" valign="top" align="center"><table width="100%" cellpadding="0" cellspacing="0"><tr>${seg(bar(i - 1))}<td width="38"><div style="width:38px;height:38px;line-height:38px;border-radius:19px;background:${col(i)};color:#ffffff;font:bold 16px/38px Arial,sans-serif;text-align:center">${m.f === i ? '✕' : i < m.d ? '✓' : i + 1}</div></td>${seg(bar(i))}</tr></table><div style="font:bold 12px Arial,sans-serif;color:${m.f === i ? '#ff7a88' : (i < m.d || i === m.c) ? '#ffffff' : '#8e8e98'};margin-top:8px">${m.f === i ? 'Refusé' : TRK[i]}</div></td>`;
  return `<table width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 24px"><tr>${[0, 1, 2, 3].map(cell).join('')}</tr></table>`;
};
const BADGE = { pending: ['#f5a623', '⏳'], accepted: ['#2bb673', '✔'], refused: ['#e5384a', '✕'], paid: ['#2bb673', '€'], admin: ['#ff1e2d', '✉'], ok: ['#2bb673', '✔'], refund_requested: ['#f5a623', '↺'], refunded: ['#2bb673', '↺'] };
const tpl = (title, inner, o = {}) => {
  const c = CO(), site = process.env.SITE_URL || '', ban = process.env.COMPANY_BANNER || '', nm = c.name.replace(/\s*sonorisation\s*$/i, ''), b = BADGE[o.st];
  const cta = o.cta && site ? `<table align="center" cellpadding="0" cellspacing="0" style="margin:24px auto 6px"><tr><td bgcolor="#c4101c" style="border-radius:8px"><a href="${E(o.ctaUrl || site)}" style="display:inline-block;padding:15px 36px;color:#ffffff;font:bold 15px Arial,sans-serif;text-decoration:none">${E(o.cta)}</a></td></tr></table>` : '';
  const badge = b ? `<table align="center" cellpadding="0" cellspacing="0" style="margin:26px auto 0"><tr><td align="center" bgcolor="${b[0]}" width="72" height="72" style="border-radius:36px;font:bold 34px/72px Arial,sans-serif;color:#ffffff">${b[1]}</td></tr></table>` : '';
  const bg = ban ? `background="${E(ban)}" style="background-image:url('${E(ban)}');background-size:cover;background-position:center;` : 'style="background-image:linear-gradient(180deg,#4a0710,#16090c);';
  const foot = `<b style="color:#cfcfd6;font-size:13px">${E(c.name)}</b>${c.addr ? '<br>' + E(c.addr) : ''}${c.phone ? '<br>Tél. ' + E(c.phone) : ''}${c.email ? '<br>' + E(c.email) : ''}${c.siret ? '<br>SIRET ' + E(c.siret) : ''}${c.tva ? ' · TVA ' + E(c.tva) : ''}`;
  return `<!doctype html><html><body style="margin:0;background:#0b0b0d;font-family:Arial,Helvetica,sans-serif;color:#e6e6ea"><table width="100%" cellpadding="0" cellspacing="0" bgcolor="#0b0b0d"><tr><td align="center" style="padding:24px 12px"><table width="600" cellpadding="0" cellspacing="0" bgcolor="#131316" style="max-width:600px;width:100%;border-radius:16px;overflow:hidden"><tr><td align="center" bgcolor="#2a0409" ${bg}padding:34px 24px 32px"><div style="font:italic 900 26px 'Arial Black',Arial,sans-serif;color:#ffffff;text-transform:uppercase;letter-spacing:1px">${E(nm)}</div><div style="color:#ff5a66;letter-spacing:6px;font:bold 11px Arial,sans-serif;margin-top:6px">SONORISATION</div>${badge}<div style="font:italic 900 30px 'Arial Black',Arial,sans-serif;color:#ffffff;text-transform:uppercase;line-height:1.15;margin-top:18px">${E(title)}</div>${o.sub ? `<div style="font:15px/1.5 Arial,sans-serif;color:#e8c9ce;margin-top:10px">${E(o.sub)}</div>` : ''}</td></tr><tr><td style="height:4px;line-height:4px;font-size:0;background:#ff1e2d">&nbsp;</td></tr><tr><td style="padding:28px 30px 12px;font-size:15px;line-height:1.6;color:#e6e6ea">${tracker(o.st)}${inner}${cta}</td></tr><tr><td style="padding:20px 30px 28px;font-size:12px;line-height:1.6;color:#8e8e98;border-top:1px solid #2a2a30">${foot}<br><span style="color:#6f6f79">Une question ? Répondez simplement à ce mail.</span></td></tr></table></td></tr></table></body></html>`;
};
const both = (m, ph, sub, txt, html) => { Promise.all([m && mail(m, sub, txt, html), ph && sms(ph, txt.slice(0, 300))]).catch(() => {}); };

// ---- Auth admin ----
const tokens = new Set();
const adm = (req, res, next) => tokens.has(req.headers['x-token']) ? next() : res.status(401).json({ error: 'Non autorisé' });
app.post('/api/login', (req, res) => {
  if (!process.env.ADMIN_PASSWORD || req.body.password !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'Mot de passe incorrect' });
  const t = crypto.randomBytes(24).toString('hex'); tokens.add(t); res.json({ token: t });
});

// ---- Suivi de dossier (code unique client) ----
const genCode = () => crypto.randomBytes(5).toString('hex').toUpperCase();
app.post('/api/suivi', (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  const d = D.dossiers.find(x => x.trackCode === code);
  if (!d) return res.status(404).json({ error: 'Code introuvable' });
  res.json({ dossier: { service: d.service, date: d.date, lastName: d.lastName, status: d.status, total: d.total || null, refund: d.refund || null } });
});
app.post('/api/suivi/paiement', async (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  const d = D.dossiers.find(x => x.trackCode === code); if (!d) return res.status(404).json({ error: 'Code introuvable' });
  if (d.status !== 'accepted') return res.status(400).json({ error: 'Le paiement n’est pas disponible pour ce dossier' });
  // Simulation de paiement (à remplacer par Stripe) : marque payé immédiatement
  d.status = 'paid'; d.total = d.total || (+d.budgetMin || 0); save();
  res.json({ ok: 1 });
});
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

// ---- Public ----
const svc = () => ({ DJ: true, Artificier: true, Lighter: true, ...(D.site.services || {}) });
app.get('/api/public', (_, res) => res.json({ site: { ...D.site, services: svc() }, contacts: D.contacts, calendar: D.calendar, legal: D.legal, upload: { cloud: process.env.CLOUDINARY_CLOUD || '', preset: process.env.CLOUDINARY_PRESET || '' } }));

// ---- Newsletter ----
app.post('/api/newsletter', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'E-mail invalide' });
  if (!D.newsletter.includes(email)) { D.newsletter.push(email); save(); }
  res.json({ ok: 1 });
});
app.post('/api/newsletter/desinscription', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  D.newsletter = D.newsletter.filter(e => e !== email); save();
  res.json({ ok: 1 });
});

app.post('/api/dossier', async (req, res) => {
  const b = req.body, s = String;
  const d = { id: crypto.randomUUID(), trackCode: genCode(), created: new Date().toISOString(), service: s(b.service).slice(0, 20), date: s(b.date), lastName: s(b.lastName).slice(0, 60),
    budgetMin: +b.budgetMin, budgetMax: +b.budgetMax, email: s(b.email).slice(0, 120), phone: s(b.phone).slice(0, 30), address: s(b.address).slice(0, 200) };
  if (!['DJ', 'Artificier', 'Lighter'].includes(d.service) || svc()[d.service] === false || !/^\d{4}-\d{2}-\d{2}$/.test(d.date) || !d.lastName || !d.email || !d.phone || !d.address || !(d.budgetMax >= d.budgetMin))
    return res.status(400).json({ error: 'Formulaire incomplet ou invalide' });
  const busy = D.calendar[d.date];
  d.status = busy ? 'refused' : 'pending';
  D.dossiers.unshift(d); save();
  const resume = `${d.service} le ${fd(d.date)} — ${d.lastName}\nBudget : ${d.budgetMin}–${d.budgetMax} €\nLieu : ${d.address}\nTel : ${d.phone} / ${d.email}\nVotre code de suivi : ${d.trackCode}`;
  const budget = eur(d.budgetMin) + ' – ' + eur(d.budgetMax);
  const summary = card(rows([['Prestation', d.service], ['Date', fd(d.date)], ['Lieu', d.address], ['Budget', budget]]));
  const full = card(rows([['Prestation', d.service], ['Date', fd(d.date)], ['Nom', d.lastName], ['Budget', budget], ['Lieu', d.address], ['Téléphone', d.phone], ['E-mail', d.email]]));
  const codeBox = card(rows([['Code de suivi', d.trackCode]]));
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
  if (req.body.notifier && D.newsletter.length) {
    const site = process.env.SITE_URL || '';
    const html = tpl('Mise à jour de nos conditions', p('Nos conditions générales et/ou nos mentions légales viennent d’être mises à jour.') + p('Nous vous invitons à en prendre connaissance sur notre site.'), { st: 'admin', sub: 'Merci de votre confiance.', cta: site ? 'Consulter le site' : undefined, ctaUrl: site || undefined });
    const text = 'Nos conditions générales et/ou nos mentions légales viennent d’être mises à jour. Consultez-les sur notre site.' + (site ? '\n' + site : '');
    for (const email of D.newsletter) { mail(email, 'Mise à jour de nos conditions', text, html).catch(() => {}); }
  }
  res.json({ ok: 1, notifies: req.body.notifier ? D.newsletter.length : 0 });
});

app.post('/api/admin/decision/:id', adm, async (req, res) => {
  const d = D.dossiers.find(x => x.id === req.params.id); if (!d) return res.status(404).json({ error: 'Introuvable' });
  d.status = req.body.accept ? 'accepted' : 'refused'; save();
  const ok = d.status === 'accepted', dt = fd(d.date), site = process.env.SITE_URL || '';
  const sm = card(rows([['Prestation', d.service], ['Date', dt], ['Lieu', d.address]]));
  both(d.email, d.phone, ok ? 'Dossier accepté' : 'Date non disponible',
    ok ? `Bonjour ${d.lastName}, bonne nouvelle : nous sommes disponibles le ${dt} et votre dossier est accepté ! Code de suivi : ${d.trackCode}` : `Bonjour ${d.lastName}, nous ne sommes malheureusement pas disponibles le ${dt}.`,
    tpl(ok ? 'Dossier accepté' : 'Date non disponible', p(`Bonjour ${E(d.lastName)},`) + (ok ? p(`Bonne nouvelle : nous sommes <b>disponibles le ${E(dt)}</b> et votre dossier <b>${E(d.service)}</b> est accepté. Vous pouvez désormais régler en ligne depuis l’espace suivi avec votre code <b>${E(d.trackCode)}</b>.`) : p(`Merci pour votre demande. Nous ne sommes malheureusement <b>pas disponibles le ${E(dt)}</b>. N’hésitez pas à nous proposer une autre date.`)) + sm,
      { st: ok ? 'accepted' : 'refused', sub: ok ? 'En attente du paiement et de la prestation.' : 'Nous ne pouvons pas assurer cette date.', cta: ok ? 'Payer mon dossier' : 'Proposer une autre date', ctaUrl: ok && site ? site + '/#suivi' : undefined }));
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
  save(); const lignes = lines.map(l => `<tr><td style="padding:11px 0;border-bottom:1px dashed #3a3a42;color:#e6e6ea">${E(l.label)}</td><td align="right" style="padding:11px 0;border-bottom:1px dashed #3a3a42;color:#ffffff;font-weight:bold">${eur(l.amount)}</td></tr>`).join('');
  const ticketHtml = card(rows([['Reçu n°', no], ['Date', new Date().toLocaleDateString('fr-FR')], ['Client', d.lastName], ['Prestation', d.service + ' — ' + fd(d.date)]])) + card(`<table width="100%" cellpadding="0" cellspacing="0" style="margin:6px 0">${lignes}<tr><td style="padding:16px 0 10px;font-weight:bold;font-size:18px;color:#ffffff">TOTAL PAYÉ</td><td align="right" style="padding:16px 0 10px;font-weight:bold;font-size:22px;color:#4ee09a">${eur(total)}</td></tr></table>`);
  both(d.email, d.phone, 'Votre reçu ' + no, ticket, tpl('Paiement reçu', p(`Bonjour ${E(d.lastName)}, merci pour votre confiance ! Voici le reçu de votre paiement.`) + ticketHtml + p('<span style="color:#a9a9b3;font-size:13px">Ce message fait office de reçu de paiement. Conservez-le.</span>'), { st: 'paid', sub: 'Reçu n° ' + no })); res.json({ ok: 1 });
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

app.post('/api/admin/test-mail', adm, async (_, res) => {
  const to = process.env.ADMIN_EMAIL; if (!to) return res.json({ error: 'ADMIN_EMAIL manquant dans Render' });
  res.json({ to, error: await mail(to, 'Test du site', 'Si tu lis ce message, les mails fonctionnent ✅', tpl('Test réussi ✅', p('Si tu lis ce message, les mails de ton site fonctionnent.'), { st: 'ok' })) });
});

(async () => {
  if (UP) { try { const r = await up(['GET', 'djdata']); if (r.result) D = { ...D, ...JSON.parse(r.result) }; console.log('Données chargées depuis Upstash'); } catch (e) { console.error('ERREUR UPSTASH', e.message); } ready = true; }
  console.log('Routes prêtes — fichier complet');
})();
