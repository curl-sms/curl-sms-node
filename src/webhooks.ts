import { createHmac, timingSafeEqual } from 'node:crypto';

import { CurlSMSError } from './errors';
import type { WebhookEvent } from './types';

/** Name of the signature header sent with every webhook. */
export const WEBHOOK_SIGNATURE_HEADER = 'X-CurlSMS-Signature';

/** Options for {@link verifyWebhook} and {@link parseWebhook}. */
export interface VerifyWebhookOptions {
  /** Maximum age of the signature timestamp in seconds (both directions). Default `300`. */
  tolerance?: number;
  /** Current time as a `Date` or Unix seconds. Defaults to the system clock. */
  now?: Date | number;
}

/** A header value as Node.js frameworks provide it. */
export type SignatureHeader = string | string[] | null | undefined;

/** The raw request body, exactly as received. */
export type RawBody = string | Uint8Array;

const DEFAULT_TOLERANCE_S = 300;

/**
 * Check the `X-CurlSMS-Signature` header (`t=<unix>,v1=<hex>`) of a webhook request.
 *
 * `v1` is the hex HMAC-SHA256 of `<t>.<raw body>` with the endpoint secret (`whsec_…`).
 * Returns `false` for a missing, malformed, wrong or expired signature.
 * Pass the raw body (string or Buffer), not a parsed object.
 */
export function verifyWebhook(
  secret: string,
  signatureHeader: SignatureHeader,
  rawBody: RawBody,
  options: VerifyWebhookOptions = {},
): boolean {
  if (typeof secret !== 'string' || secret === '') {
    throw new TypeError('curl-sms: webhook secret must be a non-empty string (whsec_…).');
  }
  const body = toBuffer(rawBody);
  const header = Array.isArray(signatureHeader) ? signatureHeader.join(',') : signatureHeader;
  if (typeof header !== 'string' || header === '') return false;

  let timestamp: string | undefined;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') timestamp = value;
    else if (key === 'v1') signatures.push(value);
  }
  if (timestamp === undefined || !/^\d+$/.test(timestamp) || signatures.length === 0) return false;

  const tolerance = options.tolerance ?? DEFAULT_TOLERANCE_S;
  const now =
    options.now instanceof Date
      ? options.now.getTime() / 1000
      : typeof options.now === 'number'
        ? options.now
        : Date.now() / 1000;
  if (Math.abs(now - Number(timestamp)) > tolerance) return false;

  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.`)
    .update(body)
    .digest();

  let valid = false;
  for (const signature of signatures) {
    if (!/^[0-9a-fA-F]{64}$/.test(signature)) continue;
    if (timingSafeEqual(Buffer.from(signature, 'hex'), expected)) valid = true;
  }
  return valid;
}

/**
 * Verify a webhook request and return the parsed event.
 * Throws {@link CurlSMSError} with code `invalid_signature` if verification fails.
 */
export function parseWebhook(
  secret: string,
  signatureHeader: SignatureHeader,
  rawBody: RawBody,
  options: VerifyWebhookOptions = {},
): WebhookEvent {
  if (!verifyWebhook(secret, signatureHeader, rawBody, options)) {
    throw new CurlSMSError({
      status: null,
      code: 'invalid_signature',
      message: 'Webhook signature is missing, invalid or expired.',
    });
  }
  try {
    return JSON.parse(toBuffer(rawBody).toString('utf8')) as WebhookEvent;
  } catch (cause) {
    throw new CurlSMSError({
      status: null,
      code: 'invalid_response',
      message: 'Webhook body is not valid JSON.',
      cause,
    });
  }
}

function toBuffer(rawBody: RawBody): Buffer {
  if (typeof rawBody === 'string') return Buffer.from(rawBody, 'utf8');
  if (rawBody instanceof Uint8Array) return Buffer.from(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength);
  throw new TypeError(
    'curl-sms: pass the raw request body (string or Buffer) to verify a webhook, not a parsed object.',
  );
}
