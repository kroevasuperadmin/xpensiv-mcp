import {
  McpProtocolError,
  NO_CREDITS_PREFIX,
  InsufficientCreditsError,
  RateLimitError,
  ToolError,
  XpensivError,
} from './errors.js';
import { errorFromReply, resolveOptions, send, type Resolved } from './http.js';
import type { Check, CheckStarted, CheckSummary, ClientOptions, McpTool } from './types.js';

const PROTOCOL_VERSION = '2025-03-26';

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

interface ToolResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

export interface McpClientOptions extends ClientOptions {
  /** Name reported to the server in initialize, so it can label checks by client. */
  clientName?: string;
  clientVersion?: string;
}

/**
 * Client for the Streamable HTTP MCP endpoint at /api/mcp (JSON-RPC over POST).
 * Use it when you want the exact tool surface an agent sees: check_app,
 * get_check and list_checks.
 */
export class XpensivMcpClient {
  private readonly r: Resolved;
  private readonly clientName: string;
  private readonly clientVersion: string;
  private nextId = 1;
  private sessionId: string | undefined;
  private initialized = false;

  constructor(options: McpClientOptions = {}) {
    this.r = resolveOptions(options);
    this.clientName = options.clientName ?? 'xpensiv-mcp';
    this.clientVersion = options.clientVersion ?? '0.1.0';
  }

  /** Send initialize and the initialized notification. Called for you by the first tool call. */
  async initialize(): Promise<{ serverName: string; serverVersion: string; protocolVersion: string }> {
    const result = (await this.rpc('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: this.clientName, version: this.clientVersion },
    })) as { protocolVersion: string; serverInfo: { name: string; version: string } };
    await this.notify('notifications/initialized');
    this.initialized = true;
    return {
      serverName: result.serverInfo.name,
      serverVersion: result.serverInfo.version,
      protocolVersion: result.protocolVersion,
    };
  }

  async listTools(): Promise<McpTool[]> {
    await this.ensureSession();
    return ((await this.rpc('tools/list', {})) as { tools: McpTool[] }).tools;
  }

  /** Call a tool and return its JSON payload. Throws typed errors for tool failures. */
  async callTool<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    await this.ensureSession();
    const result = (await this.rpc('tools/call', { name, arguments: args })) as ToolResult;
    const text = result.content?.find((c) => c.type === 'text')?.text ?? '';
    let payload: unknown = text;
    try {
      payload = JSON.parse(text);
    } catch {
      /* keep the raw text */
    }
    if (result.isError) throw toolError(payload);
    return payload as T;
  }

  /** Tool check_app: start a check on a public URL. */
  checkApp(url: string): Promise<CheckStarted> {
    return this.callTool<CheckStarted>('check_app', { url });
  }

  /** Tool get_check: status, and the fix list once completed. */
  getCheck(id: string): Promise<Check> {
    return this.callTool<Check>('get_check', { id });
  }

  /** Tool list_checks: your most recent checks (up to 50). */
  async listChecks(): Promise<CheckSummary[]> {
    return (await this.callTool<{ checks: CheckSummary[] }>('list_checks')).checks;
  }

  private async ensureSession(): Promise<void> {
    if (!this.initialized) await this.initialize();
  }

  private async notify(method: string): Promise<void> {
    await send(this.r, 'POST', '/api/mcp', { json: { jsonrpc: '2.0', method }, headers: this.mcpHeaders() });
  }

  private mcpHeaders(): Record<string, string> {
    return { accept: 'application/json, text/event-stream', ...(this.sessionId ? { 'mcp-session-id': this.sessionId } : {}) };
  }

  private async rpc(method: string, params: unknown): Promise<unknown> {
    const reply = await send(this.r, 'POST', '/api/mcp', {
      json: { jsonrpc: '2.0', id: this.nextId++, method, params },
      headers: this.mcpHeaders(),
    });
    const sid = reply.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    const body = reply.body as JsonRpcResponse | undefined;
    const rpcError = body && typeof body === 'object' && typeof body.error === 'object' ? body.error : undefined;
    if (rpcError) throw new McpProtocolError(rpcError.message, { status: reply.status, body, code: rpcError.code });
    // Auth, rate-limit and body-parse failures come back as plain {error: "..."} JSON, not JSON-RPC.
    if (reply.status !== 200 || !body || typeof body !== 'object') throw errorFromReply(reply);
    return body.result;
  }
}

function toolError(payload: unknown): XpensivError {
  const rec = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  const message = typeof rec.error === 'string' ? rec.error : typeof payload === 'string' ? payload : 'Tool failed.';
  if (message.startsWith(NO_CREDITS_PREFIX)) {
    return new InsufficientCreditsError(message, {
      body: payload,
      ...(typeof rec.balance === 'number' ? { balance: rec.balance } : {}),
      ...(typeof rec.topUp === 'string' ? { topUp: rec.topUp } : {}),
    });
  }
  if (/^Rate limit/i.test(message)) return new RateLimitError(message, { body: payload });
  return new ToolError(message, { body: payload });
}
