import {
  AuthError,
  InsufficientCreditsError,
  NotFoundError,
  RateLimitError,
  ValidationError,
  XpensivError,
} from './errors.js';
import type { ClientOptions, FetchLike } from './types.js';

export const DEFAULT_BASE_URL = 'https://xpensiv.si';
const DEFAULT_UA = 'xpensiv-mcp/0.1';

export interface Resolved {
  baseUrl: string;
  apiKey: string;
  fetch: FetchLike;
  timeoutMs: number;
  userAgent: string;
  maxRetries: number;
  sleep: (ms: number) => Promise<void>;
}

export function resolveOptions(options: ClientOptions = {}): Resolved {
  const apiKey = options.apiKey ?? process.env.XPENSIV_API_KEY;
  if (!apiKey) {
    throw new AuthError('No API key. Pass apiKey or set XPENSIV_API_KEY (create one in the Xpensiv console).');
  }
  const baseUrl = (options.baseUrl ?? process.env.XPENSIV_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const parsed = new URL(baseUrl);
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !local) {
    throw new XpensivError('baseUrl must use https, so the API key is not sent in clear text.');
  }
  return {
    baseUrl,
    apiKey,
    fetch: options.fetch ?? ((input, init) => fetch(input, init)),
    timeoutMs: options.timeoutMs ?? 30_000,
    userAgent: options.userAgent ?? DEFAULT_UA,
    maxRetries: options.maxRetries ?? 2,
    sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  };
}

export interface Reply {
  status: number;
  headers: Headers;
  body: unknown;
}

export async function send(
  r: Resolved,
  method: 'GET' | 'POST',
  path: string,
  options: { json?: unknown; headers?: Record<string, string> } = {},
): Promise<Reply> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${r.apiKey}`,
    accept: 'application/json',
    'user-agent': r.userAgent,
    ...options.headers,
  };
  if (options.json !== undefined) headers['content-type'] = 'application/json';
  const payload = options.json !== undefined ? JSON.stringify(options.json) : undefined;

  for (let attempt = 0; ; attempt++) {
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(r.timeoutMs) };
    if (payload !== undefined) init.body = payload;
    const response = await r.fetch(`${r.baseUrl}${path}`, init);
    // 429 is returned before any work is queued, so repeating the request is safe even for POST.
    if (response.status === 429 && attempt < r.maxRetries) {
      const wait = Number(response.headers.get('retry-after'));
      await response.body?.cancel().catch(() => undefined);
      await r.sleep(Math.min(Number.isFinite(wait) && wait > 0 ? wait : 5, 60) * 1000);
      continue;
    }
    return readReply(response);
  }
}

async function readReply(response: Response): Promise<Reply> {
  const text = await response.text();
  let body: unknown = undefined;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: response.status, headers: response.headers, body };
}

function messageOf(body: unknown, fallback: string): string {
  if (body && typeof body === 'object' && 'error' in body && typeof (body as { error: unknown }).error === 'string') {
    return (body as { error: string }).error;
  }
  return typeof body === 'string' && body ? body.slice(0, 200) : fallback;
}

/** Map a non-2xx reply to the matching error class. */
export function errorFromReply(reply: Reply): XpensivError {
  const { status, body } = reply;
  const message = messageOf(body, `HTTP ${status}`);
  const rec = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  switch (status) {
    case 400:
      return new ValidationError(message, { status, body });
    case 401:
      return new AuthError(message, { status, body });
    case 402: {
      const details: { status: number; body: unknown; balance?: number; topUp?: string } = { status, body };
      if (typeof rec.balance === 'number') details.balance = rec.balance;
      if (typeof rec.topUp === 'string') details.topUp = rec.topUp;
      return new InsufficientCreditsError(message, details);
    }
    case 404:
      return new NotFoundError(message, { status, body });
    case 429: {
      const retry = Number(reply.headers.get('retry-after'));
      return new RateLimitError(message, {
        status,
        body,
        ...(Number.isFinite(retry) && retry > 0 ? { retryAfterSeconds: retry } : {}),
      });
    }
    default:
      return new XpensivError(message, { status, body });
  }
}
