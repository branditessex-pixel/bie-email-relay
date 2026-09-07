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
  unsubscribeSecret: process.env.UNSUBSCRIBE_SECRET
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/send', async (req, res) => {
  const { to, subject, text, fromName, fromEmail } = req.body;

  if (!to || !subject || !text) {
    return res.status(400).json({ error: 'to, subject, and text are required' });
  }

  const from = fromName && fromEmail
    ? `${fromName} <${fromEmail}>`
    : fromEmail || 'noreply@branditessex.com';

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
