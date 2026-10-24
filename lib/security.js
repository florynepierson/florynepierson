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
  if (!values.length) return false;
  return values.every((value) => {
    try { return TRUSTED.has(new URL(value).origin); } catch (_) { return false; }
  });
}

const buckets = new Map();
function rateLimit(req, key, limit, windowMs) {
  const ip = String(req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown').slice(0, 64);
  const now = Date.now();
  const bucketKey = `${key}:${ip}`;
  let bucket = buckets.get(bucketKey);
  if (!bucket || bucket.resetAt <= now) bucket = { count: 0, resetAt: now + windowMs };
  bucket.count += 1;
  buckets.set(bucketKey, bucket);
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
  }
  return { allowed: bucket.count <= limit, retryAfter: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
}

module.exports = { allowed, rateLimit };
