/**
 * Pending Meta Lead Ads.
 *
 * This service has no DATABASE_URL client, so leads live in one JSON file.
 * DATA_DIR is that file's directory (mount a Railway Volume there). When
 * DATA_DIR is unset, META_LEADS_FILE still names the file, and otherwise
 * it is ./data/meta-leads.json beside this module — the same default as
 * before. Writes go to a temp file in that directory and then rename, so a
 * crash cannot leave a half-written list.
 *
 * GET /meta/leads/pending reads the file and does not remove leads.
 * POST /meta/leads/ack removes only the leadgen ids it is given. Anything
 * still unacked is returned again on the next poll. Leads older than
 * META_LEADS_RETENTION_DAYS (default 30) are dropped on read and write.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const defaultFetch = require('node-fetch');

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_DAYS = 30;

let graphFetch = defaultFetch;
let queue = Promise.resolve();

function setMetaGraphFetch(fn) {
  graphFetch = typeof fn === 'function' ? fn : defaultFetch;
}

function envPath(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim() === '') return '';
  return value.trim();
}

function metaLeadsFilePath() {
  const dataDir = envPath('DATA_DIR');
  if (dataDir) return path.join(dataDir, 'meta-leads.json');
  const explicit = envPath('META_LEADS_FILE');
  if (explicit) return explicit;
  return path.join(__dirname, 'data', 'meta-leads.json');
}

function retentionMs() {
  const raw = process.env.META_LEADS_RETENTION_DAYS;
  if (typeof raw !== 'string' || raw.trim() === '') return DEFAULT_RETENTION_DAYS * DAY_MS;
  const days = Number(raw);
  if (!Number.isFinite(days) || days < 0) return DEFAULT_RETENTION_DAYS * DAY_MS;
  return days * DAY_MS;
}

function receivedMs(lead) {
  if (!lead || typeof lead.receivedAt !== 'string') return null;
  const ms = Date.parse(lead.receivedAt);
  return Number.isNaN(ms) ? null : ms;
}

function pruneLeads(leads, now = Date.now()) {
  const maxAge = retentionMs();
  return leads.filter((lead) => {
    const at = receivedMs(lead);
    if (at == null) return true;
    return now - at <= maxAge;
  });
}

function readStoredMetaLeads() {
  const file = metaLeadsFilePath();
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
  if (text.trim() === '') return [];
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    const error = new Error('meta leads file is not a JSON array');
    error.code = 'META_LEADS_CORRUPT';
    throw error;
  }
  return parsed;
}

function writeStoredMetaLeads(leads) {
  const file = metaLeadsFilePath();
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
  );
  const payload = JSON.stringify(leads);
  let fd;
  try {
    fd = fs.openSync(tmp, 'w', 0o600);
    fs.writeFileSync(fd, payload);
    fs.fsyncSync(fd);
  } catch (err) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* the original file is untouched */ }
    }
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean up */ }
    throw err;
  }
  fs.closeSync(fd);
  fs.renameSync(tmp, file);
  try {
    const dirFd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } catch {
    // Some filesystems cannot fsync a directory. The rename has already landed.
  }
}

function enqueue(work) {
  const result = queue.then(work, work);
  queue = result.then(() => undefined, () => undefined);
  return result;
}

function sameId(lead, leadgenId) {
  return lead && lead.leadgenId != null && String(lead.leadgenId) === String(leadgenId);
}

function asId(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}

function notificationsFromPayload(payload) {
  const out = [];
  const entries = payload && Array.isArray(payload.entry) ? payload.entry : [];
  for (const entry of entries) {
    const changes = entry && Array.isArray(entry.changes) ? entry.changes : [];
    for (const change of changes) {
      const value = change && change.value && typeof change.value === 'object' ? change.value : {};
      const leadgenId = asId(value.leadgen_id);
      if (!leadgenId) continue;
      const created = value.created_time != null ? value.created_time : (entry && entry.time != null ? entry.time : null);
      out.push({
        leadgenId,
        formId: asId(value.form_id),
        pageId: asId(value.page_id) || asId(entry && entry.id),
        createdTime: created,
      });
    }
  }
  return out;
}

function rawLead(note) {
  return {
    leadgenId: note.leadgenId,
    formId: note.formId,
    pageId: note.pageId,
    createdTime: note.createdTime,
    receivedAt: new Date().toISOString(),
    fieldsFetched: false,
    name: null,
    email: null,
    phone: null,
    company: null,
    need: null,
    quantity: null,
  };
}

function fieldsFromGraph(data) {
  const list = data && Array.isArray(data.field_data) ? data.field_data : [];
  if (list.length === 0) return null;
  const fields = {};
  for (const field of list) {
    if (!field || !field.name) continue;
    fields[field.name] = (field.values && field.values[0]) || '';
  }
  return {
    name: fields.full_name || [fields.first_name, fields.last_name].filter(Boolean).join(' ').trim() || null,
    email: fields.email || null,
    phone: fields.phone_number || fields.phone || null,
    company: fields.company_name || fields.business_name || null,
    need: fields.what_are_you_looking_for || fields.workwear_type || null,
    quantity: fields.how_many_staff || fields.quantity || null,
    createdTime: data.created_time != null ? data.created_time : null,
  };
}

function applyFields(lead, fields) {
  lead.name = fields.name;
  lead.email = fields.email;
  lead.phone = fields.phone;
  lead.company = fields.company;
  lead.need = fields.need;
  lead.quantity = fields.quantity;
  lead.fieldsFetched = true;
  if ((lead.createdTime == null || lead.createdTime === '') && fields.createdTime != null) {
    lead.createdTime = fields.createdTime;
  }
}

function accessToken() {
  const value = process.env.META_ACCESS_TOKEN;
  if (typeof value !== 'string' || value.trim() === '') return '';
  return value.trim();
}

const GRAPH_BASE = 'https://graph.facebook.com/v21.0';
const STARTED_AT = Date.now();
const DEFAULT_MAX_FETCH_ATTEMPTS = 5;
const DEFAULT_RETRY_MINUTES = 60;

function positiveNumberEnv(name, fallback) {
  const raw = process.env[name];
  if (typeof raw !== 'string' || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function maxFetchAttempts() {
  return Math.floor(positiveNumberEnv('META_LEAD_MAX_FETCH_ATTEMPTS', DEFAULT_MAX_FETCH_ATTEMPTS));
}

function retryAfterMs() {
  return positiveNumberEnv('META_LEAD_RETRY_MINUTES', DEFAULT_RETRY_MINUTES) * 60 * 1000;
}

// Optional appsecret_proof, for apps with "Require App Secret" switched on.
// Off unless META_APPSECRET_PROOF=true, because a proof made with the wrong
// app's secret turns a working call into an error.
function appSecretProof(token) {
  if (String(process.env.META_APPSECRET_PROOF || '').trim().toLowerCase() !== 'true') return '';
  const { metaAppSecrets } = require('./meta-signature');
  const secret = metaAppSecrets()[0];
  if (!secret) return '';
  return crypto.createHmac('sha256', secret).update(token).digest('hex');
}

function graphUrl(pathAndQuery, token) {
  const sep = pathAndQuery.includes('?') ? '&' : '?';
  const proof = appSecretProof(token);
  return `${GRAPH_BASE}${pathAndQuery}${sep}access_token=${encodeURIComponent(token)}`
    + (proof ? `&appsecret_proof=${proof}` : '');
}

// Graph error messages do not normally carry the token, but scrub anything
// token-shaped anyway and cap the length.
function scrub(text) {
  if (text == null) return null;
  const token = accessToken();
  let out = String(text);
  if (token) out = out.split(token).join('[redacted]');
  return out.replace(/EA[A-Za-z0-9]{20,}/g, '[redacted]').slice(0, 300);
}

function graphError(status, body) {
  const err = body && body.error && typeof body.error === 'object' ? body.error : {};
  return {
    status: status == null ? null : status,
    code: err.code != null ? err.code : null,
    subcode: err.error_subcode != null ? err.error_subcode : null,
    type: err.type != null ? String(err.type).slice(0, 60) : null,
    message: scrub(err.message),
    fbtraceId: err.fbtrace_id != null ? String(err.fbtrace_id).slice(0, 60) : null,
  };
}

function describeGraphError(e) {
  return `status=${e.status} code=${e.code} subcode=${e.subcode} type=${e.type} fbtrace_id=${e.fbtraceId} message=${JSON.stringify(e.message)}`;
}

// Never log the request URL: it carries META_ACCESS_TOKEN.
// Resolves to { fields } on success or { error } on failure.
async function fetchLeadFields(leadgenId) {
  const token = accessToken();
  if (!token) return { error: { status: null, code: null, subcode: null, type: 'config', message: 'META_ACCESS_TOKEN is not set', fbtraceId: null } };
  if (!leadgenId) return { error: { status: null, code: null, subcode: null, type: 'config', message: 'missing leadgen id', fbtraceId: null } };
  let response;
  try {
    response = await graphFetch(graphUrl(`/${encodeURIComponent(leadgenId)}?fields=field_data,created_time`, token), { timeout: 8000 });
  } catch (e) {
    const error = { status: null, code: null, subcode: null, type: 'network', message: scrub(e && e.message), fbtraceId: null };
    console.error(`[groundwork] meta graph fetch failed for lead ${leadgenId}: ${describeGraphError(error)}`);
    return { error };
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response || !response.ok) {
    const error = graphError(response && response.status, data);
    console.error(`[groundwork] meta graph fetch failed for lead ${leadgenId}: ${describeGraphError(error)}`);
    return { error };
  }
  const fields = fieldsFromGraph(data);
  if (!fields) {
    const error = { status: response.status, code: null, subcode: null, type: 'empty', message: 'no field_data in response', fbtraceId: null };
    console.error(`[groundwork] meta graph fetch failed for lead ${leadgenId}: ${describeGraphError(error)}`);
    return { error };
  }
  return { fields };
}

// The first META_LEAD_MAX_FETCH_ATTEMPTS tries happen on every webhook and
// poll. After that the lead is marked details_unavailable and tried at most
// once per META_LEAD_RETRY_MINUTES, plus once after every restart/redeploy
// (which is when a new token takes effect).
function shouldTryFetch(lead, now = Date.now()) {
  if (!lead || lead.leadgenId == null || lead.fieldsFetched) return false;
  const attempts = Number(lead.fetchAttempts) || 0;
  if (attempts < maxFetchAttempts()) return true;
  const last = lead.lastFetchAttemptAt ? Date.parse(lead.lastFetchAttemptAt) : NaN;
  if (Number.isNaN(last) || last < STARTED_AT) return true;
  return now - last >= retryAfterMs();
}

function applyFetchFailure(lead, error) {
  lead.fetchAttempts = (Number(lead.fetchAttempts) || 0) + 1;
  lead.lastFetchAttemptAt = new Date().toISOString();
  lead.lastFetchError = {
    status: error.status,
    code: error.code,
    subcode: error.subcode,
    type: error.type,
    message: error.message,
  };
  if (lead.fetchAttempts >= maxFetchAttempts()) {
    if (lead.detailsStatus !== 'details_unavailable') {
      console.warn(`[groundwork] meta lead ${lead.leadgenId} marked details_unavailable after ${lead.fetchAttempts} failed Graph reads (page ${lead.pageId}, form ${lead.formId}); still listed in /meta/leads/pending`);
    }
    lead.detailsStatus = 'details_unavailable';
  } else {
    lead.detailsStatus = 'pending';
  }
}

function applyFetchSuccess(lead, fields) {
  applyFields(lead, fields);
  lead.detailsStatus = 'fetched';
  lead.lastFetchAttemptAt = new Date().toISOString();
  delete lead.lastFetchError;
}

// Fetch outside the queue, then write the outcome against a fresh read.
// Returns the stored lead after the update, or null if it is gone.
let warnedNoToken = false;
async function fetchAndRecord(leadgenId) {
  // No token is a config gap, not a failed read: keep the lead raw and do
  // not count an attempt, as before.
  if (!accessToken()) {
    if (!warnedNoToken) {
      warnedNoToken = true;
      console.warn('[groundwork] META_ACCESS_TOKEN is not set; Meta leads are stored without their fields');
    }
    return null;
  }
  const result = await fetchLeadFields(leadgenId);
  return enqueue(() => {
    const current = readStoredMetaLeads();
    const leads = pruneLeads(current);
    const lead = leads.find((item) => sameId(item, leadgenId));
    if (!lead) {
      if (leads.length !== current.length) writeStoredMetaLeads(leads);
      return null;
    }
    if (!lead.fieldsFetched) {
      if (result.fields) applyFetchSuccess(lead, result.fields);
      else applyFetchFailure(lead, result.error);
    }
    writeStoredMetaLeads(leads);
    return { ...lead };
  });
}

async function ingestMetaWebhook(payload) {
  const notes = notificationsFromPayload(payload);
  const toFetch = await enqueue(() => {
    const current = readStoredMetaLeads();
    const leads = pruneLeads(current);
    const need = [];
    const seen = new Set();
    let changed = leads.length !== current.length;
    for (const note of notes) {
      if (seen.has(note.leadgenId)) continue;
      seen.add(note.leadgenId);
      const existing = leads.find((lead) => sameId(lead, note.leadgenId));
      if (existing) {
        if (shouldTryFetch(existing)) need.push(existing.leadgenId);
        continue;
      }
      const lead = rawLead(note);
      leads.push(lead);
      need.push(lead.leadgenId);
      changed = true;
    }
    if (changed) writeStoredMetaLeads(leads);
    return need;
  });

  for (const leadgenId of toFetch) {
    await fetchAndRecord(leadgenId);
  }
}

async function listPendingMetaLeads() {
  const snapshot = await enqueue(() => {
    const current = readStoredMetaLeads();
    const leads = pruneLeads(current);
    if (leads.length !== current.length) writeStoredMetaLeads(leads);
    return leads.map((lead) => ({ ...lead }));
  });

  const now = Date.now();
  for (let i = 0; i < snapshot.length; i++) {
    if (!accessToken()) break;
    if (!shouldTryFetch(snapshot[i], now)) continue;
    const updated = await fetchAndRecord(snapshot[i].leadgenId);
    if (updated) snapshot[i] = updated;
  }

  return snapshot;
}

const WANTED_SCOPES = ['leads_retrieval', 'pages_show_list', 'pages_read_engagement', 'pages_manage_metadata'];

function isoFromUnix(value) {
  if (value === 0) return 'never';
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return new Date(value * 1000).toISOString();
}

// GET /meta/token-status. Reports what Graph says about META_ACCESS_TOKEN
// without returning the token. debug_token is called with the token itself
// as both input and access token, which Graph allows for its own token.
async function metaTokenStatus() {
  const { metaAppSecrets } = require('./meta-signature');
  const token = accessToken();
  const base = {
    tokenConfigured: Boolean(token),
    appSecretsConfigured: metaAppSecrets().length,
    appSecretProof: Boolean(token && appSecretProof(token)),
  };
  if (!token) return base;

  let response;
  let body = null;
  try {
    response = await graphFetch(graphUrl(`/debug_token?input_token=${encodeURIComponent(token)}`, token), { timeout: 8000 });
    try { body = await response.json(); } catch { body = null; }
  } catch (e) {
    return { ...base, error: { status: null, type: 'network', message: scrub(e && e.message) } };
  }
  if (!response.ok || !body || !body.data) {
    return { ...base, error: graphError(response.status, body) };
  }
  const data = body.data;
  const scopes = Array.isArray(data.scopes) ? data.scopes.map(String) : [];
  const granular = Array.isArray(data.granular_scopes) ? data.granular_scopes : [];
  const leadsScope = granular.find((g) => g && g.scope === 'leads_retrieval');
  const configuredAppId = (process.env.META_APP_ID || '').trim();
  return {
    ...base,
    valid: Boolean(data.is_valid),
    type: data.type || null,
    appId: data.app_id != null ? String(data.app_id) : null,
    application: data.application || null,
    appIdMatchesMETA_APP_ID: configuredAppId ? String(data.app_id) === configuredAppId : null,
    profileId: data.profile_id != null ? String(data.profile_id) : null,
    expiresAt: isoFromUnix(data.expires_at),
    dataAccessExpiresAt: isoFromUnix(data.data_access_expires_at),
    scopes,
    missingScopes: WANTED_SCOPES.filter((s) => !scopes.includes(s)),
    leadsRetrievalPageIds: leadsScope && Array.isArray(leadsScope.target_ids) ? leadsScope.target_ids.map(String) : null,
    error: data.error ? { code: data.error.code || null, subcode: data.error.subcode || null, message: scrub(data.error.message) } : null,
  };
}

async function ackMetaLeads(ids) {
  const wanted = new Set();
  for (const id of ids) {
    const text = asId(id);
    if (text) wanted.add(text);
  }
  return enqueue(() => {
    const current = readStoredMetaLeads();
    const pruned = pruneLeads(current);
    const kept = pruned.filter((lead) => lead.leadgenId == null || !wanted.has(String(lead.leadgenId)));
    const removed = current.filter((lead) => lead.leadgenId != null && wanted.has(String(lead.leadgenId))).length;
    if (kept.length !== current.length) writeStoredMetaLeads(kept);
    return { removed };
  });
}

module.exports = {
  setMetaGraphFetch,
  metaLeadsFilePath,
  readStoredMetaLeads,
  ingestMetaWebhook,
  listPendingMetaLeads,
  ackMetaLeads,
  metaTokenStatus,
  shouldTryFetch,
};
