/**
 * `sync.on_watch` (#221): `spf watch` sends one background sync pass after each run it finishes, plus a catch-up pass at
 * start. The pass is the same `runSyncPass` the CLI runs (same pid lock, same cursors), run in-process.
 *
 * INVARIANTS: `request()` returns immediately and never throws; a pass never delays, fails or changes a run or a PR; a failure
 * only logs and notifies at `notice` level (once per distinct failure, not once per run); requests that arrive while a pass
 * runs coalesce into ONE trailing pass (the in-flight pass may have read the db before the later run finished); a pass that
 * failed or found the sync lock held is retried by the next `tick()` (the watch poll) so an idle factory still converges; a
 * dry-run watch never builds one of these.
 */
import type { NotifyEvent } from "../notify/channel.ts";
import type { SyncPassReport } from "./client.ts";

export interface SyncOnWatchOptions {
  /** One pass, as `runSyncPass` with the watch's config/paths — injected so tests need no hub. `signal` aborts it (shutdown). */
  runPass: (signal: AbortSignal) => Promise<SyncPassReport>;
  notify: (event: NotifyEvent) => void;
  log: (message: string) => void;
  /** Shown on the failure notice so it says which factory/repo it came from. */
  fields?: Array<[string, string]>;
  /** Minimum gap between two pass STARTS (a D1 trace db shares a request budget with the live tracer). Default 0. */
  minIntervalMs?: number;
  /** Shutdown: how long `drain()` lets the last pass run before aborting it. Default 15s. */
  drainMs?: number;
  now?: () => number;
}

export interface SyncOnWatch {
  /** Ask for a pass. Fire and forget. */
  request: () => void;
  /** Called every watch poll: re-requests a pass when the last one failed or was locked out. */
  tick: () => void;
  /** Resolves when no pass is running or pending (shutdown drain, tests). A pass held back by `minIntervalMs` runs now. */
  idle: () => Promise<void>;
  /** Abort the in-flight pass between batches and drop anything pending. */
  abort: () => void;
  /** Shutdown: let the last pass run for at most `drainMs`, then abort it (cursors only advance on accepted batches). */
  drain: () => Promise<void>;
}

export function createSyncOnWatch(opts: SyncOnWatchOptions): SyncOnWatch {
  const now = opts.now ?? Date.now;
  const minInterval = opts.minIntervalMs ?? 0;
  let running: Promise<void> | null = null;
  let pending = false;
  let needsRetry = false;
  let lastStart = -Infinity;
  let delayTimer: NodeJS.Timeout | null = null;
  let lastNotified: string | undefined;
  let controller = new AbortController();

  const fail = (detail: string): void => {
    try {
      opts.log(`sync: background pass failed: ${detail}`);
      if (detail === lastNotified) return; // a persistent failure notifies once, not once per run
      lastNotified = detail;
      opts.notify({ kind: "watch_error", level: "notice", title: "sync: background pass failed", detail, fields: opts.fields ?? [] });
    } catch {
      // logging must not throw out of a background pass either
    }
  };

  async function loop(): Promise<void> {
    do {
      pending = false;
      lastStart = now();
      needsRetry = false;
      try {
        const report = await opts.runPass(controller.signal);
        if (report.status === "failed" || report.status === "rejected") {
          fail(report.error ?? report.status);
          needsRetry = report.status === "failed" && !controller.signal.aborted;
        } else if (report.status === "locked") {
          needsRetry = true; // another `spf sync` held the lock and may have read the db before this run finished
          opts.log("sync: background pass skipped (another spf sync holds the lock); retrying on the next poll");
        } else lastNotified = undefined;
      } catch (error) {
        fail((error as Error).message ?? String(error));
        needsRetry = !controller.signal.aborted;
      }
      if (pending && minInterval > 0 && now() - lastStart < minInterval) return; // the trailing pass waits (see request)
    } while (pending);
  }

  function start(): void {
    if (delayTimer) {
      clearTimeout(delayTimer);
      delayTimer = null;
    }
    running = loop().finally(() => {
      running = null;
      if (pending) request();
    });
  }

  function request(): void {
    if (controller.signal.aborted) return;
    if (running) {
      pending = true;
      return;
    }
    const wait = minInterval - (now() - lastStart);
    if (wait > 0) {
      pending = true;
      if (!delayTimer) {
        delayTimer = setTimeout(() => {
          delayTimer = null;
          if (!running && pending) start();
        }, wait);
        delayTimer.unref();
      }
      return;
    }
    start();
  }

  return {
    request,
    tick(): void {
      if (needsRetry && !running && !pending) request();
    },
    async idle(): Promise<void> {
      if (!running && pending && !controller.signal.aborted) start();
      while (running) await running;
    },
    async drain(): Promise<void> {
      let timer: NodeJS.Timeout | undefined;
      const bound = new Promise<void>((resolve) => (timer = setTimeout(resolve, opts.drainMs ?? 15_000)));
      await Promise.race([this.idle(), bound]);
      clearTimeout(timer);
      this.abort();
      await this.idle();
    },
    abort(): void {
      controller.abort();
      pending = false;
      if (delayTimer) {
        clearTimeout(delayTimer);
        delayTimer = null;
      }
    },
  };
}
