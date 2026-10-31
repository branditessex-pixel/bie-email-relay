const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const registerGroundworkRoutes = require('./groundwork-routes');
const { requireRelayKey, warnIfRelayKeyMissing } = require('./relay-auth');

const app = express();
app.use(cors());
// Keep the exact bytes of every JSON body: Meta signs the raw payload, and the
// parsed object cannot be used to check that signature.
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

registerGroundworkRoutes(app, {
  shopifyDomain: process.env.SHOPIFY_STORE || process.env.SHOPIFY_DOMAIN,
  shopifyAdminToken: process.env.SHOPIFY_ADMIN_TOKEN,
  shopifyWebhookSecret: process.env.SHOPIFY_WEBHOOK_SECRET,
  unsubscribeSecret: process.env.UNSUBSCRIBE_SECRET,
  metaLeadVerifyToken: process.env.META_VERIFY_TOKEN,
  metaAppSecret: process.env.META_APP_SECRET,
  metaAccessToken: process.env.META_ACCESS_TOKEN,
  metaLeadsSecret: process.env.META_LEADS_SECRET,
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/send', requireRelayKey, async (req, res) => {
  const { to, subject, text } = req.body;

  if (!to || !subject || !text) {
    return res.status(400).json({ error: 'to, subject, and text are required' });
  }

  const from = 'Hayley at Brand It Essex <hayley@branditessex.com>';

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to, subject, text }),
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({ error: data });
    }

    res.json({ success: true, id: data.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// A bug in one request must never take tracking, unsubscribes and the CRM's
// results offline, so log it and carry on instead of letting the process die.
process.on('unhandledRejection', (e) => console.error('[relay] unhandled rejection', e));
process.on('uncaughtException', (e) => console.error('[relay] uncaught exception', e));

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  warnIfRelayKeyMissing();
  app.listen(PORT, () => console.log(`bie-email-relay listening on port ${PORT}`));
}

module.exports = app;
