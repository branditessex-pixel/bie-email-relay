/**
 * Groundwork CRM integration routes: campaign open/click tracking,
 * unsubscribe (with Shopify marketing-consent sync), a stats endpoint
 * the CRM polls to build its campaign history table, and a Meta Lead Gen
 * webhook that stores incoming leads for the CRM to collect.
 *
 * Campaign event storage is a flat JSON file per campaign under
 * CAMPAIGN_DATA_DIR — Railway's filesystem is ephemeral across deploys
 * and restarts, so open/click/unsubscribe counts are best-effort between
 * sends and the next redeploy.
 *
 * Meta leads are the exception. They are stored by meta-leads.js under
 * DATA_DIR (a mounted volume) and stay there until the CRM acknowledges
 * them. GET /meta/leads/pending does not delete. A restart reloads the file.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const fetch = require('node-fetch');
const { requireRelayKey, safeEqual } = require('./relay-auth');
const { ingestMetaWebhook, listPendingMetaLeads, ackMetaLeads } = require('./meta-leads');
const {
  assessLink,
  linkRejected,
  noteUnsignedLink,
  noteRejectedLink,
  noteClickRewritten,
  resolveClickRedirect,
} = require('./link-sign');

const TRANSPARENT_PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBTAA7',
  'base64'
);

const CAMPAIGN_DIR = process.env.CAMPAIGN_DATA_DIR || path.join(__dirname, 'data', 'campaigns');

function makeToken(secret, email) {
  return crypto.createHmac('sha256', secret).update(email.trim().toLowerCase()).digest('hex');
}

function verifyToken(secret, email, token) {
  if (!secret || !token || !email) return false;
  try {
    const expected = makeToken(secret, email);
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(token));
  } catch (e) {
    return false;
  }
}

function confirmationPage({ ok, email }) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Brand It Essex</title>
  <style>body{font-family:Arial,sans-serif;background:#f9f9f8;color:#111;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
  .card{background:#fff;border:1px solid #e4e3e0;border-radius:12px;padding:40px;max-width:420px;text-align:center}
  h1{font-size:18px;margin:0 0 12px}p{font-size:14px;color:#6b6864;line-height:1.6}
  a{color:#1B5E8B}</style></head>
  <body><div class="card">
    <h1>${ok ? 'You have been unsubscribed' : 'Something went wrong'}</h1>
    <p>${ok ? `You have been unsubscribed from Brand It Essex marketing emails. You will no longer receive promotional emails from us.` : 'This unsubscribe link is invalid or has expired. Please contact us on WhatsApp if you keep receiving emails.'}</p>
    <p><a href="https://branditessex.com">branditessex.com</a></p>
  </div></body></html>`;
}

async function updateShopifyMarketingConsent({ domain, adminToken, email, unsubscribe }) {
  const search = await fetch(`https://${domain}/admin/api/2024-10/customers/search.json?query=${encodeURIComponent('email:' + email)}`, {
    headers: { 'X-Shopify-Access-Token': adminToken }
  }).then((r) => r.json());
  const customer = search.customers && search.customers[0];
  if (!customer) return null;

  await fetch(`https://${domain}/admin/api/2024-10/customers/${customer.id}.json`, {
    method: 'PUT',
    headers: { 'X-Shopify-Access-Token': adminToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer: {
        id: customer.id,
        email_marketing_consent: { state: unsubscribe ? 'unsubscribed' : 'subscribed', opt_in_level: 'single_opt_in' }
      }
    })
  });
  return customer;
}

// ── Event log (flat JSON file per campaign) ────────────────────────────────
function campaignFile(campaignId) {
  const safe = String(campaignId).replace(/[^a-zA-Z0-9_-]/g, '');
  return path.join(CAMPAIGN_DIR, `${safe}.json`);
}

function readEvents(campaignId) {
  try {
    return JSON.parse(fs.readFileSync(campaignFile(campaignId), 'utf8'));
  } catch (e) {
    return [];
  }
}

let writeQueue = Promise.resolve();
function appendEvent(campaignId, event) {
  writeQueue = writeQueue.then(() => {
    fs.mkdirSync(CAMPAIGN_DIR, { recursive: true });
    const events = readEvents(campaignId);
    events.push(event);
    fs.writeFileSync(campaignFile(campaignId), JSON.stringify(events));
  }).catch((e) => console.error('[groundwork] event log write failed', e));
  return writeQueue;
}

// Secrets are read per request so a missing value fails closed even if the
// process was started with an empty variable and so tests can exercise both.
function envSecret(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim() === '') return '';
  return value;
}

let warnedMetaVerify = false;
let warnedMetaApp = false;
let warnedShopifyWebhook = false;

function rejectPublicLink(res) {
  res.set('Cache-Control', 'no-store');
  return res.status(403).json({ error: 'Invalid link' });
}

function decodeParam(value) {
  try {
    return decodeURIComponent(value);
  } catch (e) {
    return '';
  }
}

function registerGroundworkRoutes(app, config) {
  const { shopifyDomain, shopifyAdminToken } = config;

  async function handleUnsubscribe(req, res) {
    const link = assessLink(req);
    const route = `${req.method} /unsubscribe`;
    if (linkRejected(link.status)) {
      noteRejectedLink(link.status, route);
      res.status(403);
      return req.method === 'POST' ? res.end() : res.send(confirmationPage({ ok: false }));
    }
    if (link.status === 'unsigned') noteUnsignedLink(route);

    // A signed link covers the query string only. Ignore body fields then, so a
    // signed URL cannot be reused to unsubscribe a different address.
    const body = link.status === 'signed' ? {} : (req.body || {});
    const email = (req.query.email || body.email || '').toString();
    const token = (req.query.token || body.token || '').toString();
    const campaignId = (req.query.campaignId || body.campaignId || '').toString();
    const unsubscribeSecret = envSecret('UNSUBSCRIBE_SECRET');

    try {
      if (!verifyToken(unsubscribeSecret, email, token)) {
        res.status(400);
        return req.method === 'POST' ? res.end() : res.send(confirmationPage({ ok: false, email }));
      }

      if (shopifyDomain && shopifyAdminToken) {
        await updateShopifyMarketingConsent({ domain: shopifyDomain, adminToken: shopifyAdminToken, email, unsubscribe: true });
      }
      if (campaignId) await appendEvent(campaignId, { type: 'unsubscribe', customerId: email, at: new Date().toISOString() });
    } catch (err) {
      console.error('[groundwork] unsubscribe failed', err);
      res.status(500);
      return req.method === 'POST' ? res.end() : res.send(confirmationPage({ ok: false, email }));
    }

    // RFC 8058 one-click unsubscribe (List-Unsubscribe-Post) expects a bare 200.
    if (req.method === 'POST') return res.status(200).end();
    return res.send(confirmationPage({ ok: true, email }));
  }

  app.get('/unsubscribe', handleUnsubscribe);
  app.post('/unsubscribe', express.urlencoded({ extended: false }), handleUnsubscribe);

  app.get('/track/open/:campaignId/:customerId', async (req, res) => {
    const link = assessLink(req);
    const route = 'GET /track/open/:campaignId/:customerId';
    if (linkRejected(link.status)) {
      noteRejectedLink(link.status, route);
      return rejectPublicLink(res);
    }
    if (link.status === 'unsigned') noteUnsignedLink(route);
    const { campaignId, customerId } = req.params;
    appendEvent(campaignId, { type: 'open', customerId, at: new Date().toISOString() });
    res.set('Content-Type', 'image/gif');
    res.set('Cache-Control', 'no-store');
    res.send(TRANSPARENT_PIXEL);
  });

  app.get('/track/click/:campaignId/:customerId/:url', async (req, res) => {
    const link = assessLink(req);
    const route = 'GET /track/click/:campaignId/:customerId/:url';
    if (linkRejected(link.status)) {
      noteRejectedLink(link.status, route);
      return rejectPublicLink(res);
    }
    if (link.status === 'unsigned') noteUnsignedLink(route);
    const { campaignId, customerId, url } = req.params;
    const destination = decodeParam(url);
    // ?block=... is optional and only present for links the Groundwork CRM's
    // Designed Email block editor tagged with which block produced them —
    // an ordinary link (Simple editor, or an older campaign sent before this
    // existed) just has no block query param, and this falls back to
    // `undefined` exactly as before.
    const block = req.query.block || undefined;
    const target = resolveClickRedirect(destination, { trusted: link.status === 'signed' });
    if (!target.toDestination) noteClickRewritten(target.host);
    await appendEvent(campaignId, { type: 'click', customerId, url: destination, block, at: new Date().toISOString() });
    res.redirect(302, target.location);
  });

  app.post('/shopify/webhook/customers/update', async (req, res) => {
    const shopifyWebhookSecret = envSecret('SHOPIFY_WEBHOOK_SECRET');
    if (!shopifyWebhookSecret) {
      if (!warnedShopifyWebhook) {
        warnedShopifyWebhook = true;
        console.warn('[relay] SHOPIFY_WEBHOOK_SECRET is not set; rejecting Shopify customer webhooks');
      }
      return res.status(401).end();
    }
    const hmacHeader = req.get('X-Shopify-Hmac-Sha256') || '';
    const raw = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
    const digest = crypto.createHmac('sha256', shopifyWebhookSecret).update(raw).digest('base64');
    if (!hmacHeader || !safeEqual(hmacHeader, digest)) return res.status(401).end();
    res.status(200).end();
  });

  app.get('/campaigns/:campaignId/stats', requireRelayKey, (req, res) => {
    const events = readEvents(req.params.campaignId);
    const uniqueBy = (type) => new Set(events.filter((e) => e.type === type).map((e) => e.customerId)).size;
    res.json({
      campaignId: req.params.campaignId,
      opens: uniqueBy('open'),
      clicks: uniqueBy('click'),
      unsubscribes: uniqueBy('unsubscribe'),
      events
    });
  });

  // ── Abandoned-cart email tracking ─────────────────────────────────────────
  // Same open/click mechanism as campaigns above, reusing the exact same
  // generic appendEvent/readEvents helpers — just keyed by an
  // "abandoned_<checkout token>" id instead of a campaignId, so one cart's
  // events never collide with a real campaign's.
  app.get('/abandoned/track/open/:token', (req, res) => {
    const link = assessLink(req);
    const route = 'GET /abandoned/track/open/:token';
    if (linkRejected(link.status)) {
      noteRejectedLink(link.status, route);
      return rejectPublicLink(res);
    }
    if (link.status === 'unsigned') noteUnsignedLink(route);
    appendEvent(`abandoned_${req.params.token}`, { type: 'open', at: new Date().toISOString() });
    res.set('Content-Type', 'image/gif');
    res.set('Cache-Control', 'no-store');
    res.send(TRANSPARENT_PIXEL);
  });

  app.get('/abandoned/track/click/:token/:link/:url', async (req, res) => {
    const link = assessLink(req);
    const route = 'GET /abandoned/track/click/:token/:link/:url';
    if (linkRejected(link.status)) {
      noteRejectedLink(link.status, route);
      return rejectPublicLink(res);
    }
    if (link.status === 'unsigned') noteUnsignedLink(route);
    const { token, link: linkName, url } = req.params;
    const destination = decodeParam(url);
    const target = resolveClickRedirect(destination, { trusted: link.status === 'signed' });
    if (!target.toDestination) noteClickRewritten(target.host);
    await appendEvent(`abandoned_${token}`, { type: 'click', link: linkName, url: destination, at: new Date().toISOString() });
    res.redirect(302, target.location);
  });

  // Bulk read so the CRM can refresh every tracked cart's opens/clicks in one
  // request per check instead of one per cart.
  app.get('/abandoned/stats', requireRelayKey, (req, res) => {
    const tokens = String(req.query.tokens || '').split(',').map((t) => t.trim()).filter(Boolean);
    const out = {};
    tokens.forEach((token) => { out[token] = readEvents(`abandoned_${token}`); });
    res.json(out);
  });

  // ── Meta Lead Gen webhook ────────────────────────────────────────────────
  // Step 1: Meta verifies the endpoint with a GET challenge when you first
  // register the webhook in the Meta App dashboard.
  app.get('/meta/lead', (req, res) => {
    const metaLeadVerifyToken = envSecret('META_VERIFY_TOKEN');
    const provided = req.query['hub.verify_token'];
    if (!metaLeadVerifyToken) {
      if (!warnedMetaVerify) {
        warnedMetaVerify = true;
        console.warn('[relay] META_VERIFY_TOKEN is not set; rejecting Meta webhook verification challenges');
      }
      return res.status(403).end();
    }
    if (req.query['hub.mode'] !== 'subscribe' || typeof provided !== 'string' || !safeEqual(provided, metaLeadVerifyToken)) {
      return res.status(403).end();
    }
    const challenge = req.query['hub.challenge'];
    if (typeof challenge !== 'string') return res.status(403).end();
    return res.status(200).send(challenge);
  });

  // Step 2: Meta POSTs a notification when a lead submits the form.
  // The signature is required. The raw leadgen id, form, page, and time are
  // stored before we answer, even when the Graph field fetch fails. A duplicate
  // leadgen id is not stored twice. Field data is filled in here or on the
  // next pending read.
  app.post('/meta/lead', async (req, res) => {
    // index.js parses the JSON body and keeps the original bytes in rawBody.
    const metaAppSecret = envSecret('META_APP_SECRET');
    const raw = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
    if (!metaAppSecret) {
      if (!warnedMetaApp) {
        warnedMetaApp = true;
        console.warn('[relay] META_APP_SECRET is not set; rejecting Meta lead webhooks');
      }
      return res.status(401).end();
    }
    const sig = req.get('X-Hub-Signature-256') || '';
    const expected = 'sha256=' + crypto.createHmac('sha256', metaAppSecret).update(raw).digest('hex');
    if (!safeEqual(sig, expected)) return res.status(401).end();

    let payload;
    try {
      payload = req.body && typeof req.body === 'object' ? req.body : JSON.parse(raw.toString());
    } catch {
      return res.status(400).end();
    }
    try {
      await ingestMetaWebhook(payload);
    } catch (e) {
      console.error('[groundwork] meta lead write failed', e && e.message ? e.message : e);
      return res.status(500).end();
    }
    return res.status(200).end();
  });

  // Step 3: The CRM polls this endpoint. Leads stay on disk until it acks
  // the leadgen ids it has stored. Older app versions never ack, so the
  // same leads are returned again; the app de-dupes by leadgenId.
  app.get('/meta/leads/pending', requireRelayKey, async (req, res) => {
    try {
      res.json(await listPendingMetaLeads());
    } catch (e) {
      console.error('[groundwork] meta lead read failed', e && e.message ? e.message : e);
      res.status(500).json({ error: 'Internal error' });
    }
  });

  app.post('/meta/leads/ack', requireRelayKey, async (req, res) => {
    const ids = req.body && req.body.leadgenIds;
    if (!Array.isArray(ids)) {
      return res.status(400).json({ error: 'leadgenIds must be an array' });
    }
    try {
      res.json(await ackMetaLeads(ids));
    } catch (e) {
      console.error('[groundwork] meta lead ack failed', e && e.message ? e.message : e);
      res.status(500).json({ error: 'Internal error' });
    }
  });
}

module.exports = registerGroundworkRoutes;
