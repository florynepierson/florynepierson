// Plafonne les dépenses Claude de l'AI Wallet Agent à 1 €/mois via un compteur Upstash Redis
// (API REST, pas de dépendance npm). Échec fermé : si Upstash n'est pas configuré ou
// injoignable, l'agent est bloqué plutôt que de tourner sans limite.
const MONTHLY_CAP_CENTS = 100; // 1 €

function monthKey() {
  const d = new Date();
  return `wallet-agent-budget:${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function upstash(path) {
  // Noms imposés par l'intégration Vercel/Upstash avec le préfixe "UPSTASH_REDIS_REST" :
  // le suffixe généré est KV_REST_API_URL/TOKEN, pas REST_URL/TOKEN.
  const url = process.env.UPSTASH_REDIS_REST_KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN;
  if (!url || !token) return null;
  const r = await fetch(`${url}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  const data = await r.json();
  return data.result;
}

// null = Upstash indisponible/non configuré (appelant doit refuser par prudence).
async function remainingBudgetCents() {
  const key = monthKey();
  const spent = await upstash(`get/${encodeURIComponent(key)}`);
  if (spent === null) return null;
  return MONTHLY_CAP_CENTS - Number(spent || 0);
}

// Diagnostic temporaire (aucune valeur exposée, juste présence/absence des variables).
function debugEnvPresence() {
  return {
    url_present: !!process.env.UPSTASH_REDIS_REST_KV_REST_API_URL,
    token_present: !!process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN,
    upstash_keys: Object.keys(process.env).filter((k) => k.includes('UPSTASH')),
  };
}

async function recordSpendCents(cents) {
  const key = monthKey();
  await upstash(`incrbyfloat/${encodeURIComponent(key)}/${encodeURIComponent(String(cents))}`);
  // Expire après ~35 jours : purge automatique, pas de clés qui s'accumulent indéfiniment.
  await upstash(`expire/${encodeURIComponent(key)}/${35 * 24 * 60 * 60}`);
}

module.exports = { remainingBudgetCents, recordSpendCents, MONTHLY_CAP_CENTS, debugEnvPresence };
