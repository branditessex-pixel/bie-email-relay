/**
 * Meta webhook signature check (X-Hub-Signature-256).
 *
 * Meta signs each POST with the App Secret of the app that owns the webhook
 * subscription. Rotating that secret, or a second app subscribed to the same
 * page and callback URL, gives deliveries this service cannot verify.
 *
 * Secrets: META_APP_SECRETS (comma-separated, for a rotation or two apps)
 * plus META_APP_SECRET. Both are optional on their own; with neither set
 * every delivery is rejected. Values are trimmed and de-duplicated.
 *
 * Nothing here logs a secret, a digest, or anything derived from a secret.
 */
const crypto = require('crypto');
const { safeEqual } = require('./relay-auth');

function metaAppSecrets() {
  const out = [];
  const add = (value) => {
    if (typeof value !== 'string') return;
    const text = value.trim();
    if (text && !out.includes(text)) out.push(text);
  };
  const list = process.env.META_APP_SECRETS;
  if (typeof list === 'string') list.split(',').forEach(add);
  add(process.env.META_APP_SECRET);
  return out;
}

function expectedSignature(secret, raw) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
}

// Returns the 0-based index of the secret that matched, or -1. Every secret
// is checked (no early exit) so timing does not reveal which one matched.
function matchMetaSignature(raw, header, secrets) {
  const sig = typeof header === 'string' ? header.trim().toLowerCase() : '';
  let matched = -1;
  secrets.forEach((secret, index) => {
    const ok = safeEqual(sig, expectedSignature(secret, raw));
    if (ok && matched === -1) matched = index;
  });
  return matched;
}

// Who sent it, read from the unverified body for the log only. Never trusted.
function describePayload(raw) {
  try {
    const payload = JSON.parse(raw.toString('utf8'));
    const entries = payload && Array.isArray(payload.entry) ? payload.entry : [];
    const ids = [];
    const fields = new Set();
    const leadgenIds = [];
    const formIds = new Set();
    for (const entry of entries) {
      if (entry && entry.id != null) ids.push(String(entry.id).slice(0, 40));
      const changes = entry && Array.isArray(entry.changes) ? entry.changes : [];
      for (const change of changes) {
        if (change && change.field) fields.add(String(change.field).slice(0, 40));
        const value = change && change.value;
        if (value && value.leadgen_id != null) leadgenIds.push(String(value.leadgen_id).slice(0, 40));
        if (value && value.form_id != null) formIds.add(String(value.form_id).slice(0, 40));
      }
    }
    return {
      object: payload && payload.object != null ? String(payload.object).slice(0, 40) : 'none',
      entryIds: ids.slice(0, 10).join('|') || 'none',
      fields: [...fields].slice(0, 10).join('|') || 'none',
      formIds: [...formIds].slice(0, 10).join('|') || 'none',
      leadgenIds: leadgenIds.slice(0, 10).join('|') || 'none',
    };
  } catch {
    return { object: 'unparseable', entryIds: 'none', fields: 'none', formIds: 'none', leadgenIds: 'none' };
  }
}

function signatureMismatchLog({ header, raw, rawBodyCaptured, secrets }) {
  const sig = typeof header === 'string' ? header.trim() : '';
  const hex = sig.toLowerCase().startsWith('sha256=') ? sig.slice(7) : '';
  const about = describePayload(raw);
  // Meta App Secrets are 32 hex characters. This flags a pasted typo or the
  // wrong value (e.g. an access token) without printing anything secret.
  const shapeOk = secrets.every((s) => /^[0-9a-f]{32}$/i.test(s));
  return '[relay] Meta signature mismatch:'
    + ` header present=${Boolean(header)}`
    + `, header prefix ok=${sig.toLowerCase().startsWith('sha256=')}`
    + `, header hex length=${hex.length}`
    + `, body bytes=${raw.length}`
    + `, rawBody captured=${rawBodyCaptured}`
    + `, secrets configured=${secrets.length}`
    + `, secrets look like app secrets=${shapeOk}`
    + `, object=${about.object}`
    + `, entry ids (page)=${about.entryIds}`
    + `, fields=${about.fields}`
    + `, form ids=${about.formIds}`
    + `, leadgen ids=${about.leadgenIds}`;
}

module.exports = {
  metaAppSecrets,
  matchMetaSignature,
  describePayload,
  signatureMismatchLog,
};
