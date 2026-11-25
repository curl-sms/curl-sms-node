# curl-sms for Node.js

[![CI](https://github.com/curl-sms/curl-sms-node/actions/workflows/ci.yml/badge.svg)](https://github.com/curl-sms/curl-sms-node/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/curl-sms?color=0a0a0a)](https://www.npmjs.com/package/curl-sms)
[![License: MIT](https://img.shields.io/badge/license-MIT-0a0a0a)](LICENSE)

Official Node.js and TypeScript client for the [curl-sms](https://curl-sms.com) SMS API: send an SMS with one call.

- Zero runtime dependencies, uses the built-in `fetch` (Node.js 20 or later)
- Full TypeScript types, ESM and CommonJS
- Safe retries: every send carries an idempotency key, so nothing is sent twice
- Webhook signature verification included

## Install

```sh
npm install curl-sms
```

## Quickstart

Create a key at [curl-sms.com](https://curl-sms.com). Test keys (`cs_test_…`) run all checks, send nothing and cost nothing, so you can try everything right away.

```ts
import { CurlSMS } from 'curl-sms';

const sms = new CurlSMS({ apiKey: 'cs_test_example' }); // or set CURLSMS_API_KEY

const message = await sms.send({ receiver: '+4915123456789', body: 'Hello from curl-sms' });
console.log(message.id, message.status); // 01JDQ8M3V6R1T5ZK2X9N4C7B0A queued
```

CommonJS works the same way:

```js
const { CurlSMS } = require('curl-sms');
```

Swap in a live key (`cs_live_…`) when you are ready; your code stays the same.

## Configuration

```ts
const sms = new CurlSMS({
  apiKey: 'cs_test_example', // default: CURLSMS_API_KEY, then CURLSMS_KEY
  baseUrl: 'https://curl-sms.com', // default
  timeout: 30_000, // per attempt, in milliseconds
  maxRetries: 2, // retries after network errors, timeouts, 429 and 5xx
  language: 'en', // language of error messages: 'en' or 'de'
  fetch: globalThis.fetch, // optional custom fetch implementation
});
```

Without an API key the constructor throws an error explaining how to set one.

## Methods

### `send`

One receiver returns a `Message`:

```ts
const message = await sms.send({ receiver: '+4915123456789', body: 'Your code is 4711' });
```

Up to 100 receivers return `{ ids, messages }`:

```ts
const { ids, messages } = await sms.send({
  receivers: ['+4915123456789', '+4917612345678'],
  body: 'Server backup finished.',
});
```

Schedule with `sendAt` (a `Date` or an RFC 3339 string, at most one year ahead):

```ts
await sms.send({
  receiver: '+4915123456789',
  body: 'Reminder: meeting at 9:00',
  sendAt: new Date('2026-12-01T07:00:00Z'),
});
```

Numbers without a country code are read as German numbers. Only mobile numbers are allowed.

### `estimate`

Encoding, parts and price without sending. With `receiver`, also whether the SMS would be allowed right now.

```ts
const estimate = await sms.estimate({ body: 'Grüße aus Brühl 👋', receiver: '+4915123456789' });
// { encoding: 'ucs2', segments: 1, price: '0.00', allowed: true }
```

### `get`

```ts
const message = await sms.get('01JDQ8M3V6R1T5ZK2X9N4C7B0A');
console.log(message.status); // scheduled, queued, dispatched, sent, delivered, failed, expired or canceled
```

### `cancel`

Cancels a scheduled or queued SMS (the price is refunded). For any other SMS only the text is deleted.

```ts
const canceled = await sms.cancel('01JDQ8M3V6R1T5ZK2X9N4C7B0A');
```

### `list`

Lists SMS ordered by last change. Pass `next_cursor` as `since` to poll only for changes.

```ts
let cursor: string | undefined;
const page = await sms.list({ since: cursor, status: 'delivered', limit: 100 });
for (const message of page.data) console.log(message.id, message.status);
cursor = page.next_cursor;
```

### `account`

```ts
const account = await sms.account();
console.log(account.plan, account.included_left, account.balance); // paid 287 12.40
```

Money amounts are decimal strings in euros (`"0.09"`), exactly as the API returns them.

### `health`

Needs no valid key.

```ts
const { ok, version } = await sms.health();
```

## Error handling

Every failure is a `CurlSMSError`:

```ts
import { CurlSMS, CurlSMSError } from 'curl-sms';

try {
  await sms.send({ receivers: ['+4915123456789', '12345'], body: 'Hi' });
} catch (error) {
  if (error instanceof CurlSMSError) {
    console.error(error.message); // "invalid_receiver: Invalid receiver number."
    console.error(error.status); // 422
    console.error(error.code); // "invalid_receiver"
    console.error(error.index); // 1: position in `receivers`
  }
}
```

| Property | Meaning |
|---|---|
| `status` | HTTP status, or `null` if no usable response arrived |
| `code` | API error code such as `invalid_receiver`, `insufficient_balance`, `rate_limited`; or `network_error`, `timeout`, `invalid_response` for client-side failures |
| `message` | `"<code>: <text>"` |
| `apiMessage` | The text alone, in the configured language |
| `index` | With `receivers`: the entry that caused the error |
| `errorId` | For `internal` errors; quote it when you contact support |
| `retryAfter` | Seconds from the `Retry-After` header |

All error codes are listed in the [API reference](https://curl-sms.com/docs/api).

## Retries and idempotency

The client retries network errors, timeouts, `429` and `5xx` up to `maxRetries` times (default 2), with exponential backoff (0.5 s, 1 s, 2 s, …). If the response carries `Retry-After` (as `429` does), it waits that long instead, at most 30 seconds. Other `4xx` errors are never retried.

Every `send` carries an `Idempotency-Key` (a random UUID unless you pass one), and the same key is reused on every retry. The API returns the stored response for a repeated key within 24 hours, so a retry never sends an SMS twice. Pass your own key to make repeated calls of your code safe as well:

```ts
await sms.send({ receiver: '+4915123456789', body: 'Order shipped', idempotencyKey: `order-${orderId}` });
```

## Webhooks

curl-sms signs every webhook with the header `X-CurlSMS-Signature: t=<unix>,v1=<hex>`. Verify it against the **raw** request body with your endpoint secret (`whsec_…`):

```ts
import express from 'express';
import { CurlSMSError, parseWebhook } from 'curl-sms';

const app = express();

app.post('/webhooks/curl-sms', express.raw({ type: 'application/json' }), (req, res) => {
  try {
    const event = parseWebhook(process.env.CURLSMS_WEBHOOK_SECRET!, req.get('X-CurlSMS-Signature'), req.body);
    if (event.type === 'sms.status_changed') {
      console.log(`SMS ${event.data.id} is now ${event.data.status}`);
    }
    res.sendStatus(200);
  } catch (error) {
    if (error instanceof CurlSMSError) return res.sendStatus(400); // code: invalid_signature
    throw error;
  }
});
```

- `verifyWebhook(secret, signatureHeader, rawBody, { tolerance, now })` returns `true` or `false`.
- `parseWebhook(...)` verifies and returns the typed event, or throws `CurlSMSError` with code `invalid_signature`.
- Signatures older or newer than `tolerance` seconds (default 300) are rejected to prevent replays.
- Delivery is at-least-once: deduplicate on `event.id` (same as the `X-CurlSMS-Event-Id` header).

Event types: `sms.status_changed`, `billing.quota_warning`, `billing.spend_limit_reached`, `billing.balance_low`, `webhook.test`. A dependency-free receiver is in [`examples/webhook.ts`](examples/webhook.ts).

## Test mode

Test keys (`cs_test_…`) run all checks, send nothing and cost nothing. Their status changes are simulated (`sent`, then `delivered`), and webhooks fire as for live SMS. Use them in development and CI.

## Requirements

Node.js 20 or later. TypeScript users get types out of the box; no `@types` package needed.

## Links

- Website: [curl-sms.com](https://curl-sms.com)
- Docs: [curl-sms.com/docs](https://curl-sms.com/docs)
- API reference: [curl-sms.com/docs/api](https://curl-sms.com/docs/api)
- Pricing: [curl-sms.com/pricing](https://curl-sms.com/pricing)
- Other clients and examples: [github.com/curl-sms](https://github.com/curl-sms)
- Support: [help@curl-sms.com](mailto:help@curl-sms.com)

## License

[MIT](LICENSE)
