import { CheckFailedError, TimeoutError } from './errors.js';
import { errorFromReply, resolveOptions, send, type Resolved } from './http.js';
import type { Check, CheckResult, CheckStarted, CheckSummary, ClientOptions } from './types.js';

export interface WaitOptions {
  /** Delay between polls. The API suggests 10 seconds. Default 10000. */
  intervalMs?: number;
  /** Give up after this long. Default 300000 (5 minutes). */
  timeoutMs?: number;
  /** Called after every poll, for progress output. */
  onPoll?: (check: Check) => void;
  /** Replace the sleep, for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Client for the REST API under /api/v1. */
export class XpensivClient {
  private readonly r: Resolved;

  constructor(options: ClientOptions = {}) {
    this.r = resolveOptions(options);
  }

  /** POST /api/v1/checks. Starts a check and returns its id; nothing is waited for. */
  async createCheck(url: string): Promise<CheckStarted> {
    const reply = await send(this.r, 'POST', '/api/v1/checks', { json: { url } });
    if (reply.status !== 202) throw errorFromReply(reply);
    return reply.body as CheckStarted;
  }

  /** GET /api/v1/checks/{id}. Includes `result` once the check has completed. */
  async getCheck(id: string): Promise<Check> {
    const reply = await send(this.r, 'GET', `/api/v1/checks/${encodeURIComponent(id)}`);
    if (reply.status !== 200) throw errorFromReply(reply);
    return reply.body as Check;
  }

  /** GET /api/v1/checks/{id}/result. Returns null while the check is still running. */
  async getResult(id: string): Promise<CheckResult | null> {
    const reply = await send(this.r, 'GET', `/api/v1/checks/${encodeURIComponent(id)}/result`);
    if (reply.status === 202) return null;
    if (reply.status !== 200) throw errorFromReply(reply);
    return reply.body as CheckResult;
  }

  /** GET /api/v1/checks. */
  async listChecks(): Promise<CheckSummary[]> {
    const reply = await send(this.r, 'GET', '/api/v1/checks');
    if (reply.status !== 200) throw errorFromReply(reply);
    return (reply.body as { checks: CheckSummary[] }).checks;
  }

  /** Poll until the check completes or fails. Resolves with the final check either way. */
  async waitForCheck(id: string, options: WaitOptions = {}): Promise<Check> {
    const { intervalMs = 10_000, timeoutMs = 300_000, onPoll, sleep = defaultSleep } = options;
    let waited = 0;
    for (;;) {
      const check = await this.getCheck(id);
      onPoll?.(check);
      if (check.status === 'completed' || check.status === 'failed') return check;
      if (waited + intervalMs > timeoutMs) {
        throw new TimeoutError(`check ${id} still ${check.status} after ${Math.round(waited / 1000)}s`);
      }
      await sleep(intervalMs);
      waited += intervalMs;
    }
  }

  /** Create a check, wait for it, and return the completed check. Throws CheckFailedError if it fails. */
  async runCheck(url: string, options: WaitOptions = {}): Promise<Check> {
    const started = await this.createCheck(url);
    const check = await this.waitForCheck(started.id, options);
    if (check.status === 'failed') throw new CheckFailedError(check.id, check.error ?? 'unknown error');
    return check;
  }
}
