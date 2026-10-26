/**
 * Bounded retry with backoff for the network calls `piquette watch` makes AFTER an
 * expensive chain run has already succeeded (push, open PR, comment, marker,
 * transition). Observed in production: one undici `fetch failed` from
 * `openPr` blocked an issue whose 7/7-phase chain had succeeded and whose
 * branch was already pushed, forcing a human re-queue that reran the whole
 * chain. A blip on the last mile must cost seconds, not a rerun.
 *
 * Only TRANSIENT failures are retried (see `isTransientError`) — a 4xx other
 * than 429 is a real answer from the server (bad credentials, a validation
 * error) and retrying it only delays the diagnosis.
 */

/**
 * An HTTP failure from a tracker/code-host REST call, carrying the status as a
 * field so `isTransientError` never has to scrape it back out of message text.
 * The message format of the errors the providers used to throw is unchanged.
 */
export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/**
 * Tag a transport error thrown by a non-idempotent write (a POST: comment, PR
 * create). undici raises the same socket error whether or not the server
 * already applied the request, so repeating it may duplicate the write.
 * `isTransientError` honors the tag, so `withRetry` surfaces the error instead
 * of re-running the call. Returns `e` for `throw markAmbiguousWrite(e)`.
 */
export function markAmbiguousWrite<E>(e: E): E {
  if (e && typeof e === "object") (e as { ambiguousWrite?: boolean }).ambiguousWrite = true;
  return e;
}

/** True when `e` was tagged by `markAmbiguousWrite`. */
export function isAmbiguousWrite(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { ambiguousWrite?: unknown }).ambiguousWrite === true;
}

const TRANSIENT_CODES = /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|UND_ERR_\w+)$/;
// Includes the strings `git push` prints for network trouble (git errors carry no codes).
const TRANSIENT_MESSAGE =
  /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UND_ERR_\w+|socket hang up|GOAWAY|Could not resolve host|Connection (?:reset|timed out)|Operation timed out|remote end hung up|RPC failed|early EOF|returned error: 5\d\d/i;

/**
 * Whether `e` looks like a blip worth retrying: undici's `fetch failed`
 * (whose real reason hides on `cause`), a transient socket/DNS error code, HTTP
 * 5xx, or 429. Walks the `cause` chain a few levels because undici nests the
 * real error under `TypeError: fetch failed`.
 */
export function isTransientError(e: unknown): boolean {
  if (isAmbiguousWrite(e)) return false;
  let cur: unknown = e;
  for (let depth = 0; depth < 4 && cur; depth++) {
    const err = cur as { status?: unknown; code?: unknown; message?: unknown; cause?: unknown };
    if (typeof err.status === "number" && (err.status >= 500 || err.status === 429)) return true;
    if (typeof err.code === "string" && TRANSIENT_CODES.test(err.code)) return true;
    if (typeof err.message === "string") {
      if (TRANSIENT_MESSAGE.test(err.message)) return true;
      // Providers that predate `HttpError` only expose the status in the text: "... -> 503: ...".
      if (typeof err.status !== "number" && /-> (5\d\d|429)\b/.test(err.message)) return true;
    }
    cur = err.cause;
  }
  return false;
}

export interface RetryOptions {
  /** Total tries, including the first. Default 4. */
  attempts?: number;
  /** Delay before the first retry. Default 1000ms. */
  baseMs?: number;
  /** Multiplier per further retry. Default 3 (1s, 3s, 9s). */
  factor?: number;
  /** Injectable so tests never really wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Called before each wait, for logging. */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

export const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Run `fn`, retrying transient failures with exponential backoff; non-transient errors rethrow immediately. */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 4;
  const baseMs = opts.baseMs ?? 1000;
  const factor = opts.factor ?? 3;
  const sleep = opts.sleep ?? realSleep;
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i >= attempts || !isTransientError(error)) throw error;
      const delay = baseMs * factor ** (i - 1);
      opts.onRetry?.(error, i, delay);
      await sleep(delay);
    }
  }
}
