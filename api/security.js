const TRUSTED = new Set([
  'https://www.florynepierson.com',
  'https://florynepierson.com',
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5173',
  ...(String(process.env.FP_ALLOWED_ORIGINS || '').split(',').map((v) => v.trim().replace(/\/$/, '')).filter(Boolean)),
]);

function allowed(req) {
  const values = [req.headers.origin, req.headers.referer].filter(Boolean);
  if (!values.length) return true;
  return values.some((value) => {
    try { return TRUSTED.has(new URL(value).origin); } catch (_) { return false; }
  });
}

module.exports = { allowed };
