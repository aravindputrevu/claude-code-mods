import { expect, mock, test } from 'claude-code/testing'

import type { CardSpec, Row } from '../types'
import { checkReply } from '../hooks/compile'
import { parseList } from '../hooks/sources'
import { normalize } from '../hooks/spec'
import { filterRows, snapOf, sparkline, trendOf, withTrend } from '../hooks/trend'
import { FRONT_LINKS, FRONT_TEXT, TABLE_LINKS, TABLE_TEXT } from './fixtures'

const NOW = Date.parse('2026-10-10T12:00:00Z')
const HOUR = 3_600_000
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

const SPEC_REPLY =
  '{"title":"Rust launches","source":"show","query":"rust","window":"24h","minPoints":100,"sort":"points","view":"list","limit":5,"everyMinutes":15}'
const THEMES_REPLY = '{"themes":[{"name":"Developer tools","perBucket":[0,0,1,1,2,3,4]}]}'

const PANE = {
  plugin: 'hn-mod',
  component: 'Pane',
  requestId: 'hn-pulse',
  viewport: { columns: 160, rows: 40 },
  props: {
    title: 'HN pulse',
    isFocused: true,
    bodyColumns: 72,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const BAND = {
  plugin: 'hn-mod',
  component: 'AbovePrompt',
  viewport: { columns: 120, rows: 40 },
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 6,
    bodyColumns: 110,
    scroll: { offset: 0, bodyRows: 5 },
    view: {},
  },
} as const

const ok = (json: unknown) => ({ status: 200, ok: true, headers: {}, text: JSON.stringify(json) })

/** Answers TinyFish Fetch with the front-page fixture for every URL, and the item API with nothing. */
function network(e: { url: string; init?: { body?: string } }) {
  if (e.url.startsWith('https://api.fetch.tinyfish.ai')) {
    const { urls } = JSON.parse(e.init?.body ?? '{"urls":[]}') as { urls: string[] }
    return ok({ results: urls.map(url => ({ url, text: FRONT_TEXT, links: FRONT_LINKS })), errors: [] })
  }
  if (e.url.startsWith('https://api.search.tinyfish.ai')) {
    return ok({ query: 'q', results: [], total_results: 0, page: 0 })
  }
  return { status: 404, ok: false, headers: {}, text: 'null' }
}

// --- Pure parts ---------------------------------------------------------------

test('the front page text and links become rows', () => {
  const rows = parseList({ url: 'https://news.ycombinator.com/news', text: FRONT_TEXT, links: FRONT_LINKS }, NOW)
  expect(rows.length).toBe(5)
  expect(rows[0]).toMatchObject({
    id: 50028275,
    rank: 1,
    title: 'REA Reverse – Engineer Anything',
    site: 'rea.tools',
    url: 'https://rea.tools/',
    points: 344,
    comments: 119,
    time: NOW - 7 * HOUR,
  })
  expect(rows[2]).toMatchObject({ id: 50019911, title: 'Cloudflare acquires Deno', points: 1190, comments: 606 })
})

test('an archive page in Markdown table layout becomes rows', () => {
  const rows = parseList({ url: 'https://news.ycombinator.com/front?day=2026-10-09', text: TABLE_TEXT, links: TABLE_LINKS }, NOW)
  expect(rows.length).toBe(3)
  expect(rows[0]).toMatchObject({
    rank: 1,
    title: "Why isn't the industry freaking out about DeepSeek 4.1 Flash?",
    site: 'dgt.is',
    points: 1089,
    comments: 959,
    time: NOW - 2 * 24 * HOUR,
  })
  expect(rows[1]).toMatchObject({ title: 'Cloudflare acquires Deno', site: 'deno.com', points: 1119, comments: 574 })
})

test('a self post links to its own thread', () => {
  const text = '1.\nAsk HN: What are you working on?\n13 points\nby\nuser1\n2 hours ago\n|\nhide\n|\ndiscuss\n'
  const links = [
    'https://news.ycombinator.com/vote?id=50030000&how=up&goto=news',
    'https://news.ycombinator.com/item?id=50030000',
    'https://news.ycombinator.com/user?id=someone',
    'https://news.ycombinator.com/item?id=50030000',
  ]
  const [row] = parseList({ url: '', text, links }, NOW)
  expect(row).toMatchObject({ id: 50030000, url: 'https://news.ycombinator.com/item?id=50030000', points: 13, comments: 0 })
})

test('a spec gets its defaults and loses bad values', () => {
  expect(normalize({ source: 'show', query: 'rust', minPoints: '100', limit: 99, view: 'bogus' }, 'c1').spec).toEqual({
    id: 'c1',
    title: 'rust',
    source: 'show',
    query: 'rust',
    window: '24h',
    minPoints: 100,
    sort: 'velocity',
    view: 'list',
    limit: 15,
    everyMinutes: 15,
  })
  expect(normalize({ source: 'search' }, 'c2').error).toBe('A search card needs a query.')
  expect(normalize({ source: 'hn' }, 'c3').error).toMatch(/Unknown source/)
})

test('a model reply in a code fence still checks', () => {
  expect(checkReply('```json\n' + SPEC_REPLY + '\n```', 'c9').spec?.minPoints).toBe(100)
  expect(checkReply('no spec here', 'c9').error).toMatch(/not a JSON spec/)
})

test('velocity compares with the snapshot nearest one hour old', () => {
  const rows: Row[] = [
    { id: 1, title: 'a', url: 'u', rank: 1, points: 300 },
    { id: 2, title: 'b', url: 'u', rank: 2, points: 50 },
  ]
  const old = snapOf([{ id: 1, title: 'a', url: 'u', rank: 4, points: 100 }], NOW - HOUR)
  const [a, b] = withTrend(rows, [old], NOW)
  expect(a?.velocity).toBe(200)
  expect(a?.rankDelta).toBe(3)
  expect(b?.isNew).toBe(true)
})

test('filters match whole words, the window and the minimum points', () => {
  const rows: Row[] = [
    { id: 1, title: 'Rust 2.0 released', url: 'u', points: 120, time: NOW - HOUR },
    { id: 2, title: 'Trust in software', url: 'u', points: 500, time: NOW - HOUR },
    { id: 3, title: 'Rust in the kernel', url: 'u', points: 90, time: NOW - HOUR },
    { id: 4, title: 'Rust at scale', url: 'u', points: 300, time: NOW - 3 * 24 * HOUR },
  ]
  const spec = normalize({ source: 'front', query: 'rust', minPoints: 100 }, 'x').spec as CardSpec
  expect(filterRows(rows, spec, NOW).map(row => row.id)).toEqual([1])
  expect(sparkline([1, 2, 3])).toBe('▁▅█')
  expect(trendOf([1, 1, 2, 5, 8, 9])).toBe('up')
})

// --- The pane, through the engine ------------------------------------------------

test('a plain-language request becomes a card', { options: { tinyfish_api_key: 'test-key' } }, async ($, on) => {
  const saved = new Map<string, unknown>()
  on('store.get', ($, e) => ({ value: saved.get(e.key) }))
  on('store.set', ($, e) => {
    saved.set(e.key, e.value)
    return { value: undefined }
  })
  mock.clock(on, { now: NOW })
  const prompts: string[] = []
  on('model.complete', ($, e) => {
    prompts.push(e.prompt)
    return { value: { isAnswered: true, text: SPEC_REPLY, usage: USAGE } }
  })
  on('http.fetch', ($, e) => ({ value: network(e) }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.input({ key: 'program', text: 'Rust launches with 100+ points today' })
    expect(await ui.find({ type: 'Button', key: 'draft-save' })).toBeDefined()
    await ui.press({ key: 'draft-save' })
    expect(await ui.find({ type: 'Button', key: 'draft-save' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^Rust launches$/ })).toBeDefined()
    await ui.unmount()
  }

  expect(prompts[0]?.endsWith('Request: Rust launches with 100+ points today')).toBe(true)
  const cards = saved.get('cards') as CardSpec[]
  expect(cards.length).toBe(2)
  expect(cards[0]).toMatchObject({ title: 'Rust launches', source: 'show', minPoints: 100 })
})

test('refresh fills the default cards from TinyFish', { options: { tinyfish_api_key: 'test-key' } }, async ($, on) => {
  const saved = new Map<string, unknown>()
  on('store.get', ($, e) => ({ value: saved.get(e.key) }))
  on('store.set', ($, e) => {
    saved.set(e.key, e.value)
    return { value: undefined }
  })
  mock.clock(on, { now: NOW })
  const fetched: string[] = []
  on('http.fetch', ($, e) => {
    fetched.push(e.url)
    return { value: network(e) }
  })
  on('model.complete', () => ({ value: { isAnswered: true, text: THEMES_REPLY, usage: USAGE } }))
  on('command.register', () => ({ value: { command: 'hn' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', () => ({ cwd: '/work' }))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'refresh' })

  expect(await ui.find({ type: 'Link', text: /Cloudflare acquires Deno/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Developer tools/ })).toBeDefined()
  expect(fetched.every(url => !url.includes('test-key'))).toBe(true)
  expect((saved.get('cards') as CardSpec[]).map(card => card.id)).toEqual(['trending', 'themes'])
})

test('the band shows the top story while the pane waits', { options: { tinyfish_api_key: 'test-key' } }, async ($, on) => {
  const saved = new Map<string, unknown>()
  on('store.get', ($, e) => ({ value: saved.get(e.key) }))
  on('store.set', ($, e) => {
    saved.set(e.key, e.value)
    return { value: undefined }
  })
  mock.clock(on, { now: NOW })
  on('http.fetch', ($, e) => ({ value: network(e) }))
  on('model.complete', () => ({ value: { isAnswered: true, text: THEMES_REPLY, usage: USAGE } }))
  on('command.register', () => ({ value: { command: 'hn' } }))
  on('ui.open', () => ({ value: { isPlaced: false, reason: 'the terminal is narrower than 144 columns' } }))
  on('session.start', () => ({ cwd: '/work' }))
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await pane.press({ key: 'refresh' })
  await pane.unmount()

  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ ...BAND, surface })
    expect(await band.find({ type: 'Button', key: 'band-open' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /Cloudflare acquires Deno/ })).toBeDefined()
    await band.unmount()
  }
})
