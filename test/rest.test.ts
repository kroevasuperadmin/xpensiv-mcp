import { test } from 'node:test';
import assert from 'node:assert/strict';
import { XpensivClient } from '../src/rest.js';
import {
  AuthError, CheckFailedError, InsufficientCreditsError, NotFoundError, TimeoutError, ValidationError,
} from '../src/errors.js';
import type { FetchLike } from '../src/types.js';

type Route = (url: string, init: RequestInit) => Response | Promise<Response>;
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function client(route: Route) {
  const calls: Array<{ method: string; path: string; body?: string }> = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ method: init!.method!, path: url.replace('https://api.test', ''), ...(init!.body ? { body: String(init!.body) } : {}) });
    return route(url, init!);
  };
  return { api: new XpensivClient({ apiKey: 'xpk_test', baseUrl: 'https://api.test', fetch }), calls };
}

const RESULT = {
  verdict: 'Review recommended',
  findings: [{ title: 'Low contrast', skill: 'color', region: '#hero', severity: 'medium', evidence: ['#hero: 2.1:1'], fix: 'Darken text', prompt: 'Fix contrast' }],
  screenshots: [{ region: 'mobile', url: '/api/audits/c1/shot/mobile.png' }],
  lighthouse: null,
};

test('createCheck posts the URL and returns the id (202)', async () => {
  const { api, calls } = client(() => json({ id: 'c1', status: 'queued', statusUrl: 'https://api.test/api/v1/checks/c1', resultUrl: 'https://api.test/api/v1/checks/c1/result' }, 202));
  const started = await api.createCheck('https://example.com');
  assert.equal(started.id, 'c1');
  assert.deepEqual(calls, [{ method: 'POST', path: '/api/v1/checks', body: '{"url":"https://example.com"}' }]);
});

test('createCheck surfaces 402 as InsufficientCreditsError with the top-up link', async () => {
  const { api } = client(() => json({ error: 'Out of prepaid credits. Buy a credit pack to keep running checks.', balance: 0, upgrade: '/console/billing', topUp: 'https://xpensiv.si/console/billing' }, 402));
  await assert.rejects(api.createCheck('https://example.com'), (e: unknown) => {
    assert.ok(e instanceof InsufficientCreditsError);
    assert.equal(e.topUp, 'https://xpensiv.si/console/billing');
    assert.equal(e.balance, 0);
    return true;
  });
});

test('createCheck maps 400 and 401', async () => {
  await assert.rejects(client(() => json({ error: 'Send a public http:// or https:// URL' }, 400)).api.createCheck('http://10.0.0.1'), ValidationError);
  await assert.rejects(client(() => json({ error: 'Valid API key required.' }, 401)).api.createCheck('https://example.com'), AuthError);
});

test('createCheck treats a 503 dispatch failure as an error', async () => {
  const { api } = client(() => json({ id: 'c9', status: 'failed' }, 503));
  await assert.rejects(api.createCheck('https://example.com'), (e: unknown) => (e as { status: number }).status === 503);
});

test('getCheck returns the result once completed and encodes the id', async () => {
  const { api, calls } = client(() => json({ id: 'a/b', url: 'https://example.com', status: 'completed', result: RESULT }));
  const check = await api.getCheck('a/b');
  assert.equal(check.result?.findings[0]?.skill, 'color');
  assert.equal(calls[0]?.path, '/api/v1/checks/a%2Fb');
});

test('getCheck maps 404', async () => {
  await assert.rejects(client(() => json({ error: 'Check not found for this key\'s account.' }, 404)).api.getCheck('nope'), NotFoundError);
});

test('getResult is null while running (202) and the result when done', async () => {
  assert.equal(await client(() => json({ id: 'c1', status: 'running' }, 202)).api.getResult('c1'), null);
  assert.deepEqual(await client(() => json(RESULT)).api.getResult('c1'), RESULT);
});

test('listChecks unwraps the checks array', async () => {
  const { api } = client(() => json({ checks: [{ id: 'c1', url: 'https://example.com', status: 'queued', createdAt: '2026-11-12T00:00:00Z' }] }));
  assert.equal((await api.listChecks())[0]?.id, 'c1');
});

test('waitForCheck polls until completed', async () => {
  const states = ['queued', 'running', 'completed'];
  const { api, calls } = client(() => json({ id: 'c1', url: 'https://example.com', status: states.shift(), ...(states.length === 0 ? { result: RESULT } : {}) }));
  const sleeps: number[] = [];
  const seen: string[] = [];
  const check = await api.waitForCheck('c1', { intervalMs: 5000, sleep: async (ms) => { sleeps.push(ms); }, onPoll: (c) => seen.push(c.status) });
  assert.equal(check.status, 'completed');
  assert.deepEqual(sleeps, [5000, 5000]);
  assert.deepEqual(seen, ['queued', 'running', 'completed']);
  assert.equal(calls.length, 3);
});

test('waitForCheck times out', async () => {
  const { api } = client(() => json({ id: 'c1', url: 'https://example.com', status: 'running' }));
  await assert.rejects(api.waitForCheck('c1', { intervalMs: 1000, timeoutMs: 3000, sleep: async () => {} }), TimeoutError);
});

test('runCheck creates, waits and returns the completed check', async () => {
  const route: Route = (url, init) =>
    init.method === 'POST' ? json({ id: 'c1', status: 'queued' }, 202) : json({ id: 'c1', url: 'https://example.com', status: 'completed', result: RESULT });
  const check = await client(route).api.runCheck('https://example.com', { sleep: async () => {} });
  assert.equal(check.result?.verdict, 'Review recommended');
});

test('runCheck throws CheckFailedError with the server reason', async () => {
  const route: Route = (url, init) =>
    init.method === 'POST' ? json({ id: 'c1', status: 'queued' }, 202) : json({ id: 'c1', url: 'https://example.com', status: 'failed', error: 'dispatch_failed' });
  await assert.rejects(client(route).api.runCheck('https://example.com', { sleep: async () => {} }), (e: unknown) => e instanceof CheckFailedError && /dispatch_failed/.test(e.message));
});
