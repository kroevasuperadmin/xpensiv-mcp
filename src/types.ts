/** Lifecycle of a design check. */
export type CheckStatus = 'queued' | 'running' | 'completed' | 'failed';

export type Severity = 'high' | 'medium' | 'low' | (string & {});

export interface Finding {
  title?: string;
  /** Name of the design skill the finding comes from. */
  skill?: string;
  /** CSS-ish region the evidence points at, or "Page-wide". */
  region: string;
  severity: Severity;
  evidence: string[];
  fix: string;
  /** Ready-to-paste prompt for a coding agent. */
  prompt: string;
}

export interface Screenshot {
  /** Viewport name, for example "mobile" or "desktop". */
  region: string;
  /** Path on the REST API, absolute URL from the MCP tool. */
  url: string;
}

export interface LighthouseScores {
  performance: number | null;
  accessibility: number | null;
  bestPractices: number | null;
  seo: number | null;
}

export interface CheckResult {
  verdict: string;
  provider?: string;
  modelReview?: string;
  findings: Finding[];
  screenshots: Screenshot[];
  lighthouse: { mobile: LighthouseScores; desktop: LighthouseScores } | null;
}

/** Returned when a check is created. */
export interface CheckStarted {
  id: string;
  status: CheckStatus;
  /** REST only. */
  statusUrl?: string;
  /** REST only. */
  resultUrl?: string;
  /** MCP only: what to do next, in the server's words. */
  next?: string;
}

export interface Check {
  id: string;
  url: string;
  status: CheckStatus;
  createdAt?: string;
  updatedAt?: string;
  error?: string | null;
  /** Server hint on what to do next. */
  next?: string;
  /** Present once status is "completed". */
  result?: CheckResult;
  /** MCP only: link to the check in the web console. */
  console?: string;
}

export interface CheckSummary {
  id: string;
  url: string;
  status: CheckStatus;
  createdAt: string;
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ClientOptions {
  /** Bearer API key, "xpk_...". Falls back to the XPENSIV_API_KEY environment variable. */
  apiKey?: string;
  /** Defaults to https://xpensiv.si, or XPENSIV_BASE_URL. */
  baseUrl?: string;
  /** Inject a fetch implementation, for example in tests. */
  fetch?: FetchLike;
  /** Per-request timeout in milliseconds. Default 30000. */
  timeoutMs?: number;
  /** Sent as User-Agent. */
  userAgent?: string;
}
