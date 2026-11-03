// Plafonne les dépenses Claude de l'AI Wallet Agent à 1 €/mois via un compteur Upstash Redis
// (API REST, pas de dépendance npm). Échec fermé : si Upstash n'est pas configuré ou
// injoignable, l'agent est bloqué plutôt que de tourner sans limite.
const MONTHLY_CAP_CENTS = 100; // 1 €

function monthKey() {
  const d = new Date();
  return `wallet-agent-budget:${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

let lastUpstashDebug = null;
async function upstash(path) {
  // Noms imposés par l'intégration Vercel/Upstash avec le préfixe "UPSTASH_REDIS_REST" :
  // le suffixe généré est KV_REST_API_URL/TOKEN, pas REST_URL/TOKEN.
  const url = process.env.UPSTASH_REDIS_REST_KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN;
  if (!url || !token) { lastUpstashDebug = { step: 'no_env' }; return null; }
  const fullUrl = `${url.replace(/\/$/, '')}/${path}`;
  try {
    const r = await fetch(fullUrl, { headers: { Authorization: `Bearer ${token}` } });
    const text = await r.text();
    if (!r.ok) { lastUpstashDebug = { step: 'bad_status', status: r.status, body: text.slice(0, 300), urlHost: new URL(url).host }; return null; }
    const data = JSON.parse(text);
    lastUpstashDebug = { step: 'ok', body: text.slice(0, 200) };
    return data.result;
  } catch (e) {
    lastUpstashDebug = { step: 'exception', message: e.message };
    return null;
  }
}

// null = Upstash indisponible/non configuré (appelant doit refuser par prudence).
async function remainingBudgetCents() {
  const key = monthKey();
  const spent = await upstash(`get/${encodeURIComponent(key)}`);
  if (spent === null) return null;
  return MONTHLY_CAP_CENTS - Number(spent || 0);
}

// Diagnostic temporaire (aucune valeur exposée, juste présence/absence des variables).
async function debugEnvPresence() {
  await remainingBudgetCents();
  return {
    url_present: !!process.env.UPSTASH_REDIS_REST_KV_REST_API_URL,
    token_present: !!process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN,
    last_call: lastUpstashDebug,
  };
}

async function recordSpendCents(cents) {
  const key = monthKey();
  await upstash(`incrbyfloat/${encodeURIComponent(key)}/${encodeURIComponent(String(cents))}`);
  // Expire après ~35 jours : purge automatique, pas de clés qui s'accumulent indéfiniment.
  await upstash(`expire/${encodeURIComponent(key)}/${35 * 24 * 60 * 60}`);
}

module.exports = { remainingBudgetCents, recordSpendCents, MONTHLY_CAP_CENTS, debugEnvPresence };
