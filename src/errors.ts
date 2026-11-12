/** Base class for everything this package throws about the API. */
export class XpensivError extends Error {
  /** HTTP status, when the error came from an HTTP response. */
  readonly status?: number;
  /** Parsed response body or tool payload, when there was one. */
  readonly body?: unknown;

  constructor(message: string, details: { status?: number; body?: unknown } = {}) {
    super(message);
    this.name = new.target.name;
    if (details.status !== undefined) this.status = details.status;
    if (details.body !== undefined) this.body = details.body;
  }
}

/** 401: missing, revoked or malformed API key. */
export class AuthError extends XpensivError {}

/** 400: the request was rejected, usually an invalid or non-public URL. */
export class ValidationError extends XpensivError {}

/** 404: no such check for this account. */
export class NotFoundError extends XpensivError {}

/**
 * The account has no credits left. REST answers 402; the MCP tool answers with
 * "Not enough Xpensiv credits for this check. Top up at https://xpensiv.si/pricing".
 */
export class InsufficientCreditsError extends XpensivError {
  readonly balance?: number;
  readonly topUp?: string;

  constructor(message: string, details: { status?: number; body?: unknown; balance?: number; topUp?: string } = {}) {
    super(message, details);
    if (details.balance !== undefined) this.balance = details.balance;
    if (details.topUp !== undefined) this.topUp = details.topUp;
  }
}

/** 429, or the MCP tool's "Rate limit reached". */
export class RateLimitError extends XpensivError {
  /** Seconds to wait, from the Retry-After header when present. */
  readonly retryAfterSeconds?: number;

  constructor(message: string, details: { status?: number; body?: unknown; retryAfterSeconds?: number } = {}) {
    super(message, details);
    if (details.retryAfterSeconds !== undefined) this.retryAfterSeconds = details.retryAfterSeconds;
  }
}

/** An MCP tool returned isError for any reason not covered above. */
export class ToolError extends XpensivError {}

/** A JSON-RPC level error from the MCP endpoint. */
export class McpProtocolError extends XpensivError {
  readonly code?: number;

  constructor(message: string, details: { status?: number; body?: unknown; code?: number } = {}) {
    super(message, details);
    if (details.code !== undefined) this.code = details.code;
  }
}

/** The check finished with status "failed". */
export class CheckFailedError extends XpensivError {
  readonly checkId: string;

  constructor(checkId: string, reason: string) {
    super(`check ${checkId} failed: ${reason}`);
    this.checkId = checkId;
  }
}

/** waitForCheck ran out of time before the check finished. */
export class TimeoutError extends XpensivError {}

export const NO_CREDITS_PREFIX = 'Not enough Xpensiv credits';
