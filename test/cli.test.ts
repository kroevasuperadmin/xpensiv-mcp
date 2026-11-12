import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, type Clients } from '../src/cli.js';
import { InsufficientCreditsError, RateLimitError, TimeoutError } from '../src/errors.js';
import type { Check, CheckResult } from '../src/types.js';

const RESULT: CheckResult = {
  verdict: 'Needs attention',
  findings: [{ title: 'Tap targets too small', skill: 'mobile', region: '#nav', severity: 'high', evidence: ['#nav a: 24x24px'], fix: 'Make targets 44px', prompt: 'p' }],
  screenshots: [{ region: 'mobile', url: '/api/audits/c1/shot/m.png' }],
  lighthouse: null,
};
const DONE: Check = { id: 'c1', url: 'https://example.com', status: 'completed', result: RESULT };

function harness(overrides: Partial<ReturnType<Clients['rest']>> & Partial<ReturnType<Clients['mcp']>> = {}, env: Record<string, string> = { XPENSIV_API_KEY: 'xpk_test' }) {
  let out = '', err = '';
  const seen: Array<{ kind: string; opts: unknown }> = [];
  const api = {
    createCheck: async () => ({ id: 'c1', status: 'queued' as const }),
    getCheck: async () => DONE,
    getResult: async () => RESULT as CheckResult | null,
    listChecks: async () => [{ id: 'c1', url: 'https://example.com', status: 'completed' as const, createdAt: '2026-11-12T00:00:00Z' }],
    waitForCheck: async () => DONE,
    checkApp: async () => ({ id: 'm1', status: 'queued' as const, next: 'Call get_check with this id in about 60 seconds.' }),
    listTools: async () => [{ name: 'check_app', description: 'Start a check' }],
    ...overrides,
  };
  const clients: Clients = {
    rest: (o) => { seen.push({ kind: 'rest', opts: o }); return api; },
    mcp: (o) => { seen.push({ kind: 'mcp', opts: o }); return api; },
  };
  const go = async (...argv: string[]) => {
    out = ''; err = '';
    const code = await run(argv, { stdout: { write: (s) => (out += s) }, stderr: { write: (s) => (err += s) }, env, clients, sleep: async () => {} });
    return { code, out, err };
  };
  return { go, seen };
}

test('check without --wait prints the id and exits 0', async () => {
  const { go } = harness();
  const r = await go('check', 'https://example.com');
  assert.deepEqual([r.code, r.out.trim()], [0, 'c1  queued']);
});

test('check --wait prints the findings', async () => {
  const r = await harness().go('check', 'https://example.com', '--wait');
  assert.equal(r.code, 0);
  assert.match(r.out, /Verdict: Needs attention/);
  assert.match(r.out, /\[high\] Tap targets too small \(mobile\)/);
  assert.match(r.out, /fix: Make targets 44px/);
});

test('check --mcp uses the MCP client and shows the server hint', async () => {
  const { go, seen } = harness();
  const r = await go('check', 'https://example.com', '--mcp');
  assert.equal(seen[0]?.kind, 'mcp');
  assert.match(r.out, /m1  queued\nCall get_check/);
});

test('--json prints raw JSON', async () => {
  const r = await harness().go('status', 'c1', '--json');
  assert.equal(JSON.parse(r.out).result.verdict, 'Needs attention');
});

test('out of credits exits 3 and prints the top-up link', async () => {
  const { go } = harness({ createCheck: async () => { throw new InsufficientCreditsError('Out of prepaid credits.', { topUp: 'https://xpensiv.si/console/billing' }); } });
  const r = await go('check', 'https://example.com');
  assert.equal(r.code, 3);
  assert.match(r.err, /Out of prepaid credits\./);
  assert.match(r.err, /Top up: https:\/\/xpensiv\.si\/console\/billing/);
});

test('MCP out-of-credits message passes through', async () => {
  const msg = 'Not enough Xpensiv credits for this check. Top up at https://xpensiv.si/pricing';
  const { go } = harness({ checkApp: async () => { throw new InsufficientCreditsError(msg); } });
  const r = await go('check', 'https://example.com', '--mcp');
  assert.equal(r.code, 3);
  assert.ok(r.err.includes(msg));
});

test('failed check exits 4, timeout 5, rate limit 6', async () => {
  const failed: Check = { id: 'c1', url: 'https://example.com', status: 'failed', error: 'dispatch_failed' };
  assert.equal((await harness({ waitForCheck: async () => failed }).go('check', 'https://example.com', '--wait')).code, 4);
  assert.equal((await harness({ waitForCheck: async () => { throw new TimeoutError('slow'); } }).go('check', 'https://example.com', '--wait')).code, 5);
  const limited = await harness({ listChecks: async () => { throw new RateLimitError('Too many requests.', { retryAfterSeconds: 30 }); } }).go('list');
  assert.deepEqual([limited.code, /Retry in 30s/.test(limited.err)], [6, true]);
});

test('result is 1 while pending, tools needs --mcp', async () => {
  assert.equal((await harness({ getResult: async () => null }).go('result', 'c1')).code, 1);
  assert.equal((await harness().go('tools')).code, 2);
  assert.match((await harness().go('tools', '--mcp')).out, /check_app: Start a check/);
});

test('usage errors exit 2', async () => {
  const created: string[] = [];
  const { go } = harness({ checkApp: async () => { created.push('x'); return { id: 'm', status: 'queued' as const }; } });
  for (const argv of [[], ['check'], ['status'], ['bogus'], ['list', '--interval', '0'], ['result', 'c1', '--mcp'], ['check', 'https://x.co', '--mcp', '--wait'], ['--nope']]) {
    assert.equal((await go(...argv)).code, 2, argv.join(' '));
  }
  assert.deepEqual(created, [], 'a usage error must not start a billable check');
  assert.equal((await go('--help')).code, 0);
});

test('the API key comes from the environment only and never reaches output', async () => {
  const { go, seen } = harness({}, { XPENSIV_API_KEY: 'xpk_zzz' });
  const r = await go('list');
  assert.deepEqual(seen[0]?.opts, { apiKey: 'xpk_zzz' });
  assert.ok(!r.out.includes('xpk_zzz') && !r.err.includes('xpk_zzz'));
  assert.equal((await go('--api-key', 'x', 'list')).code, 2);
});
