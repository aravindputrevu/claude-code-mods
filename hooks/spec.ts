import type { CardSpec, Sort, Source, View, Window } from '../types'

export const SOURCES: readonly Source[] = ['front', 'new', 'show', 'ask', 'search']
export const WINDOWS: readonly Window[] = ['1h', '6h', '24h', '7d', '30d']
export const SORTS: readonly Sort[] = ['velocity', 'points', 'comments', 'new']
export const VIEWS: readonly View[] = ['list', 'spark', 'themes', 'digest']

const HOUR = 3_600_000
export const WINDOW_MS: Record<Window, number> = {
  '1h': HOUR,
  '6h': 6 * HOUR,
  '24h': 24 * HOUR,
  '7d': 7 * 24 * HOUR,
  '30d': 30 * 24 * HOUR,
}

export const SOURCE_LABEL: Record<Source, string> = {
  front: 'front page',
  new: 'new',
  show: 'Show HN',
  ask: 'Ask HN',
  search: 'search',
}

export const DEFAULT_CARDS: readonly CardSpec[] = [
  {
    id: 'trending',
    title: 'Trending now',
    source: 'front',
    window: '24h',
    sort: 'velocity',
    view: 'list',
    limit: 8,
    everyMinutes: 15,
  },
  {
    id: 'themes',
    title: 'Rising themes',
    source: 'front',
    window: '7d',
    sort: 'points',
    view: 'themes',
    limit: 6,
    everyMinutes: 360,
  },
]

/** A front-page card over more than a day reads the daily archive pages. */
export const readsArchive = (spec: CardSpec): boolean =>
  spec.source === 'front' && WINDOW_MS[spec.window] > WINDOW_MS['24h']

export const archiveDays = (spec: CardSpec): number =>
  Math.round(WINDOW_MS[spec.window] / WINDOW_MS['24h'])

const isOne = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (list as readonly string[]).includes(value)

const whole = (value: unknown, min: number, max: number): number | undefined => {
  const n = typeof value === 'string' ? Number(value) : value
  if (typeof n !== 'number' || !Number.isFinite(n)) return undefined
  return Math.min(max, Math.max(min, Math.round(n)))
}

const text = (value: unknown, max: number): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : undefined

export type Checked = { spec: CardSpec; error?: undefined } | { spec?: undefined; error: string }

/** Checks a spec from the model or the store, fills the defaults, and keeps `id`. */
export function normalize(raw: unknown, id: string): Checked {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { error: 'The spec is not a JSON object.' }
  }
  const r = raw as Record<string, unknown>
  if (!isOne(SOURCES, r.source)) {
    return { error: `Unknown source "${String(r.source)}". Use one of: ${SOURCES.join(', ')}.` }
  }
  const source = r.source
  const query = text(r.query, 200)
  if (source === 'search' && query === undefined) {
    return { error: 'A search card needs a query.' }
  }
  const minPoints = whole(r.minPoints, 0, 100_000)
  const minComments = whole(r.minComments, 0, 100_000)

  return {
    spec: {
      id,
      title: text(r.title, 48) ?? query ?? SOURCE_LABEL[source],
      source,
      ...(query === undefined ? {} : { query }),
      window: isOne(WINDOWS, r.window) ? r.window : '24h',
      ...(minPoints ? { minPoints } : {}),
      ...(minComments ? { minComments } : {}),
      sort: isOne(SORTS, r.sort) ? r.sort : 'velocity',
      view: isOne(VIEWS, r.view) ? r.view : 'list',
      limit: whole(r.limit, 1, 15) ?? 5,
      everyMinutes: whole(r.everyMinutes, 5, 1440) ?? 15,
    },
  }
}

/** Reads the saved card list; drops a card that no longer checks. */
export function loadCards(raw: unknown): CardSpec[] {
  if (!Array.isArray(raw)) return [...DEFAULT_CARDS]
  const cards: CardSpec[] = []
  for (const one of raw) {
    const id = typeof one === 'object' && one !== null ? (one as { id?: unknown }).id : undefined
    if (typeof id !== 'string') continue
    const checked = normalize(one, id)
    if (checked.spec !== undefined) cards.push(checked.spec)
  }
  return cards
}

export const newCardId = (now: number, taken: readonly CardSpec[]): string => {
  let n = 0
  let id = `c${now.toString(36)}`
  while (taken.some(card => card.id === id)) id = `c${now.toString(36)}${(n += 1)}`
  return id
}

/** The spec as short chips, in the order the pane draws them. */
export function chips(spec: CardSpec): string[] {
  return [
    SOURCE_LABEL[spec.source],
    ...(spec.query === undefined ? [] : [`"${spec.query}"`]),
    ...(spec.minPoints === undefined ? [] : [`≥${spec.minPoints} pts`]),
    ...(spec.minComments === undefined ? [] : [`≥${spec.minComments} comments`]),
    spec.window,
    `by ${spec.sort}`,
    spec.view,
    `top ${spec.limit}`,
    `every ${spec.everyMinutes}m`,
  ]
}
