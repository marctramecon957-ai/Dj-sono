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
const mail = async (to, subject, text) => {
  try {
    if (process.env.BREVO_API_KEY) {
      if (!process.env.MAIL_FROM) return 'MAIL_FROM manquant dans Render';
      const r = await fetch('https://api.brevo.com/v3/smtp/email', { method: 'POST', headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sender: { name: process.env.MAIL_NAME || 'Sound & Light', email: process.env.MAIL_FROM }, to: [{ email: to }], subject, textContent: text }) });
      if (!r.ok) throw new Error('Brevo ' + r.status + ' ' + await r.text());
    } else if (mailer) await mailer.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to, subject, text });
    else return 'BREVO_API_KEY manquant dans Render';
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
const both = (m, p, sub, txt) => { Promise.all([m && mail(m, sub, txt), p && sms(p, txt.slice(0, 300))]).catch(() => {}); }; // en arrière-plan : le site ne attend plus

// ---- Auth admin ----
const tokens = new Set();
const adm = (req, res, next) => tokens.has(req.headers['x-token']) ? next() : res.status(401).json({ error: 'Non autorisé' });
app.post('/api/login', (req, res) => {
  if (!process.env.ADMIN_PASSWORD || req.body.password !== process.env.ADMIN_PASSWORD) return res.status(401).json({ error: 'Mot de passe incorrect' });
  const t = crypto.randomBytes(24).toString('hex'); tokens.add(t); res.json({ token: t });
});

// ---- Public ----
app.get('/api/public', (_, res) => res.json({ site: D.site, contacts: D.contacts, calendar: D.calendar, upload: { cloud: process.env.CLOUDINARY_CLOUD || '', preset: process.env.CLOUDINARY_PRESET || '' } }));

app.post('/api/dossier', async (req, res) => {
  const b = req.body, s = String;
  const d = { id: crypto.randomUUID(), created: new Date().toISOString(), service: s(b.service).slice(0, 20), date: s(b.date), lastName: s(b.lastName).slice(0, 60),
    budgetMin: +b.budgetMin, budgetMax: +b.budgetMax, email: s(b.email).slice(0, 120), phone: s(b.phone).slice(0, 30), address: s(b.address).slice(0, 200) };
  if (!['DJ', 'Artificier', 'Lighter'].includes(d.service) || !/^\d{4}-\d{2}-\d{2}$/.test(d.date) || !d.lastName || !d.email || !d.phone || !d.address || !(d.budgetMax >= d.budgetMin))
    return res.status(400).json({ error: 'Formulaire incomplet ou invalide' });
  const busy = D.calendar[d.date];
  d.status = busy ? 'refused' : 'pending';
  D.dossiers.unshift(d); save();
  const resume = `${d.service} le ${d.date} — ${d.lastName}\nBudget : ${d.budgetMin}–${d.budgetMax} €\nLieu : ${d.address}\nTel : ${d.phone} / ${d.email}`;
  await both(process.env.ADMIN_EMAIL, process.env.ADMIN_PHONE, `Nouveau dossier ${d.lastName}`, `Nouveau dossier${busy ? ' (date indisponible)' : ''}\n${resume}`);
  await both(d.email, d.phone, busy ? 'Date non disponible' : 'Dossier bien reçu',
    busy ? `Bonjour ${d.lastName}, nous ne sommes malheureusement pas disponibles le ${d.date}.` : `Bonjour ${d.lastName}, votre dossier est bien reçu. Réponse très prochainement.\n${resume}`);
  res.json({ ok: true, status: d.status });
});

// ---- Admin ----
app.get('/api/admin/all', adm, (_, res) => res.json({ dossiers: D.dossiers, finances: D.finances }));
app.put('/api/admin/site', adm, (req, res) => { D.site = { title: String(req.body.title || 'Sound & Light'), hero: (req.body.hero || []).map(String) }; save(); res.json({ ok: 1 }); });
app.put('/api/admin/contacts', adm, (req, res) => { D.contacts = req.body.map(c => ({ name: String(c.name), role: String(c.role || ''), phone: String(c.phone || ''), email: String(c.email || ''), photo: String(c.photo || '') })); save(); res.json({ ok: 1 }); });
app.put('/api/admin/calendar', adm, (req, res) => { D.calendar = req.body; save(); res.json({ ok: 1 }); });

app.post('/api/admin/decision/:id', adm, async (req, res) => {
  const d = D.dossiers.find(x => x.id === req.params.id); if (!d) return res.status(404).json({ error: 'Introuvable' });
  d.status = req.body.accept ? 'accepted' : 'refused'; save();
  await both(d.email, d.phone, d.status === 'accepted' ? 'Dossier accepté' : 'Date non disponible',
    d.status === 'accepted' ? `Bonjour ${d.lastName}, bonne nouvelle : nous sommes disponibles le ${d.date} et votre dossier est accepté !`
      : `Bonjour ${d.lastName}, nous ne sommes malheureusement pas disponibles le ${d.date}.`);
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
    'Client : ' + d.lastName, 'Prestation : ' + d.service + ' (' + d.date + ')', '', ...lines.map(l => pad(l.label, l.amount.toFixed(2) + ' €')), '-'.repeat(40), pad('TOTAL PAYÉ', total.toFixed(2) + ' €'), '', 'Merci de votre confiance !'].join('\n');
  d.status = 'paid'; D.finances.push({ id: crypto.randomUUID(), type: 'revenue', name: d.lastName, amount: total, date: new Date().toISOString().slice(0, 10), note: 'Reçu ' + no });
  save(); await both(d.email, d.phone, 'Votre reçu ' + no, ticket); res.json({ ok: 1 });
});

app.post('/api/admin/finance', adm, (req, res) => {
  const b = req.body; if (!['revenue', 'expense', 'budget'].includes(b.type) || !(+b.amount >= 0) || !/^\d{4}-\d{2}-\d{2}$/.test(b.date)) return res.status(400).json({ error: 'Invalide' });
  D.finances.push({ id: crypto.randomUUID(), type: b.type, name: String(b.name).slice(0, 80), amount: +b.amount, date: b.date, note: String(b.note || '').slice(0, 120) }); save(); res.json({ ok: 1 });
});
app.delete('/api/admin/finance/:id', adm, (req, res) => { D.finances = D.finances.filter(f => f.id !== req.params.id); save(); res.json({ ok: 1 }); });

app.post('/api/admin/test-mail', adm, async (_, res) => {
  const to = process.env.ADMIN_EMAIL; if (!to) return res.json({ error: 'ADMIN_EMAIL manquant dans Render' });
  res.json({ to, error: await mail(to, 'Test du site', 'Si tu lis ce message, les mails fonctionnent ✅') });
});

(async () => {
  if (UP) { try { const r = await up(['GET', 'djdata']); if (r.result) D = { ...D, ...JSON.parse(r.result) }; console.log('Données chargées depuis Upstash'); } catch (e) { console.error('ERREUR UPSTASH', e.message); } ready = true; }
  console.log('Routes prêtes — fichier complet');
})();
