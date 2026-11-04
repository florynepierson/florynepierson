// Serverless (Vercel) — génère une annonce immobilière via Claude Haiku (FR ou EN).
// Coût ~fraction de centime par appel. Nécessite ANTHROPIC_API_KEY dans le projet Vercel.
const { allowed, rateLimit } = require('../lib/security.js');
const { remainingBudgetCents, recordSpendCents } = require('../lib/budget.js');

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

// --- AI Wallet Agent (voir wallet-risk-scanner/index.html, bouton "AI Explain") -------------
// Agent Claude Haiku avec tool use : prend le score déjà calculé par walletScore() comme point
// de départ, et peut creuser via deux outils (code source d'un contrat, transactions récentes)
// avant de rendre une explication en langage naturel. Plafonné à 1 €/mois (voir lib/budget.js) :
// échec fermé si le plafond est atteint ou si Upstash est indisponible/non configuré.
const WALLET_AGENT_MODEL = 'claude-haiku-4-5-20251001';
const WALLET_AGENT_MAX_STEPS = 3;

// Tarifs Haiku 4.5 : 1 $/MTok en entrée, 5 $/MTok en sortie.
function haikuCostCents(usage) {
  const input = Number(usage && usage.input_tokens) || 0;
  const output = Number(usage && usage.output_tokens) || 0;
  return input * 0.0001 + output * 0.0005;
}

const WALLET_AGENT_TOOLS = [
  {
    name: 'get_contract_source',
    description: 'Fetch the verified source code and metadata of a smart contract address, if available. Use when the target address might be a contract (not a plain wallet) or when a counterparty in a transaction looks like a contract worth inspecting.',
    input_schema: { type: 'object', properties: { address: { type: 'string', description: 'Ethereum address (0x...)' } }, required: ['address'] },
  },
  {
    name: 'get_recent_transactions',
    description: 'Fetch up to 25 of the most recent transactions for an address (counterparties, values, timestamps, success/failure). Use to investigate a specific activity pattern beyond the summary already provided.',
    input_schema: { type: 'object', properties: { address: { type: 'string', description: 'Ethereum address (0x...)' } }, required: ['address'] },
  },
];

async function runWalletAgentTool(name, input, KEY) {
  const address = String((input && input.address) || '').trim();
  if (!ADDRESS_RE.test(address)) return { error: 'invalid_address' };
  if (name === 'get_contract_source') {
    const data = await etherscan({ module: 'contract', action: 'getsourcecode', address }, KEY);
    const r = Array.isArray(data.result) ? data.result[0] : null;
    if (!r || !r.SourceCode) return { is_contract: false };
    return {
      is_contract: true,
      contract_name: r.ContractName || null,
      is_proxy: r.Proxy === '1',
      implementation_address: r.Implementation || null,
      // Tronqué pour rester raisonnable en tokens côté modèle.
      source_excerpt: String(r.SourceCode).slice(0, 4000),
    };
  }
  if (name === 'get_recent_transactions') {
    const data = await etherscan({ module: 'account', action: 'txlist', address, startblock: 0, endblock: 99999999, sort: 'desc', page: 1, offset: 25 }, KEY);
    const txs = Array.isArray(data.result) ? data.result : [];
    return {
      transactions: txs.map((t) => ({
        to: t.to, from: t.from, valueEth: Number(t.value) / 1e18,
        timeStamp: t.timeStamp, failed: t.isError === '1',
      })),
    };
  }
  return { error: 'unknown_tool' };
}

async function walletAgent(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!allowed(req)) return res.status(403).json({ error: 'forbidden' });
  const quota = rateLimit(req, 'wallet-agent', 5, 10 * 60 * 1000);
  if (!quota.allowed) {
    res.setHeader('Retry-After', String(quota.retryAfter));
    return res.status(429).json({ error: 'rate_limit' });
  }

  const ETHERSCAN_KEY = process.env.ETHERSCAN_API_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ETHERSCAN_KEY || !ANTHROPIC_KEY) return res.status(500).json({ error: 'no_key' });

  const address = String(req.query.address || '').trim();
  if (!ADDRESS_RE.test(address)) return res.status(400).json({ error: 'invalid_address' });

  const remaining = await remainingBudgetCents();
  if (remaining === null || remaining <= 0) {
    return res.status(503).json({ error: remaining === null ? 'budget_unavailable' : 'monthly_budget_reached' });
  }

  try {
    const firstTxData = await etherscan({ module: 'account', action: 'txlist', address, startblock: 0, endblock: 99999999, sort: 'asc', page: 1, offset: 1 }, ETHERSCAN_KEY);
    const txData = await etherscan({ module: 'account', action: 'txlist', address, startblock: 0, endblock: 99999999, sort: 'desc', page: 1, offset: 1000 }, ETHERSCAN_KEY);
    const tokenData = await etherscan({ module: 'account', action: 'tokentx', address, startblock: 0, endblock: 99999999, sort: 'desc', page: 1, offset: 1000 }, ETHERSCAN_KEY);
    const firstTx = Array.isArray(firstTxData.result) ? firstTxData.result : [];
    const txs = Array.isArray(txData.result) ? txData.result : [];
    const tokenTxs = Array.isArray(tokenData.result) ? tokenData.result : [];
    const score = walletScore(txs, tokenTxs, firstTx[0] ? Number(firstTx[0].timeStamp) : null);

    const systemPrompt = 'You are a blockchain analyst explaining wallet risk to a non-technical reader. You are given a pre-computed statistical risk summary and two tools to investigate further: get_contract_source and get_recent_transactions. Only call a tool if it would materially change your answer — most of the time the summary is enough. Never fabricate on-chain data you have not retrieved. Respond with a short explanation (3-5 sentences, plain English, no jargon) followed by a one-line verdict.';
    const userMsg = `Address: ${address}\nPre-computed score: ${score.score}/100 (${score.label})\nSignals:\n- ${score.signals.join('\n- ')}\nTotal recent transactions analyzed: ${txs.length}`;

    let messages = [{ role: 'user', content: userMsg }];
    let spentCents = 0;
    let finalText = '';

    for (let i = 0; i < WALLET_AGENT_MAX_STEPS; i++) {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: WALLET_AGENT_MODEL, max_tokens: 500, system: systemPrompt, tools: WALLET_AGENT_TOOLS, messages }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error((data && data.error && data.error.message) || 'anthropic_api_error');
      spentCents += haikuCostCents(data.usage);
      messages.push({ role: 'assistant', content: data.content });

      if (data.stop_reason !== 'tool_use') {
        finalText = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
        break;
      }

      const toolUses = (data.content || []).filter((b) => b.type === 'tool_use');
      const toolResults = [];
      for (const tu of toolUses) {
        const result = await runWalletAgentTool(tu.name, tu.input, ETHERSCAN_KEY);
        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) });
      }
      messages.push({ role: 'user', content: toolResults });
    }

    await recordSpendCents(spentCents);

    if (!finalText) finalText = 'Analysis stopped before a conclusion was reached (step limit).';
    return res.status(200).json({ address, score, explanation: finalText });
  } catch (e) {
    return res.status(500).json({ error: 'server' });
  }
}
// --- fin AI Wallet Agent -----------------------------------------------------------------

// --- Gas Tracker (voir gas-tracker/index.html) ------------------------------------------------
// Même routage que Wallet Risk Scanner : ?tool=gas-tracker sur cet endpoint, pas de fichier
// api/ dédié (plafond de 12 fonctions serverless du plan Vercel Hobby).
async function gasTracker(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!allowed(req)) return res.status(403).json({ error: 'forbidden' });
  // Limite plus large que wallet-risk : la page sonde ce endpoint en direct toutes les
  // ~20s tant que l'onglet reste ouvert, pour tracer une tendance live.
  const quota = rateLimit(req, 'gas-tracker', 40, 10 * 60 * 1000);
  if (!quota.allowed) {
    res.setHeader('Retry-After', String(quota.retryAfter));
    return res.status(429).json({ error: 'rate_limit' });
  }

  const KEY = process.env.ETHERSCAN_API_KEY;
  if (!KEY) return res.status(500).json({ error: 'no_key' });

  try {
    // Séquentiel (pas Promise.all) : même précaution que wallet-risk face aux pics
    // de requêtes simultanées sur la clé gratuite.
    const oracle = await etherscan({ module: 'gastracker', action: 'gasoracle' }, KEY);
    const ethPriceData = await etherscan({ module: 'stats', action: 'ethprice' }, KEY);
    if (oracle.status === '0') return res.status(502).json({ error: 'upstream', detail: oracle.result || oracle.message });

    const safe = Number(oracle.result.SafeGasPrice);
    const propose = Number(oracle.result.ProposeGasPrice);
    const fast = Number(oracle.result.FastGasPrice);
    const ethUsd = ethPriceData && ethPriceData.result ? Number(ethPriceData.result.ethusd) : null;

    // Coût estimé d'un simple transfert ETH (21000 gas), en $.
    const costUsd = (gwei) => (ethUsd ? (gwei * 21000 * 1e-9 * ethUsd) : null);

    let verdict = 'Moderate';
    if (propose <= 10) verdict = 'Cheap — good time to transact';
    else if (propose <= 30) verdict = 'Moderate — normal range';
    else verdict = 'Expensive — consider waiting';

    return res.status(200).json({
      safe, propose, fast,
      safeUsd: costUsd(safe), proposeUsd: costUsd(propose), fastUsd: costUsd(fast),
      ethUsd, verdict, ts: Math.floor(Date.now() / 1000),
    });
  } catch (e) {
    return res.status(500).json({ error: 'server' });
  }
}
// --- fin Gas Tracker -----------------------------------------------------------------------

// --- Invest Watch (voir invest-watch/index.html) ----------------------------------------------
// Même routage que les autres outils : ?tool=invest-watch, pas de fichier api/ dédié (plafond
// de 12 fonctions serverless du plan Vercel Hobby).
// Ne prédit jamais une remontée : signale une baisse hors norme (écart au plus haut 52 sem +
// RSI survendu) et classe le contexte chiffré (croissance résultats, valorisation) en
// POSITIF/NÉGATIF/NEUTRE. Aucune recommandation d'achat/vente.
const TICKER_RE = /^[A-Z.]{1,10}$/;
const DEFAULT_TICKERS = ['GOOGL', 'AAPL', 'NVDA', 'MSFT', 'AMZN', 'META', 'TSLA', 'AMD', 'NFLX', 'AVGO'];
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36';
const DROP_THRESHOLD = 0.15;
const RSI_OVERSOLD = 30;

async function yahooCookieCrumb() {
  const r1 = await fetch('https://fc.yahoo.com', { headers: { 'User-Agent': UA }, redirect: 'manual' });
  const cookie = (r1.headers.get('set-cookie') || '').split(';')[0];
  const r2 = await fetch('https://query2.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': UA, Cookie: cookie } });
  const crumb = await r2.text();
  return { cookie, crumb };
}

function computeRsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  const recent = closes.slice(-(period + 1));
  let gains = 0, losses = 0;
  for (let i = 1; i < recent.length; i++) {
    const delta = recent[i] - recent[i - 1];
    if (delta > 0) gains += delta; else losses += -delta;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

async function analyzeTicker(ticker, cookie, crumb) {
  const chartRes = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?range=1y&interval=1d`, { headers: { 'User-Agent': UA } });
  const chart = await chartRes.json();
  const result = chart && chart.chart && chart.chart.result && chart.chart.result[0];
  if (!result) return { ticker, error: 'no_data' };

  const meta = result.meta;
  const closes = (result.indicators.quote[0].close || []).filter((v) => v != null);
  const currentPrice = meta.regularMarketPrice;
  const high52w = meta.fiftyTwoWeekHigh;
  const dropPct = (high52w - currentPrice) / high52w;
  const rsi = computeRsi(closes);
  const anomaly = dropPct >= DROP_THRESHOLD && rsi !== null && rsi <= RSI_OVERSOLD;

  // Downsample to ~60 points for the sparkline: plenty for a 1-year trend shape, keeps payload small.
  const SPARK_POINTS = 60;
  const step = Math.max(1, Math.floor(closes.length / SPARK_POINTS));
  const spark = closes.filter((_, i) => i % step === 0);

  let revenueGrowth = null, earningsGrowth = null, trailingPE = null, forwardPE = null;
  try {
    const qsRes = await fetch(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${ticker}?modules=financialData,defaultKeyStatistics&crumb=${encodeURIComponent(crumb)}`, { headers: { 'User-Agent': UA, Cookie: cookie } });
    const qs = await qsRes.json();
    const fd = qs && qs.quoteSummary && qs.quoteSummary.result && qs.quoteSummary.result[0];
    if (fd) {
      revenueGrowth = fd.financialData && fd.financialData.revenueGrowth ? fd.financialData.revenueGrowth.raw : null;
      earningsGrowth = fd.financialData && fd.financialData.earningsGrowth ? fd.financialData.earningsGrowth.raw : null;
      trailingPE = fd.defaultKeyStatistics && fd.defaultKeyStatistics.trailingPE ? fd.defaultKeyStatistics.trailingPE.raw : null;
      forwardPE = fd.defaultKeyStatistics && fd.defaultKeyStatistics.forwardPE ? fd.defaultKeyStatistics.forwardPE.raw : null;
    }
  } catch (_) { /* fondamentaux indisponibles : on garde le signal technique seul */ }

  let context = 'NEUTRE';
  let contextDetail = 'données de croissance insuffisantes ou mixtes';
  if (revenueGrowth != null && earningsGrowth != null) {
    if (revenueGrowth > 0 && earningsGrowth > 0) {
      context = 'POSITIF';
      contextDetail = 'croissance revenus/bénéfices toujours positive malgré la baisse de prix';
    } else if (revenueGrowth < 0 || earningsGrowth < 0) {
      context = 'NEGATIF';
      contextDetail = 'revenus ou bénéfices en baisse : la chute du prix suit possiblement les fondamentaux';
    }
  }

  return {
    ticker, currentPrice, high52w, dropPct, rsi, anomaly,
    revenueGrowth, earningsGrowth, trailingPE, forwardPE, context, contextDetail, spark,
  };
}

async function investWatch(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!allowed(req)) return res.status(403).json({ error: 'forbidden' });
  const quota = rateLimit(req, 'invest-watch', 10, 10 * 60 * 1000);
  if (!quota.allowed) {
    res.setHeader('Retry-After', String(quota.retryAfter));
    return res.status(429).json({ error: 'rate_limit' });
  }

  const raw = String(req.query.tickers || '').trim();
  const requested = raw ? raw.split(',').map((t) => t.trim().toUpperCase()).filter(Boolean) : DEFAULT_TICKERS;
  const tickers = requested.filter((t) => TICKER_RE.test(t)).slice(0, 10);
  if (!tickers.length) return res.status(400).json({ error: 'invalid_tickers' });

  try {
    const { cookie, crumb } = await yahooCookieCrumb();
    const results = [];
    for (const t of tickers) {
      results.push(await analyzeTicker(t, cookie, crumb));
    }
    return res.status(200).json({ results, disclaimer: 'Anomaly signal, not a buy or sell recommendation.' });
  } catch (e) {
    return res.status(500).json({ error: 'server' });
  }
}
// --- fin Invest Watch ----------------------------------------------------------------------

export default async function handler(req, res) {
  if (req.query && req.query.tool === 'wallet-risk') return walletRisk(req, res);
  if (req.query && req.query.tool === 'wallet-agent') return walletAgent(req, res);
  if (req.query && req.query.tool === 'gas-tracker') return gasTracker(req, res);
  if (req.query && req.query.tool === 'invest-watch') return investWatch(req, res);
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
