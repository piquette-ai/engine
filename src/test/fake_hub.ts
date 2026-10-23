/**
 * An in-process fake of the hosted hub's `/ingest/v1` (the real one is #136),
 * on a loopback port. Records every request, validates each POST body against
 * the contract schema, and lets a test script the reply per request.
 */
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import * as v from "valibot";
import { SyncBatchSchema, type SyncBatch } from "../core/sync/contract.js";

export interface HubRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  raw: string;
  batch?: SyncBatch;
}

export interface HubReply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Do not answer for this long (timeout tests). */
  hangMs?: number;
}

export interface FakeHub {
  url: string;
  requests: HubRequest[];
  /** POST bodies that failed contract validation — must stay empty. */
  invalid: string[];
  /** Replace the scripted reply (default: 200 for POST, `{supported:[1,1]}` for GET). */
  reply(fn: ((req: HubRequest, n: number) => HubReply | undefined) | undefined): void;
  /** Distinct event ids the hub would hold after upserting everything received. */
  uniqueEventIds(): Set<string>;
  posts(): HubRequest[];
  close(): Promise<void>;
}

export async function startFakeHub(): Promise<FakeHub> {
  const requests: HubRequest[] = [];
  const invalid: string[] = [];
  let script: ((req: HubRequest, n: number) => HubReply | undefined) | undefined;
  const timers = new Set<NodeJS.Timeout>();

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      const entry: HubRequest = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, raw };
      if (entry.method === "POST") {
        try {
          const parsed = v.safeParse(SyncBatchSchema, JSON.parse(raw));
          if (parsed.success) entry.batch = parsed.output;
          else invalid.push(raw.slice(0, 300));
        } catch {
          invalid.push(raw.slice(0, 300));
        }
      }
      requests.push(entry);
      const fallback: HubReply = entry.method === "GET" ? { status: 200, body: { supported: [1, 1] } } : { status: 200, body: { ok: true } };
      const reply = script?.(entry, requests.length) ?? fallback;
      const send = (): void => {
        res.writeHead(reply.status, { "Content-Type": "application/json", ...reply.headers });
        res.end(reply.body === undefined ? "" : JSON.stringify(reply.body));
      };
      if (reply.hangMs) {
        const t = setTimeout(send, reply.hangMs);
        timers.add(t);
      } else send();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    invalid,
    reply: (fn) => {
      script = fn;
    },
    uniqueEventIds: () => new Set(requests.flatMap((r) => r.batch?.sessions.flatMap((s) => s.events.map((e) => e.event_id)) ?? [])),
    posts: () => requests.filter((r) => r.method === "POST"),
    close: () =>
      new Promise<void>((resolve) => {
        for (const t of timers) clearTimeout(t);
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
