const { describe, before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { signLink } = require('../link-sign');

const KEY = 'test-relay-key';
const LINK_SECRET = 'test-link-secret';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-links-'));
process.env.CAMPAIGN_DATA_DIR = dataDir;
process.env.META_LEADS_FILE = path.join(dataDir, 'meta-leads.json');
process.env.RELAY_API_KEY = KEY;
process.env.RELAY_LINK_SECRET = LINK_SECRET;
process.env.META_VERIFY_TOKEN = 'meta-verify-test';
process.env.UNSUBSCRIBE_SECRET = 'unsubscribe-test-secret';
delete process.env.RELAY_REQUIRE_SIGNED_LINKS;
delete process.env.RELAY_REDIRECT_ALLOWLIST;
delete process.env.RELAY_REDIRECT_FALLBACK;
delete process.env.SHOPIFY_STORE;
delete process.env.SHOPIFY_DOMAIN;
delete process.env.SHOPIFY_ADMIN_TOKEN;
delete process.env.SHOPIFY_WEBHOOK_SECRET;
delete process.env.META_APP_SECRET;
delete process.env.META_ACCESS_TOKEN;
delete process.env.META_LEADS_SECRET;
delete process.env.RESEND_API_KEY;

const app = require('../index');

let server;
let port;

function request(method, urlPath, { headers = {}, json, body, contentType } = {}) {
  const payload = body != null
    ? Buffer.from(body)
    : (json === undefined ? null : Buffer.from(JSON.stringify(json)));
  return new Promise((resolve, reject) => {
    const reqHeaders = { ...headers };
    if (payload) {
      reqHeaders['content-type'] = contentType || reqHeaders['content-type'] || 'application/json';
      reqHeaders['content-length'] = String(payload.length);
    }
    const req = http.request({
      method,
      hostname: '127.0.0.1',
      port,
      path: urlPath,
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

function signedUrl(urlPath, query) {
  const sig = signLink(urlPath, query, process.env.RELAY_LINK_SECRET);
  const params = new URLSearchParams();
  for (const key of Object.keys(query)) params.append(key, query[key]);
  params.append('sig', sig);
  return `${urlPath}?${params.toString()}`;
}

function unsubToken(email) {
  return crypto.createHmac('sha256', process.env.UNSUBSCRIBE_SECRET).update(email.trim().toLowerCase()).digest('hex');
}

function readEvents(id) {
  const file = path.join(dataDir, `${id}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function waitEvents(id) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const found = readEvents(id);
      if (found && found.length) return resolve(found);
      if (Date.now() - start > 1000) return reject(new Error(`no events for ${id}`));
      setTimeout(tick, 15);
    };
    tick();
  });
}

describe('public email links and webhooks', { concurrency: false }, () => {
  const saved = {};

  before(async () => {
    for (const name of ['RELAY_LINK_SECRET', 'RELAY_REQUIRE_SIGNED_LINKS', 'RELAY_REDIRECT_ALLOWLIST', 'RELAY_REDIRECT_FALLBACK', 'SHOPIFY_STORE', 'META_VERIFY_TOKEN', 'META_APP_SECRET', 'SHOPIFY_WEBHOOK_SECRET']) {
      saved[name] = process.env[name];
    }
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  test('signed pixel is counted and a bad signature is not', async () => {
    const openPath = '/track/open/signedcamp/cust';
    const ok = await request('GET', signedUrl(openPath, {}));
    assert.equal(ok.status, 200);
    assert.match(ok.headers['content-type'], /image\/gif/);
    assert.equal((await waitEvents('signedcamp'))[0].customerId, 'cust');

    const upperPath = '/track/open/uppercamp/cust';
    const upper = signLink(upperPath, {}, LINK_SECRET).toUpperCase();
    const upperRes = await request('GET', `${upperPath}?sig=${upper}`);
    assert.equal(upperRes.status, 200);

    const bad = await request('GET', '/track/open/badsigcamp/cust?sig=00');
    assert.equal(bad.status, 403);
    assert.deepEqual(bad.json, { error: 'Invalid link' });
    assert.equal(readEvents('badsigcamp'), null);

    const dup = await request('GET', `/track/open/dupcamp/cust?sig=${signLink('/track/open/dupcamp/cust', {}, LINK_SECRET)}&sig=00`);
    assert.equal(dup.status, 403);
    assert.equal(readEvents('dupcamp'), null);
  });

  test('unsigned pixels still return the image and are logged without the customer id', async () => {
    const lines = [];
    const original = console.warn;
    console.warn = (...args) => { lines.push(args.map(String).join(' ')); };
    try {
      const res = await request('GET', '/track/open/unsigcamp/secret-customer');
      assert.equal(res.status, 200);
      assert.match(res.headers['content-type'], /image\/gif/);
      const logged = lines.filter((line) => line.includes('unsigned link accepted'));
      assert.ok(logged.length >= 1);
      assert.equal(logged.some((line) => line.includes('secret-customer')), false);
      assert.equal((await waitEvents('unsigcamp'))[0].customerId, 'secret-customer');

      const blank = await request('GET', '/track/open/blanksig/cust?sig=');
      assert.equal(blank.status, 200);
    } finally {
      console.warn = original;
    }
  });

  test('strict mode rejects unsigned pixels and still accepts a valid signature', async () => {
    process.env.RELAY_REQUIRE_SIGNED_LINKS = 'true';
    try {
      const denied = await request('GET', '/track/open/strictcamp/cust');
      assert.equal(denied.status, 403);
      assert.equal(readEvents('strictcamp'), null);
      const ok = await request('GET', signedUrl('/track/open/strictok/cust', {}));
      assert.equal(ok.status, 200);
    } finally {
      delete process.env.RELAY_REQUIRE_SIGNED_LINKS;
    }
  });

  test('signed clicks may leave the allowlist; unsigned clicks may not', async () => {
    const evil = 'https://evil.example/phish';
    const signed = await request('GET', signedUrl('/track/click/sigcamp/cust/' + encodeURIComponent(evil), { block: 'Hero Block' }));
    assert.equal(signed.status, 302);
    assert.equal(signed.headers.location, evil);
    assert.equal(readEvents('sigcamp')[0].block, 'Hero Block');
    assert.equal(readEvents('sigcamp')[0].url, evil);

    const unsigned = await request('GET', '/track/click/rewritecamp/cust/' + encodeURIComponent(evil));
    assert.equal(unsigned.status, 302);
    assert.equal(unsigned.headers.location, 'https://branditessex.com/');

    for (const dest of [
      'https://www.branditessex.com/a',
      'https://uvrvii-wd.myshopify.com/cart',
      'https://branditessex.com/collections/polos',
    ]) {
      const res = await request('GET', '/track/click/allowcamp/cust/' + encodeURIComponent(dest));
      assert.equal(res.status, 302, dest);
      assert.equal(res.headers.location, dest);
    }

    const lookalike = await request('GET', '/track/click/lookcamp/cust/' + encodeURIComponent('https://branditessex.com.evil.com/a'));
    assert.equal(lookalike.headers.location, 'https://branditessex.com/');

    const creds = await request('GET', '/track/click/credcamp/cust/' + encodeURIComponent('https://user:pass@branditessex.com/a'));
    assert.equal(creds.headers.location, 'https://branditessex.com/');

    const script = await request('GET', signedUrl('/track/click/jscamp/cust/' + encodeURIComponent('javascript:alert(1)'), {}));
    assert.equal(script.status, 302);
    assert.equal(script.headers.location, 'https://branditessex.com/');

    const invalid = await request('GET', '/track/click/invalidsig/cust/' + encodeURIComponent('https://branditessex.com/products/polo') + '?sig=deadbeef');
    assert.equal(invalid.status, 403);
    assert.equal(invalid.headers.location, undefined);
  });

  test('allowlist and fallback are configurable', async () => {
    process.env.RELAY_REDIRECT_ALLOWLIST = 'only.example';
    process.env.SHOPIFY_STORE = 'https://shop.example.com';
    process.env.RELAY_REDIRECT_FALLBACK = 'https://branditessex.com/home';
    try {
      const only = await request('GET', '/track/click/al1/c/' + encodeURIComponent('https://only.example/a'));
      assert.equal(only.headers.location, 'https://only.example/a');
      const sub = await request('GET', '/track/click/al1/c/' + encodeURIComponent('https://www.only.example/a'));
      assert.equal(sub.headers.location, 'https://www.only.example/a');
      const shop = await request('GET', '/track/click/al1/c/' + encodeURIComponent('https://shop.example.com/a'));
      assert.equal(shop.headers.location, 'https://shop.example.com/a');
      const bie = await request('GET', '/track/click/al1/c/' + encodeURIComponent('https://branditessex.com/a'));
      assert.equal(bie.headers.location, 'https://branditessex.com/home');
      const nested = await request('GET', '/track/click/al1/c/' + encodeURIComponent('https://only.example.evil.com/a'));
      assert.equal(nested.headers.location, 'https://branditessex.com/home');
    } finally {
      delete process.env.RELAY_REDIRECT_ALLOWLIST;
      delete process.env.SHOPIFY_STORE;
      delete process.env.RELAY_REDIRECT_FALLBACK;
    }
  });

  test('unsubscribe keeps working unsigned, and strict mode requires a signature over the email', async () => {
    const email = 'Person@Example.com';
    const token = unsubToken(email);
    const open = await request('GET', `/unsubscribe?email=${encodeURIComponent(email)}&token=${token}&campaignId=unsubopen`);
    assert.equal(open.status, 200);
    assert.match(open.text, /You have been unsubscribed/);
    assert.equal(readEvents('unsubopen')[0].customerId, email);

    const badSig = await request('GET', `/unsubscribe?email=${encodeURIComponent(email)}&token=${token}&campaignId=unsubbad&sig=00`);
    assert.equal(badSig.status, 403);
    assert.doesNotMatch(badSig.text, /You have been unsubscribed/);
    assert.equal(readEvents('unsubbad'), null);

    process.env.RELAY_REQUIRE_SIGNED_LINKS = 'true';
    try {
      const blocked = await request('GET', `/unsubscribe?email=${encodeURIComponent(email)}&token=${token}&campaignId=unsubstrict`);
      assert.equal(blocked.status, 403);
      assert.doesNotMatch(blocked.text, /You have been unsubscribed/);
      assert.equal(readEvents('unsubstrict'), null);

      const post = await request('POST', `/unsubscribe?email=${encodeURIComponent(email)}&token=${token}`, {
        body: 'List-Unsubscribe=One-Click',
        contentType: 'application/x-www-form-urlencoded',
      });
      assert.equal(post.status, 403);

      const ok = await request('GET', signedUrl('/unsubscribe', { email, token, campaignId: 'unsubsigned' }));
      assert.equal(ok.status, 200);
      assert.match(ok.text, /You have been unsubscribed/);
      assert.equal(readEvents('unsubsigned')[0].customerId, email);

      const other = 'other@example.com';
      const bodySwap = await request('POST', signedUrl('/unsubscribe', { email, token, campaignId: 'unsubbody' }), {
        body: `email=${encodeURIComponent(other)}&token=${unsubToken(other)}`,
        contentType: 'application/x-www-form-urlencoded',
      });
      assert.equal(bodySwap.status, 200);
      assert.equal(readEvents('unsubbody')[0].customerId, email);
    } finally {
      delete process.env.RELAY_REQUIRE_SIGNED_LINKS;
    }
  });

  test('without RELAY_LINK_SECRET, pixels and shop clicks keep working and other hosts go home', async () => {
    const previous = process.env.RELAY_LINK_SECRET;
    delete process.env.RELAY_LINK_SECRET;
    process.env.RELAY_REQUIRE_SIGNED_LINKS = 'true';
    const lines = [];
    const original = console.warn;
    console.warn = (...args) => { lines.push(args.map(String).join(' ')); };
    try {
      const pixel = await request('GET', '/track/open/legacycamp/cust');
      assert.equal(pixel.status, 200);
      const shop = await request('GET', '/track/click/legacycamp/cust/' + encodeURIComponent('https://branditessex.com/page'));
      assert.equal(shop.headers.location, 'https://branditessex.com/page');
      const evil = await request('GET', '/track/click/legacycamp/cust/' + encodeURIComponent('https://evil.example/x'));
      assert.equal(evil.headers.location, 'https://branditessex.com/');
      assert.ok(lines.some((line) => line.includes('RELAY_LINK_SECRET is not set')));
    } finally {
      console.warn = original;
      process.env.RELAY_LINK_SECRET = previous;
      delete process.env.RELAY_REQUIRE_SIGNED_LINKS;
    }
  });

  test('abandoned stats and pending leads require the relay key and do not flush without it', async () => {
    fs.writeFileSync(path.join(dataDir, 'abandoned_statictok.json'), JSON.stringify([{ type: 'open', marker: 'cart-secret-event' }]));
    const denied = await request('GET', '/abandoned/stats?tokens=statictok');
    assert.equal(denied.status, 401);
    assert.equal(denied.text.includes('cart-secret-event'), false);
    const allowed = await request('GET', '/abandoned/stats?tokens=statictok', { headers: { 'x-relay-key': KEY } });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.json.statictok[0].marker, 'cart-secret-event');

    const leadsFile = process.env.META_LEADS_FILE;
    fs.writeFileSync(leadsFile, JSON.stringify([{ email: 'lead-secret@example.com' }]));
    const queryOnly = await request('GET', '/meta/leads/pending?secret=meta-verify-test');
    assert.equal(queryOnly.status, 401);
    assert.equal(fs.readFileSync(leadsFile, 'utf8').includes('lead-secret@example.com'), true);
    const fetched = await request('GET', '/meta/leads/pending', { headers: { authorization: `Bearer ${KEY}` } });
    assert.equal(fetched.status, 200);
    assert.equal(fetched.json[0].email, 'lead-secret@example.com');
    assert.equal(fs.readFileSync(leadsFile, 'utf8'), '[]');
  });

  test('Meta and Shopify webhooks fail closed unless their own signature matches', async () => {
    const raw = JSON.stringify({ entry: [{ changes: [{ value: { leadgen_id: '999' } }] }] });
    const missing = await request('POST', '/meta/lead', { body: raw, contentType: 'application/json' });
    assert.equal(missing.status, 401);

    process.env.META_APP_SECRET = 'meta-app-secret';
    const good = 'sha256=' + crypto.createHmac('sha256', 'meta-app-secret').update(raw).digest('hex');
    const accepted = await request('POST', '/meta/lead', {
      body: raw,
      contentType: 'application/json',
      headers: { 'x-hub-signature-256': good },
    });
    assert.equal(accepted.status, 200);
    const rejected = await request('POST', '/meta/lead', {
      body: raw,
      contentType: 'application/json',
      headers: { 'x-hub-signature-256': 'sha256=00' },
    });
    assert.equal(rejected.status, 401);
    delete process.env.META_APP_SECRET;

    const previousToken = process.env.META_VERIFY_TOKEN;
    delete process.env.META_VERIFY_TOKEN;
    try {
      const challenge = await request('GET', '/meta/lead?hub.mode=subscribe&hub.challenge=999');
      assert.equal(challenge.status, 403);
      assert.notEqual(challenge.text, '999');
    } finally {
      process.env.META_VERIFY_TOKEN = previousToken;
    }
    const challengeOk = await request('GET', '/meta/lead?hub.mode=subscribe&hub.verify_token=meta-verify-test&hub.challenge=12345');
    assert.equal(challengeOk.status, 200);
    assert.equal(challengeOk.text, '12345');

    const shopBody = '{"id":1}';
    const shopMissing = await request('POST', '/shopify/webhook/customers/update', {
      body: shopBody,
      contentType: 'application/json',
      headers: { 'x-shopify-hmac-sha256': 'bm8=' },
    });
    assert.equal(shopMissing.status, 401);
    process.env.SHOPIFY_WEBHOOK_SECRET = 'shopify-whsec';
    const digest = crypto.createHmac('sha256', 'shopify-whsec').update(shopBody).digest('base64');
    const shopOk = await request('POST', '/shopify/webhook/customers/update', {
      body: shopBody,
      contentType: 'application/json',
      headers: { 'x-shopify-hmac-sha256': digest },
    });
    assert.equal(shopOk.status, 200);
    const shopBad = await request('POST', '/shopify/webhook/customers/update', {
      body: shopBody,
      contentType: 'application/json',
      headers: { 'x-shopify-hmac-sha256': 'bm90LXRoZS1kaWdlc3Q=' },
    });
    assert.equal(shopBad.status, 401);
    delete process.env.SHOPIFY_WEBHOOK_SECRET;
  });

  test('invalid JSON does not return a stack trace', async () => {
    const res = await request('POST', '/send', {
      body: '{',
      contentType: 'application/json',
      headers: { 'x-relay-key': KEY },
    });
    assert.equal(res.status, 400);
    assert.deepEqual(res.json, { error: 'Invalid JSON' });
    assert.equal(/node_modules|SyntaxError/.test(res.text), false);
  });
});
