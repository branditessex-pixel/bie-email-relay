const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const {
  DEFAULT_FALLBACK,
  MISSING_LINK_SECRET_STRICT_WARNING,
  signingPayload,
  signLink,
  verifyLink,
  warnIfLinkSecretMissing,
  resolveClickRedirect,
} = require('../link-sign');

const SECRET = 'example-link-secret';

describe('link signature', { concurrency: false }, () => {
  test('known vectors', () => {
    const openPayload = '/track/open/camp/cust?';
    assert.equal(signingPayload('/track/open/camp/cust', {}), openPayload);
    assert.equal(signLink('/track/open/camp/cust', {}, SECRET), hmac(openPayload));
    assert.equal(hmac(openPayload), '6bfa4942a9765f84b31249abe0b4f1ca0c9d697f53cc3c8fd1e30e7e27e842aa');

    const clickQuery = { z: '1', block: 'Hero Block', sig: 'ignore' };
    const clickPayload = '/track/click/c/u/https%3A%2F%2Fbranditessex.com%2Fsale?block=Hero%20Block&z=1';
    assert.equal(signingPayload('/track/click/c/u/https%3A%2F%2Fbranditessex.com%2Fsale', clickQuery), clickPayload);
    assert.equal(signLink('/track/click/c/u/https%3A%2F%2Fbranditessex.com%2Fsale', clickQuery, SECRET), hmac(clickPayload));
    assert.equal(hmac(clickPayload), 'b08f242df1640eafb6b76ed1baf43f97deb3efef88fd086e783289164a1d06b5');

    const unsubPayload = '/unsubscribe?campaignId=c&email=Person%40Example.com&token=abc';
    assert.equal(signingPayload('/unsubscribe', { token: 'abc', email: 'Person@Example.com', campaignId: 'c' }), unsubPayload);
    assert.equal(hmac(unsubPayload), '8730d58e280834df50e422066c9364e3be06fb1561e55518a1da5f7e7e2f0ca2');
  });

  test('verify accepts only the matching signature', () => {
    const path = '/track/open/camp/cust';
    const sig = signLink(path, {}, SECRET);
    assert.equal(verifyLink(path, { sig }, SECRET), true);
    assert.equal(verifyLink(path, { sig: sig.toUpperCase() }, SECRET), true);
    assert.equal(verifyLink(path, { sig: '00' }, SECRET), false);
    assert.equal(verifyLink(path, {}, SECRET), false);
    assert.equal(verifyLink(path, { sig }, ''), false);
  });

  test('missing link secret warns once', () => {
    const previousSecret = process.env.RELAY_LINK_SECRET;
    const previousStrict = process.env.RELAY_REQUIRE_SIGNED_LINKS;
    delete process.env.RELAY_LINK_SECRET;
    process.env.RELAY_REQUIRE_SIGNED_LINKS = 'true';
    const lines = [];
    const original = console.warn;
    console.warn = (...args) => { lines.push(args.map(String).join(' ')); };
    try {
      warnIfLinkSecretMissing();
      warnIfLinkSecretMissing();
      assert.deepEqual(lines, [MISSING_LINK_SECRET_STRICT_WARNING]);
    } finally {
      console.warn = original;
      restore('RELAY_LINK_SECRET', previousSecret);
      restore('RELAY_REQUIRE_SIGNED_LINKS', previousStrict);
    }
  });

  test('unsigned clicks stay on the allowlist', () => {
    const previousAllow = process.env.RELAY_REDIRECT_ALLOWLIST;
    const previousShop = process.env.SHOPIFY_STORE;
    const previousFallback = process.env.RELAY_REDIRECT_FALLBACK;
    delete process.env.RELAY_REDIRECT_ALLOWLIST;
    delete process.env.SHOPIFY_STORE;
    delete process.env.RELAY_REDIRECT_FALLBACK;
    try {
      assert.equal(resolveClickRedirect('https://evil.example/a').location, DEFAULT_FALLBACK);
      assert.equal(resolveClickRedirect('https://branditessex.com.evil.com/a').location, DEFAULT_FALLBACK);
      assert.equal(resolveClickRedirect('https://user:pass@branditessex.com/a').location, DEFAULT_FALLBACK);
      assert.equal(resolveClickRedirect('javascript:alert(1)').location, DEFAULT_FALLBACK);
      assert.equal(resolveClickRedirect('https://www.branditessex.com/a').toDestination, true);
      assert.equal(resolveClickRedirect('https://uvrvii-wd.myshopify.com/cart').location, 'https://uvrvii-wd.myshopify.com/cart');

      const trusted = resolveClickRedirect('https://evil.example/a', { trusted: true });
      assert.equal(trusted.toDestination, true);
      assert.equal(trusted.location, 'https://evil.example/a');
      assert.equal(resolveClickRedirect('javascript:alert(1)', { trusted: true }).location, DEFAULT_FALLBACK);

      process.env.RELAY_REDIRECT_ALLOWLIST = 'only.example';
      process.env.SHOPIFY_STORE = 'https://shop.example.com';
      assert.equal(resolveClickRedirect('https://only.example/a').toDestination, true);
      assert.equal(resolveClickRedirect('https://www.only.example/a').toDestination, true);
      assert.equal(resolveClickRedirect('https://shop.example.com/a').toDestination, true);
      assert.equal(resolveClickRedirect('https://only.example.evil.com/a').location, DEFAULT_FALLBACK);
      assert.equal(resolveClickRedirect('https://branditessex.com/a').location, DEFAULT_FALLBACK);

      process.env.RELAY_REDIRECT_FALLBACK = 'javascript:alert(1)';
      assert.equal(resolveClickRedirect('https://evil.example/a').location, DEFAULT_FALLBACK);
      process.env.RELAY_REDIRECT_FALLBACK = 'https://branditessex.com/home';
      assert.equal(resolveClickRedirect('https://evil.example/a').location, 'https://branditessex.com/home');
    } finally {
      restore('RELAY_REDIRECT_ALLOWLIST', previousAllow);
      restore('SHOPIFY_STORE', previousShop);
      restore('RELAY_REDIRECT_FALLBACK', previousFallback);
    }
  });
});

function hmac(payload) {
  return crypto.createHmac('sha256', SECRET).update(payload, 'utf8').digest('hex');
}

function restore(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
