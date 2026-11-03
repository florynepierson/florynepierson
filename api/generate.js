// Serverless (Vercel) — génère une annonce immobilière via Claude Haiku (FR ou EN).
// Coût ~fraction de centime par appel. Nécessite ANTHROPIC_API_KEY dans le projet Vercel.
const { allowed, rateLimit } = require('../lib/security.js');

// --- Wallet Risk Scanner (voir wallet-risk-scanner/index.html) -----------------------------
// Routé via ?tool=wallet-risk sur ce même endpoint plutôt qu'un fichier api/ séparé : le plan
// Vercel Hobby plafonne à 12 fonctions serverless par déploiement, déjà atteint sans celle-ci.
const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

// Adresses publiquement documentées comme mixers/scam par des sources type OFAC/Chainalysis (liste statique, non exhaustive).
const FLAGGED = new Set([
  '0x8589427373d6d84e98730d7795d8f6f8731fda0', // Tornado Cash: Proxy
  '0x722122df12d4e14e13ac3b6895a86e84145b6e2', // Tornado Cash: Router
  '0xdd4c48c0b24039969fc16d1cdf626eab821d3384', // Tornado Cash: 100 ETH pool
]);

async function etherscan(params, key) {
  const url = new URL('https://api.etherscan.io/v2/api');
  url.searchParams.set('chainid', '1'); // Ethereum mainnet
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  url.searchParams.set('apikey', key);
  const r = await fetch(url.toString());
  return r.json();
}

function walletScore(txs, tokenTxs, firstTimestamp) {
  const signals = [];
  let points = 50;

  if (!txs.length) {
    return { score: 0, label: 'No history found', signals: ['No transactions were found for this address.'] };
  }

  const timestamps = txs.map((t) => Number(t.timeStamp)).sort((a, b) => a - b);
  const ageDays = Math.max(0, (Date.now() / 1000 - (firstTimestamp || timestamps[0])) / 86400);
  if (ageDays > 365) { points += 20; signals.push(`Wallet active for over a year (${Math.round(ageDays)} days).`); }
  else if (ageDays > 30) { points += 10; signals.push(`Wallet active for ${Math.round(ageDays)} days.`); }
  else { points -= 10; signals.push(`Recently created wallet (${Math.round(ageDays)} days) — limited history.`); }

  const txCount = txs.length;
  if (txCount >= 1000) { points += 15; signals.push(`High recent volume: ${txCount}+ transactions in the most recent window.`); }
  else if (txCount > 200) { points += 15; signals.push(`Sustained activity: ${txCount} transactions.`); }
  else if (txCount > 20) { points += 8; signals.push(`${txCount} transactions on record.`); }
  else { signals.push(`Low volume: ${txCount} transactions.`); }

  if (timestamps.length > 3) {
    const intervals = [];
    for (let i = 1; i < timestamps.length; i++) intervals.push(timestamps[i] - timestamps[i - 1]);
    const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const variance = intervals.reduce((a, b) => a + (b - mean) ** 2, 0) / intervals.length;
    const stdDev = Math.sqrt(variance);
    const cv = mean > 0 ? stdDev / mean : 0;
    if (cv < 0.15 && intervals.length > 10) { points -= 10; signals.push('Unusually regular intervals between transactions (possible bot pattern).'); }
  }

  const tokenContracts = new Set(tokenTxs.map((t) => (t.contractAddress || '').toLowerCase()).filter(Boolean));
  if (tokenContracts.size > 10) { points += 15; signals.push(`High token diversity (${tokenContracts.size} distinct contracts).`); }
  else if (tokenContracts.size > 2) { points += 7; signals.push(`${tokenContracts.size} different tokens traded.`); }

  const touchedFlagged = txs.some((t) => FLAGGED.has((t.to || '').toLowerCase()) || FLAGGED.has((t.from || '').toLowerCase()));
  if (touchedFlagged) { points -= 30; signals.push('Interaction detected with a known flagged address (mixer/sanctioned service).'); }

  points = Math.max(0, Math.min(100, points));
  let label = 'Neutral activity';
  if (touchedFlagged) label = 'Suspicious activity';
  else if (points >= 75) label = 'Established wallet';
  else if (points <= 30) label = 'Low activity / limited history';

  return { score: Math.round(points), label, signals };
}

// Buckets tx counts by month (YYYY-MM) and caps the series to the most recent 24 buckets,
// reporting how many earlier months were dropped instead of silently truncating.
function monthlyActivity(txs) {
  const counts = new Map();
  for (const t of txs) {
    const d = new Date(Number(t.timeStamp) * 1000);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const months = [...counts.keys()].sort();
  const MAX = 24;
  const dropped = Math.max(0, months.length - MAX);
  const kept = months.slice(-MAX);
  return { buckets: kept.map((m) => ({ month: m, count: counts.get(m) })), droppedMonths: dropped };
}

async function walletRisk(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!allowed(req)) return res.status(403).json({ error: 'forbidden' });
  const quota = rateLimit(req, 'wallet-risk', 10, 10 * 60 * 1000);
  if (!quota.allowed) {
    res.setHeader('Retry-After', String(quota.retryAfter));
    return res.status(429).json({ error: 'rate_limit' });
  }

  const KEY = process.env.ETHERSCAN_API_KEY;
  if (!KEY) return res.status(500).json({ error: 'no_key' });

  const address = String(req.query.address || '').trim();
  if (!ADDRESS_RE.test(address)) return res.status(400).json({ error: 'invalid_address' });

  try {
    // Etherscan caps a single txlist/tokentx call at ~1000 records. For wallets with more
    // activity than that, "sort=asc" alone would only ever return the EARLIEST slice —
    // skewing every downstream signal (volume, diversity, the chart) toward old history.
    // So: one cheap call (offset=1) for the true first transaction (wallet age), and the
    // main call sorted "desc" (most recent 1000) for everything about current activity.
    // Sequential, not Promise.all: the free-tier key intermittently rejects bursts of
    // concurrent requests with a misleading "Invalid API Key" instead of a rate-limit error.
    const firstTxData = await etherscan({ module: 'account', action: 'txlist', address, startblock: 0, endblock: 99999999, sort: 'asc', page: 1, offset: 1 }, KEY);
    const txData = await etherscan({ module: 'account', action: 'txlist', address, startblock: 0, endblock: 99999999, sort: 'desc', page: 1, offset: 1000 }, KEY);
    const tokenData = await etherscan({ module: 'account', action: 'tokentx', address, startblock: 0, endblock: 99999999, sort: 'desc', page: 1, offset: 1000 }, KEY);

    const firstTx = Array.isArray(firstTxData.result) ? firstTxData.result : [];
    const txs = Array.isArray(txData.result) ? txData.result : [];
    const tokenTxs = Array.isArray(tokenData.result) ? tokenData.result : [];

    if (txData.status === '0' && txData.message !== 'No transactions found') {
      return res.status(502).json({ error: 'upstream', detail: txData.result || txData.message || 'Etherscan error' });
    }

    const result = walletScore(txs, tokenTxs, firstTx[0] ? Number(firstTx[0].timeStamp) : null);
    const activity = monthlyActivity(txs);
    return res.status(200).json({ address, txCount: txs.length, ...result, ...activity });
  } catch (e) {
    return res.status(500).json({ error: 'server' });
  }
}
// --- fin Wallet Risk Scanner -----------------------------------------------------------------

export default async function handler(req, res) {
  if (req.query && req.query.tool === 'wallet-risk') return walletRisk(req, res);
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (!allowed(req)) return res.status(403).json({ error: 'forbidden' });
  const quota = rateLimit(req, 'generate', 8, 10 * 60 * 1000);
  if (!quota.allowed) {
    res.setHeader('Retry-After', String(quota.retryAfter));
    return res.status(429).json({ error: 'rate_limit' });
  }
  const declaredSize = Number(req.headers['content-length'] || 0);
  if (declaredSize > 12_000) return res.status(413).json({ error: 'payload_too_large' });
  const KEY = process.env.ANTHROPIC_API_KEY;
  if (!KEY) return res.status(500).json({ error: 'no_key' });

  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (_) { b = {}; } }
  if (b && typeof b === 'object' && Buffer.byteLength(JSON.stringify(b), 'utf8') > 12_000) {
    return res.status(413).json({ error: 'payload_too_large' });
  }
  b = b || {};

  const lang = (b.lang === 'en') ? 'en' : 'fr';
  const clip = (v, n) => (v == null ? '' : v.toString().slice(0, n));
  const type = clip(b.type || 'Bien', 40);
  const deal = clip(b.deal || 'Vente', 20);
  const surface = clip(b.surface, 20);
  const rooms = clip(b.rooms, 10);
  const beds = clip(b.beds, 10);
  const place = clip(b.place, 80);
  const price = clip(b.price, 30);
  const atouts = Array.isArray(b.atouts) ? b.atouts.slice(0, 15).map((v) => String(v).slice(0, 160)).join(', ') : '';
  const notes = clip(b.notes, 600);
  const length = b.length === 'court' ? 'court' : (b.length === 'long' ? 'long' : 'moyen');

  const L = lang === 'en' ? {
    words: length === 'court' ? '60-90' : (length === 'long' ? '200-260' : '130-170'),
    f: { type: 'Type', deal: 'Transaction', surface: 'Area', rooms: 'Rooms', beds: 'Bedrooms', place: 'Area/neighbourhood', price: 'Price', atouts: 'Key features', notes: "Agent's notes" },
    tones: ['Warm', 'Factual', 'Premium'],
    tonesDesc: 'Warm (inviting, the reader pictures living there), Factual (clear, efficient, feature-led), Premium (elegant, upscale, aspirational)',
    intro: 'You are an expert copywriter for English real-estate listings. From the details below, write an attractive, fluent and honest listing (never invent facts that are not provided).',
    section1: 'A "accroche": a short, catchy headline (max 70 characters).',
    section2: 'Three descriptions of the same property, each about',
    section3: 'words, in three different tones:',
    langLine: 'Write everything in ENGLISH.'
  } : {
    words: length === 'court' ? '70-100' : (length === 'long' ? '220-280' : '140-180'),
    f: { type: 'Type', deal: 'Transaction', surface: 'Surface', rooms: 'Pièces', beds: 'Chambres', place: 'Secteur', price: 'Prix', atouts: 'Points forts', notes: "Notes de l'agent" },
    tones: ['Chaleureux', 'Factuel', 'Premium'],
    tonesDesc: 'Chaleureux (convivial, on se projette), Factuel (clair, efficace, orienté caractéristiques), Premium (élégant, valorisant, haut de gamme)',
    intro: 'Tu es un rédacteur expert en annonces immobilières françaises (style SeLoger / Leboncoin). À partir des informations ci-dessous, rédige une annonce attractive, fluide et honnête (n\'invente aucun fait non fourni).',
    section1: 'Une "accroche" : un titre court et vendeur (max 70 caractères).',
    section2: 'Trois descriptions du même bien, chacune d\'environ',
    section3: 'mots, dans trois tons différents :',
    langLine: 'Rédige TOUT en FRANÇAIS.'
  };

  const facts = [
    `${L.f.type} : ${type}`,
    `${L.f.deal} : ${deal}`,
    surface && `${L.f.surface} : ${surface} m²`,
    rooms && `${L.f.rooms} : ${rooms}`,
    beds && `${L.f.beds} : ${beds}`,
    place && `${L.f.place} : ${place}`,
    price && `${L.f.price} : ${price}`,
    atouts && `${L.f.atouts} : ${atouts}`,
    notes && `${L.f.notes} : ${notes}`
  ].filter(Boolean).join('\n');

  const prompt = `${L.intro}

${facts}

1. ${L.section1}
2. ${L.section2} ${L.words} ${L.section3} ${L.tonesDesc}.

${L.langLine}

Réponds UNIQUEMENT avec un objet JSON valide, sans markdown ni backticks / Reply ONLY with a valid JSON object, no markdown, no backticks:
{
  "accroche": "...",
  "variants": [
    {"tone": "${L.tones[0]}", "text": "..."},
    {"tone": "${L.tones[1]}", "text": "..."},
    {"tone": "${L.tones[2]}", "text": "..."}
  ]
}`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1500, messages: [{ role: 'user', content: prompt }] })
    });
    const data = await r.json();
    if (!r.ok) return res.status(502).json({ error: 'api', detail: (data && data.error && data.error.message) || 'upstream' });
    let txt = (data.content && data.content[0] && data.content[0].text) || '';
    txt = txt.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    let out;
    try { out = JSON.parse(txt); } catch (_) { const m = txt.match(/\{[\s\S]*\}/); out = m ? JSON.parse(m[0]) : null; }
    if (!out || !out.variants) return res.status(502).json({ error: 'parse' });
    return res.status(200).json(out);
  } catch (e) {
    return res.status(500).json({ error: 'server' });
  }
}
