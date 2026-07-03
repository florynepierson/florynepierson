// Serverless (Vercel) — génère une annonce immobilière via Claude Haiku (FR ou EN).
// Coût ~fraction de centime par appel. Nécessite ANTHROPIC_API_KEY dans le projet Vercel.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const KEY = process.env.ANTHROPIC_API_KEY;
  if (!KEY) return res.status(500).json({ error: 'no_key' });

  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (_) { b = {}; } }
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
  const atouts = Array.isArray(b.atouts) ? b.atouts.slice(0, 15).map(String).join(', ') : '';
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
