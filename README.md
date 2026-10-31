# bie-email-relay

Express service that sends mail through Resend and records Groundwork CRM campaign tracking. Deployed on Railway.

## Shared secret

`POST /send` and `GET /campaigns/:campaignId/stats` require a shared secret.

Set `RELAY_API_KEY` in the environment. Do not commit the value. Callers pass it on every request in either header:

- `X-Relay-Key: <key>`
- `Authorization: Bearer <key>`

When both are sent, `X-Relay-Key` is the value that is checked. A missing or wrong key returns `401` and `{ "error": "Unauthorized" }`. If `RELAY_API_KEY` is unset or empty, those two routes reject every request and the process logs a warning. Tracking and the other routes keep running.

These routes stay open without `RELAY_API_KEY`:

- `GET /health`
- `GET /track/open/...` and `GET /track/click/...`
- `GET /abandoned/track/open/...` and `GET /abandoned/track/click/...`
- `GET` and `POST /unsubscribe` (HMAC token in the link)
- `POST /shopify/webhook/customers/update` (Shopify HMAC)
- `GET` and `POST /meta/lead` (Meta's own verification)
- `GET /meta/leads/pending` (its own query-string secret)

`GET /abandoned/stats` is unchanged and does not use `RELAY_API_KEY`.

## Environment

| Variable | Used for |
| --- | --- |
| `PORT` | Listen port (default 3000) |
| `RESEND_API_KEY` | Resend API bearer token |
| `RELAY_API_KEY` | Shared secret for `/send` and campaign stats |
| `SHOPIFY_STORE` or `SHOPIFY_DOMAIN` | Shop domain for unsubscribe consent updates |
| `SHOPIFY_ADMIN_TOKEN` | Shopify Admin API token |
| `SHOPIFY_WEBHOOK_SECRET` | Shopify webhook HMAC |
| `UNSUBSCRIBE_SECRET` | HMAC key for unsubscribe links |
| `META_VERIFY_TOKEN` | Meta webhook hub challenge (`hub.verify_token`) |
| `META_APP_SECRET` | Meta `X-Hub-Signature-256` check |
| `META_ACCESS_TOKEN` | Graph API read of a lead |
| `META_LEADS_SECRET` | Query secret for `GET /meta/leads/pending` (falls back to `META_VERIFY_TOKEN`) |
| `CAMPAIGN_DATA_DIR` | Campaign event log directory |
| `META_LEADS_FILE` | Pending Meta leads file |

The server reads the Meta hub verify token from `META_VERIFY_TOKEN`. It does not read `META_LEAD_VERIFY_TOKEN`.

## Run

```bash
npm install
npm start
npm test
```
