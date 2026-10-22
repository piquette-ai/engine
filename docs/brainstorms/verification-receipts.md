# Brainstorm: verification receipts (video proof that work is done)

**Date:** 2026-10-20 · **Status:** proposed, not built · **Builds on:** [decision-layer-use-cases.md](decision-layer-use-cases.md) (rank 10, acceptance gate), [jev-in-the-factory.md](jev-in-the-factory.md), the `decisions:` layer ([docs/decisions.md](../decisions.md), #150)

## Problem

spf checks an agent's *claims* (gates), whether the code is green (quality suites), and what a reviewer and a human think. It never watches the running app do the thing the issue asked for, and it keeps no record that ties such an observation to an exact revision. A run can pass every gate while the feature is still broken in the browser, and the person signing off sees only findings text.

**Outcome wanted:** every run ends with a *receipt*: a verdict, the checks behind it, and video evidence of the change working, bound to the revision it proves. Verification also happens throughout the run, not only once at the end.

## Sources

| Source | What it adds |
|---|---|
| [workos/beyond-done](https://github.com/workos/beyond-done) ([slides](https://talks.workos.cloud/beyond-done/slides/#/1)) | The loop *observe → fix → prove*. A **lever** (a project CLI that drives the real app over CDP and prints JSON). A **receipt** bound to one revision, with PASS / FAIL / **can't tell** (exit 2). Red-before-green: a proof has to fail on the broken app. A narrow semantic judge (Jev `noul`, accept ≥ 0.9, fail ≤ 0.2, otherwise ask a human) for claims that aren't assertions. Stop after the same failure twice and hand a human the receipt. Its decision-model appendix maps Jev, Cloudflare Clef and OpenAI Decisions as interchangeable *roles*, not vendors. |
| AI Labs, "Vercel's CEO … AI coding workflow" ([video](https://www.youtube.com/watch?v=y2ifUC9_zuU)) + `~/Downloads/_ailabs/vercel-ceo` | `/direction` (drift from the plan), **breaker** (adversarial stress on a copy of the data), **first-timer** (a blind browser user, kept blind by a hook), **pathrunner** (critical-path browser suite with timings, "error-free sessions" as the metric), MUST NOT TRADE OFF rules that each come with a check. |
| `~/Downloads/_ailabs/jev-use-cases` | Jev as a judge of spec coverage, a Playwright browser check where Jev picks the next click, a rule enforcer with block/warn thresholds. Already mapped in decision-layer-use-cases.md. |

## Principles (from the sources, held to spf's rule)

1. **Agent proposes, code disposes, and evidence decides.** A worker's prose never satisfies a check. Observation is deterministic code (the lever), not a model.
2. **Three verdicts, not two.** Missing evidence, a stale receipt, a judge outage or a timeout is **CANT_TELL**, and CANT_TELL never becomes a pass.
3. **Hard checks before meaning checks.** Code asserts state. A decision model only judges meaning (copy, screenshots) against a rubric, and a high score never overrides a failed hard check. Judge kinds live in the `decisions:` layer and keep its invariants (from #102): off by default, closed option sets, deterministic fallback, shadow before act, add-rejection only.
4. **A receipt belongs to one revision.** Any later commit makes it stale.
5. **Keep every attempt.** Failed receipts are labeled eval cases for tuning thresholds (decision-layer rank 1, the outcome join).

## The receipt

```
receipt.json
  run_id, attempt, repo, issue, pr
  revision: { sha, dirty_hash }
  verdict: PASS | FAIL | CANT_TELL, reason, next[]
  journeys[]: { id, criterion, steps[]: { name, ms } }
  checks[]: { name, expected, actual, pass }                  # hard, in code
  judgments[]: { kind, model, model_version, rubric_version, question, p_yes, threshold }
  observations: { console_errors[], page_errors[], http_5xx[], har_summary }
  evidence: { video, poster, screenshots[], trace, har }      # store keys + sha256
```

## Verification through the run

| Phase | New check | Decision model? |
|---|---|---|
| Intake | Acceptance criteria must be observable from outside. Derive a **feature map**: journeys P01…, the contract, known ways it "lies" | Extend `intake_readiness` |
| Plan | The planner emits a `verification` block (journeys, hard checks, meaning questions, evidence kind). Gate: every criterion maps to at least one check | New `evidence_tier` choice: none / terminal / browser / both. Fallback is a changed-path rule |
| Before the fix | **Red-before-green**: the proof runs on the base revision and must FAIL (or CANT_TELL for a new feature) | No |
| Build / test | Quality suite, then `prove`: fresh browser session, journeys run with recording on, receipt written | Judge copy and screenshots against the contract (shadow first) |
| Review | Reviewer gets the receipt and video. `verdictConsistent` gains: `approved` requires a PASS receipt at HEAD | No new kind |
| Revise | New revision means re-prove. Same failure after 2 fixes goes to a human | `loop_control` (exists) |
| Sign-off | The human watches the video instead of reading findings | Human |
| PR | Receipt table + link to the receipt page; `spf/verify` check run | No |

Later, for releases or epics rather than every PR: first-timer (blind), breaker (adversarial, on a data copy), `/direction` (drift).

## Capture tooling

- **agent-browser** (0.27, installed): `record start/stop` (WebM), `trace`, `har`, `console`, `snapshot`, `screenshot --annotate`, `diff screenshot --baseline`. Covers every web instrument the lever needs, with no Playwright dependency in spf.
- **Console journeys go through agent-browser too**, driving a localhost-only `ttyd` web terminal (`keyboard type`, `press Enter`, `record`). One recorder for web and console. VHS was the first plan and was dropped in the dry run (below).
- **ffmpeg** (installed): WebM → MP4 (H.264, plays inline in browsers) and a GIF poster.

### Dry run, 2026-10-20 (console, spf's own CLI)

A throwaway harness (not committed) ran four console journeys against `spf` at `ad0f387`: P01 `version` matches package.json, P02 `list` shows the core chains, P03 `doctor --json` is well-formed, P04 an unknown chain exits non-zero. It wrote a revision-bound `receipt.json` into the local store layout above, and attached an agent-browser recording of the same journeys.

| Case | Verdict / exit | What it showed |
|---|---|---|
| Real spf + video | PASS / 0 | 10 checks, 29.5 s H.264 1200×680 MP4 + GIF poster, every file sha256'd. `doctor` reported `ok: false` (no `GITHUB_TOKEN`), recorded as an *observation*, not the proof's verdict. |
| Regressed binary (wrong version, `build` dropped) | FAIL / 1 | `next[]` named both failures with expected vs actual. The checks can tell broken from fixed. |
| Missing binary | CANT_TELL / 2 | Never a pass. |
| First VHS attempt | CANT_TELL / 2 | A failed recording correctly downgraded the receipt instead of passing without evidence. |

Findings:
- **VHS is not viable here.** In the sandbox its ttyd connection was refused. Outside the sandbox it exited 0 but captured 0 frames and wrote no files (ffmpeg 9.0.1, VHS 0.12.0). The recorder must verify its own output exists and has frames; exit 0 is not evidence.
- **Recording needs localhost.** ttyd and the browser talk over 127.0.0.1, so a sandboxed runner needs a loopback allowance (relevant to the sandbox egress config).
- **Evidence-quality check:** a frame-at-a-timestamp spot check landed on a blank prompt; a contact sheet (one frame per 3 s) showed the session was fine. The lever should emit a contact sheet as evidence alongside the video.
- **The video found what assertions missed:** `spf <unknown-chain>` prints the entire usage text, so the actual error scrolls off-screen. P04 passed (non-zero exit), but a human watching sees bad UX. This is the screenshot/judge layer's job.
- Not `ce-demo-reel`'s default upload: it posts to a public third-party host, which is wrong for private repos.

## Storage: S3-compatible, AWS or Cloudflare

One client (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`) covers AWS S3, Cloudflare R2, MinIO and other S3-compatible stores. Only the endpoint and credentials change. The config mirrors `observability.db`'s variant (sqlite vs d1).

```yaml
receipts:
  store:
    kind: local                 # default; no cloud, used by tests
    path: .spf/receipts

# Cloudflare R2
receipts:
  store:
    kind: s3
    bucket: spf-receipts
    endpoint: https://<account_id>.r2.cloudflarestorage.com
    region: auto
    access_key_id_env: R2_ACCESS_KEY_ID
    secret_access_key_env: R2_SECRET_ACCESS_KEY
  viewer_url: https://receipts.example.com

# AWS S3
receipts:
  store:
    kind: s3
    bucket: spf-receipts
    region: us-east-1           # no endpoint means AWS
    access_key_id_env: AWS_ACCESS_KEY_ID      # unset both to use the AWS default chain
    secret_access_key_env: AWS_SECRET_ACCESS_KEY
```

```ts
interface ReceiptStore {
  put(key: string, body: Buffer | Readable, contentType: string): Promise<{ key: string; bytes: number; sha256: string }>;
  get(key: string): Promise<Buffer | null>;
  signedUrl(key: string, ttlSeconds: number): Promise<string>;
  list(prefix: string): Promise<string[]>;
  promote(runId: string): Promise<void>;   // attempts/ → kept/
}
```

- `LocalReceiptStore` (default) and `S3ReceiptStore` (AWS and R2). R2 uses `region: "auto"`. Verify during the build whether R2 still needs `requestChecksumCalculation: "WHEN_REQUIRED"` with current AWS SDK versions.
- `spf doctor` writes, reads and deletes a probe object.
- **Keys:** `<prefix>/<repo>/attempts/<run_id>/<attempt>/…`, copied to `kept/<run_id>/…` on merge. Objects are never overwritten, and `receipt.json` records each file's sha256.
- **Retention:** prefix lifecycle rules (both providers support them): `attempts/` expires after 90 days, `kept/` never.
- **Links:** SigV4 presigned URLs last at most 7 days, so a PR links to `viewer_url/r/<run_id>`, a page that presigns 5-minute URLs on every view. Host it as a Worker behind Cloudflare Access, CloudFront + Lambda on AWS, or the spf dashboard locally. Without a viewer, the PR gets a 7-day presigned link marked as expiring.
- **GitHub can't render private media inline** (it proxies images anonymously). V1 posts a link. A redacted GIF poster on an orphan branch is an option if reviewers miss it.

## Epic slices (stacked)

1. **Receipt store**: `ReceiptStore`, local + S3 backends, config schema, doctor probe, MinIO integration test.
2. **Receipt schema + revision binding**: `receipt.json` types, staleness check, CANT_TELL semantics, trace-db row.
3. **Lever + recording**: an agent-browser driver (journeys, console, HAR, video), a VHS driver for CLIs, ffmpeg transcoding, upload to the store.
4. **Feature map + plan `verification` block**: intake and plan changes, and the criterion → check coverage gate.
5. **Red-before-green + commit gate**: base-revision proof, `verdictConsistent` requires a PASS receipt at HEAD, re-prove after revise.
6. **PR surface + viewer**: receipt table and link in the PR comment, `spf/verify` check run, the viewer page.
7. **Judge kinds (shadow)**: `evidence_tier` and contract judging over copy and screenshots, through the `decisions:` layer (#150): a `systemone` model such as hosted Jev or Nimble on Ollama, or Clef.
8. **Release-level agents**: first-timer, breaker, `/direction`.

## Open questions

- Which app gets the first lever: spf's web UI or a Briefs app?
- Judge backend for slice 7: which `decisions.systemone` model — hosted Jev (`noul` + images), Nimble on Ollama (per-criterion `choice`, no `noul`), or Clef on Workers AI?
- Viewer host: a Worker behind Access, or the spf dashboard?
- Redaction: secrets and PII must stay out of recorded frames. Plan pages out of frame and scan before upload. Recapture rather than blur.
