const { describe, before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { MISSING_BIB_SECRET_WARNING } = require('../relay-auth');

const KEY = 'test-relay-key';
const BIB_SECRET = 'test-bib-lead-secret';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-bib-'));

process.env.DATA_DIR = dataDir;
process.env.CAMPAIGN_DATA_DIR = path.join(dataDir, 'campaigns');
delete process.env.META_LEADS_FILE;
delete process.env.META_LEADS_RETENTION_DAYS;
delete process.env.META_ACCESS_TOKEN;
process.env.RELAY_API_KEY = KEY;
process.env.BIB_LEAD_SECRET = BIB_SECRET;
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

function ackedFile() {
  return path.join(dataDir, 'acked-bib-ids.json');
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
  if (fs.existsSync(ackedFile())) fs.unlinkSync(ackedFile());
}

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function signBib(raw, secret = BIB_SECRET) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
}

function postBib(payload, { raw, signature, headers } = {}) {
  const body = raw != null ? raw : JSON.stringify(payload);
  const sig = signature === undefined ? signBib(body) : signature;
  const reqHeaders = { ...headers };
  if (sig != null) reqHeaders['x-bib-signature'] = sig;
  return request('POST', '/bib/lead', { body, headers: reqHeaders });
}

function authHeaders(extra = {}) {
  return { 'x-relay-key': KEY, ...extra };
}

function pending() {
  return request('GET', '/meta/leads/pending', { headers: authHeaders() });
}

function ack(ids) {
  return request('POST', '/meta/leads/ack', { headers: authHeaders(), json: { leadgenIds: ids } });
}

function lead(overrides = {}) {
  return {
    id: 'bib:42',
    name: 'Ada Lovelace',
    email: 'Ada@Example.com',
    phone: '07000900000',
    company: 'Analytical Engines',
    need: 'Staff polos',
    quantity: '12',
    summary: 'Needs embroidered polos before Friday.',
    extra: {
      staffCount: 12,
      logoReady: false,
      deadline: 'Friday',
      pageUrl: 'https://branditessex.com/pages/workwear',
      utm: { source: 'chat' },
      transcriptUrl: 'https://branditessex.com/bib/transcripts/42',
      leadScore: 0.8,
      consent: true,
    },
    ...overrides,
  };
}

describe('B.I.B website leads', { concurrency: false }, () => {
  before(async () => {
    leadsStore.setMetaGraphFetch(async () => {
      throw new Error('graph should not be called');
    });
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    leadsStore.setMetaGraphFetch(null);
    delete process.env.META_ACCESS_TOKEN;
    delete process.env.META_LEADS_RETENTION_DAYS;
    process.env.BIB_LEAD_SECRET = BIB_SECRET;
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('a signed lead is stored and a bad signature is refused', async () => {
    resetStore();
    const raw = JSON.stringify(lead());
    const ok = await postBib(null, { raw });
    assert.equal(ok.status, 201);
    assert.deepEqual(ok.json, { ok: true });

    const stored = readFileLeads();
    assert.equal(stored.length, 1);
    assert.equal(stored[0].leadgenId, 'bib:42');
    assert.equal(stored[0].source, 'bib');
    assert.equal(stored[0].fieldsFetched, true);
    assert.equal(stored[0].detailsStatus, 'fetched');
    assert.equal(stored[0].email, 'ada@example.com');
    assert.equal(stored[0].name, 'Ada Lovelace');
    assert.equal(stored[0].summary, 'Needs embroidered polos before Friday.');
    assert.equal(stored[0].extra.staffCount, 12);
    assert.equal(stored[0].extra.consent, true);
    assert.equal(stored[0].extra.logoReady, false);

    const spaced = '{"id":"bib:7","email":"ada@example.com","name":"Ada"}';
    const exact = await postBib(null, { raw: spaced });
    assert.equal(exact.status, 201);
    assert.equal(readFileLeads().find((item) => item.leadgenId === 'bib:7').name, 'Ada');

    const bad = await postBib(lead({ id: 'bib:bad' }), { signature: 'sha256=' + 'ab'.repeat(32) });
    assert.equal(bad.status, 401);
    assert.deepEqual(bad.json, { error: 'Unauthorized' });
    assert.equal(readFileLeads().some((item) => item.leadgenId === 'bib:bad'), false);

    const missingHeader = await postBib(lead({ id: 'bib:no-header' }), { signature: null });
    assert.equal(missingHeader.status, 401);
    assert.equal(readFileLeads().some((item) => item.leadgenId === 'bib:no-header'), false);

    const wrongSecret = signBib(JSON.stringify(lead({ id: 'bib:other-secret' })), 'other-secret');
    const other = await postBib(lead({ id: 'bib:other-secret' }), { signature: wrongSecret });
    assert.equal(other.status, 401);

    const relayOnly = await postBib(lead({ id: 'bib:relay' }), {
      signature: null,
      headers: { 'x-relay-key': KEY },
    });
    assert.equal(relayOnly.status, 401);
    assert.equal(readFileLeads().some((item) => item.leadgenId === 'bib:relay'), false);

    const relayDoesNotOverride = await postBib(lead({ id: 'bib:relay-bad' }), {
      signature: 'sha256=' + 'cd'.repeat(32),
      headers: { 'x-relay-key': KEY, authorization: `Bearer ${KEY}` },
    });
    assert.equal(relayDoesNotOverride.status, 401);
    assert.equal(fs.existsSync(ackedFile()), false);
  });

  test('missing BIB_LEAD_SECRET fails closed and warns once', async () => {
    resetStore();
    const lines = [];
    const original = console.warn;
    console.warn = (...args) => { lines.push(args.map(String).join(' ')); };
    const previous = process.env.BIB_LEAD_SECRET;
    try {
      delete process.env.BIB_LEAD_SECRET;
      const first = await postBib(lead({ id: 'bib:unconfigured' }));
      assert.equal(first.status, 503);
      assert.deepEqual(first.json, { error: 'Unavailable' });
      assert.deepEqual(lines, [MISSING_BIB_SECRET_WARNING]);

      const second = await postBib(lead({ id: 'bib:unconfigured-2' }), {
        headers: { 'x-relay-key': KEY },
      });
      assert.equal(second.status, 503);
      assert.deepEqual(lines, [MISSING_BIB_SECRET_WARNING]);

      process.env.BIB_LEAD_SECRET = '';
      const empty = await postBib(lead());
      assert.equal(empty.status, 503);

      process.env.BIB_LEAD_SECRET = '   ';
      const blank = await postBib(lead());
      assert.equal(blank.status, 503);
      assert.deepEqual(lines, [MISSING_BIB_SECRET_WARNING]);
      assert.equal(readFileLeads().length, 0);
    } finally {
      console.warn = original;
      process.env.BIB_LEAD_SECRET = previous;
    }
  });

  test('missing id and invalid email are 400 and store nothing', async () => {
    resetStore();
    const emails = [undefined, '', '   ', 'not-an-email', 'a@b', 'a@b.', 'ada@@example.com', 'ada @example.com', 12];
    for (const email of emails) {
      const body = lead({ id: 'bib:mail-' + String(email), email });
      if (email === undefined) delete body.email;
      const res = await postBib(body);
      assert.equal(res.status, 400, JSON.stringify(email));
      assert.deepEqual(res.json, { error: 'email is invalid' });
    }

    const ids = [undefined, '', '   ', null, {}, '\u0000\n'];
    for (const id of ids) {
      const body = lead({ email: 'ada@example.com' });
      if (id === undefined) delete body.id;
      else body.id = id;
      const res = await postBib(body);
      assert.equal(res.status, 400, JSON.stringify(id));
      assert.deepEqual(res.json, { error: 'id is required' });
    }

    const unsigned = await postBib({ id: '', email: 'not-an-email' }, { signature: null });
    assert.equal(unsigned.status, 401);
    assert.equal(readFileLeads().length, 0);
  });

  test('the same id is stored once, and an acked id is not created again', async () => {
    resetStore();
    writeFileLeads([
      { leadgenId: 'meta-keep', receivedAt: new Date().toISOString(), fieldsFetched: true, email: 'meta@example.com' },
    ]);

    const first = await postBib(lead({ id: 'chat-9', email: 'ada@example.com' }));
    assert.equal(first.status, 201);
    const second = await postBib(lead({ id: 'bib:chat-9', email: 'other@example.com', name: 'Replacement' }));
    assert.equal(second.status, 200);
    assert.deepEqual(second.json, { ok: true, duplicate: true });

    const stored = readFileLeads();
    assert.deepEqual(stored.map((item) => item.leadgenId), ['meta-keep', 'bib:chat-9']);
    assert.equal(stored[1].email, 'ada@example.com');
    assert.equal(stored[1].name, 'Ada Lovelace');

    const acked = await ack(['bib:chat-9']);
    assert.equal(acked.status, 200);
    assert.equal(acked.json.removed, 1);
    assert.deepEqual(readFileLeads().map((item) => item.leadgenId), ['meta-keep']);
    const remembered = JSON.parse(fs.readFileSync(ackedFile(), 'utf8'));
    assert.equal(typeof remembered['bib:chat-9'], 'string');
    assert.equal(Object.keys(remembered).length, 1);

    const retry = await postBib(lead({ id: 'chat-9', email: 'ada@example.com', name: 'Again' }));
    assert.equal(retry.status, 200);
    assert.deepEqual(retry.json, { ok: true, duplicate: true });
    assert.deepEqual(readFileLeads().map((item) => item.leadgenId), ['meta-keep']);

    const listed = await pending();
    assert.deepEqual(listed.json.map((item) => item.leadgenId), ['meta-keep']);
  });

  test('bib:42 and 42 are one leadgen id', async () => {
    resetStore();
    const prefixed = await postBib(lead({ id: 'bib:42', email: 'ada@example.com' }));
    assert.equal(prefixed.status, 201);
    const bare = await postBib(lead({ id: '42', email: 'ada@example.com' }));
    assert.equal(bare.status, 200);
    assert.deepEqual(bare.json, { ok: true, duplicate: true });
    assert.equal(readFileLeads().length, 1);
    assert.equal(readFileLeads()[0].leadgenId, 'bib:42');

    resetStore();
    const bareFirst = await postBib(lead({ id: '42', email: 'ada@example.com' }));
    assert.equal(bareFirst.status, 201);
    const prefixedSecond = await postBib(lead({ id: 'bib:42', email: 'ada@example.com' }));
    assert.equal(prefixedSecond.status, 200);
    assert.deepEqual(prefixedSecond.json, { ok: true, duplicate: true });
    assert.deepEqual(readFileLeads().map((item) => item.leadgenId), ['bib:42']);

    const numeric = await postBib(lead({ id: 43, email: 'ada@example.com' }));
    assert.equal(numeric.status, 201);
    assert.equal(readFileLeads().find((item) => item.leadgenId === 'bib:43').leadgenId, 'bib:43');
  });

  test('pending returns bib fields and does not call Graph', async () => {
    resetStore();
    process.env.META_ACCESS_TOKEN = 'test-meta-token';
    let calls = 0;
    leadsStore.setMetaGraphFetch(async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          field_data: [{ name: 'email', values: ['graph@example.com'] }],
          created_time: '2024-06-01T00:00:00+0000',
        }),
      };
    });
    try {
      assert.equal(leadsStore.shouldTryFetch({
        leadgenId: 'bib:raw',
        source: 'bib',
        fieldsFetched: false,
      }), false);
      assert.equal(leadsStore.shouldTryFetch({
        leadgenId: 'bib:ready',
        source: 'bib',
        fieldsFetched: true,
      }), false);

      writeFileLeads([{
        leadgenId: 'bib:raw',
        source: 'bib',
        fieldsFetched: false,
        detailsStatus: 'fetched',
        receivedAt: new Date().toISOString(),
        createdTime: '2024-01-01T00:00:00.000Z',
        name: 'Kept',
        email: 'kept@example.com',
        phone: '07000111222',
        company: 'Kept Co',
        need: 'Jackets',
        quantity: '3',
        summary: 'Already here',
        extra: { consent: true },
      }]);

      const posted = await postBib(lead({ id: 'bib:live', email: 'Ada@Example.com', summary: 'From the chat' }));
      assert.equal(posted.status, 201);

      const listed = await pending();
      assert.equal(listed.status, 200);
      assert.equal(calls, 0);
      const raw = listed.json.find((item) => item.leadgenId === 'bib:raw');
      assert.equal(raw.email, 'kept@example.com');
      assert.equal(raw.name, 'Kept');
      assert.equal(raw.summary, 'Already here');
      assert.equal(raw.fieldsFetched, false);
      assert.equal(raw.source, 'bib');
      const live = listed.json.find((item) => item.leadgenId === 'bib:live');
      assert.equal(live.email, 'ada@example.com');
      assert.equal(live.summary, 'From the chat');
      assert.equal(live.phone, '07000900000');
      assert.equal(live.company, 'Analytical Engines');
      assert.equal(live.need, 'Staff polos');
      assert.equal(live.quantity, '12');
      assert.equal(live.extra.pageUrl, 'https://branditessex.com/pages/workwear');
      assert.deepEqual(live.extra.utm, { source: 'chat' });
      assert.equal(live.fieldsFetched, true);
      assert.equal(live.detailsStatus, 'fetched');
      assert.equal(readFileLeads().find((item) => item.leadgenId === 'bib:raw').email, 'kept@example.com');
    } finally {
      delete process.env.META_ACCESS_TOKEN;
      leadsStore.setMetaGraphFetch(async () => {
        throw new Error('graph should not be called');
      });
    }
  });

  test('field length limits, control characters, and extra keys', async () => {
    resetStore();
    const res = await postBib(lead({
      id: '  limits  ',
      email: '  Limits@Example.com ',
      name: 'N'.repeat(250),
      phone: ' 07\u0000\n123 ',
      company: 'C'.repeat(10) + '\u0007',
      need: ' hoodies ',
      quantity: 40,
      summary: 'S'.repeat(2500),
      extra: {
        staffCount: 4,
        logoReady: 'yes',
        deadline: 'D'.repeat(250),
        pageUrl: 'u'.repeat(600),
        utm: { source: 'chat', campaign: 'C'.repeat(250), nested: { a: 1 } },
        transcriptUrl: 't'.repeat(600),
        leadScore: 1,
        consent: false,
        ignored: 'nope',
      },
    }));
    assert.equal(res.status, 201);

    const stored = readFileLeads()[0];
    assert.equal(stored.leadgenId, 'bib:limits');
    assert.equal(stored.email, 'limits@example.com');
    assert.equal(stored.name, 'N'.repeat(200));
    assert.equal(stored.phone, '07123');
    assert.equal(stored.company, 'C'.repeat(10));
    assert.equal(stored.need, 'hoodies');
    assert.equal(stored.quantity, '40');
    assert.equal(stored.summary.length, 2000);
    assert.equal(stored.summary, 'S'.repeat(2000));
    assert.deepEqual(Object.keys(stored.extra), [
      'staffCount',
      'logoReady',
      'deadline',
      'pageUrl',
      'utm',
      'transcriptUrl',
      'leadScore',
      'consent',
    ]);
    assert.equal(stored.extra.staffCount, 4);
    assert.equal(stored.extra.logoReady, null);
    assert.equal(stored.extra.deadline, 'D'.repeat(200));
    assert.equal(stored.extra.pageUrl.length, 500);
    assert.equal(stored.extra.transcriptUrl.length, 500);
    assert.deepEqual(stored.extra.utm, { source: 'chat', campaign: 'C'.repeat(200) });
    assert.equal(stored.extra.leadScore, 1);
    assert.equal(stored.extra.consent, false);
    assert.equal(stored.extra.ignored, undefined);

    const utmString = await postBib(lead({
      id: 'utm-string',
      email: 'ada@example.com',
      extra: { utm: ' source '.repeat(80) },
    }));
    assert.equal(utmString.status, 201);
    const utm = readFileLeads().find((item) => item.leadgenId === 'bib:utm-string').extra.utm;
    assert.equal(typeof utm, 'string');
    assert.ok(utm.length <= 200);
    assert.equal(utm.startsWith('source'), true);
  });

  test('an acked bib id older than retention can be stored again', async () => {
    resetStore();
    process.env.META_LEADS_RETENTION_DAYS = '1';
    try {
      fs.writeFileSync(ackedFile(), JSON.stringify({
        'bib:old': isoDaysAgo(3),
        'bib:fresh': new Date().toISOString(),
      }));
      const old = await postBib(lead({ id: 'old', email: 'old@example.com' }));
      assert.equal(old.status, 201);
      const fresh = await postBib(lead({ id: 'fresh', email: 'fresh@example.com' }));
      assert.equal(fresh.status, 200);
      assert.deepEqual(fresh.json, { ok: true, duplicate: true });
      assert.deepEqual(readFileLeads().map((item) => item.leadgenId), ['bib:old']);
      const remembered = JSON.parse(fs.readFileSync(ackedFile(), 'utf8'));
      assert.equal(remembered['bib:old'], undefined);
      assert.equal(typeof remembered['bib:fresh'], 'string');
    } finally {
      delete process.env.META_LEADS_RETENTION_DAYS;
    }
  });
});
