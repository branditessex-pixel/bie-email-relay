const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const registerGroundworkRoutes = require('./groundwork-routes');
const { requireRelayKey, warnIfRelayKeyMissing, warnIfBibSecretMissing } = require('./relay-auth');
const { warnIfLinkSecretMissing } = require('./link-sign');

const app = express();
app.use(cors());
// Keep the exact bytes of every JSON body: Meta and B.I.B sign the raw payload,
// and the parsed object cannot be used to check that signature.
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

// Webhook secrets, RELAY_API_KEY, and RELAY_LINK_SECRET are read from the
// environment on each request. Shopify consent updates use the shop values below.
registerGroundworkRoutes(app, {
  shopifyDomain: process.env.SHOPIFY_STORE || process.env.SHOPIFY_DOMAIN,
  shopifyAdminToken: process.env.SHOPIFY_ADMIN_TOKEN,
});

// Public liveness check. Keep this body to { status: 'ok' } — no config or versions.
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

// Parser and route failures must not echo a stack or the request body.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err && (err.type === 'entity.parse.failed' || err.status === 400)) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  console.error('[relay] request error', err && err.message ? err.message : err);
  return res.status(500).json({ error: 'Internal error' });
});

// A bug in one request must never take tracking, unsubscribes and the CRM's
// results offline, so log it and carry on instead of letting the process die.
process.on('unhandledRejection', (e) => console.error('[relay] unhandled rejection', e));
process.on('uncaughtException', (e) => console.error('[relay] uncaught exception', e));

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  warnIfRelayKeyMissing();
  warnIfLinkSecretMissing();
  warnIfBibSecretMissing();
  app.listen(PORT, () => console.log(`bie-email-relay listening on port ${PORT}`));
}

module.exports = app;
