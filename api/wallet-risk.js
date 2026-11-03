// Serverless (Vercel) — calcule un score d'activité/risque pour une adresse Ethereum via l'API Etherscan.
// Heuristiques statistiques uniquement (pas de modèle entraîné). Nécessite ETHERSCAN_API_KEY dans le projet Vercel.
const { allowed, rateLimit } = require('../lib/security.js');

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;

// Adresses publiquement documentées comme mixers/scam par des sources type OFAC/Chainalysis (liste statique, non exhaustive).
const FLAGGED = new Set([
  '0x8589427373d6d84e98730d7795d8f6f8731fda0', // Tornado Cash: Proxy
  '0x722122df12d4e14e13ac3b6895a86e84145b6e2', // Tornado Cash: Router
  '0xdd4c48c0b24039969fc16d1cdf626eab821d3384', // Tornado Cash: 100 ETH pool
]);

async function etherscan(params, key) {
  const url = new URL('https://api.etherscan.io/api');
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  url.searchParams.set('apikey', key);
  const r = await fetch(url.toString());
  return r.json();
}

function score(txs, tokenTxs, address) {
  const addr = address.toLowerCase();
  const signals = [];
  let points = 50;

  if (!txs.length) {
    return { score: 0, label: 'No history found', signals: ['No transactions were found for this address.'] };
  }

  const timestamps = txs.map((t) => Number(t.timeStamp)).sort((a, b) => a - b);
  const ageDays = Math.max(0, (Date.now() / 1000 - timestamps[0]) / 86400);
  if (ageDays > 365) { points += 20; signals.push(`Wallet active for over a year (${Math.round(ageDays)} days).`); }
  else if (ageDays > 30) { points += 10; signals.push(`Wallet active for ${Math.round(ageDays)} days.`); }
  else { points -= 10; signals.push(`Recently created wallet (${Math.round(ageDays)} days) — limited history.`); }

  const txCount = txs.length;
  if (txCount > 200) { points += 15; signals.push(`Sustained activity: ${txCount} transactions.`); }
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

export default async function handler(req, res) {
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
    const [txData, tokenData] = await Promise.all([
      etherscan({ module: 'account', action: 'txlist', address, startblock: 0, endblock: 99999999, sort: 'asc' }, KEY),
      etherscan({ module: 'account', action: 'tokentx', address, startblock: 0, endblock: 99999999, sort: 'asc' }, KEY),
    ]);

    const txs = Array.isArray(txData.result) ? txData.result : [];
    const tokenTxs = Array.isArray(tokenData.result) ? tokenData.result : [];

    if (txData.status === '0' && txData.message !== 'No transactions found') {
      return res.status(502).json({ error: 'upstream', detail: txData.message || 'Etherscan error' });
    }

    const result = score(txs, tokenTxs, address);
    return res.status(200).json({ address, txCount: txs.length, ...result });
  } catch (e) {
    return res.status(500).json({ error: 'server' });
  }
}
