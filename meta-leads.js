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
  return value;
}

// Never log the request URL: it carries META_ACCESS_TOKEN.
async function fetchLeadFields(leadgenId) {
  const token = accessToken();
  if (!token || !leadgenId) return null;
  let response;
  try {
    response = await graphFetch(
      `https://graph.facebook.com/v21.0/${encodeURIComponent(leadgenId)}?fields=field_data,created_time&access_token=${encodeURIComponent(token)}`,
      { timeout: 8000 }
    );
  } catch {
    console.error('[groundwork] meta graph fetch failed');
    return null;
  }
  if (!response || !response.ok) {
    console.error('[groundwork] meta graph fetch failed', response && response.status);
    return null;
  }
  let data;
  try {
    data = await response.json();
  } catch {
    console.error('[groundwork] meta graph fetch failed');
    return null;
  }
  return fieldsFromGraph(data);
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
        if (!existing.fieldsFetched) need.push(existing.leadgenId);
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
    const fields = await fetchLeadFields(leadgenId);
    if (!fields) continue;
    await enqueue(() => {
      const current = readStoredMetaLeads();
      const leads = pruneLeads(current);
      let changed = leads.length !== current.length;
      const lead = leads.find((item) => sameId(item, leadgenId));
      if (lead && !lead.fieldsFetched) {
        applyFields(lead, fields);
        changed = true;
      }
      if (changed) writeStoredMetaLeads(leads);
    });
  }
}

async function listPendingMetaLeads() {
  const snapshot = await enqueue(() => {
    const current = readStoredMetaLeads();
    const leads = pruneLeads(current);
    if (leads.length !== current.length) writeStoredMetaLeads(leads);
    return leads.map((lead) => ({ ...lead }));
  });

  const enriched = [];
  for (const lead of snapshot) {
    if (lead.leadgenId == null || lead.fieldsFetched) continue;
    const fields = await fetchLeadFields(lead.leadgenId);
    if (!fields) continue;
    applyFields(lead, fields);
    enriched.push(String(lead.leadgenId));
  }

  if (enriched.length === 0) return snapshot;

  await enqueue(() => {
    const current = readStoredMetaLeads();
    const leads = pruneLeads(current);
    let changed = leads.length !== current.length;
    for (const leadgenId of enriched) {
      const updated = snapshot.find((lead) => sameId(lead, leadgenId));
      const lead = leads.find((item) => sameId(item, leadgenId));
      if (!updated || !lead || lead.fieldsFetched) continue;
      applyFields(lead, updated);
      changed = true;
    }
    if (changed) writeStoredMetaLeads(leads);
  });

  return snapshot;
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
};
