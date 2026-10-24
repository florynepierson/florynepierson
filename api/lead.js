// Capte un email de prospect (email-gate Plume) et l'ajoute à une liste Brevo.
// Fonctionne même sans clé (renvoie ok) pour ne jamais casser l'UX ; pour STOCKER
// réellement les leads, ajoute BREVO_API_KEY (+ BREVO_PLUME_LIST_ID) dans Vercel.
const crypto = require('crypto');
const zlib = require('zlib');
const { allowed, rateLimit } = require('../lib/security.js');

function secureEqual(actual, expected) {
  const a = crypto.createHash('sha256').update(String(actual)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b) && String(actual) === String(expected);
}

function privatePage(req, res, doc) {
  if (!['prospects', 'journal'].includes(doc)) return res.status(404).end();
  if (!['GET', 'HEAD'].includes(req.method)) return res.status(405).end();

  const quota = rateLimit(req, 'private-page-auth', 10, 15 * 60 * 1000);
  if (!quota.allowed) {
    res.setHeader('Retry-After', String(quota.retryAfter));
    return res.status(429).end('Too many attempts');
  }

  const username = process.env.PROTECTED_PAGES_USER;
  const password = process.env.PROTECTED_PAGES_PASSWORD;
  if (!username || !password) return res.status(503).end('Private pages are not configured');

  const header = String(req.headers.authorization || '');
  let credentials = '';
  const match = header.match(/^Basic ([A-Za-z0-9+/]+={0,2})$/);
  if (match && match[1].length <= 2048) credentials = Buffer.from(match[1], 'base64').toString('utf8');
  const separator = credentials.indexOf(':');
  const suppliedUser = separator >= 0 ? credentials.slice(0, separator) : '';
  const suppliedPassword = separator >= 0 ? credentials.slice(separator + 1) : '';
  if (!secureEqual(suppliedUser, username) || !secureEqual(suppliedPassword, password)) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Pages privées", charset="UTF-8"');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(401).end('Authentication required');
  }

  const encoded = process.env[doc === 'prospects' ? 'PROSPECTS_PAGE_GZIP_B64' : 'JOURNAL_PAGE_GZIP_B64'];
  if (!encoded) return res.status(503).end('Private page content is not configured');
  try {
    const html = zlib.gunzipSync(Buffer.from(encoded, 'base64'));
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('Vary', 'Authorization');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.status(200).send(req.method === 'HEAD' ? '' : html);
  } catch (_) {
    return res.status(500).end('Private page unavailable');
  }
}

export default async function handler(req, res) {
  const params = new URL(req.url, 'https://florynepierson.com').searchParams;
  const doc = (req.query && req.query.doc) || params.get('doc');
  if (doc) return privatePage(req, res, String(doc));
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  if (!allowed(req)) return res.status(403).json({ error: 'forbidden' });
  const quota = rateLimit(req, 'lead', 6, 60 * 60 * 1000);
  if (!quota.allowed) {
    res.setHeader('Retry-After', String(quota.retryAfter));
    return res.status(429).json({ error: 'rate_limit' });
  }
  if (Number(req.headers['content-length'] || 0) > 2_000) return res.status(413).json({ error: 'payload_too_large' });
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (_) { b = {}; } }
  if (b && typeof b === 'object' && Buffer.byteLength(JSON.stringify(b), 'utf8') > 2_000) {
    return res.status(413).json({ error: 'payload_too_large' });
  }
  b = b || {};
  const email = (b.email || '').toString().trim().toLowerCase();
  const lang = (b.lang === 'en') ? 'en' : 'fr';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'email' });

  const KEY = process.env.BREVO_API_KEY;
  const LIST = process.env.BREVO_PLUME_LIST_ID;
  if (!KEY) return res.status(200).json({ ok: true, stored: false }); // gate marche, lead non stocké tant que Brevo n'est pas branché

  try {
    const r = await fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: { 'api-key': KEY, 'content-type': 'application/json', 'accept': 'application/json' },
      body: JSON.stringify({
        email,
        updateEnabled: true,
        listIds: LIST ? [parseInt(LIST, 10)] : undefined,
        attributes: { SOURCE: 'plume', LANGUE: lang }
      })
    });
    // 201 = créé, 204 = mis à jour, 400 = déjà présent → on considère stocké
    return res.status(200).json({ ok: true, stored: r.ok || r.status === 400 });
  } catch (e) {
    return res.status(200).json({ ok: true, stored: false });
  }
}
