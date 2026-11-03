// Plafonne les dépenses Claude de l'AI Wallet Agent à 1 €/mois via un compteur Upstash Redis
// (API REST, pas de dépendance npm). Échec fermé : si Upstash n'est pas configuré ou
// injoignable, l'agent est bloqué plutôt que de tourner sans limite.
const MONTHLY_CAP_CENTS = 100; // 1 €

function monthKey() {
  const d = new Date();
  return `wallet-agent-budget:${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Renvoie { ok: true, result } en cas de succès (y compris quand la clé n'existe pas encore,
// où Upstash répond result: null — c'est un succès, pas un échec), ou { ok: false } si Upstash
// est injoignable/non configuré. Ne JAMAIS confondre "pas encore de dépense" avec "indisponible".
async function upstash(path) {
  // Noms imposés par l'intégration Vercel/Upstash avec le préfixe "UPSTASH_REDIS_REST" :
  // le suffixe généré est KV_REST_API_URL/TOKEN, pas REST_URL/TOKEN.
  const url = process.env.UPSTASH_REDIS_REST_KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN;
  if (!url || !token) return { ok: false };
  try {
    const r = await fetch(`${url.replace(/\/$/, '')}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return { ok: false };
    const data = await r.json();
    return { ok: true, result: data.result };
  } catch (e) {
    return { ok: false };
  }
}

// null = Upstash indisponible/non configuré (appelant doit refuser par prudence).
async function remainingBudgetCents() {
  const key = monthKey();
  const res = await upstash(`get/${encodeURIComponent(key)}`);
  if (!res.ok) return null;
  return MONTHLY_CAP_CENTS - Number(res.result || 0);
}

async function recordSpendCents(cents) {
  const key = monthKey();
  await upstash(`incrbyfloat/${encodeURIComponent(key)}/${encodeURIComponent(String(cents))}`);
  // Expire après ~35 jours : purge automatique, pas de clés qui s'accumulent indéfiniment.
  await upstash(`expire/${encodeURIComponent(key)}/${35 * 24 * 60 * 60}`);
}

module.exports = { remainingBudgetCents, recordSpendCents, MONTHLY_CAP_CENTS };
