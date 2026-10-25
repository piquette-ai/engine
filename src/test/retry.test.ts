import { test } from "node:test";
import assert from "node:assert/strict";
import { HttpError, isTransientError, markAmbiguousWrite, withRetry } from "../core/retry.js";

function withCause(message: string, code: string): Error {
  const err = new TypeError(message);
  (err as Error & { cause?: unknown }).cause = Object.assign(new Error("inner"), { code });
  return err;
}

test("isTransientError: undici 'fetch failed', socket/DNS codes (own or on cause), UND_ERR_*", () => {
  assert.equal(isTransientError(new TypeError("fetch failed")), true);
  assert.equal(isTransientError(withCause("boom", "ECONNRESET")), true);
  assert.equal(isTransientError(withCause("boom", "ETIMEDOUT")), true);
  assert.equal(isTransientError(withCause("boom", "ENOTFOUND")), true);
  assert.equal(isTransientError(withCause("boom", "EAI_AGAIN")), true);
  assert.equal(isTransientError(withCause("boom", "UND_ERR_CONNECT_TIMEOUT")), true);
  assert.equal(isTransientError(Object.assign(new Error("x"), { code: "UND_ERR_SOCKET" })), true);
  assert.equal(isTransientError(new Error("read ECONNRESET")), true);
});

test("isTransientError: git network failures", () => {
  assert.equal(isTransientError(new Error("fatal: unable to access 'x': Could not resolve host: github.com")), true);
  assert.equal(isTransientError(new Error("fatal: the remote end hung up unexpectedly")), true);
});

test("isTransientError: HTTP 5xx and 429 (status field or legacy message text), not other 4xx", () => {
  assert.equal(isTransientError(new HttpError("x", 500)), true);
  assert.equal(isTransientError(new HttpError("x", 503)), true);
  assert.equal(isTransientError(new HttpError("x", 429)), true);
  assert.equal(isTransientError(new Error("GitHub POST /pulls -> 502: bad gateway")), true);
  assert.equal(isTransientError(new HttpError("x", 400)), false);
  assert.equal(isTransientError(new HttpError("x", 401)), false);
  assert.equal(isTransientError(new HttpError("x", 404)), false);
  assert.equal(isTransientError(new HttpError("GitHub POST /pulls -> 422: validation failed", 422)), false);
  assert.equal(isTransientError(new Error("GitHub POST /pulls -> 422: validation failed")), false);
});

test("isTransientError: ordinary errors and non-errors are not transient", () => {
  assert.equal(isTransientError(new Error("nothing to commit")), false);
  assert.equal(isTransientError(undefined), false);
  assert.equal(isTransientError("fetch failed"), false);
});

test("withRetry: backs off 1s,3s,9s and succeeds on the last try", async () => {
  const sleeps: number[] = [];
  let calls = 0;
  const result = await withRetry(
    async () => {
      if (++calls < 4) throw new TypeError("fetch failed");
      return "ok";
    },
    { sleep: async (ms) => void sleeps.push(ms) },
  );
  assert.equal(result, "ok");
  assert.equal(calls, 4);
  assert.deepEqual(sleeps, [1000, 3000, 9000]);
});

test("withRetry: gives up after `attempts` and rethrows the last transient error", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls++;
          throw new HttpError("down", 503);
        },
        { attempts: 3, sleep: async () => {} },
      ),
    /down/,
  );
  assert.equal(calls, 3);
});

test("withRetry: a non-transient error rethrows immediately without sleeping", async () => {
  let calls = 0;
  let slept = false;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls++;
          throw new HttpError("nope", 422);
        },
        { sleep: async () => void (slept = true) },
      ),
    /nope/,
  );
  assert.equal(calls, 1);
  assert.equal(slept, false);
});

test("withRetry: onRetry sees each failure with its attempt number and delay", async () => {
  const seen: Array<[number, number]> = [];
  let calls = 0;
  await withRetry(
    async () => {
      if (++calls < 3) throw new TypeError("fetch failed");
    },
    { sleep: async () => {}, onRetry: (_e, attempt, delay) => seen.push([attempt, delay]) },
  );
  assert.deepEqual(seen, [[1, 1000], [2, 3000]]);
});

test("isTransientError: an error tagged by markAmbiguousWrite is never transient, so withRetry does not re-run the write", async () => {
  assert.equal(isTransientError(markAmbiguousWrite(withCause("fetch failed", "UND_ERR_SOCKET"))), false);
  let calls = 0;
  await assert.rejects(() =>
    withRetry(
      async () => {
        calls++;
        throw markAmbiguousWrite(withCause("fetch failed", "UND_ERR_SOCKET"));
      },
      { sleep: async () => {} },
    ),
  );
  assert.equal(calls, 1);
});
