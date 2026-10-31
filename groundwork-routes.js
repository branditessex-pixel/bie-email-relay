/**
 * Groundwork CRM integration routes: campaign open/click tracking,
 * unsubscribe (with Shopify marketing-consent sync), a stats endpoint
 * the CRM polls to build its campaign history table, and a Meta Lead Gen
 * webhook that stores incoming leads for the CRM to collect.
 *
 * Event storage is a flat JSON file per campaign under DATA_DIR — Railway's
 * filesystem is ephemeral across deploys/restarts, so this is a best-effort
 * log, not a durable database. Good enough for open/click/unsubscribe counts
 * that only need to survive between sends and the next redeploy.
 *
 * Meta leads are stored the same way under META_LEADS_FILE. The CRM polls
 * GET /meta/leads/pending to consume them; once consumed they are gone.
 * A Railway restart between a lead arriving and the CRM polling will lose
 * that lead — acceptable at current volumes. If that ever matters, swap the
 * JSON file for a Railway Postgres add-on.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const fetch = require('node-fetch');
const { requireRelayKey } = require('./relay-auth');

const TRANSPARENT_PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBTAA7',
  'base64'
);

const DATA_DIR = process.env.CAMPAIGN_DATA_DIR || path.join(__dirname, 'data', 'campaigns');
const META_LEADS_FILE = process.env.META_LEADS_FILE || path.join(__dirname, 'data', 'meta-leads.json');

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
  return path.join(DATA_DIR, `${safe}.json`);
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
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const events = readEvents(campaignId);
    events.push(event);
    fs.writeFileSync(campaignFile(campaignId), JSON.stringify(events));
  }).catch((e) => console.error('[groundwork] event log write failed', e));
  return writeQueue;
}

// ── Meta Lead Gen pending store ────────────────────────────────────────────
let metaWriteQueue = Promise.resolve();

function readMetaLeads() {
  try { return JSON.parse(fs.readFileSync(META_LEADS_FILE, 'utf8')); } catch { return []; }
}

function appendMetaLead(lead) {
  metaWriteQueue = metaWriteQueue.then(() => {
    fs.mkdirSync(path.dirname(META_LEADS_FILE), { recursive: true });
    const leads = readMetaLeads();
    leads.push(lead);
    fs.writeFileSync(META_LEADS_FILE, JSON.stringify(leads));
  }).catch((e) => console.error('[groundwork] meta lead write failed', e));
  return metaWriteQueue;
}

function flushMetaLeads() {
  const leads = readMetaLeads();
  fs.mkdirSync(path.dirname(META_LEADS_FILE), { recursive: true });
  fs.writeFileSync(META_LEADS_FILE, JSON.stringify([]));
  return leads;
}

function registerGroundworkRoutes(app, config) {
  const { shopifyDomain, shopifyAdminToken, shopifyWebhookSecret, unsubscribeSecret,
          metaLeadVerifyToken, metaAppSecret, metaAccessToken, metaLeadsSecret } = config;

  async function handleUnsubscribe(req, res) {
    const email = (req.query.email || (req.body && req.body.email) || '').toString();
    const token = (req.query.token || (req.body && req.body.token) || '').toString();
    const campaignId = (req.query.campaignId || (req.body && req.body.campaignId) || '').toString();

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
    const { campaignId, customerId } = req.params;
    appendEvent(campaignId, { type: 'open', customerId, at: new Date().toISOString() });
    res.set('Content-Type', 'image/gif');
    res.set('Cache-Control', 'no-store');
    res.send(TRANSPARENT_PIXEL);
  });

  app.get('/track/click/:campaignId/:customerId/:url', async (req, res) => {
    const { campaignId, customerId, url } = req.params;
    const destination = decodeURIComponent(url);
    // ?block=... is optional and only present for links the Groundwork CRM's
    // Designed Email block editor tagged with which block produced them —
    // an ordinary link (Simple editor, or an older campaign sent before this
    // existed) just has no block query param, and this falls back to
    // `undefined` exactly as before.
    const block = req.query.block || undefined;
    await appendEvent(campaignId, { type: 'click', customerId, url: destination, block, at: new Date().toISOString() });
    res.redirect(302, destination);
  });

  app.post('/shopify/webhook/customers/update', async (req, res) => {
    const hmacHeader = req.get('X-Shopify-Hmac-Sha256');
    const raw = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
    const digest = crypto.createHmac('sha256', shopifyWebhookSecret || '').update(raw).digest('base64');
    if (!shopifyWebhookSecret || !hmacHeader || digest !== hmacHeader) {
      return res.status(401).end();
    }
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
    appendEvent(`abandoned_${req.params.token}`, { type: 'open', at: new Date().toISOString() });
    res.set('Content-Type', 'image/gif');
    res.set('Cache-Control', 'no-store');
    res.send(TRANSPARENT_PIXEL);
  });

  app.get('/abandoned/track/click/:token/:link/:url', async (req, res) => {
    const { token, link, url } = req.params;
    const destination = decodeURIComponent(url);
    await appendEvent(`abandoned_${token}`, { type: 'click', link, url: destination, at: new Date().toISOString() });
    res.redirect(302, destination);
  });

  // Bulk read so the CRM can refresh every tracked cart's opens/clicks in one
  // request per check instead of one per cart.
  app.get('/abandoned/stats', (req, res) => {
    const tokens = String(req.query.tokens || '').split(',').map((t) => t.trim()).filter(Boolean);
    const out = {};
    tokens.forEach((token) => { out[token] = readEvents(`abandoned_${token}`); });
    res.json(out);
  });

  // ── Meta Lead Gen webhook ────────────────────────────────────────────────
  // Step 1: Meta verifies the endpoint with a GET challenge when you first
  // register the webhook in the Meta App dashboard.
  app.get('/meta/lead', (req, res) => {
    if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === metaLeadVerifyToken) {
      return res.status(200).send(req.query['hub.challenge']);
    }
    res.status(403).end();
  });

  // Step 2: Meta POSTs a notification when a lead submits the form.
  // We verify the signature, fetch the actual field data from the Graph API,
  // and store it for the CRM to collect.
  app.post('/meta/lead', async (req, res) => {
    // index.js parses the JSON body and keeps the original bytes in rawBody.
    const raw = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
    if (metaAppSecret) {
      const sig = req.get('X-Hub-Signature-256') || '';
      const expected = 'sha256=' + crypto.createHmac('sha256', metaAppSecret).update(raw).digest('hex');
      const a = Buffer.from(sig); const b = Buffer.from(expected);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).end();
    }
    res.status(200).end();

    try {
      const payload = req.body && typeof req.body === 'object' ? req.body : JSON.parse(raw.toString());
      const change = (payload.entry && payload.entry[0] && payload.entry[0].changes && payload.entry[0].changes[0]) || {};
      const leadgenId = change.value && change.value.leadgen_id;
      if (!leadgenId || !metaAccessToken) return;

      const r = await fetch(
        `https://graph.facebook.com/v21.0/${leadgenId}?fields=field_data,created_time&access_token=${metaAccessToken}`
      );
      if (!r.ok) { console.error('[groundwork] meta graph fetch failed', r.status); return; }
      const data = await r.json();

      const fields = {};
      for (const f of (data.field_data || [])) fields[f.name] = (f.values && f.values[0]) || '';

      const lead = {
        leadgenId,
        receivedAt: new Date().toISOString(),
        name: fields.full_name || [fields.first_name, fields.last_name].filter(Boolean).join(' ').trim() || null,
        email: fields.email || null,
        phone: fields.phone_number || fields.phone || null,
        company: fields.company_name || fields.business_name || null,
        need: fields.what_are_you_looking_for || fields.workwear_type || null,
        quantity: fields.how_many_staff || fields.quantity || null,
      };

      await appendMetaLead(lead);
    } catch (e) {
      console.error('[groundwork] meta lead processing failed', e);
    }
  });

  // Step 3: The CRM polls this endpoint every 10 minutes, consumes pending
  // leads, and injects them into the local leads store.
  app.get('/meta/leads/pending', (req, res) => {
    const secret = metaLeadsSecret || metaLeadVerifyToken;
    if (!secret || req.query.secret !== secret) return res.status(401).end();
    res.json(flushMetaLeads());
  });
}

module.exports = registerGroundworkRoutes;
