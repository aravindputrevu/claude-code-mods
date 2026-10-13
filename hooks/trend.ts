import type { CardSpec, Row, Sort } from '../types'
import { WINDOW_MS } from './spec'

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** One reading of a list: story id to [rank, points, comments]. */
export type Snap = { at: number; pts: Record<string, [number, number, number]> }

export function snapOf(rows: readonly Row[], at: number): Snap {
  const pts: Snap['pts'] = {}
  for (const row of rows) pts[String(row.id)] = [row.rank ?? 0, row.points ?? 0, row.comments ?? 0]
  return { at, pts }
}

/** Adds a snapshot and drops the ones older than `keepMs`. */
export const addSnap = (list: readonly Snap[] | undefined, snap: Snap, keepMs: number): Snap[] =>
  [...(list ?? []), snap].filter(one => snap.at - one.at <= keepMs).sort((a, b) => a.at - b.at)

/** The snapshot to compare with: at least 10 minutes old, the nearest to one hour old. */
export function baseSnap(snaps: readonly Snap[], now: number): Snap | undefined {
  let best: Snap | undefined
  for (const snap of snaps) {
    if (now - snap.at < 10 * MINUTE) continue
    if (best === undefined || Math.abs(now - snap.at - HOUR) < Math.abs(now - best.at - HOUR)) best = snap
  }
  return best
}

/** Adds points per hour, rank movement, a new mark and a points history to each row. */
export function withTrend(rows: readonly Row[], snaps: readonly Snap[], now: number): Row[] {
  const base = baseSnap(snaps, now)
  const recent = snaps.slice(-8)
  return rows.map(row => {
    const key = String(row.id)
    const before = base?.pts[key]
    const spark = recent.map(snap => snap.pts[key]?.[1]).filter((n): n is number => n !== undefined)
    if (row.points !== undefined) spark.push(row.points)
    const next: Row = { ...row, ...(spark.length > 1 ? { spark } : {}) }
    if (base !== undefined && before !== undefined && row.points !== undefined) {
      next.velocity = (row.points - before[1]) / ((now - base.at) / HOUR)
      if (row.rank !== undefined && before[0] > 0) next.rankDelta = before[0] - row.rank
      return next
    }
    if (base !== undefined && before === undefined) next.isNew = true
    return withAverage(next, now)
  })
}

/** Points per hour since the post: the measure when there is no snapshot to compare with. */
export function withAverage(row: Row, now: number): Row {
  if (row.points === undefined || row.time === undefined) return row
  return { ...row, velocity: row.points / Math.max(1, (now - row.time) / HOUR) }
}

const termsOf = (query: string): RegExp[] =>
  query
    .split('|')
    .map(term => term.trim().toLowerCase())
    .filter(term => term !== '')
    .map(term => new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i'))

/** The card's filters: query terms (lists only), window (when `now` is given), minimum points and comments. */
export function filterRows(rows: readonly Row[], spec: CardSpec, now?: number): Row[] {
  const terms = spec.source === 'search' || spec.query === undefined ? [] : termsOf(spec.query)
  const oldest = now === undefined ? -Infinity : now - WINDOW_MS[spec.window]
  return rows.filter(row => {
    if (terms.length > 0 && !terms.some(t => t.test(row.title) || t.test(row.site ?? ''))) return false
    if (row.time !== undefined && row.time < oldest) return false
    if (spec.minPoints !== undefined && (row.points ?? 0) < spec.minPoints) return false
    if (spec.minComments !== undefined && (row.comments ?? 0) < spec.minComments) return false
    return true
  })
}

const KEY: Record<Sort, (row: Row) => number> = {
  velocity: row => row.velocity ?? -1,
  points: row => row.points ?? -1,
  comments: row => row.comments ?? -1,
  new: row => row.time ?? row.id,
}

export const sortRows = (rows: readonly Row[], sort: Sort): Row[] =>
  [...rows].sort((a, b) => KEY[sort](b) - KEY[sort](a))

/** Stories per bucket: seven equal buckets across the window, oldest first. */
export function bucketCounts(rows: readonly Row[], windowMs: number, now: number, buckets = 7): number[] {
  const counts = new Array<number>(buckets).fill(0)
  const size = windowMs / buckets
  for (const row of rows) {
    if (row.time === undefined) continue
    const age = now - row.time
    if (age < 0 || age >= windowMs) continue
    const slot = buckets - 1 - Math.floor(age / size)
    counts[slot] = (counts[slot] ?? 0) + 1
  }
  return counts
}

const BARS = '▁▂▃▄▅▆▇█'

export function sparkline(values: readonly number[]): string {
  if (values.length === 0) return ''
  const low = Math.min(...values)
  const high = Math.max(...values)
  return values
    .map(v => BARS[high === low ? 3 : Math.round(((v - low) / (high - low)) * (BARS.length - 1))] ?? BARS[0])
    .join('')
}

/** A rate as the pane writes it: `+180/h`. */
export const rate = (velocity: number | undefined): string =>
  velocity === undefined ? '' : `${velocity >= 0 ? '+' : ''}${Math.round(velocity)}/h`

/** Up when the newest third is above the oldest third. */
export function trendOf(values: readonly number[]): 'up' | 'flat' | 'down' {
  if (values.length < 2) return 'flat'
  const third = Math.max(1, Math.floor(values.length / 3))
  const sum = (list: readonly number[]) => list.reduce((a, b) => a + b, 0)
  const early = sum(values.slice(0, third))
  const late = sum(values.slice(-third))
  if (late > early * 1.25 && late - early >= 1) return 'up'
  if (late < early * 0.75 && early - late >= 1) return 'down'
  return 'flat'
}

export function ago(ms: number): string {
  if (ms < MINUTE) return 'just now'
  if (ms < HOUR) return `${Math.round(ms / MINUTE)}m ago`
  if (ms < 48 * HOUR) return `${Math.round(ms / HOUR)}h ago`
  return `${Math.round(ms / (24 * HOUR))}d ago`
}
