# xpensiv-mcp

A TypeScript client and CLI for the [Xpensiv](https://xpensiv.si) REST API under `/api/v1` and the MCP endpoint at `https://xpensiv.si/api/mcp`.

## Why

Use this package to call the API from CI, a script or an agent. It handles bearer authentication, polls until a check completes, and maps HTTP errors to error classes. The CLI returns exit codes for usage errors, failed checks, credit errors, timeouts and rate limits.

It has no runtime dependencies and needs Node 20 or later. The test suite runs against mocked responses and never calls the live API.

## Install

```sh
npm install github:kroevasuperadmin/xpensiv-mcp
```

Create an API key in the Xpensiv console (`xpk_...`) and export it:

```sh
export XPENSIV_API_KEY=xpk_...
```

## CLI

```sh
npx xpensiv-mcp check https://example.com --wait   # start a check and wait for the findings
npx xpensiv-mcp check https://example.com          # start only, print the id
npx xpensiv-mcp status <id>                        # status, plus findings once completed
npx xpensiv-mcp result <id>                        # findings only (REST)
npx xpensiv-mcp list                               # recent checks
npx xpensiv-mcp tools --mcp                        # tools the MCP server exposes
```

Add `--mcp` to use the MCP endpoint instead of REST, `--json` for raw JSON, and `--interval` / `--timeout` (seconds) to tune `--wait`. The key is read from the environment only. There is no `--api-key` flag, because it would land in shell history.

| exit code | meaning |
|---|---|
| 0 | ok |
| 1 | other error, or `result` while the check is still running |
| 2 | usage error |
| 3 | out of credits |
| 4 | the check failed |
| 5 | timed out waiting |
| 6 | rate limited |

## SDK

```ts
import { XpensivClient, InsufficientCreditsError } from 'xpensiv-mcp';

const xpensiv = new XpensivClient({ apiKey: process.env.XPENSIV_API_KEY });

try {
  const check = await xpensiv.runCheck('https://example.com', {
    onPoll: (c) => console.error(c.status),
  });
  for (const f of check.result!.findings) {
    console.log(`[${f.severity}] ${f.region}: ${f.fix}`);
  }
} catch (e) {
  if (e instanceof InsufficientCreditsError) console.error('Top up at', e.topUp);
  else throw e;
}
```

The MCP client exposes the same three tools an agent sees:

```ts
import { XpensivMcpClient } from 'xpensiv-mcp';

const mcp = new XpensivMcpClient({ apiKey: process.env.XPENSIV_API_KEY });
const { id } = await mcp.checkApp('https://example.com'); // tool: check_app
const check = await mcp.getCheck(id);                      // tool: get_check
const recent = await mcp.listChecks();                     // tool: list_checks
```

`XpensivClient` has `createCheck`, `getCheck`, `getResult` (null while running), `listChecks`, `waitForCheck` and `runCheck`. Both clients take `baseUrl`, `fetch` (to inject your own), `timeoutMs` and `maxRetries`. On HTTP 429 the client waits for `Retry-After` (capped at 60 s) and tries again up to `maxRetries` times (default 2, `0` turns it off). The MCP tool's own "Rate limit reached" answer is not retried. `baseUrl` must be `https` unless it points at localhost.

## Errors

| situation | REST | MCP tool | class |
|---|---|---|---|
| bad or missing key | 401 | HTTP 401 | `AuthError` |
| invalid or non-public URL | 400 | tool error | `ValidationError` / `ToolError` |
| no credits | 402, `Out of prepaid credits...` | tool error, `Not enough Xpensiv credits for this check. Top up at https://xpensiv.si/pricing` | `InsufficientCreditsError` (`balance`, `topUp`) |
| rate limit | 429 with `Retry-After` | tool error, `Rate limit reached...` | `RateLimitError` (`retryAfterSeconds`) |
| unknown check id | 404 | tool error | `NotFoundError` / `ToolError` |
| check ended `failed` | status `failed` | status `failed` | `CheckFailedError` (from `runCheck`) |

All of them extend `XpensivError`, which carries `status` and the parsed `body`.

## Example

Sample output, shortened. The ids and findings are illustrative.

```console
$ xpensiv-mcp check https://example.com --wait
status: queued
status: running
status: completed
c1f0…  completed  https://example.com/

Verdict: Review recommended

[medium] Low contrast on hero text (color)
  where: #hero
  evidence: #hero: contrast 2.1:1
  fix: Darken the text to reach 4.5:1
screenshot mobile: /api/audits/c1f0…/shot/mobile.png
```

When the balance is empty:

```console
$ xpensiv-mcp check https://example.com --mcp
xpensiv-mcp: Not enough Xpensiv credits for this check. Top up at https://xpensiv.si/pricing
Top up: https://xpensiv.si/pricing
$ echo $?
3
```

## CI gate

`examples/ci-gate.mjs` runs a check against a preview URL and exits 1 when it finds anything rated `high`:

```sh
XPENSIV_API_KEY=xpk_... node examples/ci-gate.mjs https://preview.example.com
```

## Development

```sh
npm ci
npm test   # builds with tsc, then runs node --test on the compiled tests
```

## License

MIT
