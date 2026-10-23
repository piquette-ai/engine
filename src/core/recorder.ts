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
 * Known limits (documented, not hidden):
 *  - The recording is a SECOND execution of the journey commands (the first
 *    one, without a terminal, is what the checks judge). Journeys must be
 *    repeatable; the receipt says so in its observations.
 *  - Whatever the commands print is on the video. Don't put secrets in
 *    journey commands or let them print any.
 *  - ttyd and the browser talk over 127.0.0.1; a sandboxed runner needs a
 *    loopback allowance.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, statSync, writeFileSync } from "node:fs";
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
  /** The command typed into the terminal. */
  command: string;
  /** How long to wait after Enter before typing the next one. */
  wait_ms: number;
}

export interface ConsoleRecorder {
  /** Records `steps` typed into a fresh terminal in `cwd`; writes every file under `workDir`. Throws when it can't produce real evidence. */
  record(steps: RecordStep[], options: { cwd: string; workDir: string; title?: string }): Promise<Recording>;
}

/** Tools the console recorder needs on PATH. Exported for `spf doctor`. */
export const RECORDER_TOOLS = ["agent-browser", "ttyd", "ffmpeg", "ffprobe"] as const;

/** How long to wait for a typed command to echo back before deciding the terminal never got it: 25 × 200 ms = 5 s. */
const ECHO_POLL_TRIES = 25;
const ECHO_POLL_MS = 200;

export function missingRecorderTools(): string[] {
  return RECORDER_TOOLS.filter((tool) => spawnSync("bash", ["-c", `command -v ${tool}`], { encoding: "utf-8" }).status !== 0);
}

/** Wait after a command: what it took without a terminal, plus room for typing and rendering. */
export function waitFor(measuredMs: number): number {
  return Math.min(30_000, Math.max(1_500, Math.round(measuredMs * 1.5) + 1_000));
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

type Ab = (args: string[], what: string, timeoutMs?: number) => string;

/**
 * Put text on the terminal's prompt in ONE write: xterm's `term.paste()`
 * (bracketed paste when the shell asked for it, so readline takes it as one
 * unit). Per-key `keyboard type` dropped ~20 characters of a long command
 * under load (#224). Falls back to `keyboard type` only when the page has no
 * `term.paste`. The text travels as a JSON string literal, so quotes, `$`,
 * backslashes and unicode arrive unchanged.
 */
export function pasteScript(text: string): string {
  return `(() => { if (!window.term || typeof window.term.paste !== 'function') return 'unavailable'; window.term.paste(${JSON.stringify(text)}); return 'pasted'; })()`;
}

function sendText(ab: Ab, text: string, what: string): void {
  const out = ab(["eval", pasteScript(text)], `paste ${what}`, 120_000);
  if (out.includes("unavailable")) ab(["keyboard", "type", text], `type ${what}`, 120_000);
}

export class AgentBrowserTtydRecorder implements ConsoleRecorder {
  constructor(
    private readonly options: { viewport?: { width: number; height: number }; fontSize?: number } = {},
  ) {}

  async record(steps: RecordStep[], opts: { cwd: string; workDir: string; title?: string }): Promise<Recording> {
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
    const rc = path.join(opts.workDir, "term.rc");
    writeFileSync(rc, `cd ${JSON.stringify(opts.cwd)}\nexport PS1='\\[\\e[36m\\]spf-proof\\[\\e[0m\\] $ '\nclear\n`);

    const port = await freePort();
    const url = `http://127.0.0.1:${port}/`;
    const session = `spf-proof-${process.pid}-${port}`;
    const ab = (args: string[], what: string, timeoutMs?: number) => run("agent-browser", ["--session", session, ...args], `agent-browser ${what}`, timeoutMs);

    let ttyd: ChildProcess | undefined;
    let recording = false;
    const sections: string[] = [];
    try {
      ttyd = spawn(
        "ttyd",
        ["-i", "127.0.0.1", "-p", String(port), "-W", "-t", `fontSize=${this.options.fontSize ?? 16}`, "-t", "scrollback=10000", "-t", 'theme={"background":"#0b0f19"}', "bash", "--rcfile", rc, "-i"],
        { stdio: "ignore", env: operatorEnv() }, // the terminal is an interactive bash: no `spf sync` credentials (#33)
      );
      await waitForHttp(url, 10_000);

      ab(["set", "viewport", String(width), String(height)], "set viewport");
      ab(["open", url], "open terminal");
      ab(["wait", "1500"], "wait");
      ab(["record", "start", files.source], "record start");
      recording = true;
      ab(["click", ".xterm-screen"], "focus terminal");
      if (opts.title) {
        sendText(ab, `# ${opts.title}`, "title");
        ab(["press", "Enter"], "press Enter");
        ab(["wait", "800"], "wait");
      }
      for (const step of steps) {
        // Each journey runs in a subshell: under `bash -c` (how the checks run
        // it) an `exit` or `cd` only affects that journey, but typed into the
        // recorded INTERACTIVE shell an `exit` closed the terminal and every
        // later command went nowhere — found re-proving the #179 pilot PR,
        // whose planner wrote `…; exit $exit_code`.
        const readBack = () => {
          let cursor = evalJson<{ row: number; line: string }>(ab, CURSOR_JS, "read prompt line");
          // Poll, don't read once: the paste returns when the text is SENT,
          // but the echo still travels browser -> ttyd -> bash -> websocket
          // -> xterm; under load a single read came back empty (#179 pilot).
          for (let tries = 0; !cursor.line.includes(step.command) && tries < ECHO_POLL_TRIES; tries++) {
            ab(["wait", String(ECHO_POLL_MS)], "wait for echo");
            cursor = evalJson<{ row: number; line: string }>(ab, CURSOR_JS, "read prompt line");
          }
          return cursor;
        };
        // Proof the terminal received THIS command, read back before Enter.
        // The dogfood run recorded 30 s of a disconnected terminal and every
        // file check passed, so a video alone is not evidence. On a mismatch:
        // Ctrl-U clears the line and the paste is retried once.
        sendText(ab, `( ${step.command} )`, "command");
        let cursor = readBack();
        if (!cursor.line.includes(step.command)) {
          ab(["press", "Control+u"], "clear line");
          ab(["wait", "300"], "wait");
          sendText(ab, `( ${step.command} )`, "command (retry)");
          cursor = readBack();
        }
        if (!cursor.line.includes(step.command)) {
          throw new Error(`the terminal did not receive \`${step.command}\` (prompt line read back: ${JSON.stringify(cursor.line.slice(-160))})`);
        }
        ab(["press", "Enter"], "press Enter");
        ab(["wait", String(step.wait_ms)], "wait", step.wait_ms + 30_000);
        const output = evalJson<{ cleared: boolean; text: string }>(ab, outputSinceJs(cursor.row, step.command), "read output");
        const note = output.cleared ? "[the program cleared the terminal; this is what it left on screen]\n" : "";
        sections.push(`$ ${step.command}\n${note}${output.text}`);
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
