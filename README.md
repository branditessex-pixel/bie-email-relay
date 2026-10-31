# bie-email-relay

Express service that sends mail through Resend and records Groundwork CRM campaign tracking. Deployed on Railway. Do not commit secret values.

Express also answers `HEAD` for each `GET` route with the same handler and the same checks.

## Routes

| Method | Path | Auth | What it does |
| --- | --- | --- | --- |
| `GET` | `/health` | Public | `{ "status": "ok" }` only. No config, version, or request data. |
| `POST` | `/send` | `RELAY_API_KEY` | Sends one email through Resend from Hayley at Brand It Essex. |
| `GET` | `/campaigns/:campaignId/stats` | `RELAY_API_KEY` | Unique open, click, and unsubscribe counts, plus the raw event list. |
| `GET` | `/abandoned/stats` | `RELAY_API_KEY` | Raw open/click events for the checkout tokens in `?tokens=`. |
| `GET` | `/meta/leads/pending` | `RELAY_API_KEY` | Returns pending Meta leads. Each lead includes `leadgenId`. Does not delete them. The old `?secret=` query is not accepted. |
| `POST` | `/meta/leads/ack` | `RELAY_API_KEY` | Body `{ "leadgenIds": ["..."] }`. Removes only those ids. Same `X-Relay-Key` or Bearer check as pending. The old `?secret=` query is not accepted. |
| `GET` | `/track/open/:campaignId/:customerId` | Link signature | Records an open and returns a 1×1 gif. |
| `GET` | `/track/click/:campaignId/:customerId/:url` | Link signature | Records a click and redirects. Unsigned destinations must be on the host allowlist. |
| `GET` | `/abandoned/track/open/:token` | Link signature | Records an abandoned-cart open and returns the gif. |
| `GET` | `/abandoned/track/click/:token/:link/:url` | Link signature | Records an abandoned-cart click and redirects, with the same allowlist rule. |
| `GET` | `/unsubscribe` | Link signature + per-email token | Confirms unsubscribe and, when Shopify env is set, updates marketing consent. |
| `POST` | `/unsubscribe` | Link signature + per-email token | RFC 8058 one-click unsubscribe. Same checks as `GET`. |
| `GET` | `/meta/lead` | `META_VERIFY_TOKEN` | Meta hub challenge. The token is required; a missing token does not echo `hub.challenge`. |
| `GET` | `/meta/token-status` | `RELAY_API_KEY` | Read-only. Asks Graph `/debug_token` about `META_ACCESS_TOKEN` and returns its type, app id, page (`profileId`), expiry, scopes and `missingScopes`. Never returns the token. |
| `POST` | `/meta/lead` | `META_APP_SECRET` / `META_APP_SECRETS` HMAC | Meta lead webhook. The app secret is required. The raw lead is stored, then fields are read from the Graph API with `META_ACCESS_TOKEN`. |
| `POST` | `/shopify/webhook/customers/update` | `SHOPIFY_WEBHOOK_SECRET` HMAC | Checks Shopify's `X-Shopify-Hmac-Sha256` over the raw body and returns 200. |

`RELAY_API_KEY` is not added to Meta or Shopify webhooks. Email pixels, click redirects, and unsubscribe links cannot send that header; they use the link signature below.

### `RELAY_API_KEY`

Set `RELAY_API_KEY` in the environment. Callers pass it on every protected request:

- `X-Relay-Key: <key>`
- `Authorization: Bearer <key>`

When both are sent, `X-Relay-Key` is the value that is checked. Comparison is constant-time. A missing or wrong key returns `401` and `{ "error": "Unauthorized" }`. If `RELAY_API_KEY` is unset, empty, or only whitespace, those routes reject every request and the process logs a warning. The process stays up.

### Link signatures

Query parameter `sig` is the lowercase hex HMAC-SHA256 of a canonical string, keyed with `RELAY_LINK_SECRET`. `signLink(path, query, secret)`, `signingPayload(path, query)`, and `verifyLink(path, query, secret)` in `link-sign.js` implement this. The CRM (a separate repo) has to produce the same string.

1. **Path.** The request path only, starting with `/`. Use the path exactly as it appears on the wire. Do not decode percent-encoding. Do not include the scheme, host, port, `?query`, or `#hash`. A click destination is one path segment, so encode it with `encodeURIComponent` (`/` becomes `%2F`, `:` becomes `%3A`).
2. **Pairs.** Every query parameter except `sig`. Repeated keys are separate pairs. Drop a missing or blank `sig`. More than one `sig` value is an invalid link.
3. **Sort.** Sort by raw key, then by raw value, using UTF-16 code unit order (JavaScript `string < string`). Sort before encoding.
4. **Encode.** `encodeURIComponent(key) + "=" + encodeURIComponent(value)`. ECMAScript `encodeURIComponent` leaves `A–Z a–z 0–9 - _ . ! ~ * ' ( )` unescaped. Space is `%20`, not `+`. `@` is `%40`.
5. **Join.** Join pairs with `&`. No trailing `&`. If there are no pairs, this part is an empty string.
6. **Payload.** `path + "?" + canonicalQuery`. The `?` is always there, including when the query is empty. Example: `/track/open/camp/cust?`.
7. **Signature.** HMAC-SHA256 over the UTF-8 payload. The key is the UTF-8 bytes of `RELAY_LINK_SECRET`. Hex-encode the digest with lowercase `a-f`. The server lowercases the received hex before the constant-time compare.

Sign the canonical payload, not the raw query string. `+` and `%20` in the request both parse back to a space and then re-encode as `%20`.

Vectors for `RELAY_LINK_SECRET=example-link-secret` (an example only, not a real key):

| Payload | `sig` |
| --- | --- |
| `/track/open/camp/cust?` | `6bfa4942a9765f84b31249abe0b4f1ca0c9d697f53cc3c8fd1e30e7e27e842aa` |
| `/track/click/c/u/https%3A%2F%2Fbranditessex.com%2Fsale?block=Hero%20Block&z=1` | `b08f242df1640eafb6b76ed1baf43f97deb3efef88fd086e783289164a1d06b5` |
| `/unsubscribe?campaignId=c&email=Person%40Example.com&token=abc` | `8730d58e280834df50e422066c9364e3be06fb1561e55518a1da5f7e7e2f0ca2` |

The click payload is the path plus query `{ block: "Hero Block", z: "1" }`. `sig` is not part of the input. The unsubscribe payload sorts `campaignId`, then `email`, then `token`.

```javascript
const crypto = require('crypto');

function canonicalQuery(query) {
  const entries = [];
  for (const key of Object.keys(query || {})) {
    if (key === 'sig') continue;
    const value = query[key];
    for (const item of (Array.isArray(value) ? value : [value])) {
      entries.push([String(key), item == null ? '' : String(item)]);
    }
  }
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return entries.map(([key, value]) => encodeURIComponent(key) + '=' + encodeURIComponent(value)).join('&');
}

function signLink(path, query, secret) {
  const payload = path + '?' + canonicalQuery(query);
  return crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}
```

**Already-sent emails do not have `sig`.**

- `RELAY_LINK_SECRET` unset: signatures are not checked and a warning is logged. Pixels still return the gif. Unsubscribe still honours the per-email token. This stays true even if `RELAY_REQUIRE_SIGNED_LINKS=true`, because there is no key to check.
- Secret set and `RELAY_REQUIRE_SIGNED_LINKS` not exactly `true` (the default): a valid `sig` is accepted. A missing `sig` is accepted and logged as an unsigned link (the log line names the route, not the customer). A present but wrong `sig` is `403` and is not treated as unsigned.
- `RELAY_REQUIRE_SIGNED_LINKS=true` and the secret is set: a missing `sig` is `403`. Pixels are not counted. Clicks are not followed. Unsubscribe does not run. A signed unsubscribe must carry `email` and `token` in the query string, because the signature does not cover the body. The per-email token is still required, so a signed URL cannot unsubscribe an arbitrary address. The body cannot replace the signed email.

### Click redirects

Destinations must be `http:` or `https:` with no username or password. Anything else, including `javascript:`, goes to the homepage.

- **Signed** (`sig` valid): redirect to that destination, on any host.
- **Unsigned** (no `sig`, or `RELAY_LINK_SECRET` unset): redirect only if the hostname equals an allowlist entry or is a subdomain of one (`www.branditessex.com` matches `branditessex.com`). Otherwise redirect to the homepage. The browser is not sent to the original URL.

`RELAY_REDIRECT_ALLOWLIST` is a comma-separated host list. When it is unset, the default is `branditessex.com` and `uvrvii-wd.myshopify.com`. The hostname of `SHOPIFY_STORE` or `SHOPIFY_DOMAIN` is always added. When the allowlist variable is set, it replaces the default. Subdomains of a listed host match. `branditessex.com.evil.com` does not.

`RELAY_REDIRECT_FALLBACK` is the homepage used when a destination is not allowed. It must be an absolute `http` or `https` URL with no userinfo. The default is `https://branditessex.com/`.

The click is still recorded against the original destination during the unsigned transition. Rejected signatures are not recorded.

### Provider webhooks

Shopify: HMAC-SHA256 of the raw body, base64, compared in constant time with `X-Shopify-Hmac-Sha256`. If `SHOPIFY_WEBHOOK_SECRET` is unset, the route returns `401` and logs a warning.

Meta challenge: `hub.mode=subscribe` and `hub.verify_token` must match `META_VERIFY_TOKEN` in constant time. The code reads `META_VERIFY_TOKEN`. It does not read `META_LEAD_VERIFY_TOKEN`. If the token is unset, the challenge is `403` and `hub.challenge` is not echoed.

Meta lead POST: `X-Hub-Signature-256` must equal `sha256=` plus the hex HMAC-SHA256 of the raw body, keyed with one of the configured app secrets: `META_APP_SECRETS` (comma-separated, for a rotation or a second app) and/or `META_APP_SECRET`. Every secret is checked in constant time. A mismatch is `401` and logs the header shape, body size, how many secrets are configured, and the unverified payload's `object`, entry (page) ids, form ids and leadgen ids, so the sending page/app can be identified. No secret or signature is logged. If no secret is set, the route returns `401` and does not store a lead. A valid call stores every leadgen id in the body (form, page, and time included), skipping ids already stored, then tries the Graph field read, then returns `200`. A failed or skipped Graph read still returns `200` and keeps the raw lead. The route returns `500` only when the lead file cannot be written, so Meta retries.

### Meta lead storage

Pending leads are one JSON file, `$DATA_DIR/meta-leads.json`. Attach a Railway Volume mounted at `/data` and set `DATA_DIR=/data`. The container disk is wiped on restart and redeploy; the volume is not. When `DATA_DIR` is unset, the file stays at `./data/meta-leads.json`, which is the previous location. `META_LEADS_FILE` still names the file only when `DATA_DIR` is unset. Writes use a temp file in the same directory and then rename.

Graph field reads log Meta's `error.code`, `error_subcode`, `type`, `fbtrace_id` and message on failure (never the URL or token). Each failure is recorded on the lead as `fetchAttempts`, `lastFetchAttemptAt` and `lastFetchError`. After `META_LEAD_MAX_FETCH_ATTEMPTS` (default 5) failures the lead gets `detailsStatus: "details_unavailable"`, stays listed with its `leadgenId`, `formId` and `pageId` (still `fieldsFetched: false`, so the CRM keeps it unacked), and Graph is tried at most once per `META_LEAD_RETRY_MINUTES` (default 60) plus once after each restart or redeploy. A good read sets `detailsStatus: "fetched"`. Set `META_APPSECRET_PROOF=true` only if the Meta app has "Require App Secret" switched on; the proof uses the first configured app secret.

`GET /meta/leads/pending` reloads that file, retries the Graph field fetch for any lead whose fields are not stored yet, and returns the list. It does not delete leads. Each object includes `leadgenId`. Webhook fields are `formId`, `pageId`, and `createdTime`. After a successful Graph read the object also has `name`, `email`, `phone`, `company`, `need`, and `quantity`, and `fieldsFetched` is `true`.

`POST /meta/leads/ack` takes `{ "leadgenIds": ["123"] }` and removes only those ids. The check is the same `RELAY_API_KEY` header as pending (`X-Relay-Key`, or `Authorization: Bearer`). Unknown ids are ignored. Ack a lead after the CRM has stored it. Leave `fieldsFetched: false` unacked so the next poll can deliver the fields. Older app versions never ack: those leads are sent again on every poll, and the app de-dupes by `leadgenId`.

Leads older than `META_LEADS_RETENTION_DAYS` (default 30, measured from `receivedAt`) are removed on read and on write so the file cannot grow forever. The hub verification token is read from `META_VERIFY_TOKEN`.

## Environment

Set these on the Railway service. Do not put the values in git.

| Variable | Required | Used for |
| --- | --- | --- |
| `RELAY_API_KEY` | Yes, for CRM calls | `/send`, campaign stats, abandoned stats, `GET /meta/leads/pending`, and `POST /meta/leads/ack`. Unset means those routes return `401`. |
| `RELAY_LINK_SECRET` | Yes, before strict mode | HMAC key for email-link `sig`. Unset keeps pixels and unsubscribe working and logs a warning. |
| `RELAY_REQUIRE_SIGNED_LINKS` | Not yet | Set to exactly `true` only after the CRM signs links and old unsigned emails can expire. Default off. |
| `RELAY_REDIRECT_ALLOWLIST` | No | Comma-separated click hosts. Default `branditessex.com,uvrvii-wd.myshopify.com`. |
| `RELAY_REDIRECT_FALLBACK` | No | Homepage for blocked clicks. Default `https://branditessex.com/`. |
| `RESEND_API_KEY` | Yes, to send | Resend API bearer token. |
| `UNSUBSCRIBE_SECRET` | Yes, to unsubscribe | HMAC key for the per-email `token` query param. |
| `SHOPIFY_STORE` or `SHOPIFY_DOMAIN` | Yes, for consent sync | Shop hostname used for Admin API consent updates and added to the click allowlist. |
| `SHOPIFY_ADMIN_TOKEN` | Yes, for consent sync | Shopify Admin API token. |
| `SHOPIFY_WEBHOOK_SECRET` | Yes, for the webhook | Shopify customer-webhook HMAC. Unset means `401`. |
| `META_VERIFY_TOKEN` | Yes, for the challenge | Meta `hub.verify_token`. The relay reads `META_VERIFY_TOKEN`, not `META_LEAD_VERIFY_TOKEN`. |
| `META_APP_SECRET` | Yes, for lead posts | Meta `X-Hub-Signature-256`. Unset means `401`. |
| `META_ACCESS_TOKEN` | Yes, to fill lead fields | Graph API token. A verified webhook is still stored when this is missing or the Graph read fails. Fields are retried on the next pending read. |
| `DATA_DIR` | Yes, so leads survive restarts | Directory for `meta-leads.json`. Attach a Railway Volume mounted at `/data` and set `DATA_DIR=/data`. When unset, the file stays at `./data/meta-leads.json`. |
| `META_LEADS_RETENTION_DAYS` | No | Drop unacked leads older than this many days. Default 30. |
| `PORT` | No | Listen port. Railway sets this. Default 3000. |
| `CAMPAIGN_DATA_DIR` | No | Campaign event log directory. Open and click counts only. |
| `META_LEADS_FILE` | No | Full path of the leads file. Ignored when `DATA_DIR` is set. |

`META_LEADS_SECRET` is not read. Pending leads use `RELAY_API_KEY`.

## Run

```bash
npm install
npm start
npm test
```
