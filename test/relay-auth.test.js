const { describe, before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MISSING_KEY_WARNING } = require('../relay-auth');

const KEY = 'test-relay-key';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-auth-'));
process.env.CAMPAIGN_DATA_DIR = dataDir;
process.env.META_LEADS_FILE = path.join(dataDir, 'meta-leads.json');
process.env.RELAY_API_KEY = KEY;
process.env.META_VERIFY_TOKEN = 'meta-verify-test';
process.env.UNSUBSCRIBE_SECRET = 'unsubscribe-test-secret';
delete process.env.RESEND_API_KEY;

const app = require('../index');

let server;
let base;

function request(method, urlPath, { headers = {}, json } = {}) {
  const payload = json === undefined ? null : Buffer.from(JSON.stringify(json));
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, base);
    const reqHeaders = { ...headers };
    if (payload) {
      reqHeaders['content-type'] = reqHeaders['content-type'] || 'application/json';
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
        const body = Buffer.concat(chunks);
        let parsed = null;
        try { parsed = JSON.parse(body.toString('utf8')); } catch { parsed = null; }
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body,
          text: body.toString('utf8'),
          json: parsed,
        });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

describe('relay shared secret', { concurrency: false }, () => {
  before(async () => {
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
    fs.writeFileSync(path.join(dataDir, 'campauth.json'), JSON.stringify([
      { type: 'open', customerId: 'cust-1', at: '2020-01-01T00:00:00.000Z' },
    ]));
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
    process.env.RELAY_API_KEY = KEY;
  });

  test('POST /send without a key is 401 and does not reach validation', async () => {
    const res = await request('POST', '/send', { json: {} });
    assert.equal(res.status, 401);
    assert.deepEqual(res.json, { error: 'Unauthorized' });
  });

  test('wrong, empty, and different-length keys are 401', async () => {
    for (const headers of [
      { 'x-relay-key': 'wrong' },
      { 'x-relay-key': '' },
      { 'x-relay-key': KEY + KEY },
      { authorization: 'Bearer wrong' },
      { authorization: 'Basic ' + KEY },
    ]) {
      const res = await request('POST', '/send', { headers, json: {} });
      assert.equal(res.status, 401, JSON.stringify(headers));
      assert.deepEqual(res.json, { error: 'Unauthorized' });
    }
  });

  test('X-Relay-Key and Authorization Bearer pass the check before Resend is called', async () => {
    // Missing to/subject/text returns 400 from the existing handler, which
    // runs only after auth and before the Resend request.
    const header = await request('POST', '/send', { headers: { 'x-relay-key': KEY }, json: {} });
    assert.equal(header.status, 400);
    assert.deepEqual(header.json, { error: 'to, subject, and text are required' });

    const bearer = await request('POST', '/send', { headers: { authorization: `Bearer ${KEY}` }, json: {} });
    assert.equal(bearer.status, 400);

    const lower = await request('POST', '/send', { headers: { authorization: `bearer ${KEY}` }, json: {} });
    assert.equal(lower.status, 400);
  });

  test('X-Relay-Key is the value that is checked when both headers are sent', async () => {
    const res = await request('POST', '/send', {
      headers: { 'x-relay-key': 'wrong', authorization: `Bearer ${KEY}` },
      json: {},
    });
    assert.equal(res.status, 401);
  });

  test('campaign stats require the key and hide events without it', async () => {
    const denied = await request('GET', '/campaigns/campauth/stats');
    assert.equal(denied.status, 401);
    assert.deepEqual(denied.json, { error: 'Unauthorized' });
    assert.equal(denied.text.includes('cust-1'), false);

    const allowed = await request('GET', '/campaigns/campauth/stats', {
      headers: { 'x-relay-key': KEY },
    });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.json.opens, 1);
    assert.equal(allowed.json.events[0].customerId, 'cust-1');

    const bearer = await request('GET', '/campaigns/campauth/stats', {
      headers: { authorization: `Bearer ${KEY}` },
    });
    assert.equal(bearer.status, 200);
    assert.equal(bearer.json.opens, 1);
  });

  test('missing RELAY_API_KEY fails closed and logs a warning', async () => {
    const lines = [];
    const original = console.warn;
    console.warn = (...args) => { lines.push(args.map(String).join(' ')); };
    const previous = process.env.RELAY_API_KEY;
    try {
      delete process.env.RELAY_API_KEY;
      const res = await request('GET', '/campaigns/campauth/stats', { headers: { 'x-relay-key': KEY } });
      assert.equal(res.status, 401);
      assert.deepEqual(res.json, { error: 'Unauthorized' });
      assert.equal(res.text.includes('cust-1'), false);
      assert.ok(lines.some((line) => line === MISSING_KEY_WARNING));

      process.env.RELAY_API_KEY = '';
      const empty = await request('POST', '/send', { headers: { 'x-relay-key': KEY }, json: {} });
      assert.equal(empty.status, 401);

      process.env.RELAY_API_KEY = '   ';
      const blank = await request('GET', '/campaigns/campauth/stats', { headers: { 'x-relay-key': '   ' } });
      assert.equal(blank.status, 401);
      assert.equal(blank.text.includes('cust-1'), false);
    } finally {
      console.warn = original;
      process.env.RELAY_API_KEY = previous;
    }
  });

  test('health, tracking, unsubscribe, and Meta routes stay unauthenticated', async () => {
    const health = await request('GET', '/health');
    assert.equal(health.status, 200);
    assert.deepEqual(health.json, { status: 'ok' });

    const pixel = await request('GET', '/track/open/pixelcamp/someone');
    assert.equal(pixel.status, 200);
    assert.match(pixel.headers['content-type'], /image\/gif/);

    const click = await request('GET', '/track/click/pixelcamp/someone/' + encodeURIComponent('https://example.com/x'));
    assert.equal(click.status, 302);
    assert.equal(click.headers.location, 'https://example.com/x');

    const abandonedPixel = await request('GET', '/abandoned/track/open/tok');
    assert.equal(abandonedPixel.status, 200);

    const abandonedClick = await request('GET', '/abandoned/track/click/tok/cart/' + encodeURIComponent('https://example.com/cart'));
    assert.equal(abandonedClick.status, 302);

    const abandonedStats = await request('GET', '/abandoned/stats?tokens=tok');
    assert.equal(abandonedStats.status, 200);

    const unsub = await request('GET', '/unsubscribe?email=person@example.com&token=bad');
    assert.equal(unsub.status, 400);
    assert.match(unsub.text, /Something went wrong/);

    const meta = await request('GET', '/meta/lead?hub.mode=subscribe&hub.verify_token=meta-verify-test&hub.challenge=12345');
    assert.equal(meta.status, 200);
    assert.equal(meta.text, '12345');

    const metaDenied = await request('GET', '/meta/lead?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=12345');
    assert.equal(metaDenied.status, 403);

    const pending = await request('GET', '/meta/leads/pending');
    assert.equal(pending.status, 401);
    assert.equal(pending.text, '');
  });
});
