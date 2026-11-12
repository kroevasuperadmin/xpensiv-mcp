// Fail a CI job when a deployed preview has high-severity design findings.
//
//   XPENSIV_API_KEY=xpk_... node examples/ci-gate.mjs https://preview.example.com
//
// Exit codes: 0 clean, 1 high-severity findings, 3 out of credits (so the job
// can be marked "skipped" instead of "failed" if you prefer), 4 check failed.
import { XpensivClient, InsufficientCreditsError, CheckFailedError } from '../dist/src/index.js';

const url = process.argv[2];
if (!url) {
  console.error('usage: node examples/ci-gate.mjs <url>');
  process.exit(2);
}

try {
  const check = await new XpensivClient().runCheck(url, { onPoll: (c) => console.error(`status: ${c.status}`) });
  const high = check.result.findings.filter((f) => f.severity === 'high');
  for (const f of high) console.log(`HIGH ${f.region}: ${f.fix}`);
  console.log(`${check.result.verdict}: ${check.result.findings.length} findings, ${high.length} high`);
  process.exit(high.length ? 1 : 0);
} catch (error) {
  console.error(error.message);
  process.exit(error instanceof InsufficientCreditsError ? 3 : error instanceof CheckFailedError ? 4 : 1);
}
