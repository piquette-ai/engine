---
name: Super Portable Software Factory (SPF)
description: Timetable visuals, plain words — runs read like a printed schedule in light and a departure board in dark.
colors:
  # paper scale (light theme)
  paper-cream: "#f6f3ec"
  paper-raised: "#fcfaf4"
  paper-sunk: "#ede8db"
  paper-stripe: "#f1eee4"
  ink: "#211e14"
  ink-dim: "#5f5948"
  ink-faint: "#76705e"
  paper-rule: "#d8d2c0"
  paper-rule-soft: "#e6e1d0"
  # board scale (dark theme)
  board-black: "#141311"
  board-raised: "#1e1c17"
  board-sunk: "#0c0b09"
  board-stripe: "#1a1915"
  bone: "#efe8d4"
  bone-dim: "#96907c"
  bone-faint: "#857f6a"
  board-rule: "#37342b"
  board-rule-soft: "#2a2820"
  # accents — paper: red wayfinding + ballpoint live; board: amber (they do not mix)
  timetable-red: "#da291c"
  ballpoint: "#2545a8"
  board-amber: "#e8b64a"
  # signals — print-ink variants on paper, bright originals on the board
  pass-paper: "#1e7a3c"
  fail-paper: "#b3261e"
  pass-board: "#4ade80"
  fail-board: "#ff6f67"
typography:
  display:
    fontFamily: "Overpass, system-ui, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "20px"
    fontWeight: 700
    lineHeight: 1.2
  headline:
    fontFamily: "Overpass, system-ui, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "17px"
    fontWeight: 700
    lineHeight: 1.3
  body:
    fontFamily: "Overpass, system-ui, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Overpass, system-ui, 'Helvetica Neue', Arial, sans-serif"
    fontSize: "16px"
    fontWeight: 600
    letterSpacing: "0.06em"
  data:
    fontFamily: "'Overpass Mono', ui-monospace, 'SF Mono', Menlo, Consolas, monospace"
    fontSize: "16px"
    fontWeight: 400
    fontFeature: "'tnum'"
rounded:
  cell: "2px"
spacing:
  sm: "8px"
  md: "16px"
  lg: "28px"
  gutter: "28px"
  gutter-narrow: "16px"
  page-max: "1720px"
  # literal values (hard-coded in components, no custom property yet): reading-column, sidebar, touch-target, gutter-narrow
  reading-column: "820px"
  sidebar: "320px"
  touch-target: "44px"
components:
  status-cell:
    textColor: "{colors.board-amber}"
    rounded: "{rounded.cell}"
    padding: "3px 10px"
  tag-stub:
    textColor: "{colors.bone}"
    rounded: "{rounded.cell}"
    padding: "2px 10px"
  phase-bay:
    textColor: "{colors.bone}"
    rounded: "{rounded.cell}"
    padding: "10px 12px"
---

# Design System: Super Portable Software Factory (SPF)

## Overview

**Creative North Star: "The Timetable."**

SPF keeps the *look* of railway operations and drops its *words*. The visual language is the timetable: Overpass and Overpass Mono, warm paper and near-black board tokens, hairline rules, 2px cells, and a split-flap on state change. The vocabulary is plain: the app speaks about **runs**, **chains**, **phases** and **steps**, never departures, services, tracks or "ADW".

The information architecture borrows from the tools engineers already read fluently:

- **Linear** — the Runs list: dense one-line rows, grouped by what needs a human, keyboard triage (`j`/`k`/`Enter`/`e`), a side peek instead of a page change.
- **GitHub Actions** — the run page: a summary, a step list with a duration bar per step, annotations on the failing step, a checks block.
- **Stripe** — the run header and sidebar: title, status, one meta line, a key-value sidebar that prints `—` for every missing value.
- **Apple** — one focal point per page, and colour only for exceptions.
- **Every.to** — the receipt: a centred editorial reading column.

The retired system (deep-space navy, gradients, neon glow, glass blur) stays this system's anti-reference. Product truth is load-bearing: the trace is the trust mechanism ("agent proposes, code disposes" made legible), the UI is read-only except archiving a run (mark reviewed), nothing is fabricated (a missing value is `—`, a missing recording says so), and cold-start copy tells a first-time reader what to do next.

**Key Characteristics:**
- One theme switch, two palettes: paper (light) and board (dark) share every component; only semantic tokens change.
- Depth from hairline rules and tabular alignment; no shadows, no glow, no blur, no gradients.
- Colour is exception: green/red are verdicts, the live accent is "in flight", everything else is ink or bone.
- The board flips on state change; nothing else moves.

## Vocabulary

Visuals stay in the world; words leave it.

| Say | Never |
| --- | --- |
| Runs, a run | departures, services, trains |
| Started (clock) | departed |
| Chain (the named sequence of phases a run executed) | service, line |
| Phases, steps (the phase list) | tracks, bays (in copy) |
| Timeline (the lane view of phases) | departure board (in copy) |
| Needs review, Running, day groups (Today, Yesterday, dates) | on time, delayed |
| the run id (`a1b2c3d4`) | ADW, adw_id (in any visible text; it remains the route/API key) |

Class names and code may keep railway-era identifiers; **rendered text, labels, titles and `aria-label`s may not.** Mock fixtures and empty states follow the same rule.

## Colors

Two restrained neutral scales, one accent family per theme, and a quarantined pair of signal hues. Colour that is not signal or wayfinding does not exist here.

### Primary
- **Timetable Red** (#da291c): paper wayfinding only — the middle stripe of the mark, focus rings (the archive action's hover border and glyph are the one explicit exception). Thin, never a fill. **Red is reserved for failure and wayfinding; it never marks selection, running or progress.**
- **Ballpoint** (#2545a8): the live accent in light theme — running status, the `live` marker, running step bars, links. 7.6:1 on paper-cream.
- **Board Amber** (#e8b64a): the live accent in dark theme — same jobs as ballpoint, 10:1 on board-black.

### Neutral
- **Paper Cream** (#f6f3ec) / **Paper Raised** (#fcfaf4) / **Paper Sunk** (#ede8db) / **Paper Stripe** (#f1eee4): ground, hover face, wells, alternate list rows (board: #1a1915).
- **Ink** (#211e14) / **Ink Dim** (#5f5948, 6.2:1) / **Ink Faint** (#76705e, ~4.5:1 — the meta-text floor).
- **Paper Rule** (#d8d2c0) / **Paper Rule Soft** (#e6e1d0): hairlines.
- **Board Black** (#141311) / **Board Raised** (#1e1c17) / **Board Sunk** (#0c0b09): dark ground, face, wells.
- **Bone** (#efe8d4, 15:1) / **Bone Dim** (#96907c, 6.1:1) / **Bone Faint** (#857f6a, ~4.9:1).
- **Board Rule** (#37342b) / **Board Rule Soft** (#2a2820): dark hairlines.

### Signal
- **Pass Green** (#1e7a3c light / #4ade80 dark) and **Fail Red** (#b3261e light / #ff6f67 dark): a recorded success or failure. Never decoration, never softened.

### Semantic tokens
Components bind only to `--ground --face --inset --fg --dim --faint --rule --rule-soft --accent --live --pass --fail`. `body` defines the paper values; `body.board` swaps them for the board. The class is set by the global Light / Dark / System control in the masthead settings menu (`lib/theme.ts`, mirrored by a pre-mount script in `app/index.html`).

| Token | Light (paper) | Dark (board) |
| --- | --- | --- |
| `--accent` (focus ring, wayfinding, hover) | timetable red | board amber |
| `--live` (running, live, links in the trace) | ballpoint | board amber |
| `--pass` / `--fail` | print-ink variants | bright variants |

### Named Rules
**The Resolved Theming Rule.** There is no longer a paper list and a board trace: one global toggle themes every route. In light theme the trace, run page and receipt take **ballpoint** (`--live`) for everything in flight and keep **red** exclusively for failure and focus/wayfinding; in dark theme amber does both live jobs. So a red element anywhere inside a run is a failure, a blue/amber one is in flight, and a selection is neither (see below).

**The Color Is Signal Rule.** Outside the live accent, hue only ever means data state — green passed, red failed. Event types, agents and lanes get no colours; they get names, numbers and words. Only exceptions are coloured: in the Runs list a succeeded run is plain ink; failed (red), recovered (a quiet glyph), and running (live accent) are the only tinted rows.

**The Ink Selection Rule.** Selection is marked in ink — an inset rule and the sunk ground — never in an accent.

## Typography

**Body & Display Font:** Overpass (system-ui → Helvetica Neue → Arial)
**Data Font:** Overpass Mono (ui-monospace → SF Mono → Menlo → Consolas)
Both self-hosted, latin woff2, weights 400/600/700 (mono: 400/700).

### Hierarchy
- **Display** (700, 24px on desktop, 20px at ≤640px, 1.2): page titles — "Runs", the run's request as the page title, a phase name in the peek.
- **Receipt headline** (700, 28px, 22px under 560px): used only for the receipt's verdict sentence — that page's single focal point. Do not reuse it.
- **Headline** (700, 17px): panel and step titles.
- **Body** (400, 16px, 1.5): everything read — request titles in rows, descriptions, section copy.
- **Label** (600, 16px, tracked 0.06em): group heads (lowercase on the list), sidebar keys, column heads.
- **Data** (Overpass Mono 400/700, 16px, `tnum`): run ids, clocks, durations, costs, tokens, commit shas, code. Right-aligned in numeric columns; 700 only for identity (the run id).

### Named Rules
**The Data Voice Rule.** Mono is for code, data, and measurement — never prose or buttons' body copy.

**The Floor Is Sixteen Rule.** Nothing renders below 16px. Density comes from hairlines, alignment and tabular numerals — never from smaller type.

## Layout

**Page container and gutter.** Every route (list, run, receipt, masthead) sits in one container: `.page` = `max-width: var(--page-max)` (1720px, wide enough that the list's viewport-keyed folds never see less room than they were tuned for), centred, inset by `--gutter` (28px; 16px at ≤980px). `.page-flush` drops the inset for roots whose children carry their own. Pages never invent their own max-width or side padding; the receipt narrows *inside* the container to a 820px reading column.

**Masthead.** Sticky: the station-code mark, wordmark › repo › run id › phase crumbs, the `live` indicator (shown only while data is fresh), and a settings menu (theme). At ≤640px it stays one row; the wordmark gives way first, then the repo; the run id is the last crumb to shrink (it truncates only when a phase crumb follows), and crumb links keep a 44px hit area.

**Runs list (the Linear row).** A title (Display "Runs") with a count, a search field, and a Status filter menu (plus repo/factory filters in hosted mode). Rows are grouped: **Needs review** (failed and recovered runs; always open), **Running** (always open), then one group per day (collapsible, newest first). A group head is a lowercase tracked label with a count.

Row anatomy, one line of primary text and one muted line:
1. a status glyph (22px column) — the only colour in the row besides the note;
2. the request as plain text, one line, truncated (`plainRequest` strips markdown);
3. a muted line: the **note** (only for exceptions — "failed at test", "recovered after build failed", "build 2/3"), the run id, chain name and a short phase strip (`PhaseDots`, max 4);
4. right-aligned data: started clock and runtime (84px column), then cost, then a 76px action cell holding the "peek" icon (`Space`) and the "mark reviewed" icon (`e`).
Whole row is the link. Alternate rows carry `--stripe`, a tint halfway between ground and the hover fill, with parity counted from each group's oldest row so a run arriving on top never flips the stripes under it (running rows keep their raised face instead). Hover and the keyboard cursor take `--inset`, one clear step past the stripe in both themes, and the cursor adds an inset ink ring; the action icons are faint until the row is hot and always keyboard-reachable. Under 640px the muted line shortens, the peek icon goes (a tap opens the run) and the action cell is one 44px icon. Keyboard: `j`/`k` move, `Enter` opens, `Space` peeks, `e` marks reviewed, `u` undoes, `/` searches, `?` lists keys, `Esc` closes the peek, then clears.

**Run peek.** `Space` on the cursor row (or its peek icon) opens the run in the shared peek drawer (`PeekDrawer`) without leaving the list: the first line of the request as the title, the status and meta line, "Open run" and "Mark reviewed" actions, the Failed / Recovered band (`RunBand`) and the Verified band (`SessionVerification`, compact: no poster), a Duration / Cost / Tokens strip, and the step list (`PhaseSteps`, compact: glyph, name, bar, duration). While it is open `j`/`k` move the cursor and the drawer follows, `e` marks reviewed and the cursor (and drawer) advance with the undo toast, `Space` or `Esc` closes it and focus returns to the row. It reads the row the list already polls; only a failed run's gate record is fetched, once per settled state, from a small cache, so a closed peek leaves nothing polling. On ≥1280px the list reflows beside it; under 640px it is full-screen with a 44px close cell.

**Run detail (Stripe header + GitHub Actions body).**
- *Header:* the request is the title (two lines, disclosure for the full text); one meta line — status word, chain, who, started, duration, issue — separated by `·`; an attention callout ("Failed at test", with an "Open test" action) only when a run failed.
- *Grid:* a main column and a 320px key-value sidebar (`Details` card: repository, chain, run id, who, started, ended, cost, tokens …, `—` for anything unrecorded; an on-device Assistant card when available). Below 1100px the sidebar drops under the main column.
- *Verdict band:* when the run recorded a receipt, the main column opens on it — the page's one focal point, a full-width cell summarising the recorded verification (verdict sentence, evidence, and a link to play the recording).
- *Phases:* the **Steps** list (default) is a GitHub-style step list: status glyph, name, who ran it, a duration bar on one shared axis, the duration; a failed step carries its annotation inline. The **Timeline** tab shows the same phases as lane rows (track number, name, model, context meter) against a shared time axis; bays shift laterally and never overlap. The request phase is left out of both (a link under the list opens it).
- *Peek drawer:* selecting a step opens the phase in a drawer from the right that starts under the sticky masthead (width `clamp(420px, 40vw, 640px)`; full width on phones). On ≥1280px the run reflows beside it with the sidebar under the steps, so `j`/`k` can step phases without losing the list; `Esc` or Back closes it. The phase id rides in the URL, so a peek is a link. Sections inside (Gates, Outputs, Events) are hairline-headed; Gates and Outputs collapse, Events is always open.

**Receipt (Every.to reading column).** A single 820px column centred in the page container: verdict banner (Receipt headline + mark + one sub line) → a facts list (repo, run, chain, issue, commit with copy, tree) → the before/after table → the recording figure → collapsible sections (Contact sheet, Transcript, Checks). One focal point (the verdict); no sidebar; prose and tables share one measure.

**Responsive.** ≥1100px full grid; ≤1100px detail sidebar stacks; ≤980px gutter narrows to 16px and list rows fold to the stacked form; ≤640px the masthead is one row, targets reach 44px (`min-height: 44px` on buttons, inputs, toggles, 44×44 on icon buttons), and **the page never scrolls sideways** — a wide Timeline pans inside its own container (`overflow-x: auto`, 700px floor) rather than widening the document.

### Named Rules
**The Request Is the Origin Rule.** Every run begins with what the human asked; the request is the title of the run and the first step is left out of the lists so nothing competes with the ask.

**The Panning Container Rule.** A wide figure (timeline, tables) scrolls inside its own bordered container. The document width is never a function of content.

**The Number Names, Not Amputates Rule.** A column wide enough for its identity — or it wraps; ellipsis is reserved for unbounded text (requests, descriptions, long repo slugs).

**The Missing Value Rule.** A missing value prints `—`. Never a blank, a `0`, or an invented default.

## Elevation & Depth

No shadows at all — no ambient, no hover, no glow, no blur. Depth is hairline structure and tonal layering: ground, raised face, sunk inset, soft rule, hard rule. State adds a 2px outline or a signal border, never a lift. The one motion the system owns: a status change flips like a split-flap (280ms rotateX settle), and the live lamp pulses in dark. `prefers-reduced-motion` removes every animation.

### Named Rules
**The Hairline Rule.** Structure is 1px rules, 1px gaps, weight and alignment — nothing else.

## Shapes

Everything is a printed cell: corners at 2px, borders at 1px. No pills, no cards-with-radius, no blobs. The only round forms are the live lamp and glyphs (type, not shapes).

## Components

### Buttons
No filled primary; actions are typographic or a single glyph — never both.
- **Action words** (Open test, Steps/Timeline toggle, close): data-voice or plain, 1px rule border or none, accent border on hover/focus. The Steps/Timeline control is a squared two-cell segmented control; the selected cell inverts to `--fg` on `--ground`.
- **Action icons** (mark reviewed, settings, close, copy): a bare Lucide glyph, faint at rest, hairline border + fg on hover. 44×44 on phone.
- **Menus** (Status filter, settings): a square hairline cell, label faint, value in ink; the popover is a hairline panel — no shadow.
- **Disabled/loading:** an inline "api unreachable — retrying" bar in the fail signal; no spinner theater.

### Status glyph and word
`StatusGlyph` draws a phase or run status as one mark: check (pass), x (fail), circle-dot (running, live accent, pulses in dark only), circle (queued), rotate (recovered). The status *word* beside it — "Failed", "Running", "Succeeded" — is set in the same signal ink. On state change the label remounts and plays the split-flap settle. A flap never overlays neighbouring text: it sits in its own cell and the runtime stat keeps its own column.

### Chips — stat cells
Hairline-bordered square cell: a faint Lucide line icon plus a tabular mono value; `compact` drops the border. No emoji or unicode glyphs as icons.

### Run row
See Layout. Hover is one tonal step; focus (keyboard cursor) is an inset rule in ink; running rows carry a live-accent glyph; failed rows tint only the note.

### Group head
A lowercase tracked label, a count in faint, a chevron on collapsible day groups; "Needs review" tints only its count (fail ink).

### Step row
Glyph · name · who · duration bar · duration. The bar is a 2px-tall rule on a shared axis, ink-dim for done, `--live` for running, `--fail` for failed; the annotation of a failed step sits under it in the fail ink.

### Timeline lane
Track number, line icon, lane name (700), model, a 6px context meter (live accent only while running). Phase bays are squared 2px cells: running takes the live border, failed the fail border, queued is dashed; selection is an ink inset rule.

### Verdict band / banner
A full-width hairline cell: mark, one headline sentence, one muted sub line, a reason line when the verdict is not a pass. The pass mark is green; fail is red; nothing else is tinted.

### Key-value sidebar
A `dl` in a hairline card: faint key, ink value, `—` for missing; values wrap or truncate with a title, never overflow.

### Peek drawer
`PeekDrawer`, shared by the phase peek and the run peek: fixed right panel under the masthead, `--ground` with a 1px left rule; heading focus on open; a 44px close cell top-right; full width under 640px.

### Detail section
Collapsible hairline header with a chevron, Lucide icon, label and count; closed by default.

### Tag stub, gate row
Unchanged: a square bordered cell with a faint key and an ink value; a gate is an inset cell whose failing state takes the 1px fail border with violations in the fail ink.

## Do's and Don'ts

### Do:
- **Do** use plain words for everything rendered: runs, chain, started, phases, steps.
- **Do** bind components to semantic tokens only; `body.board` swaps the whole palette.
- **Do** keep red for failure and focus, and the live accent (ballpoint / amber) for in-flight state.
- **Do** colour only exceptions; a succeeded run reads as plain ink.
- **Do** print `—` for anything unrecorded, and give empty states a next step ("No runs yet. Start one with `spf watch`…").
- **Do** right-align numbers, keep them tabular and in the data voice.
- **Do** let wide figures pan inside their container, and test every route at 390px for page-level overflow (`document.documentElement.scrollWidth <= clientWidth`).
- **Do** give every interactive element a 44px target on phone glass, growing the hit area (padding, negative margin) rather than the visible mark.
- **Do** theme the browser surfaces: selection, scrollbars, focus rings, caret.
- **Do** let whitelabel brands retheme only through `--accent/--live/--ground/--face/--fg/--rule` (hex only, see docs/cloud.md); `--pass/--fail` are never brandable.

### Don't:
- **Don't** add shadows, glow, gradients, blur or translucent overlays.
- **Don't** write railway vocabulary (departures, service, track, ADW) into any rendered text.
- **Don't** mark selection, running or progress in red.
- **Don't** assign colours to agents, event types, chains or lanes.
- **Don't** set text below 16px, use mono for prose, or reach for pills and large radii.
- **Don't** fabricate data to fill a layout hole, or let a page's own max-width/gutter drift from `.page`.
- **Don't** put a transient overlay (split-flap, toast) over text another stat needs.
