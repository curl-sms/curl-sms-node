import { readFileSync } from 'node:fs';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { CurlSMS, CurlSMSError, VERSION, type Message, type SendManyResponse } from '../src/index';
import { apiError, message, MockServer } from './mock-server';

const KEY = 'cs_test_example';
const NUMBER = '+4915123456789';

const server = new MockServer();
let client: CurlSMS;

beforeAll(async () => {
  await server.start();
});

afterAll(async () => {
  await server.stop();
});

afterEach(() => {
  server.reset();
});

function makeClient(options: ConstructorParameters<typeof CurlSMS>[0] = {}): CurlSMS {
  return new CurlSMS({ apiKey: KEY, baseUrl: server.url, ...options });
}

describe('construction', () => {
  const saved = { api: process.env['CURLSMS_API_KEY'], key: process.env['CURLSMS_KEY'] };

  afterEach(() => {
    restoreEnv('CURLSMS_API_KEY', saved.api);
    restoreEnv('CURLSMS_KEY', saved.key);
  });

  it('reads CURLSMS_API_KEY from the environment', async () => {
    process.env['CURLSMS_API_KEY'] = 'cs_test_from_env';
    process.env['CURLSMS_KEY'] = 'cs_test_fallback';
    server.enqueue({ status: 200, body: accountBody() });
    await new CurlSMS({ baseUrl: server.url }).account();
    expect(server.requests[0]?.headers.authorization).toBe('Bearer cs_test_from_env');
  });

  it('falls back to CURLSMS_KEY', async () => {
    delete process.env['CURLSMS_API_KEY'];
    process.env['CURLSMS_KEY'] = 'cs_test_fallback';
    server.enqueue({ status: 200, body: accountBody() });
    await new CurlSMS({ baseUrl: server.url }).account();
    expect(server.requests[0]?.headers.authorization).toBe('Bearer cs_test_fallback');
  });

  it('prefers the explicit apiKey over the environment', async () => {
    process.env['CURLSMS_API_KEY'] = 'cs_test_from_env';
    server.enqueue({ status: 200, body: accountBody() });
    await makeClient().account();
    expect(server.requests[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it('throws a clear error without any key', () => {
    delete process.env['CURLSMS_API_KEY'];
    delete process.env['CURLSMS_KEY'];
    expect(() => new CurlSMS()).toThrow(/CURLSMS_API_KEY/);
  });

  it('validates timeout and maxRetries', () => {
    expect(() => new CurlSMS({ apiKey: KEY, timeout: 0 })).toThrow(TypeError);
    expect(() => new CurlSMS({ apiKey: KEY, maxRetries: -1 })).toThrow(TypeError);
  });

  it('uses defaults', () => {
    const c = new CurlSMS({ apiKey: KEY });
    expect(c.baseUrl).toBe('https://curl-sms.com');
    expect(c.timeout).toBe(30_000);
    expect(c.maxRetries).toBe(2);
    expect(c.language).toBe('en');
  });

  it('strips trailing slashes from baseUrl', () => {
    expect(new CurlSMS({ apiKey: KEY, baseUrl: 'https://example.test///' }).baseUrl).toBe('https://example.test');
  });

  it('does not expose the key as an enumerable property', () => {
    expect(JSON.stringify(new CurlSMS({ apiKey: KEY }))).not.toContain(KEY);
  });
});

describe('send', () => {
  it('sends to one receiver and returns the message', async () => {
    client = makeClient();
    server.enqueue({ status: 202, body: message() });

    const result: Message = await client.send({ receiver: NUMBER, body: 'Hello' });

    expect(result.id).toBe('01JDQ8M3V6R1T5ZK2X9N4C7B0A');
    expect(result.price).toBe('0.00');
    const req = server.requests[0]!;
    expect(req.method).toBe('POST');
    expect(req.path).toBe('/api/sms/send');
    expect(req.json).toEqual({ receiver: NUMBER, body: 'Hello' });
    expect(req.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(req.headers['content-type']).toBe('application/json');
    expect(req.headers.accept).toBe('application/json');
    expect(req.headers['accept-language']).toBe('en');
    expect(req.headers['user-agent']).toBe(`curl-sms-node/${VERSION}`);
    expect(req.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('sends to many receivers and returns ids and messages', async () => {
    client = makeClient();
    const second = message({ id: '01JDQ8M3V6R1T5ZK2X9N4C7B0B', receiver: '+4917612345678' });
    server.enqueue({ status: 202, body: { ids: ['01JDQ8M3V6R1T5ZK2X9N4C7B0A', second['id']], messages: [message(), second] } });

    const result: SendManyResponse = await client.send({
      receivers: [NUMBER, '+4917612345678'],
      body: 'Backup finished.',
    });

    expect(result.ids).toHaveLength(2);
    expect(result.messages[1]?.receiver).toBe('+4917612345678');
    expect(server.requests[0]?.json).toEqual({ receivers: [NUMBER, '+4917612345678'], body: 'Backup finished.' });
  });

  it('formats sendAt from a Date and passes strings through', async () => {
    client = makeClient();
    server.enqueue({ status: 202, body: message({ status: 'scheduled' }) }, { status: 202, body: message() });

    await client.send({ receiver: NUMBER, body: 'Later', sendAt: new Date('2026-12-01T07:00:00Z') });
    await client.send({ receiver: NUMBER, body: 'Later', sendAt: '2026-12-01T08:00:00+01:00' });

    expect(server.requests[0]?.json).toMatchObject({ send_at: '2026-12-01T07:00:00.000Z' });
    expect(server.requests[1]?.json).toMatchObject({ send_at: '2026-12-01T08:00:00+01:00' });
  });

  it('uses a given idempotency key', async () => {
    client = makeClient();
    server.enqueue({ status: 202, body: message() });
    await client.send({ receiver: NUMBER, body: 'Hi', idempotencyKey: 'order-4711' });
    expect(server.requests[0]?.headers['idempotency-key']).toBe('order-4711');
  });

  it('generates a new idempotency key per call', async () => {
    client = makeClient();
    server.enqueue({ status: 202, body: message() }, { status: 202, body: message() });
    await client.send({ receiver: NUMBER, body: 'One' });
    await client.send({ receiver: NUMBER, body: 'Two' });
    expect(server.requests[0]?.headers['idempotency-key']).not.toBe(server.requests[1]?.headers['idempotency-key']);
  });

  it('rejects invalid arguments without a request', async () => {
    client = makeClient();
    // @ts-expect-error both receiver and receivers
    await expect(client.send({ receiver: NUMBER, receivers: [NUMBER], body: 'x' })).rejects.toThrow(TypeError);
    // @ts-expect-error neither receiver nor receivers
    await expect(client.send({ body: 'x' })).rejects.toThrow(TypeError);
    await expect(client.send({ receiver: NUMBER, body: 'x', sendAt: new Date('nope') })).rejects.toThrow(TypeError);
    await expect(client.send({ receiver: NUMBER, body: 'x', idempotencyKey: '' })).rejects.toThrow(TypeError);
    expect(server.requests).toHaveLength(0);
  });
});

describe('other endpoints', () => {
  it('estimate posts body and receiver', async () => {
    client = makeClient();
    server.enqueue({ status: 200, body: { encoding: 'ucs2', segments: 1, price: '0.00', allowed: true } });
    const estimate = await client.estimate({ body: 'Grüße 👋', receiver: NUMBER });
    expect(estimate).toEqual({ encoding: 'ucs2', segments: 1, price: '0.00', allowed: true });
    expect(server.requests[0]?.path).toBe('/api/sms/estimate');
    expect(server.requests[0]?.json).toEqual({ body: 'Grüße 👋', receiver: NUMBER });
  });

  it('estimate without receiver sends only the body', async () => {
    client = makeClient();
    server.enqueue({ status: 200, body: { encoding: 'gsm7', segments: 1, price: '0.00', allowed: true } });
    await client.estimate({ body: 'Hi' });
    expect(server.requests[0]?.json).toEqual({ body: 'Hi' });
  });

  it('get URL-encodes the id', async () => {
    client = makeClient();
    server.enqueue({ status: 200, body: message({ status: 'delivered' }) });
    const result = await client.get('a/b c');
    expect(result.status).toBe('delivered');
    expect(server.requests[0]?.method).toBe('GET');
    expect(server.requests[0]?.path).toBe('/api/sms/a%2Fb%20c');
  });

  it('cancel sends DELETE', async () => {
    client = makeClient();
    server.enqueue({ status: 200, body: message({ status: 'canceled', refunded: true }) });
    const result = await client.cancel('01JDQ8M3V6R1T5ZK2X9N4C7B0A');
    expect(result.refunded).toBe(true);
    expect(server.requests[0]?.method).toBe('DELETE');
    expect(server.requests[0]?.path).toBe('/api/sms/01JDQ8M3V6R1T5ZK2X9N4C7B0A');
  });

  it('list passes only the given query parameters', async () => {
    client = makeClient();
    server.enqueue(
      { status: 200, body: { data: [message()], next_cursor: 'c1' } },
      { status: 200, body: { data: [], next_cursor: 'c2' } },
    );
    const page = await client.list();
    expect(page.next_cursor).toBe('c1');
    expect(page.data).toHaveLength(1);
    expect([...server.requests[0]!.query.keys()]).toEqual([]);

    await client.list({ since: 'c1', status: 'delivered', limit: 50 });
    const query = server.requests[1]!.query;
    expect(query.get('since')).toBe('c1');
    expect(query.get('status')).toBe('delivered');
    expect(query.get('limit')).toBe('50');
  });

  it('account returns the account', async () => {
    client = makeClient();
    server.enqueue({ status: 200, body: accountBody() });
    const account = await client.account();
    expect(account.balance).toBe('12.40');
    expect(server.requests[0]?.path).toBe('/api/account');
  });

  it('health sends no Authorization header', async () => {
    client = makeClient();
    server.enqueue({ status: 200, body: { ok: true, version: '1.0.0' } });
    expect(await client.health()).toEqual({ ok: true, version: '1.0.0' });
    expect(server.requests[0]?.headers.authorization).toBeUndefined();
  });

  it('health returns ok=false on 503 without retrying', async () => {
    client = makeClient();
    server.enqueue({ status: 503, body: { ok: false, version: '1.0.0' } });
    expect(await client.health()).toEqual({ ok: false, version: '1.0.0' });
    expect(server.requests).toHaveLength(1);
  });

  it('sends the configured language', async () => {
    client = makeClient({ language: 'de' });
    server.enqueue({ status: 200, body: accountBody() });
    await client.account();
    expect(server.requests[0]?.headers['accept-language']).toBe('de');
  });
});

describe('errors', () => {
  it('maps API errors with code, message and index', async () => {
    client = makeClient();
    server.enqueue({ status: 422, body: apiError('invalid_receiver', 'Invalid receiver number.', { index: 1 }) });

    const error = await client.send({ receivers: [NUMBER, '123'], body: 'x' }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CurlSMSError);
    expect(error).toBeInstanceOf(Error);
    const e = error as CurlSMSError;
    expect(e.name).toBe('CurlSMSError');
    expect(e.status).toBe(422);
    expect(e.code).toBe('invalid_receiver');
    expect(e.index).toBe(1);
    expect(e.apiMessage).toBe('Invalid receiver number.');
    expect(e.message).toBe('invalid_receiver: Invalid receiver number.');
  });

  it('does not retry 422', async () => {
    client = makeClient();
    server.enqueue({ status: 422, body: apiError('body_empty', 'Text is empty.') });
    await expect(client.send({ receiver: NUMBER, body: '' })).rejects.toMatchObject({ code: 'body_empty' });
    expect(server.requests).toHaveLength(1);
  });

  it.each([
    [401, 'unauthorized'],
    [402, 'insufficient_balance'],
    [403, 'verification_required'],
    [404, 'not_found'],
    [409, 'not_cancelable'],
  ])('does not retry HTTP %i', async (status, code) => {
    client = makeClient();
    server.enqueue({ status, body: apiError(code, 'Nope.') });
    await expect(client.cancel('x')).rejects.toMatchObject({ status, code });
    expect(server.requests).toHaveLength(1);
  });

  it('exposes error_id of internal errors', async () => {
    client = makeClient({ maxRetries: 0 });
    server.enqueue({ status: 500, body: apiError('internal', 'Internal error.', { error_id: '01JDQ8R0A1B2C3D4E5F6G7H8J9' }) });
    await expect(client.account()).rejects.toMatchObject({
      status: 500,
      code: 'internal',
      errorId: '01JDQ8R0A1B2C3D4E5F6G7H8J9',
    });
  });

  it('reports non-JSON error bodies as invalid_response', async () => {
    client = makeClient({ maxRetries: 0 });
    server.enqueue({ status: 502, rawBody: '<html>Bad Gateway</html>', headers: { 'Content-Type': 'text/html' } });
    await expect(client.account()).rejects.toMatchObject({ status: 502, code: 'invalid_response' });
  });

  it('reports invalid JSON in a success response as invalid_response', async () => {
    client = makeClient();
    server.enqueue({ status: 200, rawBody: 'not json' });
    await expect(client.account()).rejects.toMatchObject({ status: 200, code: 'invalid_response' });
  });

  it('reports a timeout', async () => {
    client = makeClient({ timeout: 100, maxRetries: 0 });
    server.enqueue({ status: 200, body: accountBody(), delay: 1_000 });
    await expect(client.account()).rejects.toMatchObject({ status: null, code: 'timeout' });
  });

  it('reports network errors', async () => {
    client = new CurlSMS({ apiKey: KEY, baseUrl: 'http://127.0.0.1:1', maxRetries: 0 });
    await expect(client.account()).rejects.toMatchObject({ status: null, code: 'network_error' });
  });
});

describe('retries', () => {
  it('retries 429 respecting Retry-After and keeps the idempotency key', async () => {
    client = makeClient();
    server.enqueue(
      { status: 429, body: apiError('rate_limited', 'Too many requests.'), headers: { 'Retry-After': '1' } },
      { status: 202, body: message() },
    );

    const started = Date.now();
    const result = await client.send({ receiver: NUMBER, body: 'Hi' });

    expect(result.status).toBe('queued');
    expect(Date.now() - started).toBeGreaterThanOrEqual(950);
    expect(server.requests).toHaveLength(2);
    const [first, second] = server.requests;
    expect(first?.headers['idempotency-key']).toBeDefined();
    expect(second?.headers['idempotency-key']).toBe(first?.headers['idempotency-key']);
    expect(second?.body).toBe(first?.body);
  });

  it('retries 503 with Retry-After', async () => {
    client = makeClient();
    server.enqueue(
      { status: 503, body: apiError('internal', 'Unavailable.'), headers: { 'Retry-After': '0' } },
      { status: 503, body: apiError('internal', 'Unavailable.'), headers: { 'Retry-After': '0' } },
      { status: 200, body: accountBody() },
    );
    const account = await client.account();
    expect(account.plan).toBe('paid');
    expect(server.requests).toHaveLength(3);
  });

  it('gives up after maxRetries and reports retryAfter', async () => {
    client = makeClient({ maxRetries: 1 });
    server.enqueue(
      { status: 429, body: apiError('rate_limited', 'Too many requests.'), headers: { 'Retry-After': '0' } },
      { status: 429, body: apiError('rate_limited', 'Too many requests.'), headers: { 'Retry-After': '7' } },
    );
    await expect(client.account()).rejects.toMatchObject({ status: 429, code: 'rate_limited', retryAfter: 7 });
    expect(server.requests).toHaveLength(2);
  });

  it('does not retry when maxRetries is 0', async () => {
    client = makeClient({ maxRetries: 0 });
    server.enqueue({ status: 503, body: apiError('internal', 'Unavailable.'), headers: { 'Retry-After': '0' } });
    await expect(client.account()).rejects.toMatchObject({ status: 503 });
    expect(server.requests).toHaveLength(1);
  });

  it('retries network errors with the same idempotency key', async () => {
    client = makeClient({ maxRetries: 1 });
    server.enqueue({ status: 0, drop: true }, { status: 202, body: message() });
    const result = await client.send({ receiver: NUMBER, body: 'Hi' });
    expect(result.id).toBe('01JDQ8M3V6R1T5ZK2X9N4C7B0A');
    expect(server.requests).toHaveLength(2);
    expect(server.requests[1]?.headers['idempotency-key']).toBe(server.requests[0]?.headers['idempotency-key']);
  });

  it('retries timeouts', async () => {
    client = makeClient({ timeout: 200, maxRetries: 1 });
    server.enqueue({ status: 200, body: accountBody(), delay: 1_000 }, { status: 200, body: accountBody() });
    const account = await client.account();
    expect(account.plan).toBe('paid');
    expect(server.requests).toHaveLength(2);
  });
});

describe('custom fetch', () => {
  it('uses an injected fetch implementation', async () => {
    const calls: string[] = [];
    const fakeFetch: typeof fetch = async (input) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ ok: true, version: 'x' }), { status: 200 });
    };
    const c = new CurlSMS({ apiKey: KEY, baseUrl: 'https://api.example.test', fetch: fakeFetch });
    expect(await c.health()).toEqual({ ok: true, version: 'x' });
    expect(calls).toEqual(['https://api.example.test/api/health']);
  });
});

describe('package', () => {
  it('VERSION matches package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });
});

function accountBody(): Record<string, unknown> {
  return {
    plan: 'paid',
    mode: 'live',
    included_total: 300,
    included_left: 287,
    balance: '12.40',
    spend_limit: '10.00',
    spent: '0.18',
    daily_limit: 500,
    daily_left: 488,
  };
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
