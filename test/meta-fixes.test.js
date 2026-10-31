const { describe, before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const KEY = 'test-relay-key';
const OLD_SECRET = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NEW_SECRET = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const TOKEN = 'EAATESTTOKENVALUE1234567890abcdefghij';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-meta-fix-'));

process.env.DATA_DIR = dataDir;
process.env.CAMPAIGN_DATA_DIR = path.join(dataDir, 'campaigns');
process.env.RELAY_API_KEY = KEY;
process.env.META_VERIFY_TOKEN = 'meta-verify-test';
delete process.env.META_APP_SECRET;
delete process.env.META_APP_SECRETS;
delete process.env.META_ACCESS_TOKEN;
delete process.env.META_LEAD_MAX_FETCH_ATTEMPTS;
delete process.env.META_LEAD_RETRY_MINUTES;
delete process.env.META_APPSECRET_PROOF;

const app = require('../index');
const leadsStore = require('../meta-leads');

let server;
let base;

function request(method, urlPath, { headers = {}, body } = {}) {
  const payload = body != null ? Buffer.from(body) : null;
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, base);
    const reqHeaders = { ...headers };
    if (payload) {
      reqHeaders['content-type'] = 'application/json';
      reqHeaders['content-length'] = String(payload.length);
    }
    const req = http.request({ method, hostname: url.hostname, port: url.port, path: url.pathname + url.search, headers: reqHeaders }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        resolve({ status: res.statusCode, text, json });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function leadRaw(id) {
  return JSON.stringify({
    object: 'page',
    entry: [{ id: 'page-123', time: 1700000000, changes: [{ field: 'leadgen', value: { leadgen_id: id, form_id: 'form-9', page_id: 'page-123', created_time: 1700000000 } }] }],
  });
}

function sign(secret, raw) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
}

function postLead(id, secret) {
  const raw = leadRaw(id);
  return request('POST', '/meta/lead', { body: raw, headers: { 'x-hub-signature-256': sign(secret, raw) } });
}

function readLeads() {
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'meta-leads.json'), 'utf8'));
}

function writeLeads(leads) {
  fs.writeFileSync(path.join(dataDir, 'meta-leads.json'), JSON.stringify(leads));
}

function capture(method, fn) {
  const lines = [];
  const original = console[method];
  console[method] = (...args) => { lines.push(args.map(String).join(' ')); };
  return Promise.resolve().then(fn).finally(() => { console[method] = original; }).then(() => lines);
}

function graph400() {
  let calls = 0;
  const fn = async (url) => {
    calls++;
    assert.match(url, /access_token=/);
    return {
      ok: false,
      status: 400,
      json: async () => ({ error: { message: `Unsupported get request. token ${TOKEN}`, type: 'GraphMethodException', code: 100, error_subcode: 33, fbtrace_id: 'trace-1' } }),
    };
  };
  fn.calls = () => calls;
  return fn;
}

function graphOk() {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({ field_data: [{ name: 'full_name', values: ['Duncan Test'] }, { name: 'email', values: ['d@example.com'] }], created_time: '2026-10-31T16:52:00+0000' }),
  });
}

describe('meta lead signature and token fixes', { concurrency: false }, () => {
  before(async () => {
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    leadsStore.setMetaGraphFetch(null);
    if (server) await new Promise((r) => server.close(r));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('no app secret configured rejects every delivery', async () => {
    writeLeads([]);
    const res = await postLead('s-0', OLD_SECRET);
    assert.equal(res.status, 401);
    assert.equal(readLeads().length, 0);
  });

  test('META_APP_SECRETS accepts any listed secret and META_APP_SECRET still works alone', async () => {
    writeLeads([]);
    process.env.META_APP_SECRET = OLD_SECRET;
    assert.equal((await postLead('s-1', OLD_SECRET)).status, 200);
    assert.equal((await postLead('s-2', NEW_SECRET)).status, 401);

    process.env.META_APP_SECRETS = ` ${NEW_SECRET} ,`;
    assert.equal((await postLead('s-3', NEW_SECRET)).status, 200);
    assert.equal((await postLead('s-4', OLD_SECRET)).status, 200);

    delete process.env.META_APP_SECRET;
    assert.equal((await postLead('s-5', NEW_SECRET)).status, 200);
    assert.equal((await postLead('s-6', OLD_SECRET)).status, 401);
    assert.deepEqual(readLeads().map((l) => l.leadgenId), ['s-1', 's-3', 's-4', 's-5']);
    delete process.env.META_APP_SECRETS;
  });

  test('a mismatch logs the sending page and lead ids but no secret or signature', async () => {
    writeLeads([]);
    process.env.META_APP_SECRET = OLD_SECRET;
    const raw = leadRaw('s-7');
    const badSig = sign(NEW_SECRET, raw);
    let res;
    const lines = await capture('warn', async () => {
      res = await request('POST', '/meta/lead', { body: raw, headers: { 'x-hub-signature-256': badSig } });
    });
    assert.equal(res.status, 401);
    const line = lines.find((l) => l.includes('Meta signature mismatch'));
    assert.ok(line);
    assert.match(line, /header hex length=64/);
    assert.match(line, /secrets configured=1, secrets look like app secrets=true/);
    assert.match(line, /object=page, entry ids \(page\)=page-123, fields=leadgen, form ids=form-9, leadgen ids=s-7/);
    for (const secretish of [OLD_SECRET, NEW_SECRET, badSig, sign(OLD_SECRET, raw)]) {
      assert.equal(line.includes(secretish), false);
    }
    assert.equal(readLeads().length, 0);
  });

  test('a Graph error is logged with its code, retried, then capped as details_unavailable', async () => {
    writeLeads([]);
    process.env.META_APP_SECRET = OLD_SECRET;
    process.env.META_ACCESS_TOKEN = TOKEN;
    process.env.META_LEAD_MAX_FETCH_ATTEMPTS = '3';
    const g = graph400();
    leadsStore.setMetaGraphFetch(g);
    try {
      const errors = await capture('error', async () => {
        assert.equal((await postLead('g-1', OLD_SECRET)).status, 200);
      });
      const line = errors.find((l) => l.includes('meta graph fetch failed'));
      assert.match(line, /lead g-1: status=400 code=100 subcode=33 type=GraphMethodException fbtrace_id=trace-1/);
      assert.equal(line.includes(TOKEN), false);
      assert.equal(line.includes('graph.facebook.com'), false);

      let lead = readLeads()[0];
      assert.equal(lead.fetchAttempts, 1);
      assert.equal(lead.detailsStatus, 'pending');
      assert.equal(lead.lastFetchError.code, 100);
      assert.equal(lead.lastFetchError.subcode, 33);
      assert.equal(lead.lastFetchError.message.includes(TOKEN), false);

      await capture('error', async () => {
        const p1 = await request('GET', '/meta/leads/pending', { headers: { 'x-relay-key': KEY } });
        assert.equal(p1.json[0].fetchAttempts, 2);
        const warns = await capture('warn', async () => {
          const p2 = await request('GET', '/meta/leads/pending', { headers: { 'x-relay-key': KEY } });
          assert.equal(p2.json[0].detailsStatus, 'details_unavailable');
          assert.equal(p2.json[0].fieldsFetched, false);
          assert.equal(p2.json[0].formId, 'form-9');
          assert.equal(p2.json[0].pageId, 'page-123');
        });
        assert.ok(warns.some((w) => w.includes('g-1 marked details_unavailable after 3')));
      });
      assert.equal(g.calls(), 3);

      // Capped: further polls and webhook replays do not call Graph.
      await request('GET', '/meta/leads/pending', { headers: { 'x-relay-key': KEY } });
      await postLead('g-1', OLD_SECRET);
      assert.equal(g.calls(), 3);
      assert.equal(readLeads().length, 1);

      // After the retry window it tries again, and a good read fills it in.
      lead = readLeads()[0];
      lead.lastFetchAttemptAt = new Date(Date.now() - 61 * 60 * 1000).toISOString();
      writeLeads([lead]);
      leadsStore.setMetaGraphFetch(graphOk());
      const filled = await request('GET', '/meta/leads/pending', { headers: { 'x-relay-key': KEY } });
      assert.equal(filled.json[0].fieldsFetched, true);
      assert.equal(filled.json[0].detailsStatus, 'fetched');
      assert.equal(filled.json[0].email, 'd@example.com');
      assert.equal(filled.json[0].lastFetchError, undefined);
      assert.equal(readLeads()[0].email, 'd@example.com');
    } finally {
      delete process.env.META_LEAD_MAX_FETCH_ATTEMPTS;
      delete process.env.META_ACCESS_TOKEN;
      leadsStore.setMetaGraphFetch(null);
    }
  });

  test('a lead capped before this process started is retried once after a restart', () => {
    process.env.META_LEAD_MAX_FETCH_ATTEMPTS = '3';
    try {
      const lead = { leadgenId: 'r-1', fieldsFetched: false, fetchAttempts: 9, lastFetchAttemptAt: new Date(Date.now() - 1000 * 60 * 60 * 24).toISOString() };
      assert.equal(leadsStore.shouldTryFetch(lead), true);
      lead.lastFetchAttemptAt = new Date().toISOString();
      assert.equal(leadsStore.shouldTryFetch(lead), false);
      assert.equal(leadsStore.shouldTryFetch({ leadgenId: 'r-2', fieldsFetched: true }), false);
    } finally {
      delete process.env.META_LEAD_MAX_FETCH_ATTEMPTS;
    }
  });

  test('GET /meta/token-status needs the relay key and never returns the token', async () => {
    process.env.META_APP_SECRET = OLD_SECRET;
    const denied = await request('GET', '/meta/token-status');
    assert.equal(denied.status, 401);

    const unset = await request('GET', '/meta/token-status', { headers: { 'x-relay-key': KEY } });
    assert.equal(unset.status, 200);
    assert.deepEqual(unset.json, { tokenConfigured: false, appSecretsConfigured: 1, appSecretProof: false });

    process.env.META_ACCESS_TOKEN = TOKEN;
    process.env.META_APP_ID = '111';
    let seenUrl = '';
    leadsStore.setMetaGraphFetch(async (url) => {
      seenUrl = url;
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: {
          app_id: '222', type: 'PAGE', application: 'Brand It Leads', is_valid: true,
          expires_at: 0, data_access_expires_at: 1800000000, profile_id: 'page-123',
          scopes: ['pages_show_list', 'pages_read_engagement'],
          granular_scopes: [{ scope: 'pages_show_list', target_ids: ['page-123'] }],
        } }),
      };
    });
    try {
      const res = await request('GET', '/meta/token-status', { headers: { 'x-relay-key': KEY } });
      assert.equal(res.status, 200);
      assert.match(seenUrl, /\/debug_token\?input_token=/);
      assert.equal(res.text.includes(TOKEN), false);
      assert.equal(res.json.valid, true);
      assert.equal(res.json.type, 'PAGE');
      assert.equal(res.json.appId, '222');
      assert.equal(res.json.appIdMatchesMETA_APP_ID, false);
      assert.equal(res.json.profileId, 'page-123');
      assert.equal(res.json.expiresAt, 'never');
      assert.deepEqual(res.json.missingScopes, ['leads_retrieval', 'pages_manage_metadata']);
      assert.equal(res.json.leadsRetrievalPageIds, null);
    } finally {
      delete process.env.META_ACCESS_TOKEN;
      delete process.env.META_APP_ID;
      leadsStore.setMetaGraphFetch(null);
    }
  });

  test('appsecret_proof is only sent when META_APPSECRET_PROOF=true', async () => {
    writeLeads([]);
    process.env.META_APP_SECRET = OLD_SECRET;
    process.env.META_ACCESS_TOKEN = TOKEN;
    const urls = [];
    leadsStore.setMetaGraphFetch(async (url) => { urls.push(url); return graphOk()(); });
    try {
      await postLead('p-1', OLD_SECRET);
      process.env.META_APPSECRET_PROOF = 'true';
      await postLead('p-2', OLD_SECRET);
      assert.equal(urls[0].includes('appsecret_proof='), false);
      const proof = crypto.createHmac('sha256', OLD_SECRET).update(TOKEN).digest('hex');
      assert.equal(urls[1].endsWith(`&appsecret_proof=${proof}`), true);
    } finally {
      delete process.env.META_APPSECRET_PROOF;
      delete process.env.META_ACCESS_TOKEN;
      leadsStore.setMetaGraphFetch(null);
    }
  });
});
