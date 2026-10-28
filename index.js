const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const registerGroundworkRoutes = require('./groundwork-routes');

const app = express();
app.use(cors());
app.use(express.json());

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

app.post('/send', async (req, res) => {
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`bie-email-relay listening on port ${PORT}`));
