/**
 * What the dashboard API reads. Two implementations: `LocalTraceReader` (a
 * target repo's piquette.db, node) and `D1TraceReader` (the cloud app's synced D1,
 * node-free). The routes in `app.ts` see only this interface, so the same
 * route table serves both and a contract suite can pin them together.
 */
import type { AgentPrompts, Envelope, EventsPage, GateResult, HostedFactory, Session, SessionDetail, SessionSummary } from "../shared/types.ts";

/** Picks one run when two share an `adw_id` (hosted mode): a factory serves many repos, and a repo many factories. Local mode ignores it. */
export interface SessionSel {
  factory?: string;
  repo?: string;
}

export interface SessionFilter {
  repos?: string[];
  factories?: string[];
  /** List the reviewed (archived) runs instead of the open ones. */
  archived?: boolean;
}

export interface HostedHealth {
  repos: string[];
  factories: HostedFactory[];
}

export interface TraceReader {
  readonly mode: "local" | "hosted";
  readonly label: string;
  readonly journalMode: string;
  sessionCount(): Promise<number>;
  sessions(limit: number, filter?: SessionFilter): Promise<SessionSummary[]>;
  sessionDetail(id: string, sel?: SessionSel): Promise<SessionDetail | null>;
  session(id: string, sel?: SessionSel): Promise<Session | null>;
  events(id: string, after: number, limit: number, sel?: SessionSel): Promise<EventsPage>;
  envelopes(id: string, sel?: SessionSel): Promise<Envelope[]>;
  gates(id: string, sel?: SessionSel): Promise<GateResult[]>;
  /** Null system/user when the agent never ran, or (hosted) the sync level did not carry prompts. */
  prompts(id: string, agent: string, sel?: SessionSel): Promise<AgentPrompts>;
  /** False when the session does not exist (for this reader). Writes only review state, never a synced table. */
  setArchived(id: string, archived: boolean, sel?: SessionSel, actor?: string): Promise<boolean>;
  hostedHealth?(): Promise<HostedHealth>;
}

export interface SessionCandidate {
  factory_id: string;
  factory_name: string;
  repo: string;
}

/** Hosted mode: an `adw_id` that exists under more than one (repo, factory) the reader may see. */
export class AmbiguousSession extends Error {
  readonly candidates: SessionCandidate[];
  constructor(id: string, candidates: SessionCandidate[]) {
    super(`${id} exists in more than one place: ${candidates.map((c) => `${c.repo} @ ${c.factory_name}`).join(", ")}; pick one with ?repo= and ?factory=`);
    this.name = "AmbiguousSession";
    this.candidates = candidates;
  }
}

/** A filter value the hosted API refuses. Surfaces as a 400. */
export class BadFilter extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BadFilter";
  }
}

/** Path segments (`adw_id`, agent) are plain identifiers; anything else is refused outright. */
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;
export const isSafeSegment = (value: string): boolean => SAFE_SEGMENT.test(value) && value !== "." && value !== "..";
