/**
 * Shared test double for `core/decisions.ts`'s `DecisionClient` — the seam every decision is
 * tested through, so no test ever touches the network (the
 * module header's invariant 8). Same role `FakeProvider`/`FakeAsker` play
 * for their own interfaces.
 *
 * A `FakeDecisionClient` is driven by a RESPONDER: a function from the request
 * to the response (or a thrown error). The static constructors cover the
 * shapes every feature test needs:
 *
 *   FakeDecisionClient.choosing("high", 0.92)        // every question answers "high" @ 0.92
 *   FakeDecisionClient.answering({ q0: {...} })      // exact answers per question name
 *   FakeDecisionClient.failing(new SystemOneApiError(529, "overloaded"))
 *   FakeDecisionClient.hanging()                     // never answers; rejects with AbortError when the caller's timeout aborts
 *   FakeDecisionClient.scoring(2, 0.8)               // score answer at level index 2 (0-based)
 *
 * `calls` records every request, so a test can assert "disabled => zero
 * calls" or inspect the exact closed option set sent as `criteria`;
 * `signals` records each call's `AbortSignal` (same index), so a test can
 * assert the client actually observed the timeout's abort.
 *
 * Two injection routes (see `core/decisions.ts`):
 *   - direct:        `createDecider({ config, client: fake })`
 *   - process-wide:  `setDecisionClientFactory(() => fake)` for code that builds
 *                    its own `Decider` (e.g. `Run.decider` via `startRun`); ALWAYS
 *                    reset with `setDecisionClientFactory(null)` in a `finally`.
 */
import type { DecisionClient, SystemOneRequest, SystemOneResponse } from "../core/decisions.js";

export type DecisionResponder = (request: SystemOneRequest, options: { signal: AbortSignal }) => SystemOneResponse | Promise<SystemOneResponse>;

function abortError(): Error {
  return Object.assign(new Error("aborted"), { name: "AbortError" });
}

export class FakeDecisionClient implements DecisionClient {
  readonly calls: SystemOneRequest[] = [];
  readonly signals: AbortSignal[] = [];
  private readonly responder: DecisionResponder;

  constructor(responder: DecisionResponder) {
    this.responder = responder;
  }

  async systemOne(request: SystemOneRequest, options: { signal: AbortSignal }): Promise<SystemOneResponse> {
    this.calls.push(request);
    this.signals.push(options.signal);
    if (options.signal.aborted) throw abortError();
    return this.responder(request, options);
  }

  /** Every question in the request answers `choice` with `confidence` (a choice-shaped answer). */
  static choosing(choice: string, confidence: number, usage = { input_tokens: 10, output_tokens: 0 }): FakeDecisionClient {
    return new FakeDecisionClient((request) => ({
      model: request.model,
      answers: Object.fromEntries(Object.keys(request.questions).map((name) => [name, { type: "choice", choice, confidence }])),
      usage,
    }));
  }

  /** Every question answers a score at 0-based `level` with `confidence`, via a one-hot `probabilities` map. */
  static scoring(level: number, confidence: number): FakeDecisionClient {
    return new FakeDecisionClient((request) => ({
      model: request.model,
      answers: Object.fromEntries(
        Object.entries(request.questions).map(([name, question]) => {
          const levels = question.type === "score" ? question.criteria.length : 0;
          const probabilities = Object.fromEntries(Array.from({ length: levels }, (_, i) => [String(i), i === level ? 1 : 0]));
          return [name, { type: "score", score: level, probabilities, confidence }];
        }),
      ),
      usage: { input_tokens: 10, output_tokens: 0 },
    }));
  }

  /** Exact `answers` map, keyed by question name (`q0`, `q1`, ... in item order for `decideBatch`). */
  static answering(answers: Record<string, unknown>): FakeDecisionClient {
    return new FakeDecisionClient((request) => ({ model: request.model, answers, usage: { input_tokens: 10, output_tokens: 0 } }));
  }

  static failing(error: Error): FakeDecisionClient {
    return new FakeDecisionClient(() => {
      throw error;
    });
  }

  /** Never answers on its own; when the caller's timeout aborts the signal, rejects with an `AbortError` (so the promise settles and `signals[i].aborted` is true). */
  static hanging(): FakeDecisionClient {
    return new FakeDecisionClient(
      (_request, { signal }) =>
        new Promise<SystemOneResponse>((_, reject) => {
          if (signal.aborted) return reject(abortError());
          signal.addEventListener("abort", () => reject(abortError()), { once: true });
        }),
    );
  }

  /** Answers like `choosing(choice, confidence)`, but only after `ms` — for proving a batch's deadline is its LARGEST live `timeout_ms`. */
  static delayed(ms: number, choice: string, confidence: number): FakeDecisionClient {
    const inner = FakeDecisionClient.choosing(choice, confidence);
    return new FakeDecisionClient(
      (request, options) =>
        new Promise<SystemOneResponse>((resolve, reject) => {
          const timer = setTimeout(() => resolve(inner.systemOne(request, options)), ms);
          options.signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(abortError());
            },
            { once: true },
          );
        }),
    );
  }
}
