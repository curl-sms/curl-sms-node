// Minimal webhook receiver using only node:http.
// Run: CURLSMS_WEBHOOK_SECRET=whsec_... npx tsx examples/webhook.ts
import { createServer } from 'node:http';

import { CurlSMSError, parseWebhook } from 'curl-sms';

const secret = process.env['CURLSMS_WEBHOOK_SECRET'];
if (!secret) throw new Error('Set CURLSMS_WEBHOOK_SECRET to the endpoint secret (whsec_...).');

createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/webhooks/curl-sms') {
    res.writeHead(404).end();
    return;
  }
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    try {
      const event = parseWebhook(secret, req.headers['x-curlsms-signature'], Buffer.concat(chunks));
      if (event.type === 'sms.status_changed') {
        console.log(`SMS ${event.data.id} is now ${event.data.status}`);
      } else {
        console.log(`Event ${event.type} (${event.id})`);
      }
      res.writeHead(200).end();
    } catch (error) {
      if (error instanceof CurlSMSError) {
        res.writeHead(400).end();
        return;
      }
      throw error;
    }
  });
}).listen(3000, () => console.log('Listening on http://localhost:3000/webhooks/curl-sms'));
