import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { CardData, CardSpec, CatchUp, Draft, Expanded, Row, Status, Theme } from '../types'
import { checkReply, compileAsk } from './compile'
import { catchupAsk, digestAsk, themesAsk, themesIn, threadAsk, type Ask } from './digest'
import { bandTree, paneTree, type Actions, type El } from './pane'
import {
  dayOf,
  dayUrl,
  daysBefore,
  fetchArgv,
  fetchBody,
  FETCH_ENDPOINT,
  hitsOf,
  httpProblem,
  ITEM_ENDPOINT,
  itemUrl,
  LIST_URL,
  pagesOf,
  parseList,
  rowsFromHits,
  searchArgv,
  searchQuery,
  type FetchOptions,
  type Item,
  type ListSource,
  type Page,
  type SearchHit,
  type SearchParams,
  type Tinyfish,
} from './sources'
import { archiveDays, loadCards, newCardId, readsArchive, WINDOW_MS } from './spec'
import { addSnap, bucketCounts, filterRows, snapOf, sortRows, withAverage, withTrend, type Snap } from './trend'

type Engine = EngineInterface
type Timer = ReturnType<Engine['clock']['every']>

const MINUTE = 60_000
const DAY = 86_400_000
const AWAY_MS = 12 * 60 * MINUTE

const PANE = 'hn-pulse'

const cardsAtom = atom({ plugin: 'hn-mod', key: 'cards' } as const, [] as CardSpec[])
const dataAtom = atom({ plugin: 'hn-mod', key: 'data' } as const, {} as Record<string, CardData>)
const draftAtom = atom({ plugin: 'hn-mod', key: 'draft' } as const, null as Draft | null)
const editingAtom = atom({ plugin: 'hn-mod', key: 'editing' } as const, null as string | null)
const expandedAtom = atom({ plugin: 'hn-mod', key: 'expanded' } as const, null as Expanded | null)
const catchupAtom = atom({ plugin: 'hn-mod', key: 'catchup' } as const, null as CatchUp | null)
const statusAtom = atom({ plugin: 'hn-mod', key: 'status' } as const, { mode: 'cli', refreshedAt: 0 } as Status)
const paneShownAtom = atom({ plugin: 'hn-mod', key: 'paneShown' } as const, false)
const bandHiddenAtom = atom({ plugin: 'hn-mod', key: 'bandHidden' } as const, false)

// --- Configuration and module state (a reload starts these over) --------------

let options: PluginOptions = {}
let tinyfish: Tinyfish = { mode: 'cli', cli: 'tinyfish' }
let isConfigured = false
let tick: Timer | undefined
let running: Promise<void> | undefined
const lists = new Map<ListSource, { at: number; rows: Promise<Row[]> }>()
const items = new Map<number, { at: number; item: Item | null }>()
const threads = new Map<number, string>()

const model = (): string =>
  typeof options.model === 'string' && options.model.trim() !== '' ? options.model.trim() : 'haiku'

const snapshotMs = (): number =>
  Math.min(120, Math.max(5, typeof options.snapshot_minutes === 'number' ? options.snapshot_minutes : 15)) * MINUTE

const problem = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, 200)

const uniqueById = (rows: readonly Row[]): Row[] => {
  const seen = new Set<number>()
  return rows.filter(row => (seen.has(row.id) ? false : (seen.add(row.id), true)))
}

/** The TinyFish route: the key option, then TINYFISH_API_KEY, then the CLI's own login. */
async function configure($: Engine): Promise<void> {
  if (isConfigured) return
  const fromConfig = typeof options.tinyfish_api_key === 'string' ? options.tinyfish_api_key.trim() : ''
  const fromEnv = fromConfig === '' ? ((await $.env.get('TINYFISH_API_KEY')) ?? '').trim() : ''
  const cli = typeof options.tinyfish_cli === 'string' && options.tinyfish_cli.trim() !== '' ? options.tinyfish_cli.trim() : 'tinyfish'
  const key = fromConfig !== '' ? fromConfig : fromEnv
  tinyfish = key !== '' ? { mode: 'api', key } : { mode: 'cli', cli }
  isConfigured = true
  await update($, statusAtom, status => ({ ...status, mode: tinyfish.mode }))
}

// --- TinyFish, the HN item API and the model ----------------------------------

async function runCli($: Engine, argv: string[]): Promise<string> {
  let out
  try {
    out = await $.process.run(argv, { timeoutMs: 60_000 })
  } catch {
    throw new Error(`Cannot run "${argv[0]}". Set TINYFISH_API_KEY or the TinyFish API key option.`)
  }
  if (out.exitCode === 127) {
    throw new Error(`"${argv[0]}" is not on PATH. Set TINYFISH_API_KEY or the TinyFish API key option.`)
  }
  if (out.exitCode !== 0) {
    const last = out.stderr.trim().split('\n').pop() ?? ''
    throw new Error(`TinyFish CLI failed: ${last.slice(0, 160) || `exit ${out.exitCode}`}`)
  }
  return out.stdout
}

/** HN-only search. The CLI has no time window, so its hits are filtered by item time later. */
async function tinyfishSearch($: Engine, p: SearchParams): Promise<SearchHit[]> {
  await configure($)
  const tf = tinyfish
  if (tf.mode === 'cli') return hitsOf(await runCli($, searchArgv(tf.cli, p)))
  const res = await $.http.fetch(searchQuery(p), { headers: { 'X-API-Key': tf.key, Accept: 'application/json' } })
  if (!res.ok) throw new Error(httpProblem('Search', res.status))
  return hitsOf(res.text)
}

/** Clean page text (and links) through TinyFish Fetch, ten URLs to a request. */
async function tinyfishFetch($: Engine, urls: readonly string[], opts: FetchOptions): Promise<Page[]> {
  await configure($)
  const tf = tinyfish
  const pages: Page[] = []
  for (let i = 0; i < urls.length; i += 10) {
    const batch = urls.slice(i, i + 10)
    if (tf.mode === 'cli') {
      pages.push(...pagesOf(await runCli($, fetchArgv(tf.cli, batch, opts))))
      continue
    }
    const res = await $.http.fetch(FETCH_ENDPOINT, {
      method: 'POST',
      headers: { 'X-API-Key': tf.key, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: fetchBody(batch, opts),
    })
    if (!res.ok) throw new Error(httpProblem('Fetch', res.status))
    pages.push(...pagesOf(res.text))
  }
  return pages
}

/** Points, comments and time for HN items, kept for ten minutes. */
async function readItems($: Engine, ids: readonly number[], now: number): Promise<Map<number, Item>> {
  const out = new Map<number, Item>()
  await Promise.all(
    ids.map(async id => {
      const known = items.get(id)
      if (known !== undefined && now - known.at < 10 * MINUTE) {
        if (known.item !== null) out.set(id, known.item)
        return
      }
      try {
        const res = await $.http.fetch(`${ITEM_ENDPOINT}${id}.json`)
        const item = res.ok ? (JSON.parse(res.text) as Item | null) : null
        items.set(id, { at: now, item })
        if (item !== null) out.set(id, item)
      } catch {
        items.set(id, { at: now, item: null })
      }
    }),
  )
  return out
}

/** One model call. The fixed instructions lead the prompt with a cache mark, as the mods guide advises. */
async function complete($: Engine, ask: Ask): Promise<string> {
  let reply
  try {
    reply = await $.model.complete({
      model: model(),
      prompt: [{ text: ask.system, cache: true }, { text: ask.prompt }],
      maxTokens: ask.maxTokens,
      // Short summary and JSON jobs: low effort keeps the thinking short.
      effort: 'low',
      timeoutMs: 60_000,
    })
  } catch (error) {
    throw new Error(`Claude Code refused the model call for "${model()}": ${problem(error)}`)
  }
  if (!reply.isAnswered) {
    const why = reply.reason === 'api-error'
      ? `the API answered ${reply.status ?? 'with no status'} (${reply.error})`
      : reply.reason === 'aborted'
        ? 'the call timed out or was cancelled'
        : 'the reply had no text'
    throw new Error(`The model call for "${model()}" failed: ${why}.`)
  }
  return reply.text.trim()
}

// --- Story sources ----------------------------------------------------------------

/** A list page, read at most once per half snapshot period, with trend fields added. */
function listRows($: Engine, source: ListSource, now: number): Promise<Row[]> {
  const known = lists.get(source)
  if (known !== undefined && now - known.at < snapshotMs() / 2) return known.rows
  const rows = readList($, source, now)
  lists.set(source, { at: now, rows })
  rows.catch(() => lists.delete(source))
  return rows
}

async function readList($: Engine, source: ListSource, now: number): Promise<Row[]> {
  const [page] = await tinyfishFetch($, [LIST_URL[source]], { links: true, ttlSeconds: 120 })
  const rows = page === undefined ? [] : parseList(page, now)
  if (rows.length === 0) throw new Error(`TinyFish returned no stories for ${LIST_URL[source]}.`)

  const snaps = ((await $.store.get('snaps')) ?? {}) as Partial<Record<ListSource, Snap[]>>
  const history = snaps[source] ?? []
  const last = history[history.length - 1]
  if (last === undefined || now - last.at >= snapshotMs() - MINUTE) {
    await $.store.set('snaps', { ...snaps, [source]: addSnap(history, snapOf(rows, now), 26 * 60 * MINUTE) })
  }
  return withTrend(rows, history, now)
}

type DayEntry = { at: number; rows: Row[] }

/** A day page read 12 hours after the day ended is final; an earlier read is good for 3 hours. */
const isFresh = (day: string, entry: DayEntry | undefined, now: number): boolean => {
  if (entry === undefined || entry.rows.length === 0) return false
  const dayEnd = Date.parse(`${day}T00:00:00Z`) + DAY
  return entry.at - dayEnd >= 12 * 60 * MINUTE || now - entry.at < 3 * 60 * MINUTE
}

/** Front-page rows for each day, from the store when a fresh read is there. */
async function archive($: Engine, days: readonly string[], now: number): Promise<Map<string, Row[]>> {
  const saved = ((await $.store.get('archive')) ?? {}) as Record<string, DayEntry>
  const missing = days.filter(day => !isFresh(day, saved[day], now))
  if (missing.length > 0) {
    const pages = await tinyfishFetch($, missing.map(dayUrl), { links: true })
    const empty: string[] = []
    for (const day of missing) {
      const page = pages.find(one => one.url.endsWith(`day=${day}`))
      // The age text on a day page counts from the time of the fetch.
      const rows = page === undefined ? [] : parseList(page, now).slice(0, 30)
      if (rows.length > 0) saved[day] = { at: now, rows }
      else if (saved[day] === undefined) empty.push(day)
    }
    const keep = Object.keys(saved).sort().slice(-40)
    await $.store.set('archive', Object.fromEntries(keep.map(day => [day, saved[day]])))
    if (empty.length === days.length) throw new Error(`TinyFish returned no stories for ${empty.join(', ')}.`)
  }
  return new Map(days.map(day => [day, saved[day]?.rows ?? []]))
}

async function searchRows($: Engine, spec: CardSpec, now: number): Promise<Row[]> {
  const query = spec.query ?? spec.title
  const recencyMinutes = WINDOW_MS[spec.window] / MINUTE
  const hits = await tinyfishSearch($, { query, recencyMinutes })
  if (hits.length >= 8) {
    const more = await tinyfishSearch($, { query, recencyMinutes, page: 1 }).catch(() => [])
    for (const hit of more) if (!hits.some(one => one.id === hit.id)) hits.push(hit)
  }
  const found = await readItems($, hits.map(hit => hit.id), now)
  return rowsFromHits(hits, found).map(row => withAverage(row, now))
}

// --- Cards ------------------------------------------------------------------------

type Cached = { key: string; digest?: string; themes?: Theme[] }

async function cachedEntry($: Engine, id: string): Promise<Cached | undefined> {
  const all = ((await $.store.get('cache')) ?? {}) as Record<string, Cached>
  return all[id]
}

async function keepEntry($: Engine, id: string, entry: Cached): Promise<void> {
  const all = ((await $.store.get('cache')) ?? {}) as Record<string, Cached>
  const ids = new Set((await read($, cardsAtom)).map(card => card.id))
  const kept = Object.fromEntries(Object.entries(all).filter(([key]) => ids.has(key)))
  await $.store.set('cache', { ...kept, [id]: entry })
}

async function setData($: Engine, id: string, fn: (old: CardData | undefined) => CardData): Promise<void> {
  await update($, dataAtom, data => ({ ...data, [id]: fn(data[id]) }))
}

async function refreshCard($: Engine, spec: CardSpec): Promise<void> {
  const now = await $.clock.now()
  await setData($, spec.id, old => ({ rows: [], updatedAt: 0, ...old, isLoading: true }))
  try {
    let candidates: Row[]
    let buckets: Array<{ label: string; rows: Row[] }> | undefined
    if (spec.source === 'search') {
      candidates = await searchRows($, spec, now)
    } else if (readsArchive(spec)) {
      const days = daysBefore(now, archiveDays(spec))
      const byDay = await archive($, days, now)
      buckets = days.map(day => ({ label: day, rows: filterRows(byDay.get(day) ?? [], spec) }))
      candidates = uniqueById(days.flatMap(day => byDay.get(day) ?? [])).map(row => withAverage(row, now))
    } else {
      candidates = await listRows($, spec.source, now)
    }

    // An archive day is complete: its rows are filtered by query and points, not by age.
    const filtered = filterRows(candidates, spec, readsArchive(spec) ? undefined : now)
    const rows = sortRows(filtered, spec.sort).slice(0, spec.limit)
    const next: CardData = { rows, updatedAt: now, isLoading: false }

    if (spec.view === 'spark' && (spec.source === 'search' || buckets !== undefined)) {
      next.spark = buckets?.map(b => b.rows.length) ?? bucketCounts(filtered, WINDOW_MS[spec.window], now)
    }
    if (spec.view === 'themes') {
      const groups = buckets ?? [{ label: dayOf(now), rows: filtered }]
      const key = `${JSON.stringify(spec)}|${groups.map(g => `${g.label}:${g.rows.length}`).join(',')}`
      const hit = await cachedEntry($, spec.id)
      if (hit?.key === key && hit.themes !== undefined) {
        next.themes = hit.themes
      } else {
        next.themes = themesIn(await complete($, themesAsk(groups, spec.limit)), groups.length, spec.limit)
        await keepEntry($, spec.id, { key, themes: next.themes })
      }
    }
    if (spec.view === 'digest' && rows.length > 0) {
      const key = rows.map(row => row.id).join(',')
      const hit = await cachedEntry($, spec.id)
      if (hit?.key === key && hit.digest !== undefined) {
        next.digest = hit.digest
      } else {
        next.digest = await complete($, digestAsk(spec.title, rows))
        await keepEntry($, spec.id, { key, digest: next.digest })
      }
    }
    await setData($, spec.id, () => next)
    await noteError($, spec.id, undefined, now)
  } catch (error) {
    await setData($, spec.id, old => ({ ...old, rows: old?.rows ?? [], updatedAt: now, isLoading: false, error: problem(error) }))
    await noteError($, spec.id, problem(error), now)
  }
}

/** Keeps each card's last error in the store, so it can be read after the session. */
async function noteError($: Engine, id: string, message: string | undefined, now: number): Promise<void> {
  const all = ((await $.store.get('errors')) ?? {}) as Record<string, { at: number; message: string }>
  if (message === undefined && all[id] === undefined) return
  const { [id]: _old, ...rest } = all
  await $.store.set('errors', message === undefined ? rest : { ...rest, [id]: { at: now, message } })
}

/** Refreshes each card whose interval has passed, one after another. */
function refreshDue($: Engine, force = false): Promise<void> {
  if (running !== undefined) return running
  running = (async () => {
    try {
      const now = await $.clock.now()
      const cards = await read($, cardsAtom)
      const data = await read($, dataAtom)
      for (const spec of cards) {
        const card = data[spec.id]
        // A card that failed tries again after five minutes, not after its whole interval.
        const minutes = card?.error !== undefined ? Math.min(5, spec.everyMinutes) : spec.everyMinutes
        if (force || now - (card?.updatedAt ?? 0) >= minutes * MINUTE) await refreshCard($, spec)
      }
      await update($, statusAtom, status => ({ ...status, refreshedAt: now }))
    } finally {
      running = undefined
    }
  })()
  return running
}

/** The catch-up card: the front-page archive for each day since the last visit. */
async function runCatchup($: Engine, since: number, now: number): Promise<void> {
  const missed = Math.min(7, Math.max(0, Math.floor(now / DAY) - Math.floor(since / DAY)))
  const days = missed > 0 ? daysBefore(now, missed) : []
  await update($, catchupAtom, () => ({ since, days, rows: [], isBusy: true }))
  try {
    const byDay = days.length > 0
      ? await archive($, days, now)
      : new Map([[dayOf(now), await listRows($, 'front', now)]])
    const rows = sortRows(uniqueById([...byDay.values()].flat()), 'points').slice(0, 8)
    await update($, catchupAtom, old => (old === null ? null : { ...old, rows }))
    const digest = await complete($, catchupAsk([...byDay].map(([day, list]) => ({ day, rows: list }))))
    await update($, catchupAtom, old => (old === null ? null : { ...old, rows, digest, isBusy: false }))
  } catch (error) {
    await update($, catchupAtom, old => (old === null ? null : { ...old, isBusy: false, error: problem(error) }))
  }
}

/** Opens or closes the summary under a row; reads the thread with TinyFish Fetch. */
async function toggleThread($: Engine, cardId: string, row: Row): Promise<void> {
  const open = await read($, expandedAtom)
  if (open !== null && open.cardId === cardId && open.itemId === row.id) {
    await update($, expandedAtom, () => null)
    return
  }
  const known = threads.get(row.id)
  await update($, expandedAtom, () => ({ cardId, itemId: row.id, isBusy: known === undefined, ...(known === undefined ? {} : { text: known }) }))
  if (known !== undefined) return
  let text: string
  try {
    const [page] = await tinyfishFetch($, [itemUrl(row.id)], { ttlSeconds: 600 })
    text = await complete($, threadAsk(row.title, page?.text ?? ''))
    threads.set(row.id, text)
  } catch (error) {
    text = problem(error)
  }
  await update($, expandedAtom, old =>
    old !== null && old.cardId === cardId && old.itemId === row.id ? { ...old, text, isBusy: false } : old,
  )
}

// --- The pane's actions -------------------------------------------------------------

async function saveCards($: Engine, cards: CardSpec[]): Promise<void> {
  await update($, cardsAtom, () => cards)
  await $.store.set('cards', cards)
}

/** Plain language to a preview card: a new card, or a change to the preview or the edited card. */
async function submitRequest($: Engine, text: string): Promise<void> {
  const request = text.trim()
  if (request === '') return
  const [draft, editing, cards] = await Promise.all([read($, draftAtom), read($, editingAtom), read($, cardsAtom)])
  const base = draft?.spec ?? cards.find(card => card.id === editing)
  const editId = draft?.editId ?? (draft?.spec === undefined ? base?.id : undefined)
  const keep = { ...(editId === undefined ? {} : { editId }), ...(draft?.spec === undefined ? {} : { spec: draft.spec }) }
  await update($, draftAtom, () => ({ text: request, isBusy: true, ...keep }))
  const id = base?.id ?? newCardId(await $.clock.now(), cards)
  const ask = compileAsk(request, base)
  let reply: string
  try {
    reply = await complete($, { ...ask, maxTokens: 2000 })
  } catch (error) {
    await update($, draftAtom, () => ({ text: request, isBusy: false, error: problem(error), ...keep }))
    return
  }
  const checked = checkReply(reply, id)
  await update($, draftAtom, () =>
    checked.spec !== undefined
      ? { text: request, isBusy: false, spec: checked.spec, ...(editId === undefined ? {} : { editId }) }
      : { text: request, isBusy: false, error: checked.error, ...keep },
  )
}

async function saveDraft($: Engine): Promise<void> {
  const draft = await read($, draftAtom)
  const spec = draft?.spec
  if (draft === null || spec === undefined) return
  const cards = await read($, cardsAtom)
  const next = draft.editId === undefined
    ? [spec, ...cards]
    : cards.map(card => (card.id === draft.editId ? spec : card))
  await saveCards($, next)
  await update($, draftAtom, () => null)
  await update($, editingAtom, () => null)
  await refreshCard($, spec)
}

async function moveCard($: Engine, id: string, by: -1 | 1): Promise<void> {
  const cards = [...(await read($, cardsAtom))]
  const from = cards.findIndex(card => card.id === id)
  const moved = cards[from]
  const to = from + by
  if (moved === undefined || to < 0 || to >= cards.length) return
  cards.splice(from, 1)
  cards.splice(to, 0, moved)
  await saveCards($, cards)
}

async function removeCard($: Engine, id: string): Promise<void> {
  await saveCards($, (await read($, cardsAtom)).filter(card => card.id !== id))
  await update($, dataAtom, data => Object.fromEntries(Object.entries(data).filter(([key]) => key !== id)))
  await update($, editingAtom, current => (current === id ? null : current))
}

function actionsFor($: Engine): Actions {
  return {
    refresh: () => void refreshDue($, true),
    submit: text => void submitRequest($, text),
    saveDraft: () => void saveDraft($),
    cancelDraft: () => {
      void update($, draftAtom, () => null)
      void update($, editingAtom, () => null)
    },
    edit: id => {
      void update($, draftAtom, () => null)
      void update($, editingAtom, current => (current === id ? null : id))
    },
    move: (id, by) => void moveCard($, id, by),
    remove: id => void removeCard($, id),
    toggle: (cardId, row) => void toggleThread($, cardId, row),
    dismissCatchup: () => void update($, catchupAtom, () => null),
  }
}

// --- Session ------------------------------------------------------------------------

async function openPane($: Engine, isAsked: boolean): Promise<void> {
  const pane = { id: PANE, title: 'HN pulse' }
  const opened = await $.ui.open(isAsked ? { ...pane, focus: true as const } : pane)
  await update($, paneShownAtom, () => opened.isPlaced)
}

/** Cards from the store into the session's state: at start, and again after /clear. */
async function loadState($: Engine): Promise<void> {
  // 0.1.0 kept day pages under 'days' with no read time; 'archive' replaces it.
  if ((await $.store.get('days')) !== undefined) await $.store.delete('days')
  const saved = await $.store.get('cards')
  const cards = loadCards(saved)
  await update($, cardsAtom, () => cards)
  if (saved === undefined) await $.store.set('cards', cards)
}

async function start($: Engine, isInteractive: boolean): Promise<void> {
  await configure($)
  await loadState($)

  const now = await $.clock.now()
  const lastSeen = await $.store.get('lastSeenAt')
  await $.store.set('lastSeenAt', now)
  if (typeof lastSeen === 'number' && now - lastSeen > AWAY_MS) {
    $.clock.after(500, () => void runCatchup($, lastSeen, now))
  }

  tick?.cancel()
  tick = $.clock.every(MINUTE, () => {
    void refreshDue($)
    void $.clock.now().then(at => $.store.set('lastSeenAt', at))
  })
  $.clock.after(100, () => void refreshDue($))
  if (isInteractive && options.auto_open !== false) await openPane($, false)
}

export const register: Register = (on, opts) => {
  options = opts
  isConfigured = false

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'hn', description: 'Open the HN pulse pane (/hn refresh reads every card again)' })
    await start($, e.isInteractive)
    return next(e)
  })

  // /clear, /resume and /branch reset $.state and fire no session.start.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    await loadState($)
    $.clock.after(100, () => void refreshDue($, true))
    return next(e)
  })

  on('command.run', { command: 'hn' }, async ($, e) => {
    await openPane($, true)
    if (e.args.trim() === 'refresh') void refreshDue($, true)
    return {}
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const closed = await next(e)
    await update($, paneShownAtom, () => false)
    return closed
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const el: El = $.ui.resolve(e)
    const [cards, data, draft, editing, expanded, catchup, status] = await Promise.all([
      read($, cardsAtom),
      read($, dataAtom),
      read($, draftAtom),
      read($, editingAtom),
      read($, expandedAtom),
      read($, catchupAtom),
      read($, statusAtom),
    ])
    const now = await $.clock.now()
    return paneTree(el, actionsFor($), {
      cards,
      data,
      draft,
      editing,
      expanded,
      catchup,
      status,
      now,
      width: e.props.bodyColumns,
    })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const [isShown, isHidden] = await Promise.all([read($, paneShownAtom), read($, bandHiddenAtom)])
    if (isShown || isHidden) return next(e)
    const [cards, data] = await Promise.all([read($, cardsAtom), read($, dataAtom)])
    const rows = cards.flatMap(card => (card.source === 'search' ? [] : (data[card.id]?.rows ?? [])))
    const top = [...rows].sort((a, b) => (b.velocity ?? -1) - (a.velocity ?? -1))[0]
    if (top === undefined) return next(e)
    const fresh = new Set(rows.filter(row => row.isNew === true).map(row => row.id)).size
    return bandTree(
      $.ui.resolve(e),
      top,
      fresh,
      () => void openPane($, true),
      () => void update($, bandHiddenAtom, () => true),
      e.props.bodyColumns,
    )
  })
}
