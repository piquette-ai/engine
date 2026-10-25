import type { LoaderFigure } from './loader'

// Geometry for the brand loader: small isometric "factory line" figures, drawn
// with the iso-glow kernel (+x runs down-right, +y down-left, +z up). Built
// once at module load; the component only toggles classes on them.

const C = Math.cos(Math.PI / 6)
type V3 = readonly [number, number, number]
const P = ([x, y, z]: V3): [number, number] => [(x - y) * C, (x + y) / 2 - z]
const r1 = (n: number) => Math.round(n * 10) / 10
const pts = (...ps: V3[]) => ps.map((p) => P(p).map(r1).join(',')).join(' ')
const pathOf = (ps: V3[]) => 'M' + ps.map((p) => P(p).map(r1).join(' ')).join('L')

export interface Box {
  top: string
  front: string
  side: string
}

/** A box is its three visible faces: top, front (y = max) and side (x = max). */
function box(x: number, y: number, z: number, w: number, d: number, h: number): Box {
  return {
    top: pts([x, y, z + h], [x + w, y, z + h], [x + w, y + d, z + h], [x, y + d, z + h]),
    front: pts([x, y + d, z + h], [x + w, y + d, z + h], [x + w, y + d, z], [x, y + d, z]),
    side: pts([x + w, y, z + h], [x + w, y + d, z + h], [x + w, y + d, z], [x + w, y, z]),
  }
}

export interface Part {
  box: Box
  /** Index of the station this box is, or undefined for structure (plate, core). */
  station?: number
}

export interface Figure {
  viewBox: string
  /** Width / height of the viewBox, for the inline size. */
  aspect: number
  /** Painted back to front. */
  parts: Part[]
  /** Plate-top hairline inset. */
  inset: string
  /** The conveyor wire the pulse runs along (normalised with pathLength=1000). */
  wire: string
  /** Short feeds from the wire into each station. */
  stubs: string
  /** Where each station sits along the wire, 0–1 of its drawn length. */
  at: number[]
  /** conveyor/stack fill up and stay lit; relay lights one station at a time. */
  mode: 'fill' | 'relay'
  period: number
}

/** Fractions of 2D path length at the given vertex indices. */
function fractions(wire: V3[], idx: number[]): number[] {
  const cum = [0]
  for (let i = 1; i < wire.length; i++) {
    const [ax, ay] = P(wire[i - 1] as V3)
    const [bx, by] = P(wire[i] as V3)
    cum.push((cum[i - 1] as number) + Math.hypot(bx - ax, by - ay))
  }
  const total = cum[cum.length - 1] as number
  return idx.map((i) => (cum[i] as number) / total)
}

function frame(corners: V3[], pad = 10): { viewBox: string; aspect: number } {
  const xs: number[] = []
  const ys: number[] = []
  for (const c of corners) {
    const [x, y] = P(c)
    xs.push(x)
    ys.push(y)
  }
  const x0 = Math.min(...xs) - pad
  const y0 = Math.min(...ys) - pad
  const w = Math.max(...xs) + pad - x0
  const h = Math.max(...ys) + pad - y0
  return { viewBox: `${r1(x0)} ${r1(y0)} ${r1(w)} ${r1(h)}`, aspect: w / h }
}

/** A row of stations on a plate, the wire running along the front edge. */
function row(n: number, mode: Figure['mode'], period: number): Figure {
  const S = 28 // station footprint
  const H = 22 // station height
  const gap = n === 4 ? 24 : 34
  const len = 16 + n * S + (n - 1) * gap + 16
  const D = 64
  const wy = 54 // wire line, in front of the stations (their front face is y = 16 + S)
  const parts: Part[] = [{ box: box(0, 0, 0, len, D, 6) }]
  const centers: number[] = []
  for (let i = 0; i < n; i++) {
    const x = 16 + i * (S + gap)
    parts.push({ box: box(x, 16, 6, S, S, H), station: i })
    centers.push(x + S / 2)
  }
  const wire: V3[] = [[4, wy, 6], ...centers.map((cx) => [cx, wy, 6] as V3), [len - 4, wy, 6]]
  const stubs = centers.map((cx) => pathOf([[cx, wy, 6], [cx, 16 + S, 6]])).join('')
  return {
    ...frame([[0, 0, 0], [len, 0, 0], [0, D, 0], [len, D, 0], [16, 16, 6 + H], [len, 0, 6]]),
    parts,
    inset: pts([4, 4, 6], [len - 4, 4, 6], [len - 4, D - 4, 6], [4, D - 4, 6]),
    wire: pathOf(wire),
    stubs,
    at: fractions(wire, centers.map((_, i) => i + 1)),
    mode,
    period,
  }
}

/** Four slabs stacked like floors on a core, a riser climbing the front-right corner. */
function stack(): Figure {
  const n = 4
  const W = 50
  const SLAB = 10
  const STEP = 15
  const parts: Part[] = [{ box: box(0, 0, 0, 104, 90, 6) }]
  const zs: number[] = []
  for (let i = 0; i < n; i++) {
    const z = 6 + i * STEP
    parts.push({ box: box(18, 14, z, W, W, SLAB), station: i })
    if (i < n - 1) parts.push({ box: box(36, 32, z + SLAB, 14, 14, STEP - SLAB) })
    zs.push(z + SLAB / 2)
  }
  const top = 6 + (n - 1) * STEP + SLAB
  const rx = 80
  const ry = 76
  const wire: V3[] = [[100, ry, 6], [rx, ry, 6], ...zs.map((z) => [rx, ry, z] as V3), [rx, ry, top + 4]]
  const stubs = zs.map((z) => pathOf([[rx, ry, z], [18 + W, 14 + W, z]])).join('')
  return {
    ...frame([[0, 0, 0], [104, 0, 0], [0, 90, 0], [104, 90, 0], [18, 14, top], [rx, ry, top + 4]]),
    parts,
    inset: pts([4, 4, 6], [100, 4, 6], [100, 86, 6], [4, 86, 6]),
    wire: pathOf(wire),
    stubs,
    at: fractions(wire, zs.map((_, i) => i + 2)),
    mode: 'fill',
    period: 2600,
  }
}

export const FIGURES: Record<LoaderFigure, Figure> = {
  conveyor: row(4, 'fill', 2600),
  relay: row(3, 'relay', 2700),
  stack: stack(),
}

export interface FrameState {
  lit: boolean[]
  /** Pulse head position along the wire (0–1), or null when no pulse shows. */
  pulse: number | null
  /** Wire drawn hot from 0 to here (progress mode), or null. */
  hot: number | null
}

const TRAVEL = 0.78 // share of a fill loop the pulse spends travelling; the rest holds all lit

/** What the figure shows at loop phase t (0–1). */
export function frameAt(fig: Figure, t: number): FrameState {
  const n = fig.at.length
  if (fig.mode === 'fill') {
    const p = Math.min(t / TRAVEL, 1)
    return { lit: fig.at.map((a) => p >= a), pulse: t < TRAVEL ? p : null, hot: null }
  }
  // relay: hold on station k, then the light travels the wire to the next one
  const seg = t * n
  const k = Math.min(Math.floor(seg), n - 1)
  const u = seg - k
  const HOLD = 0.55
  if (u < HOLD) return { lit: fig.at.map((_, i) => i === k), pulse: null, hot: null }
  const from = fig.at[k] as number
  const to = fig.at[k + 1] ?? 1
  return { lit: fig.at.map(() => false), pulse: from + ((u - HOLD) / (1 - HOLD)) * (to - from), hot: null }
}

/** Real progress (0–100): stations light as the line reaches them; nothing loops. */
export function frameForProgress(fig: Figure, pct: number): FrameState {
  const p = Math.max(0, Math.min(100, pct)) / 100
  return { lit: fig.at.map((a) => p >= a - 0.001), pulse: null, hot: p }
}

export const allLit = (fig: Figure): FrameState => ({ lit: fig.at.map(() => true), pulse: null, hot: null })
export const noneLit = (fig: Figure): FrameState => ({ lit: fig.at.map(() => false), pulse: null, hot: null })
