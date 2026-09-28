// Capte un email de prospect (email-gate Plume) et l'ajoute à une liste Brevo.
// Fonctionne même sans clé (renvoie ok) pour ne jamais casser l'UX ; pour STOCKER
// réellement les leads, ajoute BREVO_API_KEY (+ BREVO_PLUME_LIST_ID) dans Vercel.
function allowed(req) {
  const values = [req.headers.origin, req.headers.referer].filter(Boolean);
  if (!values.length) return true;
  return values.some((value) => {
    try {
      const origin = new URL(value).origin;
      return ['https://www.florynepierson.com', 'https://florynepierson.com', 'http://localhost:3000', 'http://localhost:5173', 'http://127.0.0.1:3000', 'http://127.0.0.1:5173'].includes(origin);
    } catch (_) { return false; }
  });
}
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  if (!allowed(req)) return res.status(403).json({ error: 'forbidden' });
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (_) { b = {}; } }
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
