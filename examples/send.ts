// Send one SMS and print its status.
// Run: CURLSMS_API_KEY=cs_test_example npx tsx examples/send.ts
import { CurlSMS, CurlSMSError } from 'curl-sms';

const sms = new CurlSMS();

try {
  const message = await sms.send({ receiver: '+4915123456789', body: 'Hello from curl-sms' });
  console.log(`${message.id}: ${message.status} (${message.segments} part(s), ${message.price} EUR)`);

  const latest = await sms.get(message.id);
  console.log(`Now: ${latest.status}`);
} catch (error) {
  if (error instanceof CurlSMSError) {
    console.error(`Failed (${error.status ?? 'no response'}): ${error.message}`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
