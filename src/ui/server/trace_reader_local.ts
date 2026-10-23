/**
 * The local dashboard reader: `SfDb` unchanged, plus the prompt files that
 * live in the session dir (the db has no copy of them). `sel` and the
 * filter are hosted-mode concepts and are ignored here.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { SfDb } from "./db.ts";
import { isSafeSegment, type TraceReader } from "./trace_reader.ts";
import type { AgentPrompts } from "../shared/types.ts";

export class LocalTraceReader implements TraceReader {
  readonly mode = "local" as const;
  readonly label: string;
  readonly journalMode: string;
  constructor(private readonly db: SfDb) {
    this.label = db.label;
    this.journalMode = db.journalMode;
  }
  sessionCount = () => this.db.sessionCount();
  sessions = (limit: number, filter?: { archived?: boolean }) => this.db.sessions(limit, filter?.archived === true);
  sessionDetail = (id: string) => this.db.sessionDetail(id);
  session = (id: string) => this.db.session(id);
  events = (id: string, after: number, limit: number) => this.db.events(id, after, limit);
  envelopes = (id: string) => this.db.envelopes(id);
  gates = (id: string) => this.db.gates(id);
  setArchived = (id: string, archived: boolean) => this.db.setArchived(id, archived);

  async prompts(adwId: string, agent: string): Promise<AgentPrompts> {
    if (!isSafeSegment(adwId) || !isSafeSegment(agent)) throw new Error("invalid adw_id or agent");
    const sessionsDir = this.db.sessionsDir;
    const dir = resolve(sessionsDir, adwId, agent, "prompts");
    // Defense in depth: the segment check already forbids traversal.
    if (dir !== sessionsDir && !dir.startsWith(sessionsDir + sep)) throw new Error("invalid path");
    // A prompt file is absent whenever the agent never ran in this session: null, not an error.
    const read = (name: string): string | null => {
      const file = resolve(dir, `${name}.md`);
      return existsSync(file) ? readFileSync(file, "utf-8") : null;
    };
    return { system: read("system"), user: read("user") };
  }
}
