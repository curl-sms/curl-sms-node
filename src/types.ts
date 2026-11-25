/**
 * Types mirroring the schemas of the curl-sms OpenAPI description.
 * Field names are kept exactly as the API returns them (snake_case).
 * Money amounts are decimal strings in euros, e.g. `"0.09"`.
 */

/**
 * Lifecycle of an SMS: `scheduled` → `queued` → `dispatched` → `sent` → `delivered`,
 * plus the end states `failed` (refunded automatically), `expired` and `canceled`.
 * `delivered` is only set where the network provides a delivery report; rely on `sent`.
 */
export type Status =
  | 'scheduled'
  | 'queued'
  | 'dispatched'
  | 'sent'
  | 'delivered'
  | 'failed'
  | 'expired'
  | 'canceled';

/** Error codes returned by the API in `{"error":{"code":"…"}}`. */
export type ErrorCode =
  | 'unauthorized'
  | 'invalid_json'
  | 'invalid_receiver'
  | 'ambiguous_receiver'
  | 'body_empty'
  | 'body_invalid_utf8'
  | 'body_too_long'
  | 'too_many_receivers'
  | 'send_at_out_of_range'
  | 'invalid_idempotency_key'
  | 'idempotency_key_mismatch'
  | 'idempotency_in_progress'
  | 'invalid_cursor'
  | 'payload_too_large'
  | 'not_found'
  | 'not_cancelable'
  | 'rate_limited'
  | 'daily_limit'
  | 'destination_blocked'
  | 'free_zone_only'
  | 'stop_listed'
  | 'suspended'
  | 'verification_required'
  | 'insufficient_balance'
  | 'spend_limit'
  | 'internal';

/** Error codes produced by this client when there is no API error to report. */
export type ClientErrorCode = 'network_error' | 'timeout' | 'invalid_response' | 'invalid_signature';

/** Key mode: live keys send real SMS, test keys run all checks but send nothing. */
export type Mode = 'live' | 'test';

/** Text encoding. GSM-7 parts hold 160 characters (153 when split), UCS-2 parts 70 (67). */
export type Encoding = 'gsm7' | 'ucs2';

/** An SMS as returned by `send`, `get`, `cancel` and `list`. */
export interface Message {
  /** ULID of the SMS. */
  id: string;
  mode: Mode;
  /** Receiver in E.164 format. Empty after account deletion. */
  receiver: string;
  status: Status;
  /** Number of SMS parts. */
  segments: number;
  encoding: Encoding;
  /** Price charged from the balance in euros (`"0.00"` for included SMS and test keys). */
  price: string;
  /** Reason if the SMS failed or expired, e.g. `send_failed` or `queue_timeout`; `null` otherwise. */
  error_code: string | null;
  /** `true` if the price was credited back. `price` always keeps the original amount. */
  refunded: boolean;
  /** RFC 3339 timestamp. */
  created_at: string;
  send_at: string | null;
  sent_at: string | null;
  delivered_at: string | null;
}

/** Response of `send` with `receivers`. */
export interface SendManyResponse {
  ids: string[];
  messages: Message[];
}

/** Result of `estimate`. */
export interface Estimate {
  encoding: Encoding;
  segments: number;
  /** Price in euros. */
  price: string;
  /** Whether the SMS would be allowed right now. */
  allowed: boolean;
  /** Error code if `allowed` is false. */
  code?: ErrorCode | (string & {});
}

/** Plan, quota, balance and limits of the account behind the key. */
export interface Account {
  /** For example `free` or `paid`. */
  plan: string;
  mode: Mode;
  included_total: number;
  included_left: number;
  /** Prepaid balance in euros. */
  balance: string;
  /** Monthly cap on balance use in euros (`"0.00"` = no balance use). */
  spend_limit: string;
  /** Balance used in the current period in euros. */
  spent: string;
  daily_limit: number;
  daily_left: number;
}

/** One page of SMS from `list`. */
export interface MessageList {
  data: Message[];
  /** Pass as `since` in the next call to get only later changes. */
  next_cursor: string;
}

/** Response of `health`. */
export interface Health {
  ok: boolean;
  version?: string;
}

/** Body of an API error response. */
export interface ApiErrorBody {
  error: {
    code: ErrorCode | (string & {});
    message: string;
    index?: number;
    error_id?: string;
  };
}

/** Type of a webhook event. */
export type WebhookEventType =
  | 'sms.status_changed'
  | 'billing.quota_warning'
  | 'billing.spend_limit_reached'
  | 'billing.balance_low'
  | 'webhook.test';

/** Fields shared by all webhook events. */
export interface WebhookEnvelope<T extends WebhookEventType, D> {
  /** Event ID, same as the `X-CurlSMS-Event-Id` header. Delivery is at-least-once: deduplicate on it. */
  id: string;
  type: T;
  /** Unix seconds. */
  created: number;
  data: D;
}

/** Data of `sms.status_changed`. */
export interface StatusChangedData {
  /** ID of the SMS. */
  id: string;
  status: Status;
  /** Only set on errors. */
  error_code?: string;
  /** RFC 3339 timestamp of the change. */
  at: string;
}

/** Data of `billing.quota_warning`: included SMS 50, 75 or 100 % used. */
export interface QuotaWarningData {
  pct: 50 | 75 | 100;
  used: number;
  included: number;
  period_start: string;
}

/** Data of `billing.spend_limit_reached`. */
export interface SpendLimitReachedData {
  spent_cents: number;
  limit_cents: number;
  period_start: string;
}

/** Data of `billing.balance_low`. */
export interface BalanceLowData {
  balance_cents: number;
  period_start: string;
}

/** Data of `webhook.test`. */
export interface WebhookTestData {
  message?: string;
}

export type StatusChangedEvent = WebhookEnvelope<'sms.status_changed', StatusChangedData>;
export type QuotaWarningEvent = WebhookEnvelope<'billing.quota_warning', QuotaWarningData>;
export type SpendLimitReachedEvent = WebhookEnvelope<'billing.spend_limit_reached', SpendLimitReachedData>;
export type BalanceLowEvent = WebhookEnvelope<'billing.balance_low', BalanceLowData>;
export type WebhookTestEvent = WebhookEnvelope<'webhook.test', WebhookTestData>;

/** A verified webhook event. Narrow on `type`. */
export type WebhookEvent =
  | StatusChangedEvent
  | QuotaWarningEvent
  | SpendLimitReachedEvent
  | BalanceLowEvent
  | WebhookTestEvent;
