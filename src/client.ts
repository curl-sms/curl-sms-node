import { randomUUID } from 'node:crypto';

import { CurlSMSError } from './errors';
import type {
  Account,
  ApiErrorBody,
  Estimate,
  Health,
  Message,
  MessageList,
  SendManyResponse,
  Status,
} from './types';
import { VERSION } from './version';

/** Options for {@link CurlSMS}. All are optional. */
export interface CurlSMSOptions {
  /**
   * API key (`cs_live_…` or `cs_test_…`). Defaults to the environment variable
   * `CURLSMS_API_KEY`, then `CURLSMS_KEY`.
   */
  apiKey?: string;
  /** Base URL of the API. Default `https://curl-sms.com`. */
  baseUrl?: string;
  /** Timeout per attempt in milliseconds. Default `30000`. */
  timeout?: number;
  /** Retries after network errors, timeouts, 429 and 5xx. Default `2`. */
  maxRetries?: number;
  /** Language of API error messages, sent as `Accept-Language` (`en` or `de`). Default `en`. */
  language?: string;
  /** Custom `fetch` implementation. Defaults to the global `fetch`. */
  fetch?: typeof globalThis.fetch;
}

interface SendBase {
  /** SMS text, UTF-8. At most 10 parts. */
  body: string;
  /** Schedule the SMS: a `Date` or an RFC 3339 string, later than now and at most one year ahead. */
  sendAt?: Date | string;
  /**
   * Idempotency key (printable ASCII, 1–255 characters). Generated automatically if
   * omitted, so retries never send twice. Reuse your own key to make repeated calls safe.
   */
  idempotencyKey?: string;
}

/** Send to one receiver. */
export interface SendOneParams extends SendBase {
  /** Mobile number, ideally E.164 (`+49…`). Without a country code it is read as German. */
  receiver: string;
  receivers?: never;
}

/** Send the same text to 1–100 receivers. */
export interface SendManyParams extends SendBase {
  receivers: string[];
  receiver?: never;
}

/** Parameters of {@link CurlSMS.send}: exactly one of `receiver` or `receivers`. */
export type SendParams = SendOneParams | SendManyParams;

/** Parameters of {@link CurlSMS.estimate}. */
export interface EstimateParams {
  /** SMS text. */
  body: string;
  /** Optional receiver for the price and permission check. */
  receiver?: string;
}

/** Parameters of {@link CurlSMS.list}. */
export interface ListParams {
  /** Cursor from a previous `next_cursor`: only SMS changed after it. */
  since?: string;
  /** Only SMS with this status. */
  status?: Status;
  /** Page size, 1–500 (API default 100). */
  limit?: number;
}

interface RequestOptions {
  body?: unknown;
  query?: Record<string, string | number | undefined>;
  idempotencyKey?: string;
  auth?: boolean;
  retry?: boolean;
  /** Non-2xx statuses whose JSON body is returned instead of thrown. */
  acceptStatuses?: number[];
}

const DEFAULT_BASE_URL = 'https://curl-sms.com';
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 2;
const MAX_RETRY_DELAY_MS = 30_000;
const BASE_BACKOFF_MS = 500;

/**
 * Client for the curl-sms API.
 *
 * ```ts
 * const sms = new CurlSMS({ apiKey: 'cs_test_example' });
 * const message = await sms.send({ receiver: '+4915123456789', body: 'Hello' });
 * ```
 */
export class CurlSMS {
  readonly baseUrl: string;
  readonly timeout: number;
  readonly maxRetries: number;
  readonly language: string;
  readonly #apiKey: string;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: CurlSMSOptions = {}) {
    const env = typeof process !== 'undefined' && process.env ? process.env : {};
    const apiKey = options.apiKey ?? env['CURLSMS_API_KEY'] ?? env['CURLSMS_KEY'];
    if (!apiKey) {
      throw new Error(
        'curl-sms: no API key. Pass { apiKey } or set the CURLSMS_API_KEY environment variable. ' +
          'Create a key at https://curl-sms.com (test keys start with cs_test_).',
      );
    }
    const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new TypeError('curl-sms: timeout must be a positive number of milliseconds.');
    }
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    if (!Number.isInteger(maxRetries) || maxRetries < 0) {
      throw new TypeError('curl-sms: maxRetries must be an integer >= 0.');
    }
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== 'function') {
      throw new Error('curl-sms: no fetch implementation found. Use Node.js 18 or later, or pass { fetch }.');
    }

    this.#apiKey = apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeout = timeout;
    this.maxRetries = maxRetries;
    this.language = options.language ?? 'en';
    this.#fetch = fetchImpl;
  }

  /**
   * Send an SMS. With `receiver` it resolves to the {@link Message}; with `receivers`
   * (1–100 numbers) to a {@link SendManyResponse}.
   */
  send(params: SendOneParams): Promise<Message>;
  send(params: SendManyParams): Promise<SendManyResponse>;
  send(params: SendParams): Promise<Message | SendManyResponse>;
  async send(params: SendParams): Promise<Message | SendManyResponse> {
    if (params === null || typeof params !== 'object') {
      throw new TypeError('curl-sms: send() expects an object like { receiver, body }.');
    }
    const hasOne = params.receiver !== undefined;
    const hasMany = params.receivers !== undefined;
    if (hasOne === hasMany) {
      throw new TypeError('curl-sms: pass exactly one of `receiver` or `receivers`.');
    }
    if (hasMany && !Array.isArray(params.receivers)) {
      throw new TypeError('curl-sms: `receivers` must be an array of phone numbers.');
    }
    if (typeof params.body !== 'string') {
      throw new TypeError('curl-sms: `body` must be a string.');
    }
    if (params.idempotencyKey !== undefined && params.idempotencyKey === '') {
      throw new TypeError('curl-sms: `idempotencyKey` must not be empty.');
    }

    const payload: Record<string, unknown> = hasOne
      ? { receiver: params.receiver, body: params.body }
      : { receivers: params.receivers, body: params.body };
    if (params.sendAt !== undefined) payload['send_at'] = formatSendAt(params.sendAt);

    return this.#request<Message | SendManyResponse>('POST', '/api/sms/send', {
      body: payload,
      idempotencyKey: params.idempotencyKey ?? randomUUID(),
    });
  }

  /** Calculate encoding, parts and price without sending. With `receiver`, also whether it is allowed now. */
  async estimate(params: EstimateParams): Promise<Estimate> {
    if (params === null || typeof params !== 'object' || typeof params.body !== 'string') {
      throw new TypeError('curl-sms: estimate() expects an object like { body, receiver? }.');
    }
    const payload: Record<string, unknown> = { body: params.body };
    if (params.receiver !== undefined) payload['receiver'] = params.receiver;
    return this.#request<Estimate>('POST', '/api/sms/estimate', { body: payload });
  }

  /** Get an SMS by ID. */
  async get(id: string): Promise<Message> {
    return this.#request<Message>('GET', `/api/sms/${encodeId(id)}`);
  }

  /** Cancel a scheduled or queued SMS (refunded), or delete the text of any other SMS. */
  async cancel(id: string): Promise<Message> {
    return this.#request<Message>('DELETE', `/api/sms/${encodeId(id)}`);
  }

  /** List SMS of the key's mode, ordered by last change. Pass `next_cursor` as `since` to poll for changes. */
  async list(params: ListParams = {}): Promise<MessageList> {
    return this.#request<MessageList>('GET', '/api/sms', {
      query: { since: params.since, status: params.status, limit: params.limit },
    });
  }

  /** Plan, included SMS, balance and limits. */
  async account(): Promise<Account> {
    return this.#request<Account>('GET', '/api/account');
  }

  /** Health check. Needs no valid key. Resolves with `{ ok: false }` if the service reports a problem (503). */
  async health(): Promise<Health> {
    return this.#request<Health>('GET', '/api/health', { auth: false, acceptStatuses: [503] });
  }

  async #request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Accept-Language': this.language,
      'User-Agent': `curl-sms-node/${VERSION}`,
    };
    if (options.auth !== false) headers['Authorization'] = `Bearer ${this.#apiKey}`;
    let body: string | undefined;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
    if (options.idempotencyKey !== undefined) headers['Idempotency-Key'] = options.idempotencyKey;

    const canRetry = options.retry !== false;
    for (let attempt = 0; ; attempt++) {
      const retriesLeft = canRetry && attempt < this.maxRetries;
      let result: { status: number; headers: Headers; text: string };
      try {
        result = await this.#fetchOnce(url, { method, headers, body });
      } catch (err) {
        if (retriesLeft) {
          await sleep(backoff(attempt));
          continue;
        }
        throw err;
      }

      const ok = (result.status >= 200 && result.status < 300) || options.acceptStatuses?.includes(result.status);
      if (ok) {
        try {
          return JSON.parse(result.text) as T;
        } catch (cause) {
          throw new CurlSMSError({
            status: result.status,
            code: 'invalid_response',
            message: `Response is not valid JSON (HTTP ${result.status}).`,
            cause,
          });
        }
      }

      const error = toApiError(result.status, result.headers, result.text);
      const retryableStatus = result.status === 429 || result.status >= 500;
      if (retryableStatus && retriesLeft) {
        await sleep(
          error.retryAfter !== undefined ? Math.min(error.retryAfter * 1000, MAX_RETRY_DELAY_MS) : backoff(attempt),
        );
        continue;
      }
      throw error;
    }
  }

  async #fetchOnce(
    url: URL,
    init: { method: string; headers: Record<string, string>; body: string | undefined },
  ): Promise<{ status: number; headers: Headers; text: string }> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeout);
    try {
      const response = await this.#fetch(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        signal: controller.signal,
      });
      const text = await response.text();
      return { status: response.status, headers: response.headers, text };
    } catch (cause) {
      if (timedOut) {
        throw new CurlSMSError({
          status: null,
          code: 'timeout',
          message: `No response within ${this.timeout} ms.`,
          cause,
        });
      }
      const detail = cause instanceof Error ? describeNetworkError(cause) : String(cause);
      throw new CurlSMSError({
        status: null,
        code: 'network_error',
        message: `Request to ${url.origin} failed: ${detail}`,
        cause,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

function formatSendAt(sendAt: Date | string): string {
  if (sendAt instanceof Date) {
    if (Number.isNaN(sendAt.getTime())) throw new TypeError('curl-sms: `sendAt` is an invalid Date.');
    return sendAt.toISOString();
  }
  if (typeof sendAt !== 'string' || sendAt === '') {
    throw new TypeError('curl-sms: `sendAt` must be a Date or an RFC 3339 string.');
  }
  return sendAt;
}

function encodeId(id: string): string {
  if (typeof id !== 'string' || id === '') {
    throw new TypeError('curl-sms: id must be a non-empty string.');
  }
  return encodeURIComponent(id);
}

function backoff(attempt: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_RETRY_DELAY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parse `Retry-After` (seconds or HTTP date) into seconds. */
function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

function toApiError(status: number, headers: Headers, text: string): CurlSMSError {
  const retryAfter = parseRetryAfter(headers.get('retry-after'));
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  const error = (parsed as Partial<ApiErrorBody> | undefined)?.error;
  if (error && typeof error.code === 'string' && typeof error.message === 'string') {
    return new CurlSMSError({
      status,
      code: error.code,
      message: error.message,
      index: typeof error.index === 'number' ? error.index : undefined,
      errorId: typeof error.error_id === 'string' ? error.error_id : undefined,
      retryAfter,
    });
  }
  return new CurlSMSError({
    status,
    code: 'invalid_response',
    message: `Unexpected response with HTTP ${status}.`,
    retryAfter,
  });
}

function describeNetworkError(err: Error): string {
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error && cause.message) return cause.message;
  return err.message;
}
