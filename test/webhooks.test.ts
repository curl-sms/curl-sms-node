import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { CurlSMSError, parseWebhook, verifyWebhook } from '../src/index';

const SECRET = 'whsec_test_example';
const NOW = 1_763_892_907;
const BODY = JSON.stringify({
  id: 'evt_01JDQ8P2K9W3E6Y1M4T7Z0R5C8',
  type: 'sms.status_changed',
  created: NOW,
  data: { id: '01JDQ8M3V6R1T5ZK2X9N4C7B0A', status: 'delivered', at: '2026-11-23T10:15:07.123Z' },
});

function sign(body: string, t: number = NOW, secret: string = SECRET): string {
  const v1 = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return `t=${t},v1=${v1}`;
}

describe('verifyWebhook', () => {
  it('accepts a valid signature', () => {
    expect(verifyWebhook(SECRET, sign(BODY), BODY, { now: NOW })).toBe(true);
  });

  it('accepts a Buffer body and a Date for now', () => {
    expect(verifyWebhook(SECRET, sign(BODY), Buffer.from(BODY), { now: new Date(NOW * 1000) })).toBe(true);
  });

  it('accepts the header as an array and with spaces', () => {
    const header = sign(BODY).replace(',', ', ');
    expect(verifyWebhook(SECRET, [header], BODY, { now: NOW })).toBe(true);
  });

  it('accepts if any of several v1 signatures matches', () => {
    const valid = sign(BODY).split('v1=')[1];
    const header = `t=${NOW},v1=${'f'.repeat(64)},v1=${valid}`;
    expect(verifyWebhook(SECRET, header, BODY, { now: NOW })).toBe(true);
  });

  it('rejects a wrong secret', () => {
    expect(verifyWebhook('whsec_other', sign(BODY), BODY, { now: NOW })).toBe(false);
  });

  it('uses the full secret including the whsec_ prefix', () => {
    const withoutPrefix = sign(BODY, NOW, SECRET.slice('whsec_'.length));
    expect(verifyWebhook(SECRET, withoutPrefix, BODY, { now: NOW })).toBe(false);
  });

  it('rejects a tampered body', () => {
    expect(verifyWebhook(SECRET, sign(BODY), BODY.replace('delivered', 'failed'), { now: NOW })).toBe(false);
  });

  it('rejects an expired timestamp', () => {
    expect(verifyWebhook(SECRET, sign(BODY), BODY, { now: NOW + 301 })).toBe(false);
    expect(verifyWebhook(SECRET, sign(BODY), BODY, { now: NOW + 300 })).toBe(true);
  });

  it('rejects a timestamp too far in the future', () => {
    expect(verifyWebhook(SECRET, sign(BODY), BODY, { now: NOW - 301 })).toBe(false);
  });

  it('respects a custom tolerance', () => {
    expect(verifyWebhook(SECRET, sign(BODY), BODY, { now: NOW + 1000, tolerance: 1200 })).toBe(true);
  });

  it('uses the system clock by default', () => {
    const t = Math.floor(Date.now() / 1000);
    expect(verifyWebhook(SECRET, sign(BODY, t), BODY)).toBe(true);
    expect(verifyWebhook(SECRET, sign(BODY, t - 3600), BODY)).toBe(false);
  });

  it.each([undefined, null, '', 'garbage', `t=${NOW}`, 'v1=abc', `t=abc,v1=${'a'.repeat(64)}`, `t=${NOW},v1=zz`])(
    'rejects a malformed header: %s',
    (header) => {
      expect(verifyWebhook(SECRET, header, BODY, { now: NOW })).toBe(false);
    },
  );

  it('throws on a missing secret or a parsed body', () => {
    expect(() => verifyWebhook('', sign(BODY), BODY)).toThrow(TypeError);
    // @ts-expect-error parsed object instead of raw body
    expect(() => verifyWebhook(SECRET, sign(BODY), JSON.parse(BODY) as object)).toThrow(/raw request body/);
  });
});

describe('parseWebhook', () => {
  it('returns the parsed event', () => {
    const event = parseWebhook(SECRET, sign(BODY), BODY, { now: NOW });
    expect(event.type).toBe('sms.status_changed');
    if (event.type === 'sms.status_changed') {
      expect(event.data.status).toBe('delivered');
    }
  });

  it('throws invalid_signature on failure', () => {
    let error: unknown;
    try {
      parseWebhook(SECRET, sign(BODY), BODY, { now: NOW + 1000 });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(CurlSMSError);
    expect(error).toMatchObject({ code: 'invalid_signature', status: null });
  });

  it('throws invalid_response for a signed body that is not JSON', () => {
    expect(() => parseWebhook(SECRET, sign('not json'), 'not json', { now: NOW })).toThrow(
      expect.objectContaining({ code: 'invalid_response' }),
    );
  });
});
