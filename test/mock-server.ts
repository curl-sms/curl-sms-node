import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  body: string;
  json: unknown;
}

export interface MockResponse {
  status: number;
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
  /** Delay before answering, in milliseconds. */
  delay?: number;
  /** Destroy the socket without answering. */
  drop?: boolean;
}

type Responder = MockResponse | ((req: RecordedRequest) => MockResponse);

/** A local HTTP server that answers with queued responses and records every request. */
export class MockServer {
  readonly requests: RecordedRequest[] = [];
  #queue: Responder[] = [];
  #server: Server;
  url = '';

  constructor() {
    this.#server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const url = new URL(req.url ?? '/', 'http://localhost');
        let json: unknown;
        try {
          json = body ? JSON.parse(body) : undefined;
        } catch {
          json = undefined;
        }
        const recorded: RecordedRequest = {
          method: req.method ?? '',
          path: url.pathname,
          query: url.searchParams,
          headers: req.headers,
          body,
          json,
        };
        this.requests.push(recorded);

        const next = this.#queue.shift();
        const response: MockResponse =
          next === undefined
            ? { status: 500, body: { error: { code: 'internal', message: 'No mock response queued.' } } }
            : typeof next === 'function'
              ? next(recorded)
              : next;

        const answer = () => {
          if (response.drop) {
            req.socket.destroy();
            return;
          }
          const payload = response.rawBody ?? (response.body === undefined ? '' : JSON.stringify(response.body));
          res.writeHead(response.status, { 'Content-Type': 'application/json', ...response.headers });
          res.end(payload);
        };
        if (response.delay) setTimeout(answer, response.delay);
        else answer();
      });
    });
  }

  /** Queue responses, answered in order. */
  enqueue(...responses: Responder[]): this {
    this.#queue.push(...responses);
    return this;
  }

  reset(): void {
    this.requests.length = 0;
    this.#queue = [];
  }

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.#server.listen(0, '127.0.0.1', resolve));
    const { port } = this.#server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    this.#server.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => this.#server.close((err) => (err ? reject(err) : resolve())));
  }
}

export function message(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '01JDQ8M3V6R1T5ZK2X9N4C7B0A',
    mode: 'test',
    receiver: '+4915123456789',
    status: 'queued',
    segments: 1,
    encoding: 'gsm7',
    price: '0.00',
    error_code: null,
    created_at: '2026-11-23T10:15:00.000Z',
    send_at: null,
    sent_at: null,
    delivered_at: null,
    refunded: false,
    ...overrides,
  };
}

export function apiError(code: string, text: string, extra: Record<string, unknown> = {}): { error: Record<string, unknown> } {
  return { error: { code, message: text, ...extra } };
}
