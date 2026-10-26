/**
 * Console recorder (#159, ticket B / #174): video evidence of console
 * journeys, recorded the way the #159 dry run proved works — agent-browser
 * driving a localhost-only `ttyd` web terminal (`record start/stop`), then
 * ffmpeg for an H.264 MP4, a GIF poster and a contact sheet (one frame
 * every 3 s, so a reviewer can scan the whole session at a glance).
 *
 * VHS was tried first and dropped: it exited 0 having captured 0 frames. So
 * this recorder never trusts an exit code — it checks its own output (files
 * exist, the video has frames and a real duration) and throws otherwise.
 * The prover turns any throw into CAN'T TELL, never PASS.
 *
 * The video is the run the checks judged, not a second one (#238): the
 * journeys' output is captured once with its timing, and the terminal plays
 * that capture back (idle gaps capped). Recording used to re-type every
 * command into a shell, so each build or app start ran twice per attempt.
 * Before each step the recorder reads the command back off the screen, and
 * after it the step's footer (exit code, duration): a disconnected terminal
 * still fails the recording instead of passing on file checks alone.
 *
 * Known limits (documented, not hidden):
 *  - Whatever the commands print is on the video. Don't put secrets in
 *    journey commands or let them print any.
 *  - The run's output went to a pipe, not a terminal, so it looks the way
 *    the checks saw it: programs that colour only on a TTY play back plain.
 *  - ttyd and the browser talk over 127.0.0.1; a sandboxed runner needs a
 *    loopback allowance.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, statSync, writeFileSync } from "node:fs";
import type { OutputChunk } from "./journeys.ts";
import { createServer } from "node:net";
import path from "node:path";
import { operatorEnv } from "./utils.ts";

export interface RecordingFiles {
  video: string;
  poster: string;
  contact_sheet: string;
  source: string;
  /** The terminal's own text buffer at the end of the session — what was on screen, readable and searchable without the video. */
  transcript: string;
}

export interface Recording {
  files: RecordingFiles;
  duration_s: number;
}

export interface RecordStep {
  /** The command the journey ran. Shown, never run again. */
  command: string;
  /** Its merged output as captured, with arrival times. */
  transcript: OutputChunk[];
  exit: number | null;
  /** How long the run took. */
  ms: number;
}

export interface ConsoleRecorder {
  /** Records a terminal playing back `steps` (already run); writes every file under `workDir`. Throws when it can't produce real evidence. */
  record(steps: RecordStep[], options: { workDir: string; title?: string }): Promise<Recording>;
}

/** Tools the console recorder needs on PATH. Exported for `piquette doctor`. */
export const RECORDER_TOOLS = ["agent-browser", "ttyd", "ffmpeg", "ffprobe"] as const;

/** How long to wait for a step's command to show on screen before deciding the terminal never got it: 25 × 200 ms = 5 s. */
const ECHO_POLL_TRIES = 25;
const ECHO_POLL_MS = 200;
/** How often to look for a step's footer while it plays. */
const FOOTER_POLL_MS = 300;

export function missingRecorderTools(): string[] {
  return RECORDER_TOOLS.filter((tool) => spawnSync("bash", ["-c", `command -v ${tool}`], { encoding: "utf-8" }).status !== 0);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no free port"))));
    });
  });
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      last = `HTTP ${res.status}`;
    } catch (error) {
      last = (error as Error).message;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`ttyd did not come up at ${url} within ${timeoutMs}ms (${last})`);
}

function run(cmd: string, args: string[], what: string, timeoutMs = 60_000): string {
  const result = spawnSync(cmd, args, { encoding: "utf-8", timeout: timeoutMs, env: operatorEnv() });
  if (result.error) throw new Error(`${what}: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = `${result.stderr || ""}${result.stdout || ""}`.trim().split("\n").slice(-2).join(" ");
    throw new Error(`${what} failed (exit ${result.status})${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout;
}

/** Duration in seconds and video packet count, read back from the file — the recorder's own proof it captured something. */
export function probeVideo(file: string): { duration_s: number; packets: number } {
  const out = run(
    "ffprobe",
    ["-v", "error", "-select_streams", "v:0", "-count_packets", "-show_entries", "stream=nb_read_packets:format=duration", "-of", "json", file],
    "ffprobe",
  );
  const parsed = JSON.parse(out) as { streams?: Array<{ nb_read_packets?: string }>; format?: { duration?: string } };
  return { duration_s: Number(parsed.format?.duration ?? 0), packets: Number(parsed.streams?.[0]?.nb_read_packets ?? 0) };
}

/**
 * Reading ttyd's xterm instance (`window.term`) from the page. Every helper
 * returns `JSON.stringify(...)`, so agent-browser prints one quoted JSON
 * string that is parsed twice on this side — command text with quotes or
 * newlines survives the round trip. Rows xterm wrapped are re-joined, so a
 * long command still matches the string that was typed.
 */
const JOIN_ROWS_JS =
  "const rowsText = (b, from, to) => { const out = []; for (let i = from; i < to; i++) { const l = b.getLine(i); if (!l) continue; const t = l.translateToString(true); if (l.isWrapped && out.length) out[out.length - 1] += t; else out.push(t); } return out.join('\\n'); };" +
  "const logicalLine = (b, row) => { let start = row; while (start > 0 && b.getLine(start) && b.getLine(start).isWrapped) start--; return rowsText(b, start, row + 1); };";

/** The logical line under the cursor (wrapped rows joined) and the absolute row it ends on. */
const CURSOR_JS = `(() => { ${JOIN_ROWS_JS} const b = window.term.buffer.active; const row = b.baseY + b.cursorY; return JSON.stringify({ row, line: logicalLine(b, row) }); })()`;

/**
 * What a command printed: the rows after the line it was typed on. When the
 * program cleared the terminal (Ink does when its output is taller than the
 * screen, scrollback included), that line is gone; then the whole buffer is
 * the output, flagged `cleared`.
 */
function outputSinceJs(row: number, command: string): string {
  return (
    `(() => { ${JOIN_ROWS_JS} const b = window.term.buffer.active; ` +
    `const still = b.length > ${row} && logicalLine(b, ${row}).includes(${JSON.stringify(command)}); ` +
    `const from = still ? ${row} + 1 : 0; ` +
    `return JSON.stringify({ cleared: !still, text: rowsText(b, from, b.length).replace(/\\s+$/, '') }); })()`
  );
}

function evalJson<T>(ab: (args: string[], what: string) => string, js: string, what: string): T {
  const out = ab(["eval", js], what).trim().split("\n").pop() ?? "";
  try {
    const inner = JSON.parse(out);
    if (typeof inner === "string") return JSON.parse(inner) as T;
  } catch {
    /* fall through */
  }
  throw new Error(`${what}: could not read the terminal (got ${JSON.stringify(out.slice(0, 120))})`);
}

/** The terminal replay's environment: no `piquette sync` credentials (#33), and never PIQUETTE_EVIDENCE_DIR (#235). The replay runs no journey command, but the terminal is still a process piquette starts. */
export function replayEnv(base: NodeJS.ProcessEnv = operatorEnv()): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  delete env.PIQUETTE_EVIDENCE_DIR;
  return env;
}

// ── the replay ──────────────────────────────────────────────────────────────

/** An idle gap longer than this plays as this long (asciinema's idle_time_limit): a 40 s build with no output doesn't make a 40 s still video. */
export const MAX_IDLE_MS = 1_500;
/** Per step, output beyond this many characters is not replayed (the start is cut, with a note on screen); xterm stays responsive. */
export const MAX_REPLAY_CHARS = 200_000;

const PROMPT = "\x1b[36mpiquette-proof\x1b[0m $ ";

export interface ReplayWrite {
  delay_ms: number;
  text: string;
}

export interface ReplayStep {
  /** Shown after the prompt, as if typed; the replay waits for Enter after it. */
  header: string;
  writes: ReplayWrite[];
  /** The plain text of the footer line, read back from the terminal as proof the whole step reached it. */
  footer: string;
  /** Upper bound on how long the writes take to play. */
  play_ms: number;
}

export interface ReplayPlan {
  prompt: string;
  title?: string;
  steps: ReplayStep[];
}

/** The line a step's command shows on: `( command )`, the way the checks ran it (a subshell; an `exit` ends only that journey). */
export function stepHeader(command: string): string {
  return `( ${command} )`;
}

/**
 * What the terminal will show, from the captured run: each chunk at its
 * original offset, idle gaps capped at MAX_IDLE_MS, then a footer with the
 * real exit code and duration. Pure; the video is built from this alone.
 */
export function replayPlan(steps: RecordStep[], title?: string): ReplayPlan {
  return {
    prompt: PROMPT,
    title,
    steps: steps.map((step, i) => {
      let chunks = step.transcript;
      const total = chunks.reduce((n, c) => n + c.text.length, 0);
      const writes: ReplayWrite[] = [];
      if (total > MAX_REPLAY_CHARS) {
        let kept = 0;
        let from = chunks.length;
        while (from > 0 && kept + chunks[from - 1].text.length <= MAX_REPLAY_CHARS) kept += chunks[--from].text.length;
        chunks = chunks.slice(from);
        writes.push({ delay_ms: 0, text: `\x1b[2m[… ${total - kept} earlier characters of output not replayed]\x1b[0m\n` });
      }
      let at = 0;
      for (const c of chunks) {
        writes.push({ delay_ms: Math.min(MAX_IDLE_MS, Math.max(0, c.t - at)), text: c.text });
        at = c.t;
      }
      const tail = Math.min(MAX_IDLE_MS, Math.max(0, step.ms - at));
      const text = writes.map((w) => w.text).join("");
      const footer = `[step ${i + 1}/${steps.length} · exit ${step.exit ?? "?"} · ${(step.ms / 1000).toFixed(1)}s]`;
      writes.push({ delay_ms: tail, text: `${text === "" || text.endsWith("\n") ? "" : "\n"}\x1b[2m${footer}\x1b[0m\n` });
      return { header: stepHeader(step.command), writes, footer, play_ms: writes.reduce((n, w) => n + w.delay_ms, 0) };
    }),
  };
}

/**
 * The program ttyd runs (CommonJS, run by this node): it prints the plan and
 * nothing else — no shell, no journey command. Before each step it shows
 * the prompt and command, then waits for Enter, so the recorder can read the
 * command back off the screen first, as it did when it typed it. When the
 * plan is done it stays open (an exiting program closes ttyd's terminal)
 * until stdin ends.
 */
export const REPLAY_SCRIPT = `"use strict";
const fs = require("fs");
const plan = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const out = (s) => new Promise((r) => process.stdout.write(s, () => r()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let enters = 0, wake = null, ended = false, finished = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { enters += (d.match(/\\r\\n|\\r|\\n/g) || []).length; if (wake) wake(); });
process.stdin.on("end", () => { ended = true; if (wake) wake(); if (finished) process.exit(0); });
const enter = async () => { while (enters === 0 && !ended) await new Promise((r) => (wake = r)); wake = null; if (enters > 0) enters--; };
(async () => {
  if (plan.title) await out(plan.prompt + "# " + plan.title + "\\n");
  for (const step of plan.steps) {
    await out(plan.prompt + step.header);
    await enter();
    if (!process.stdin.isTTY) await out("\\n");
    for (const w of step.writes) { if (w.delay_ms > 0) await sleep(w.delay_ms); await out(w.text); }
  }
  await out(plan.prompt);
  finished = true;
  if (ended) process.exit(0);
  setInterval(() => {}, 1 << 30);
})();
`;

export class AgentBrowserTtydRecorder implements ConsoleRecorder {
  constructor(
    private readonly options: { viewport?: { width: number; height: number }; fontSize?: number } = {},
  ) {}

  async record(steps: RecordStep[], opts: { workDir: string; title?: string }): Promise<Recording> {
    const missing = missingRecorderTools();
    if (missing.length > 0) throw new Error(`recorder tools not on PATH: ${missing.join(", ")}`);
    if (steps.length === 0) throw new Error("nothing to record");

    const { width, height } = this.options.viewport ?? { width: 1200, height: 680 };
    const files: RecordingFiles = {
      source: path.join(opts.workDir, "source.webm"),
      video: path.join(opts.workDir, "video.mp4"),
      poster: path.join(opts.workDir, "poster.gif"),
      contact_sheet: path.join(opts.workDir, "contact-sheet.png"),
      transcript: path.join(opts.workDir, "terminal.txt"),
    };
    const plan = replayPlan(steps, opts.title);
    const planFile = path.join(opts.workDir, "replay.json");
    const script = path.join(opts.workDir, "replay.cjs");
    writeFileSync(planFile, JSON.stringify(plan));
    writeFileSync(script, REPLAY_SCRIPT);

    const port = await freePort();
    const url = `http://127.0.0.1:${port}/`;
    const session = `piquette-proof-${process.pid}-${port}`;
    const ab = (args: string[], what: string, timeoutMs?: number) => run("agent-browser", ["--session", session, ...args], `agent-browser ${what}`, timeoutMs);

    let ttyd: ChildProcess | undefined;
    let recording = false;
    const sections: string[] = [];
    try {
      ttyd = spawn(
        "ttyd",
        ["-i", "127.0.0.1", "-p", String(port), "-W", "-t", `fontSize=${this.options.fontSize ?? 16}`, "-t", "scrollback=10000", "-t", 'theme={"background":"#0b0f19"}', process.execPath, script, planFile],
        { stdio: "ignore", env: replayEnv() },
      );
      await waitForHttp(url, 10_000);

      ab(["set", "viewport", String(width), String(height)], "set viewport");
      ab(["open", url], "open terminal");
      ab(["wait", "1500"], "wait");
      ab(["record", "start", files.source], "record start");
      recording = true;
      ab(["click", ".xterm-screen"], "focus terminal");
      for (const [i, step] of plan.steps.entries()) {
        // Proof the terminal shows THIS command before it plays. The dogfood run recorded 30 s of a
        // disconnected terminal and every file check passed, so a video alone is not evidence. Poll,
        // don't read once: the text travels replay -> ttyd -> websocket -> xterm (#179 pilot).
        const needle = step.header.split("\n").pop() ?? step.header;
        let cursor = evalJson<{ row: number; line: string }>(ab, CURSOR_JS, "read prompt line");
        for (let tries = 0; !cursor.line.includes(needle) && tries < ECHO_POLL_TRIES; tries++) {
          ab(["wait", String(ECHO_POLL_MS)], "wait for command");
          cursor = evalJson<{ row: number; line: string }>(ab, CURSOR_JS, "read prompt line");
        }
        if (!cursor.line.includes(needle)) {
          throw new Error(`the terminal did not show \`${steps[i].command}\` (prompt line read back: ${JSON.stringify(cursor.line.slice(-160))})`);
        }
        ab(["press", "Enter"], "press Enter");
        // …and proof it played to the end: the footer, read back.
        const deadline = Date.now() + step.play_ms + 30_000;
        let output = evalJson<{ cleared: boolean; text: string }>(ab, outputSinceJs(cursor.row, needle), "read output");
        while (!output.text.includes(step.footer) && Date.now() < deadline) {
          ab(["wait", String(FOOTER_POLL_MS)], "wait for step");
          output = evalJson<{ cleared: boolean; text: string }>(ab, outputSinceJs(cursor.row, needle), "read output");
        }
        if (!output.text.includes(step.footer)) {
          throw new Error(`the terminal never showed the end of \`${steps[i].command}\` (${step.footer})`);
        }
        const note = output.cleared ? "[the program cleared the terminal; this is what it left on screen]\n" : "";
        sections.push(`$ ${steps[i].command}\n${note}${output.text}`);
        ab(["wait", "600"], "wait");
      }
      ab(["wait", "1200"], "wait");
      ab(["record", "stop"], "record stop");
      recording = false;
    } finally {
      if (recording) {
        try {
          ab(["record", "stop"], "record stop (cleanup)");
        } catch {
          /* best effort */
        }
      }
      try {
        ab(["close"], "close");
      } catch {
        /* best effort */
      }
      ttyd?.kill("SIGTERM");
    }

    if (!existsSync(files.source) || statSync(files.source).size === 0) throw new Error("agent-browser produced no recording");
    writeFileSync(files.transcript, sections.join("\n\n") + "\n");
    run("ffmpeg", ["-y", "-v", "error", "-i", files.source, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", files.video], "ffmpeg mp4", 300_000);
    run("ffmpeg", ["-y", "-v", "error", "-i", files.source, "-vf", "fps=6,scale=720:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=64[p];[b][p]paletteuse", files.poster], "ffmpeg gif", 300_000);
    run("ffmpeg", ["-y", "-v", "error", "-i", files.source, "-vf", "fps=1/3,scale=400:-1,tile=5x4", "-frames:v", "1", files.contact_sheet], "ffmpeg contact sheet", 300_000);

    const { duration_s, packets } = probeVideo(files.video);
    if (!(duration_s >= 1) || packets < 1) {
      throw new Error(`recording has no usable video (duration ${duration_s}s, ${packets} frame(s)) — exit 0 is not evidence`);
    }
    for (const f of [files.poster, files.contact_sheet]) {
      if (!existsSync(f) || statSync(f).size === 0) throw new Error(`recording is missing ${path.basename(f)}`);
    }
    return { files, duration_s };
  }
}
