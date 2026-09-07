/**
 * Groundwork CRM integration routes: campaign open/click tracking,
 * unsubscribe (with Shopify marketing-consent sync), and a stats endpoint
 * the CRM polls to build its campaign history table.
 *
 * Event storage is a flat JSON file per campaign under DATA_DIR — Railway's
 * filesystem is ephemeral across deploys/restarts, so this is a best-effort
 * log, not a durable database. Good enough for open/click/unsubscribe counts
 * that only need to survive between sends and the next redeploy.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const fetch = require('node-fetch');

const TRANSPARENT_PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBTAA7',
  'base64'
);

const DATA_DIR = process.env.CAMPAIGN_DATA_DIR || path.join(__dirname, 'data', 'campaigns');

function makeToken(secret, email) {
  return crypto.createHmac('sha256', secret).update(email.trim().toLowerCase()).digest('hex');
}

function verifyToken(secret, email, token) {
  if (!token) return false;
  const expected = makeToken(secret, email);
  try {
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

function registerGroundworkRoutes(app, config) {
  const { shopifyDomain, shopifyAdminToken, shopifyWebhookSecret, unsubscribeSecret } = config;

  async function handleUnsubscribe(req, res) {
    const email = (req.query.email || (req.body && req.body.email) || '').toString();
    const token = (req.query.token || (req.body && req.body.token) || '').toString();
    const campaignId = (req.query.campaignId || (req.body && req.body.campaignId) || '').toString();

    if (!email || !verifyToken(unsubscribeSecret, email, token)) {
      res.status(400);
      return req.method === 'POST' ? res.end() : res.send(confirmationPage({ ok: false, email }));
    }

    try {
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
    await appendEvent(campaignId, { type: 'click', customerId, url: destination, at: new Date().toISOString() });
    res.redirect(302, destination);
  });

  app.post('/shopify/webhook/customers/update', express.raw({ type: 'application/json' }), async (req, res) => {
    const hmacHeader = req.get('X-Shopify-Hmac-Sha256');
    const digest = crypto.createHmac('sha256', shopifyWebhookSecret || '').update(req.body).digest('base64');
    if (!shopifyWebhookSecret || !hmacHeader || digest !== hmacHeader) {
      return res.status(401).end();
    }
    res.status(200).end();
  });

  app.get('/campaigns/:campaignId/stats', (req, res) => {
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
}

module.exports = registerGroundworkRoutes;
