import { parseArgs } from 'node:util';
import { CheckFailedError, InsufficientCreditsError, RateLimitError, TimeoutError } from './errors.js';
import { XpensivMcpClient } from './mcp.js';
import { XpensivClient } from './rest.js';
import type { Check, CheckResult, CheckStarted, CheckSummary, ClientOptions, McpTool } from './types.js';

const HELP = `xpensiv-mcp: run Xpensiv design checks from the terminal

Usage:
  xpensiv-mcp check <url> [--wait]     start a check (add --wait to poll until it finishes)
  xpensiv-mcp status <id>              status of a check, with findings once completed
  xpensiv-mcp result <id>              findings only (exit 1 while the check is still running)
  xpensiv-mcp list                     your recent checks
  xpensiv-mcp tools                    list the MCP tools the server exposes

Options:
  --mcp                 use the MCP endpoint (/api/mcp) instead of the REST API
  --wait                with check: poll until completed or failed
  --interval <sec>      poll interval for --wait (default 10)
  --timeout <sec>       give up waiting after this long (default 300)
  --base-url <url>      default https://xpensiv.si, or XPENSIV_BASE_URL
  --json                print raw JSON
  -h, --help

The API key is read from XPENSIV_API_KEY (create one at https://xpensiv.si/console/keys).
There is deliberately no --api-key flag: it would end up in shell history and process lists.

Exit codes: 0 ok, 1 error, 2 usage, 3 out of credits, 4 check failed, 5 timed out, 6 rate limited.`;

export interface Clients {
  rest: (o: ClientOptions) => Pick<XpensivClient, 'createCheck' | 'getCheck' | 'getResult' | 'listChecks' | 'waitForCheck'>;
  mcp: (o: ClientOptions) => Pick<XpensivMcpClient, 'checkApp' | 'getCheck' | 'listChecks' | 'listTools'>;
}

export interface CliIo {
  stdout?: { write(s: string): unknown };
  stderr?: { write(s: string): unknown };
  env?: Record<string, string | undefined>;
  clients?: Clients;
  sleep?: (ms: number) => Promise<void>;
}

const defaultClients: Clients = { rest: (o) => new XpensivClient(o), mcp: (o) => new XpensivMcpClient(o) };

function formatResult(result: CheckResult): string {
  const lines = [`Verdict: ${result.verdict}`];
  if (result.findings.length === 0) lines.push('No findings.');
  for (const f of result.findings) {
    lines.push('', `[${f.severity}] ${f.title ?? f.region}${f.skill ? ` (${f.skill})` : ''}`);
    lines.push(`  where: ${f.region}`);
    for (const e of f.evidence) lines.push(`  evidence: ${e}`);
    lines.push(`  fix: ${f.fix}`);
  }
  if (result.screenshots.length) lines.push('', ...result.screenshots.map((s) => `screenshot ${s.region}: ${s.url}`));
  return lines.join('\n');
}

function formatCheck(check: Check): string {
  const head = `${check.id}  ${check.status}  ${check.url}`;
  if (check.result) return `${head}\n\n${formatResult(check.result)}`;
  if (check.error) return `${head}\nerror: ${check.error}`;
  return check.next ? `${head}\n${check.next}` : head;
}

/** @returns the process exit code */
export async function run(argv: string[], io: CliIo = {}): Promise<number> {
  const { stdout = process.stdout, stderr = process.stderr, env = process.env, clients = defaultClients } = io;
  const out = (s: string) => stdout.write(`${s}\n`);
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        mcp: { type: 'boolean', default: false },
        wait: { type: 'boolean', default: false },
        interval: { type: 'string', default: '10' },
        timeout: { type: 'string', default: '300' },
        'base-url': { type: 'string' },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (error) {
    stderr.write(`xpensiv-mcp: ${(error as Error).message}\n`);
    return 2;
  }
  const { values, positionals } = parsed;
  const [command, arg] = positionals;
  if (values.help || !command) {
    out(HELP);
    return values.help ? 0 : 2;
  }
  const interval = Number(values.interval);
  const timeout = Number(values.timeout);
  if (!(interval > 0) || !(timeout > 0)) {
    stderr.write('xpensiv-mcp: --interval and --timeout must be positive numbers of seconds\n');
    return 2;
  }
  if (['check', 'status', 'result'].includes(command) && !arg) {
    stderr.write(`xpensiv-mcp: ${command} needs ${command === 'check' ? 'a URL' : 'a check id'}\n`);
    return 2;
  }
  if (!['check', 'status', 'result', 'list', 'tools'].includes(command)) {
    stderr.write(`xpensiv-mcp: unknown command "${command}"\n`);
    return 2;
  }
  if (values.mcp && command === 'result') {
    stderr.write('xpensiv-mcp: "result" is REST only; use "status" with --mcp\n');
    return 2;
  }
  if (command === 'check' && values.mcp && values.wait) {
    stderr.write('xpensiv-mcp: --wait is REST only; poll with "status --mcp" instead\n');
    return 2;
  }
  if (command === 'tools' && !values.mcp) {
    stderr.write('xpensiv-mcp: "tools" needs --mcp\n');
    return 2;
  }

  const options: ClientOptions = {
    ...(env.XPENSIV_API_KEY ? { apiKey: env.XPENSIV_API_KEY } : {}),
    ...(values['base-url'] ? { baseUrl: values['base-url'] } : {}),
  };
  const print = (data: unknown, text: string) => out(values.json ? JSON.stringify(data, null, 2) : text);
  const wait = {
    intervalMs: interval * 1000,
    timeoutMs: timeout * 1000,
    ...(io.sleep ? { sleep: io.sleep } : {}),
    onPoll: (c: Check) => { if (!values.json) stderr.write(`status: ${c.status}\n`); },
  };

  try {
    const rest = values.mcp ? undefined : clients.rest(options);
    const mcp = values.mcp ? clients.mcp(options) : undefined;

    if (command === 'check') {
      const started: CheckStarted = rest ? await rest.createCheck(arg!) : await mcp!.checkApp(arg!);
      if (!values.wait) {
        print(started, `${started.id}  ${started.status}${started.next ? `\n${started.next}` : ''}`);
        return 0;
      }
      const done = await rest!.waitForCheck(started.id, wait);
      print(done, formatCheck(done));
      return done.status === 'failed' ? 4 : 0;
    }
    if (command === 'status') {
      const check = rest ? await rest.getCheck(arg!) : await mcp!.getCheck(arg!);
      print(check, formatCheck(check));
      return check.status === 'failed' ? 4 : 0;
    }
    if (command === 'result') {
      const result = await rest!.getResult(arg!);
      if (!result) {
        print({ id: arg, status: 'pending' }, 'Not finished yet. Try again in a few seconds.');
        return 1;
      }
      print(result, formatResult(result));
      return 0;
    }
    if (command === 'list') {
      const checks: CheckSummary[] = rest ? await rest.listChecks() : await mcp!.listChecks();
      print(checks, checks.map((c) => `${c.id}  ${c.status}  ${c.createdAt}  ${c.url}`).join('\n') || 'No checks yet.');
      return 0;
    }
    const tools: McpTool[] = await mcp!.listTools();
    print(tools, tools.map((t) => `${t.name}${t.description ? `: ${t.description}` : ''}`).join('\n'));
    return 0;
  } catch (error) {
    return report(error, stderr);
  }
}

function report(error: unknown, stderr: { write(s: string): unknown }): number {
  const message = error instanceof Error ? error.message : String(error);
  stderr.write(`xpensiv-mcp: ${message}\n`);
  if (error instanceof InsufficientCreditsError) {
    stderr.write(`Top up: ${error.topUp ?? 'https://xpensiv.si/pricing'}\n`);
    return 3;
  }
  if (error instanceof CheckFailedError) return 4;
  if (error instanceof TimeoutError) return 5;
  if (error instanceof RateLimitError) {
    if (error.retryAfterSeconds) stderr.write(`Retry in ${error.retryAfterSeconds}s\n`);
    return 6;
  }
  return 1;
}
