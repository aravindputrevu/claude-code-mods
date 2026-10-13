import type { Row, Source } from '../types'

const HN = 'https://news.ycombinator.com'
const SEARCH_URL = 'https://api.search.tinyfish.ai/'
const FETCH_URL = 'https://api.fetch.tinyfish.ai/'
const ITEM_URL = 'https://hacker-news.firebaseio.com/v0/item/'

export type ListSource = Exclude<Source, 'search'>

export const LIST_URL: Record<ListSource, string> = {
  front: `${HN}/news`,
  new: `${HN}/newest`,
  show: `${HN}/show`,
  ask: `${HN}/ask`,
}

export const dayUrl = (day: string): string => `${HN}/front?day=${day}`
export const itemUrl = (id: number): string => `${HN}/item?id=${id}`

// --- TinyFish: request shapes and reply readers (the hooks module makes the calls) ---

/** How the mod reaches TinyFish: the REST API with a key, or the CLI's own login. */
export type Tinyfish = { mode: 'api'; key: string } | { mode: 'cli'; cli: string }

export const SEARCH_ENDPOINT = SEARCH_URL
export const FETCH_ENDPOINT = FETCH_URL
export const ITEM_ENDPOINT = ITEM_URL

export const httpProblem = (what: string, status: number): string =>
  status === 401 || status === 403
    ? `TinyFish ${what} refused the API key (${status}).`
    : status === 402 || status === 429
      ? `TinyFish ${what} is over its limit (${status}). The card tries again later.`
      : `TinyFish ${what} failed (${status}).`

export type SearchParams = { query: string; recencyMinutes?: number; page?: number }

export function searchQuery(p: SearchParams): string {
  const q = new URLSearchParams({
    query: p.query,
    include_domains: 'news.ycombinator.com',
    purpose: 'Find Hacker News story threads about this topic.',
  })
  if (p.recencyMinutes !== undefined) q.set('recency_minutes', String(Math.max(1, Math.round(p.recencyMinutes))))
  if (p.page !== undefined) q.set('page', String(p.page))
  return `${SEARCH_URL}?${q.toString()}`
}

export function searchArgv(cli: string, p: SearchParams): string[] {
  const argv = [cli, 'search', 'query', p.query, '--include-domains', 'news.ycombinator.com']
  if (p.page !== undefined) argv.push('--page', String(p.page))
  return argv
}

export type FetchOptions = { links?: boolean; ttlSeconds?: number }

export const fetchBody = (urls: readonly string[], opts: FetchOptions): string =>
  JSON.stringify({
    urls,
    format: 'markdown',
    ...(opts.links === true ? { links: true } : {}),
    ...(opts.ttlSeconds === undefined ? {} : { ttl: opts.ttlSeconds }),
  })

export const fetchArgv = (cli: string, urls: readonly string[], opts: FetchOptions): string[] => [
  cli, 'fetch', 'content', 'get', '--format', 'markdown', ...(opts.links === true ? ['--links'] : []), ...urls,
]

export const parseJson = (text: string, what: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`TinyFish ${what} sent a reply that is not JSON.`)
  }
}

export type SearchHit = { id: number; title: string; url: string; snippet: string }

/** The HN item links of a TinyFish Search reply, without duplicates. */
export function hitsOf(body: string): SearchHit[] {
  const json = parseJson(body, 'Search') as { results?: unknown }
  const hits: SearchHit[] = []
  for (const one of (Array.isArray(json.results) ? json.results : []) as Array<Record<string, unknown>>) {
    const url = typeof one.url === 'string' ? one.url : ''
    const id = itemIdOf(url)
    if (id === undefined || hits.some(hit => hit.id === id)) continue
    hits.push({
      id,
      title: (typeof one.title === 'string' ? one.title : '').replace(/\s*\|\s*Hacker News\s*$/, ''),
      url,
      snippet: typeof one.snippet === 'string' ? one.snippet : '',
    })
  }
  return hits
}

export type Page = { url: string; text: string; links: string[] }

/** The pages of a TinyFish Fetch reply. */
export function pagesOf(body: string): Page[] {
  const json = parseJson(body, 'Fetch') as { results?: unknown }
  return ((Array.isArray(json.results) ? json.results : []) as Array<Record<string, unknown>>).map(one => ({
    url: typeof one.url === 'string' ? one.url : '',
    text: typeof one.text === 'string' ? one.text : '',
    links: Array.isArray(one.links) ? one.links.filter((l): l is string => typeof l === 'string') : [],
  }))
}

// --- The official HN item API: points, comments and time for search hits ----

export type Item = {
  id: number
  type?: string
  title?: string
  url?: string
  score?: number
  descendants?: number
  time?: number
  dead?: boolean
  deleted?: boolean
}

/** Search hits as rows: stories only, with points, comments and time from the item API. */
export function rowsFromHits(hits: readonly SearchHit[], found: ReadonlyMap<number, Item>): Row[] {
  const rows: Row[] = []
  for (const hit of hits) {
    const item = found.get(hit.id)
    if (item === undefined) {
      rows.push({ id: hit.id, title: hit.title, url: itemUrl(hit.id) })
      continue
    }
    if (item.dead === true || item.deleted === true) continue
    if (item.type !== 'story' && item.type !== 'poll') continue
    const url = item.url ?? itemUrl(hit.id)
    const site = siteOf(item.url)
    rows.push({
      id: hit.id,
      title: item.title ?? hit.title,
      url,
      ...(site === undefined ? {} : { site }),
      ...(item.score === undefined ? {} : { points: item.score }),
      ...(item.descendants === undefined ? {} : { comments: item.descendants }),
      ...(item.time === undefined ? {} : { time: item.time * 1000 }),
    })
  }
  return rows
}

// --- Reading an HN list page from TinyFish Fetch ------------------------------

const ITEM = /^https?:\/\/news\.ycombinator\.com\/item\?id=(\d+)$/
const ON_HN = /^https?:\/\/(news\.)?ycombinator\.com(\/|$)/

export const itemIdOf = (url: string): number | undefined => {
  const m = ITEM.exec(url)
  return m === null ? undefined : Number(m[1])
}

export const siteOf = (url: string | undefined): string | undefined => {
  const m = url === undefined ? null : /^https?:\/\/(?:www\.)?([^/?#]+)/.exec(url)
  return m === null ? undefined : m[1]
}

/** Story ids and links, in page order, from the link list TinyFish Fetch returns. */
export function storiesFromLinks(links: readonly string[]): Array<{ id: number; url: string }> {
  const out: Array<{ id: number; url: string }> = []
  const seen = new Set<number>()
  let pending: string | undefined
  for (const href of links) {
    if (!ON_HN.test(href)) {
      pending ??= href
      continue
    }
    const id = itemIdOf(href)
    if (id === undefined || seen.has(id)) continue
    seen.add(id)
    out.push({ id, url: pending ?? itemUrl(id) })
    pending = undefined
  }
  return out
}

const UNIT_MS: Record<string, number> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  month: 30 * 86_400_000,
  year: 365 * 86_400_000,
}

const RANK = /^(\d{1,3})\.$/
const RANK_INLINE = /^(\d{1,3})\.\s+(.+)$/
const POINTS = /(\d+)\s+points?\b/
const COMMENTS = /(\d+)\s+comments?\b/
const AGE = /(\d+)\s+(minute|hour|day|month|year)s?\s+ago\b/
const SITE_SUFFIX = /^(.*\S)\s+\(([a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/[^\s()]*)?)\)$/i
const CELL = /(?<!\\)\|/
const RULE = /^:?-{3,}:?$/

const unescape = (token: string): string => token.replace(/\\([\\`*_{}[\]()#+\-.!|~>])/g, '$1')

/**
 * The page text as tokens. TinyFish Fetch writes an HN list either one token per line
 * or as a Markdown table (`| 1. | Title (site) |`); both become the same token list.
 */
export const tokensOf = (text: string): string[] =>
  text
    .replace(/ /g, ' ')
    .split('\n')
    .flatMap(line => line.split(CELL))
    .map(token => unescape(token.trim()))
    .filter(token => token !== '' && !RULE.test(token))

type Entry = { rank: number; title: string; site?: string; points?: number; comments?: number; time?: number }

/** The ranked entries of an HN list page as TinyFish Fetch writes it. */
export function entriesFromText(text: string, now: number): Entry[] {
  const tokens = tokensOf(text)
  const entries: Entry[] = []
  let current: Entry | undefined
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] ?? ''
    const ranked = RANK.exec(token)
    const inline = ranked === null ? RANK_INLINE.exec(token) : null
    if (ranked !== null || inline !== null) {
      let title = ranked !== null ? (tokens[i + 1] ?? '') : (inline?.[2] ?? '')
      if (ranked !== null) i += 1
      current = { rank: Number((ranked ?? inline)?.[1]), title }
      const suffix = SITE_SUFFIX.exec(title)
      if (suffix !== null) {
        title = suffix[1] ?? title
        current.site = suffix[2]
      } else if (tokens[i + 1] === '(' && tokens[i + 3] === ')') {
        current.site = tokens[i + 2]
        i += 3
      }
      current.title = title
      entries.push(current)
      continue
    }
    if (current === undefined) continue
    const points = POINTS.exec(token)
    if (points !== null && current.points === undefined) current.points = Number(points[1])
    const comments = COMMENTS.exec(token)
    if (comments !== null) current.comments = Number(comments[1])
    if (token === 'discuss') current.comments = 0
    const age = AGE.exec(token)
    if (age !== null && current.time === undefined) {
      current.time = now - Number(age[1]) * (UNIT_MS[age[2] ?? 'hour'] ?? 3_600_000)
    }
  }
  return entries
}

/** An HN list page as rows: the text gives rank, title, points and age; the links give ids. */
export function parseList(page: Page, now: number): Row[] {
  const entries = entriesFromText(page.text, now)
  const stories = storiesFromLinks(page.links)
  const rows: Row[] = []
  for (let i = 0; i < Math.min(entries.length, stories.length); i += 1) {
    const entry = entries[i]
    const story = stories[i]
    if (entry === undefined || story === undefined) continue
    rows.push({
      id: story.id,
      title: entry.title,
      url: story.url,
      rank: entry.rank,
      ...(entry.site === undefined ? {} : { site: entry.site }),
      ...(entry.points === undefined ? {} : { points: entry.points }),
      ...(entry.comments === undefined ? {} : { comments: entry.comments }),
      ...(entry.time === undefined ? {} : { time: entry.time }),
    })
  }
  return rows
}

/** `YYYY-MM-DD` of a time, in UTC. */
export const dayOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

/** The `count` whole days before `now`, oldest first. */
export const daysBefore = (now: number, count: number): string[] =>
  Array.from({ length: count }, (_, i) => dayOf(now - (count - i) * 86_400_000))
