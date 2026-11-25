# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-11-25

### Added

- `CurlSMS` client with `send`, `estimate`, `get`, `cancel`, `list`, `account` and `health`.
- `send` to one receiver (returns a `Message`) or up to 100 receivers (returns `SendManyResponse`), with optional scheduling via `sendAt`.
- Automatic `Idempotency-Key` on every send, so retries never send twice.
- Retries with exponential backoff on network errors, timeouts, `429` (respecting `Retry-After`) and `5xx`.
- `CurlSMSError` with HTTP status, API error code, receiver index, error ID and `retryAfter`.
- `verifyWebhook` and `parseWebhook` for signed webhooks (`X-CurlSMS-Signature`).
- TypeScript types for all API objects and webhook events.
- ESM and CommonJS builds with type declarations. Zero runtime dependencies, Node.js 20 or later.

[Unreleased]: https://github.com/curl-sms/curl-sms-node/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/curl-sms/curl-sms-node/releases/tag/v1.0.0
