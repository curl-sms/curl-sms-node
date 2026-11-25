import type { ClientErrorCode, ErrorCode } from './types';

/** Constructor input of {@link CurlSMSError}. */
export interface CurlSMSErrorInit {
  status: number | null;
  code: ErrorCode | ClientErrorCode | (string & {});
  message: string;
  index?: number | undefined;
  errorId?: string | undefined;
  retryAfter?: number | undefined;
  cause?: unknown;
}

/**
 * The single error type of this client.
 *
 * - API errors: `status` is the HTTP status, `code` the API error code (e.g. `invalid_receiver`).
 * - Client-side failures: `status` is `null`, `code` is `network_error`, `timeout`,
 *   `invalid_response` or `invalid_signature`.
 *
 * `message` reads `"<code>: <text>"`; the plain text is in `apiMessage`.
 */
export class CurlSMSError extends Error {
  /** HTTP status, or `null` if no usable response was received. */
  readonly status: number | null;
  /** API error code or client-side code. */
  readonly code: ErrorCode | ClientErrorCode | (string & {});
  /** The error text without the code (from the API, in the requested language). */
  readonly apiMessage: string;
  /** With `receivers`: position of the entry that caused the error. */
  readonly index: number | undefined;
  /** Only for `internal` errors. Quote it when you contact support. */
  readonly errorId: string | undefined;
  /** Seconds to wait before retrying, from the `Retry-After` header. */
  readonly retryAfter: number | undefined;

  constructor(init: CurlSMSErrorInit) {
    super(`${init.code}: ${init.message}`, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = 'CurlSMSError';
    this.status = init.status;
    this.code = init.code;
    this.apiMessage = init.message;
    this.index = init.index;
    this.errorId = init.errorId;
    this.retryAfter = init.retryAfter;
  }
}
