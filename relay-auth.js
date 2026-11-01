/**
 * Shared secret for routes the Groundwork CRM calls directly.
 * Email pixels, click redirects, and unsubscribe links cannot send this
 * header; those use link-sign.js. Provider webhooks keep their own checks.
 *
 * Callers send the secret in X-Relay-Key, or as Authorization: Bearer <key>.
 * RELAY_API_KEY must be set; otherwise these routes fail closed.
 */
const crypto = require('crypto');

function relayApiKey() {
  const value = process.env.RELAY_API_KEY;
  if (typeof value !== 'string' || value.trim() === '') return null;
  return value;
}

const MISSING_KEY_WARNING =
  '[relay] RELAY_API_KEY is not set; refusing POST /send, GET /campaigns/:campaignId/stats, GET /abandoned/stats, GET /meta/leads/pending, and POST /meta/leads/ack until it is configured';

function warnIfRelayKeyMissing() {
  if (!relayApiKey()) console.warn(MISSING_KEY_WARNING);
}

function keyFromRequest(req) {
  const headerKey = req.get('x-relay-key');
  if (headerKey) return headerKey;
  const authorization = req.get('authorization') || '';
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match ? match[1].trim() : '';
}

// Hash both sides so the comparison stays constant-time when the lengths differ.
function safeEqual(provided, expected) {
  const actual = crypto.createHash('sha256').update(String(provided), 'utf8').digest();
  const want = crypto.createHash('sha256').update(String(expected), 'utf8').digest();
  return crypto.timingSafeEqual(actual, want);
}

function requireRelayKey(req, res, next) {
  const expected = relayApiKey();
  if (!expected) {
    console.warn(MISSING_KEY_WARNING);
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!safeEqual(keyFromRequest(req), expected)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
}

// B.I.B website leads. This is not the CRM key: RELAY_API_KEY also unlocks
// POST /send, so a leaked relay key must not be enough to insert leads.
// Callers send X-Bib-Signature: sha256=<hex HMAC-SHA256 of the raw body>.
const MISSING_BIB_SECRET_WARNING =
  '[relay] BIB_LEAD_SECRET is not set; refusing POST /bib/lead until it is configured';

let warnedMissingBibSecret = false;

function bibLeadSecret() {
  const value = process.env.BIB_LEAD_SECRET;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text === '' ? null : text;
}

function warnIfBibSecretMissing() {
  if (warnedMissingBibSecret || bibLeadSecret()) return;
  warnedMissingBibSecret = true;
  console.warn(MISSING_BIB_SECRET_WARNING);
}

function requireBibKey(req, res, next) {
  const secret = bibLeadSecret();
  if (!secret) {
    warnIfBibSecretMissing();
    return res.status(503).json({ error: 'Unavailable' });
  }
  const header = (req.get('x-bib-signature') || '').trim().toLowerCase();
  const raw = req.rawBody || Buffer.alloc(0);
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  if (!safeEqual(header, expected)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
}

module.exports = {
  requireRelayKey,
  requireBibKey,
  warnIfRelayKeyMissing,
  warnIfBibSecretMissing,
  MISSING_KEY_WARNING,
  MISSING_BIB_SECRET_WARNING,
  safeEqual,
};
