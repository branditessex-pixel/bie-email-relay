const { describe, before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const KEY = 'test-relay-key';
const APP_SECRET = 'meta-app-secret';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-meta-'));

process.env.DATA_DIR = dataDir;
process.env.CAMPAIGN_DATA_DIR = path.join(dataDir, 'campaigns');
delete process.env.META_LEADS_FILE;
delete process.env.META_LEADS_RETENTION_DAYS;
delete process.env.META_LEADS_SECRET;
delete process.env.META_ACCESS_TOKEN;
process.env.RELAY_API_KEY = KEY;
process.env.META_APP_SECRET = APP_SECRET;
process.env.META_VERIFY_TOKEN = 'meta-verify-test';
process.env.UNSUBSCRIBE_SECRET = 'unsubscribe-test-secret';
delete process.env.RESEND_API_KEY;

const app = require('../index');
const leadsStore = require('../meta-leads');

let server;
let base;

function request(method, urlPath, { headers = {}, json, body, contentType } = {}) {
  const payload = body != null
    ? Buffer.from(body)
    : (json === undefined ? null : Buffer.from(JSON.stringify(json)));
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, base);
    const reqHeaders = { ...headers };
    if (payload) {
      reqHeaders['content-type'] = contentType || reqHeaders['content-type'] || 'application/json';
      reqHeaders['content-length'] = String(payload.length);
    }
    const req = http.request({
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: reqHeaders,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        let parsed = null;
        try { parsed = JSON.parse(raw.toString('utf8')); } catch { parsed = null; }
        resolve({ status: res.statusCode, headers: res.headers, text: raw.toString('utf8'), json: parsed });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function leadsFile() {
  return path.join(dataDir, 'meta-leads.json');
}

function readFileLeads() {
  return JSON.parse(fs.readFileSync(leadsFile(), 'utf8'));
}

function writeFileLeads(leads) {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(leadsFile(), JSON.stringify(leads));
}

function resetStore() {
  writeFileLeads([]);
}

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function sign(raw) {
  return 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex');
}

function leadBody(ids) {
  const list = Array.isArray(ids) ? ids : [ids];
  return {
    object: 'page',
    entry: [{
      id: 'page-entry',
      time: 1700001111,
      changes: list.map((id) => ({
        field: 'leadgen',
        value: {
          leadgen_id: id,
          form_id: 'form-77',
          page_id: 'page-88',
          created_time: 1690002222,
        },
      })),
    }],
  };
}

function postLead(ids, { signature } = {}) {
  const raw = JSON.stringify(leadBody(ids));
  return request('POST', '/meta/lead', {
    body: raw,
    contentType: 'application/json',
    headers: { 'x-hub-signature-256': signature === undefined ? sign(raw) : signature },
  });
}

function authHeaders(extra = {}) {
  return { 'x-relay-key': KEY, ...extra };
}

function pending() {
  return request('GET', '/meta/leads/pending', { headers: authHeaders() });
}

function ack(ids, headers = authHeaders()) {
  return request('POST', '/meta/leads/ack', { headers, json: { leadgenIds: ids } });
}

function graphOk() {
  return async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      field_data: [
        { name: 'full_name', values: ['Ada Lovelace'] },
        { name: 'email', values: ['ada@example.com'] },
        { name: 'phone_number', values: ['07000900000'] },
      ],
      created_time: '2024-06-01T00:00:00+0000',
    }),
  });
}

describe('meta lead durability', { concurrency: false }, () => {
  before(async () => {
    leadsStore.setMetaGraphFetch(async () => {
      throw new Error('graph down');
    });
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    leadsStore.setMetaGraphFetch(null);
    delete process.env.META_ACCESS_TOKEN;
    delete process.env.META_LEADS_RETENTION_DAYS;
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('DATA_DIR selects the leads file and falls back to ./data', () => {
    const previousData = process.env.DATA_DIR;
    const previousFile = process.env.META_LEADS_FILE;
    try {
      process.env.DATA_DIR = dataDir;
      delete process.env.META_LEADS_FILE;
      assert.equal(leadsStore.metaLeadsFilePath(), path.join(dataDir, 'meta-leads.json'));

      process.env.DATA_DIR = '/data';
      process.env.META_LEADS_FILE = '/tmp/ignored-meta-leads.json';
      assert.equal(leadsStore.metaLeadsFilePath(), path.join('/data', 'meta-leads.json'));

      delete process.env.DATA_DIR;
      process.env.META_LEADS_FILE = '/tmp/explicit-meta-leads.json';
      assert.equal(leadsStore.metaLeadsFilePath(), '/tmp/explicit-meta-leads.json');

      delete process.env.META_LEADS_FILE;
      assert.equal(
        leadsStore.metaLeadsFilePath(),
        path.join(__dirname, '..', 'data', 'meta-leads.json')
      );
    } finally {
      process.env.DATA_DIR = previousData;
      if (previousFile === undefined) delete process.env.META_LEADS_FILE;
      else process.env.META_LEADS_FILE = previousFile;
    }
  });

  test('leads survive a restart by reloading DATA_DIR', async () => {
    resetStore();
    delete process.env.META_ACCESS_TOKEN;
    const posted = await postLead('restart-1');
    assert.equal(posted.status, 200);

    const file = leadsFile();
    assert.equal(file, path.join(process.env.DATA_DIR, 'meta-leads.json'));
    assert.equal(fs.existsSync(path.join(__dirname, '..', 'data', 'meta-leads.json')), false);
    const onDisk = readFileLeads();
    assert.equal(onDisk.length, 1);
    assert.equal(onDisk[0].leadgenId, 'restart-1');
    assert.equal(onDisk[0].formId, 'form-77');
    assert.equal(onDisk[0].pageId, 'page-88');
    assert.equal(onDisk[0].createdTime, 1690002222);

    const resolved = require.resolve('../meta-leads');
    const previous = require.cache[resolved];
    delete require.cache[resolved];
    try {
      const reloaded = require('../meta-leads');
      const fromNewProcess = reloaded.readStoredMetaLeads();
      assert.equal(fromNewProcess.length, 1);
      assert.equal(fromNewProcess[0].leadgenId, 'restart-1');
      assert.equal(fromNewProcess[0].email, null);
    } finally {
      require.cache[resolved] = previous;
    }

    const seeded = readFileLeads();
    seeded.push({
      leadgenId: 'restart-2',
      formId: 'form-2',
      pageId: 'page-2',
      createdTime: 1690003333,
      receivedAt: new Date().toISOString(),
      fieldsFetched: true,
      email: 'kept@example.com',
      name: 'Kept',
    });
    writeFileLeads(seeded);

    const listed = await pending();
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.json.map((lead) => lead.leadgenId).sort(), ['restart-1', 'restart-2']);
    assert.equal(listed.json.find((lead) => lead.leadgenId === 'restart-2').email, 'kept@example.com');
    assert.deepEqual(readFileLeads().map((lead) => lead.leadgenId).sort(), ['restart-1', 'restart-2']);
    assert.deepEqual(fs.readdirSync(dataDir).filter((name) => name.endsWith('.tmp')), []);
  });

  test('pending returns leadgen ids and does not delete them', async () => {
    resetStore();
    writeFileLeads([
      {
        leadgenId: 'keep-a',
        receivedAt: new Date().toISOString(),
        fieldsFetched: true,
        email: 'a@example.com',
      },
      {
        leadgenId: 'keep-b',
        receivedAt: new Date().toISOString(),
        fieldsFetched: true,
        email: 'b@example.com',
      },
    ]);

    const denied = await request('GET', '/meta/leads/pending?secret=meta-verify-test');
    assert.equal(denied.status, 401);
    assert.equal(readFileLeads().length, 2);

    const first = await pending();
    assert.equal(first.status, 200);
    assert.deepEqual(first.json.map((lead) => lead.leadgenId), ['keep-a', 'keep-b']);
    const second = await pending();
    assert.equal(second.status, 200);
    assert.deepEqual(second.json.map((lead) => lead.leadgenId), ['keep-a', 'keep-b']);
    assert.deepEqual(readFileLeads().map((lead) => lead.leadgenId), ['keep-a', 'keep-b']);
  });

  test('ack deletes only the listed leadgen ids', async () => {
    resetStore();
    writeFileLeads([
      { leadgenId: 'ack-a', receivedAt: new Date().toISOString(), fieldsFetched: true, email: 'a@example.com' },
      { leadgenId: 'ack-b', receivedAt: new Date().toISOString(), fieldsFetched: true, email: 'b@example.com' },
      { leadgenId: 'ack-c', receivedAt: new Date().toISOString(), fieldsFetched: true, email: 'c@example.com' },
    ]);

    const noKey = await ack(['ack-a'], {});
    assert.equal(noKey.status, 401);
    assert.deepEqual(readFileLeads().map((lead) => lead.leadgenId), ['ack-a', 'ack-b', 'ack-c']);

    const queryOnly = await request('POST', '/meta/leads/ack?secret=meta-verify-test', {
      json: { leadgenIds: ['ack-a'] },
    });
    assert.equal(queryOnly.status, 401);
    assert.equal(readFileLeads().length, 3);

    const badBody = await request('POST', '/meta/leads/ack', {
      headers: authHeaders(),
      json: { leadgenIds: 'ack-a' },
    });
    assert.equal(badBody.status, 400);
    assert.deepEqual(badBody.json, { error: 'leadgenIds must be an array' });
    assert.equal(readFileLeads().length, 3);

    const bearer = await ack(['ack-a', 'missing-id'], { authorization: `Bearer ${KEY}` });
    assert.equal(bearer.status, 200);
    assert.equal(bearer.json.removed, 1);
    assert.deepEqual(readFileLeads().map((lead) => lead.leadgenId), ['ack-b', 'ack-c']);

    const listed = await pending();
    assert.deepEqual(listed.json.map((lead) => lead.leadgenId), ['ack-b', 'ack-c']);

    const again = await ack(['ack-a']);
    assert.equal(again.status, 200);
    assert.equal(again.json.removed, 0);
    assert.deepEqual(readFileLeads().map((lead) => lead.leadgenId), ['ack-b', 'ack-c']);

    const rest = await ack(['ack-c']);
    assert.equal(rest.json.removed, 1);
    assert.deepEqual(readFileLeads().map((lead) => lead.leadgenId), ['ack-b']);
  });

  test('retention prune drops leads older than META_LEADS_RETENTION_DAYS', async () => {
    delete process.env.META_LEADS_RETENTION_DAYS;
    writeFileLeads([
      { leadgenId: 'old-31', receivedAt: isoDaysAgo(31), fieldsFetched: true, email: 'old@example.com' },
      { leadgenId: 'new-1', receivedAt: isoDaysAgo(1), fieldsFetched: true, email: 'new@example.com' },
    ]);
    const defaults = await pending();
    assert.equal(defaults.status, 200);
    assert.deepEqual(defaults.json.map((lead) => lead.leadgenId), ['new-1']);
    assert.deepEqual(readFileLeads().map((lead) => lead.leadgenId), ['new-1']);

    process.env.META_LEADS_RETENTION_DAYS = '10';
    try {
      writeFileLeads([
        { leadgenId: 'old-11', receivedAt: isoDaysAgo(11), fieldsFetched: true, email: 'old11@example.com' },
        { leadgenId: 'new-9', receivedAt: isoDaysAgo(9), fieldsFetched: true, email: 'new9@example.com' },
      ]);
      const custom = await pending();
      assert.deepEqual(custom.json.map((lead) => lead.leadgenId), ['new-9']);
      assert.deepEqual(readFileLeads().map((lead) => lead.leadgenId), ['new-9']);
    } finally {
      delete process.env.META_LEADS_RETENTION_DAYS;
    }
  });

  test('a duplicate webhook is stored once and a failed field fetch is retried', async () => {
    resetStore();
    process.env.META_ACCESS_TOKEN = 'test-meta-token';
    leadsStore.setMetaGraphFetch(async () => {
      throw new Error('graph down');
    });
    try {
      const unsigned = await postLead('dup-1', { signature: 'sha256=00' });
      assert.equal(unsigned.status, 401);
      assert.equal(fs.existsSync(leadsFile()) && readFileLeads().length === 0, true);

      const first = await postLead(['dup-1', 'dup-2']);
      assert.equal(first.status, 200);
      const second = await postLead('dup-1');
      assert.equal(second.status, 200);

      const stored = readFileLeads();
      assert.deepEqual(stored.map((lead) => lead.leadgenId), ['dup-1', 'dup-2']);
      assert.equal(stored[0].formId, 'form-77');
      assert.equal(stored[0].pageId, 'page-88');
      assert.equal(stored[0].createdTime, 1690002222);
      assert.equal(stored[0].fieldsFetched, false);
      assert.equal(stored[0].email, null);
      assert.equal(stored[1].email, null);

      const stillRaw = await pending();
      assert.equal(stillRaw.status, 200);
      assert.equal(stillRaw.json[0].fieldsFetched, false);
      assert.equal(stillRaw.json[0].leadgenId, 'dup-1');
      assert.equal(readFileLeads().length, 2);

      leadsStore.setMetaGraphFetch(graphOk());
      const filled = await pending();
      assert.equal(filled.status, 200);
      assert.equal(filled.json.length, 2);
      const enriched = filled.json.find((lead) => lead.leadgenId === 'dup-1');
      assert.equal(enriched.email, 'ada@example.com');
      assert.equal(enriched.name, 'Ada Lovelace');
      assert.equal(enriched.phone, '07000900000');
      assert.equal(enriched.fieldsFetched, true);
      assert.equal(enriched.formId, 'form-77');
      assert.equal(enriched.pageId, 'page-88');
      assert.equal(enriched.createdTime, 1690002222);
      assert.equal(readFileLeads().length, 2);
      assert.equal(readFileLeads()[0].email, 'ada@example.com');

      leadsStore.setMetaGraphFetch(async () => {
        throw new Error('graph down');
      });
      const replay = await postLead('dup-1');
      assert.equal(replay.status, 200);
      const afterReplay = readFileLeads();
      assert.equal(afterReplay.length, 2);
      assert.equal(afterReplay[0].email, 'ada@example.com');
      assert.equal(afterReplay[0].fieldsFetched, true);

      const stillThere = await pending();
      assert.equal(stillThere.json.find((lead) => lead.leadgenId === 'dup-1').email, 'ada@example.com');
      assert.equal(readFileLeads().length, 2);
    } finally {
      delete process.env.META_ACCESS_TOKEN;
      leadsStore.setMetaGraphFetch(async () => {
        throw new Error('graph down');
      });
    }
  });

  test('a corrupt leads file is not replaced with an empty list', async () => {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(leadsFile(), '{');
    try {
      const listed = await pending();
      assert.equal(listed.status, 500);
      assert.equal(fs.readFileSync(leadsFile(), 'utf8'), '{');
      const acked = await ack(['anything']);
      assert.equal(acked.status, 500);
      assert.equal(fs.readFileSync(leadsFile(), 'utf8'), '{');
    } finally {
      resetStore();
    }
  });
});
