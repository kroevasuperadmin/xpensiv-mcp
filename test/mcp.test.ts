import { test } from 'node:test';
import assert from 'node:assert/strict';
import { XpensivMcpClient } from '../src/mcp.js';
import {
  AuthError, InsufficientCreditsError, McpProtocolError, RateLimitError, ToolError,
} from '../src/errors.js';
import type { FetchLike } from '../src/types.js';

interface Rpc { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } }
type Handler = (rpc: Rpc) => Response | { result?: unknown; error?: { code: number; message: string } };

const NO_CREDITS = 'Not enough Xpensiv credits for this check. Top up at https://xpensiv.si/pricing';
const tool = (payload: unknown, isError = false) => ({ result: { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], ...(isError ? { isError: true } : {}) } });

function server(handler: Handler) {
  const seen: Array<{ rpc: Rpc; headers: Record<string, string> }> = [];
  const fetch: FetchLike = async (url, init) => {
    assert.equal(url, 'https://api.test/api/mcp');
    const rpc = JSON.parse(String(init!.body)) as Rpc;
    seen.push({ rpc, headers: init!.headers as Record<string, string> });
    if (rpc.method === 'initialize') {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'xpensiv', version: '1.1.0' } } }), { status: 200, headers: { 'mcp-session-id': 'c.eHBlbnNpdg' } });
    }
    if (rpc.method.startsWith('notifications/')) return new Response(null, { status: 202 });
    const out = handler(rpc);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, ...out }), { status: 200 });
  };
  return { mcp: new XpensivMcpClient({ apiKey: 'xpk_test', baseUrl: 'https://api.test', fetch, clientName: 'unit' }), seen };
}

test('first tool call initializes, then reuses the session id', async () => {
  const { mcp, seen } = server(() => ({ result: { tools: [{ name: 'check_app' }] } }));
  assert.deepEqual(await mcp.listTools(), [{ name: 'check_app' }]);
  await mcp.listTools();
  assert.deepEqual(seen.map((s) => s.rpc.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/list']);
  assert.equal(seen[0]?.headers['mcp-session-id'], undefined);
  assert.equal(seen[2]?.headers['mcp-session-id'], 'c.eHBlbnNpdg');
  assert.equal(seen[2]?.headers.authorization, 'Bearer xpk_test');
});

test('checkApp, getCheck and listChecks call the right tools', async () => {
  const { mcp, seen } = server((rpc) => {
    switch (rpc.params?.name) {
      case 'check_app': return tool({ id: 'c1', status: 'queued', next: 'Call get_check with this id in about 60 seconds.' });
      case 'get_check': return tool({ id: 'c1', url: 'https://example.com', status: 'running', next: 'Still working.' });
      default: return tool({ checks: [{ id: 'c1', url: 'https://example.com', status: 'running', createdAt: 'x' }] });
    }
  });
  assert.equal((await mcp.checkApp('https://example.com')).id, 'c1');
  assert.equal((await mcp.getCheck('c1')).status, 'running');
  assert.equal((await mcp.listChecks()).length, 1);
  const calls = seen.filter((s) => s.rpc.method === 'tools/call').map((s) => s.rpc.params);
  assert.deepEqual(calls, [
    { name: 'check_app', arguments: { url: 'https://example.com' } },
    { name: 'get_check', arguments: { id: 'c1' } },
    { name: 'list_checks', arguments: {} },
  ]);
});

test('"Not enough Xpensiv credits" becomes InsufficientCreditsError', async () => {
  const { mcp } = server(() => tool({ error: NO_CREDITS, balance: 0, topUp: 'https://xpensiv.si/pricing' }, true));
  await assert.rejects(mcp.checkApp('https://example.com'), (e: unknown) => {
    assert.ok(e instanceof InsufficientCreditsError);
    assert.equal(e.message, NO_CREDITS);
    assert.equal(e.balance, 0);
    assert.equal(e.topUp, 'https://xpensiv.si/pricing');
    return true;
  });
});

test('other tool errors: rate limit and generic', async () => {
  await assert.rejects(server(() => tool({ error: 'Rate limit reached. Wait a minute and try again.' }, true)).mcp.checkApp('https://example.com'), RateLimitError);
  await assert.rejects(server(() => tool({ error: 'Check not found for this account.' }, true)).mcp.getCheck('x'), ToolError);
});

test('JSON-RPC errors become McpProtocolError', async () => {
  const { mcp } = server(() => ({ error: { code: -32601, message: 'Method not found' } }));
  await assert.rejects(mcp.listTools(), (e: unknown) => e instanceof McpProtocolError && e.code === -32601);
});

test('HTTP 401 on the endpoint becomes AuthError', async () => {
  const mcp = new XpensivMcpClient({
    apiKey: 'xpk_bad', baseUrl: 'https://api.test',
    fetch: async () => new Response(JSON.stringify({ error: 'Bearer API key required.' }), { status: 401 }),
  });
  await assert.rejects(mcp.listTools(), AuthError);
});

test('initialize reports server info', async () => {
  const { mcp } = server(() => ({ result: {} }));
  assert.deepEqual(await mcp.initialize(), { serverName: 'xpensiv', serverVersion: '1.1.0', protocolVersion: '2025-03-26' });
});
