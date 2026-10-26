/**
 * Journey evidence (#235): files a journey writes into `$PIQUETTE_EVIDENCE_DIR`
 * (recordings and screenshots of the real UI). Pure filesystem, no store.
 * Everything here is hostile input: the journey command is planner-authored,
 * so names, links, sizes and file kinds are all checked, and a rejected file
 * is only ever a `DroppedFile` note, never a check or a verdict input.
 *
 * What the checks do NOT give: a journey can already read and copy any file
 * its user can, so "inside the evidence directory" is hygiene (no surprises
 * from links, FIFOs, devices), not a sandbox. Do not capture secrets: kept
 * evidence is uploaded to the receipt store and linked from the PR.
 */

import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from "node:fs";
import path from "node:path";
import { EVIDENCE_CONTENT_TYPES, EVIDENCE_EXTENSIONS } from "./evidence_types.ts";

export { EVIDENCE_EXTENSIONS };

export const MAX_EVIDENCE_FILES_PER_JOURNEY = 50;
const MAX_DEPTH = 3;
/** Dropped notes kept per journey; the rest become one summary note, so a frame dump can't bloat receipt.json. */
export const MAX_DROPPED_NOTES_PER_JOURNEY = 20;
/** Directory entries looked at per journey; past this the walk stops and says so. */
const MAX_ENTRIES_PER_JOURNEY = 2000;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MB = 1024 * 1024;

export interface EvidenceLimits {
  maxFileBytes: number;
  maxTotalBytes: number;
  allowed: Set<string>;
}
export interface CollectedFile {
  journey: string;
  rel: string;
  abs: string;
  bytes: number;
  contentType: string;
  /** The journey's resolved evidence directory; when set, a read re-checks the file still resolves inside it. */
  root?: string;
}
export interface DroppedFile {
  journey: string;
  file: string;
  reason: string;
}

export interface EvidenceLimitsInput {
  max_file_mb?: number;
  max_total_mb?: number;
  allowed_types?: readonly string[];
}

export function evidenceLimits(cfg?: EvidenceLimitsInput): EvidenceLimits {
  return {
    maxFileBytes: Math.floor((cfg?.max_file_mb ?? 50) * MB),
    maxTotalBytes: Math.floor((cfg?.max_total_mb ?? 200) * MB),
    allowed: new Set((cfg?.allowed_types ?? EVIDENCE_EXTENSIONS).map((e) => e.toLowerCase())),
  };
}

const mbLabel = (bytes: number) => String(Math.round((bytes / MB) * 100) / 100);

export function collectJourneyEvidence(runs: { id: string; dir: string }[], limits: EvidenceLimits): { files: CollectedFile[]; dropped: DroppedFile[] } {
  const files: CollectedFile[] = [];
  const dropped: DroppedFile[] = [];
  let total = 0;

  for (const run of runs) {
    let root: string;
    try {
      root = realpathSync(run.dir);
    } catch {
      continue;
    }
    let notes = 0;
    let omitted = 0;
    const drop = (file: string, reason: string) => {
      if (notes < MAX_DROPPED_NOTES_PER_JOURNEY) {
        notes++;
        dropped.push({ journey: run.id, file, reason });
      } else omitted++;
    };
    let entries = 0;
    const found: { rel: string; abs: string; size: number; type: string }[] = [];

    const walk = (dir: string, rels: string[]) => {
      let names: string[];
      try {
        names = readdirSync(dir).sort();
      } catch {
        return;
      }
      for (const name of names) {
        if (++entries > MAX_ENTRIES_PER_JOURNEY) {
          if (entries === MAX_ENTRIES_PER_JOURNEY + 1) drop([...rels, name].join("/"), `more than ${MAX_ENTRIES_PER_JOURNEY} entries, the rest were not looked at`);
          return;
        }
        const rel = [...rels, name].join("/");
        const abs = path.join(dir, name);
        if (!SAFE_SEGMENT.test(name)) {
          drop(rel, "unsafe file name");
          continue;
        }
        let st;
        try {
          st = lstatSync(abs);
        } catch {
          continue;
        }
        if (st.isSymbolicLink()) {
          drop(rel, "symlink");
          continue;
        }
        if (st.isDirectory()) {
          if (rels.length >= MAX_DEPTH) drop(rel, `deeper than ${MAX_DEPTH} directories`);
          else walk(abs, [...rels, name]);
          continue;
        }
        if (!st.isFile()) {
          drop(rel, "not a regular file");
          continue;
        }
        if (st.nlink > 1) {
          drop(rel, "hard-linked file");
          continue;
        }
        const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
        const type = EVIDENCE_CONTENT_TYPES[ext];
        if (!type || !limits.allowed.has(ext)) {
          drop(rel, `file type ".${ext}" is not allowed (allowed: ${[...limits.allowed].join(", ")})`);
          continue;
        }
        let real: string;
        try {
          real = realpathSync(abs);
        } catch {
          continue;
        }
        if (!real.startsWith(root + path.sep)) {
          drop(rel, "outside the evidence directory");
          continue;
        }
        found.push({ rel, abs, size: st.size, type });
      }
    };
    walk(run.dir, []);

    let count = 0;
    for (const f of found) {
      if (count >= MAX_EVIDENCE_FILES_PER_JOURNEY) {
        drop(f.rel, `more than ${MAX_EVIDENCE_FILES_PER_JOURNEY} files for this journey`);
        continue;
      }
      if (f.size > limits.maxFileBytes) {
        drop(f.rel, `over the ${mbLabel(limits.maxFileBytes)} MB per-file cap (receipts.evidence.max_file_mb)`);
        continue;
      }
      if (total + f.size > limits.maxTotalBytes) {
        drop(f.rel, `over the ${mbLabel(limits.maxTotalBytes)} MB per-receipt cap (receipts.evidence.max_total_mb)`);
        continue;
      }
      total += f.size;
      count++;
      files.push({ journey: run.id, rel: f.rel, abs: f.abs, bytes: f.size, contentType: f.type, root });
    }
    if (omitted > 0) dropped.push({ journey: run.id, file: "…", reason: `and ${omitted} more not kept (notes capped at ${MAX_DROPPED_NOTES_PER_JOURNEY} per journey)` });
  }
  return { files, dropped };
}

/**
 * Read a collected file without following a link swapped in since the walk; at most `maxFileBytes` are read.
 * Throws if the file is no longer what the walk saw. O_NONBLOCK keeps a FIFO swapped in since the walk from
 * blocking the open forever (the fstat check below then rejects it); it does nothing for regular files.
 */
export function readEvidenceFile(file: CollectedFile, limits: EvidenceLimits): Buffer {
  const fd = openSync(file.abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error("not a regular file");
    if (st.nlink > 1) throw new Error("hard-linked file");
    if (file.root) {
      // O_NOFOLLOW only covers the last path component: a directory swapped for a symlink since the walk is caught here.
      const real = realpathSync(file.abs);
      if (!real.startsWith(file.root + path.sep)) throw new Error("outside the evidence directory");
    }
    if (st.size > limits.maxFileBytes) throw new Error("file grew past the per-file cap");
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    return buf.subarray(0, off);
  } finally {
    closeSync(fd);
  }
}
