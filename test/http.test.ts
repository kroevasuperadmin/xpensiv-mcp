import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorFromReply, resolveOptions, send } from '../src/http.js';
import {
  AuthError, InsufficientCreditsError, NotFoundError, RateLimitError, ValidationError, XpensivError,
} from '../src/errors.js';

const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
  status, body, headers: new Headers(headers),
});

test('error mapping by status', () => {
  assert.ok(errorFromReply(reply(400, { error: 'Send a public URL' })) instanceof ValidationError);
  assert.ok(errorFromReply(reply(401, { error: 'Valid API key required.' })) instanceof AuthError);
  assert.ok(errorFromReply(reply(404, { error: 'Check not found.' })) instanceof NotFoundError);
  assert.ok(errorFromReply(reply(500, 'boom')) instanceof XpensivError);
});

test('402 carries balance and top-up link', () => {
  const e = errorFromReply(reply(402, { error: 'Out of prepaid credits.', balance: 0, topUp: 'https://xpensiv.si/console/billing' }));
  assert.ok(e instanceof InsufficientCreditsError);
  assert.equal(e.balance, 0);
  assert.equal(e.topUp, 'https://xpensiv.si/console/billing');
  assert.equal(e.status, 402);
});

test('429 exposes Retry-After', () => {
  const e = errorFromReply(reply(429, { error: 'Too many requests.' }, { 'retry-after': '42' })) as RateLimitError;
  assert.ok(e instanceof RateLimitError);
  assert.equal(e.retryAfterSeconds, 42);
});

test('resolveOptions needs a key, refuses clear-text remote hosts, trims slashes', () => {
  const saved = process.env.XPENSIV_API_KEY;
  delete process.env.XPENSIV_API_KEY;
  try {
    assert.throws(() => resolveOptions({}), AuthError);
    assert.throws(() => resolveOptions({ apiKey: 'k', baseUrl: 'http://xpensiv.example' }), /https/);
    assert.equal(resolveOptions({ apiKey: 'k', baseUrl: 'http://localhost:3000/' }).baseUrl, 'http://localhost:3000');
    process.env.XPENSIV_API_KEY = 'from-env';
    assert.equal(resolveOptions({}).apiKey, 'from-env');
    assert.equal(resolveOptions({ apiKey: 'k' }).baseUrl, 'https://xpensiv.si');
  } finally {
    if (saved === undefined) delete process.env.XPENSIV_API_KEY; else process.env.XPENSIV_API_KEY = saved;
  }
});

test('send adds bearer auth and JSON headers and parses the body', async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const r = resolveOptions({
    apiKey: 'xpk_test', baseUrl: 'https://api.test',
    fetch: async (url, init) => { seen = { url, init: init! }; return new Response('{"ok":true}', { status: 202 }); },
  });
  const out = await send(r, 'POST', '/api/v1/checks', { json: { url: 'https://example.com' } });
  assert.equal(seen!.url, 'https://api.test/api/v1/checks');
  const h = seen!.init.headers as Record<string, string>;
  assert.equal(h.authorization, 'Bearer xpk_test');
  assert.equal(h['content-type'], 'application/json');
  assert.equal(seen!.init.body, '{"url":"https://example.com"}');
  assert.deepEqual([out.status, out.body], [202, { ok: true }]);
});

test('429 is retried after Retry-After and then succeeds', async () => {
  const sleeps: number[] = [];
  let calls = 0;
  const r = resolveOptions({
    apiKey: 'k', baseUrl: 'https://api.test', sleep: async (ms) => { sleeps.push(ms); },
    fetch: async () => (++calls < 3 ? new Response('{"error":"Too many requests."}', { status: 429, headers: { 'retry-after': '7' } }) : new Response('{"ok":1}', { status: 200 })),
  });
  const out = await send(r, 'POST', '/api/v1/checks', { json: { url: 'https://example.com' } });
  assert.deepEqual([out.status, calls, sleeps], [200, 3, [7000, 7000]]);
});

test('after maxRetries the 429 is returned for the caller to map', async () => {
  let calls = 0;
  const r = resolveOptions({
    apiKey: 'k', baseUrl: 'https://api.test', maxRetries: 1, sleep: async () => {},
    fetch: async () => { calls++; return new Response('{"error":"Too many requests."}', { status: 429, headers: { 'retry-after': '1' } }); },
  });
  const out = await send(r, 'GET', '/api/v1/checks');
  assert.deepEqual([out.status, calls], [429, 2]);
  assert.ok(errorFromReply(out) instanceof RateLimitError);
});

test('maxRetries 0 disables retrying, and Retry-After is capped at 60 s', async () => {
  let calls = 0;
  const off = resolveOptions({ apiKey: 'k', baseUrl: 'https://api.test', maxRetries: 0, fetch: async () => { calls++; return new Response('{}', { status: 429 }); } });
  assert.equal((await send(off, 'GET', '/x')).status, 429);
  assert.equal(calls, 1);

  const sleeps: number[] = [];
  let n = 0;
  const capped = resolveOptions({
    apiKey: 'k', baseUrl: 'https://api.test', maxRetries: 1, sleep: async (ms) => { sleeps.push(ms); },
    fetch: async () => (n++ ? new Response('{}', { status: 200 }) : new Response('{}', { status: 429, headers: { 'retry-after': '3600' } })),
  });
  await send(capped, 'GET', '/x');
  assert.deepEqual(sleeps, [60000]);
});
