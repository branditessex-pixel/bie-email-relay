/**
 * Signatures for links embedded in emails (pixels, click redirects, unsubscribe).
 * Those requests cannot send RELAY_API_KEY. See README for the canonical string
 * the Groundwork CRM must reproduce.
 *
 * RELAY_LINK_SECRET unset: do not require signatures (pixels and unsubscribe
 * keep working). Click redirects still refuse non-allowlisted hosts.
 * RELAY_REQUIRE_SIGNED_LINKS=true: missing signatures are rejected. Default off,
 * so links already sent without `sig` keep working until the owner opts in.
 */
const crypto = require('crypto');
const { safeEqual } = require('./relay-auth');

const DEFAULT_ALLOWLIST = ['branditessex.com', 'uvrvii-wd.myshopify.com'];
const DEFAULT_FALLBACK = 'https://branditessex.com/';

const MISSING_LINK_SECRET_WARNING =
  '[relay] RELAY_LINK_SECRET is not set; pixels and unsubscribe links keep working without signatures. Unsigned click redirects are limited to the host allowlist';

const MISSING_LINK_SECRET_STRICT_WARNING =
  '[relay] RELAY_LINK_SECRET is not set; RELAY_REQUIRE_SIGNED_LINKS=true cannot be enforced, so pixels and unsubscribe links keep working. Unsigned click redirects are limited to the host allowlist';

let warnedMissingLinkSecret = false;

function linkSecret() {
  const value = process.env.RELAY_LINK_SECRET;
  if (typeof value !== 'string' || value.trim() === '') return null;
  return value;
}

function strictSignedLinks() {
  return String(process.env.RELAY_REQUIRE_SIGNED_LINKS || '').trim().toLowerCase() === 'true';
}

function warnIfLinkSecretMissing() {
  if (linkSecret() || warnedMissingLinkSecret) return;
  warnedMissingLinkSecret = true;
  console.warn(strictSignedLinks() ? MISSING_LINK_SECRET_STRICT_WARNING : MISSING_LINK_SECRET_WARNING);
}

function queryEntries(query) {
  const entries = [];
  if (!query || typeof query !== 'object') return entries;
  for (const key of Object.keys(query)) {
    if (key === 'sig') continue;
    const value = query[key];
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) entries.push([String(key), item == null ? '' : String(item)]);
  }
  entries.sort((a, b) => {
    if (a[0] < b[0]) return -1;
    if (a[0] > b[0]) return 1;
    if (a[1] < b[1]) return -1;
    if (a[1] > b[1]) return 1;
    return 0;
  });
  return entries;
}

// encodeURIComponent, then join. Sorting is on the raw key and value (UTF-16
// code units), not on the encoded form. `sig` is never part of the input.
function canonicalQuery(query) {
  return queryEntries(query)
    .map(([key, value]) => encodeURIComponent(key) + '=' + encodeURIComponent(value))
    .join('&');
}

function signingPayload(path, query) {
  return String(path) + '?' + canonicalQuery(query);
}

function signLink(path, query, secret) {
  return crypto.createHmac('sha256', secret).update(signingPayload(path, query), 'utf8').digest('hex');
}

function presentedSig(query) {
  if (!query || query.sig == null) return { kind: 'absent' };
  if (Array.isArray(query.sig)) return { kind: 'invalid' };
  const value = String(query.sig).trim();
  if (!value) return { kind: 'absent' };
  return { kind: 'present', value };
}

function verifyLink(path, query, secret) {
  const presented = presentedSig(query);
  if (!secret || presented.kind !== 'present') return false;
  const expected = signLink(path, query, secret);
  return safeEqual(presented.value.toLowerCase(), expected);
}

function rawPath(req) {
  const raw = (req && (req.originalUrl || req.url)) || '/';
  const q = raw.indexOf('?');
  return q === -1 ? raw : raw.slice(0, q);
}

function assessLink(req) {
  const path = rawPath(req);
  const secret = linkSecret();
  if (!secret) {
    warnIfLinkSecretMissing();
    return { status: 'legacy', path };
  }
  const presented = presentedSig(req.query);
  if (presented.kind === 'invalid') return { status: 'invalid', path };
  if (presented.kind === 'present') {
    return verifyLink(path, req.query, secret)
      ? { status: 'signed', path }
      : { status: 'invalid', path };
  }
  if (strictSignedLinks()) return { status: 'strict-unsigned', path };
  return { status: 'unsigned', path };
}

function linkRejected(status) {
  return status === 'invalid' || status === 'strict-unsigned';
}

function noteUnsignedLink(route) {
  console.warn(`[relay] unsigned link accepted route=${route}`);
}

function noteRejectedLink(status, route) {
  console.warn(`[relay] rejecting ${status} link route=${route}`);
}

function noteClickRewritten(host) {
  const safeHost = String(host || 'invalid').replace(/[\r\n\t]/g, '').slice(0, 200);
  console.warn(`[relay] unsigned click destination not allowlisted; redirecting to homepage host=${safeHost}`);
}

function fallbackUrl() {
  const configured = process.env.RELAY_REDIRECT_FALLBACK;
  if (typeof configured === 'string' && configured.trim()) {
    try {
      const url = new URL(configured.trim());
      if ((url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password) {
        return url.href;
      }
    } catch (e) { /* use the default homepage */ }
  }
  return DEFAULT_FALLBACK;
}

function normalizeAllowHost(value) {
  let raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  if (!raw.includes('://')) raw = 'https://' + raw;
  try {
    return new URL(raw).hostname.replace(/\.$/, '');
  } catch (e) {
    return '';
  }
}

function redirectAllowlist() {
  const configured = process.env.RELAY_REDIRECT_ALLOWLIST;
  const source = (typeof configured === 'string' && configured.trim())
    ? configured.split(',')
    : DEFAULT_ALLOWLIST.slice();
  const shop = process.env.SHOPIFY_STORE || process.env.SHOPIFY_DOMAIN || '';
  if (shop) source.push(shop);
  const hosts = [];
  for (const item of source) {
    const host = normalizeAllowHost(item);
    if (host && !hosts.includes(host)) hosts.push(host);
  }
  return hosts;
}

function hostAllowed(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!host) return false;
  return redirectAllowlist().some((allowed) => host === allowed || host.endsWith('.' + allowed));
}

function resolveClickRedirect(destination, { trusted = false } = {}) {
  const fallback = fallbackUrl();
  let parsed;
  try {
    parsed = new URL(destination);
  } catch (e) {
    return { location: fallback, toDestination: false, host: '' };
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password) {
    return { location: fallback, toDestination: false, host };
  }
  if (trusted || hostAllowed(host)) return { location: parsed.href, toDestination: true, host };
  return { location: fallback, toDestination: false, host };
}

module.exports = {
  DEFAULT_ALLOWLIST,
  DEFAULT_FALLBACK,
  MISSING_LINK_SECRET_WARNING,
  MISSING_LINK_SECRET_STRICT_WARNING,
  linkSecret,
  strictSignedLinks,
  warnIfLinkSecretMissing,
  canonicalQuery,
  signingPayload,
  signLink,
  verifyLink,
  assessLink,
  linkRejected,
  noteUnsignedLink,
  noteRejectedLink,
  noteClickRewritten,
  fallbackUrl,
  redirectAllowlist,
  resolveClickRedirect,
};
