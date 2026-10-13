import type { Row, Theme } from '../types'
import { jsonIn } from './compile'
import { trendOf } from './trend'

/**
 * A model request: the instructions, the prompt and the reply cap. Haiku 5.5 thinks by default,
 * and its thinking counts against the cap, so each cap leaves room for thinking and the answer.
 */
export type Ask = { system: string; prompt: string; maxTokens: number }

const line = (row: Row): string =>
  `- ${row.title}${row.points === undefined ? '' : ` (${row.points} points, ${row.comments ?? 0} comments)`}`

/** Two sentences on what a card's stories have in common. */
export const digestAsk = (title: string, rows: readonly Row[]): Ask => ({
  system:
    'You summarize Hacker News stories for a busy developer. Write two short plain sentences, at most 45 words in all. No lists, no headings, no preamble.',
  prompt: `Card: ${title}\nStories:\n${rows.map(line).join('\n')}`,
  maxTokens: 1500,
})

/** Up to four bullets on what the person did not see while away. */
export const catchupAsk = (days: ReadonlyArray<{ day: string; rows: readonly Row[] }>): Ask => ({
  system:
    'You brief a developer who was away from Hacker News. Write at most four bullets, each one line under 20 words, starting with "- ". Name the topics, not the counts. No preamble.',
  prompt: days.map(d => `${d.day}:\n${d.rows.slice(0, 12).map(line).join('\n')}`).join('\n\n'),
  maxTokens: 2000,
})

/** Three short lines on a thread, from the page text TinyFish Fetch returned. */
export const threadAsk = (title: string, page: string): Ask => ({
  system:
    'You summarize a Hacker News thread in exactly three short lines: what the post is; what most commenters agree on; the main disagreement. Each line under 20 words. No preamble.',
  prompt: `Title: ${title}\n\n${page.slice(0, 14_000)}`,
  maxTokens: 1500,
})

/** Groups titles into themes, with one count for each bucket (a day), oldest bucket first. */
export const themesAsk = (buckets: ReadonlyArray<{ label: string; rows: readonly Row[] }>, limit: number): Ask => ({
  system: `You find themes in Hacker News titles. Reply with JSON only: {"themes":[{"name":"...","perBucket":[n,...]}]}. Give at most ${limit} themes, each a 1 to 4 word name. "perBucket" has one count for each bucket, in the order given. Count a title in at most one theme. Skip one-off topics.`,
  prompt: buckets.map((b, i) => `Bucket ${i + 1} (${b.label}):\n${b.rows.map(row => `- ${row.title}`).join('\n')}`).join('\n\n'),
  maxTokens: 4000,
})

/** The themes in a reply, rising first, then by count. */
export function themesIn(reply: string, buckets: number, limit: number): Theme[] {
  const json = jsonIn(reply) as { themes?: unknown } | undefined
  const list = Array.isArray(json?.themes) ? json.themes : []
  const themes: Theme[] = []
  for (const one of list as Array<Record<string, unknown>>) {
    if (typeof one.name !== 'string' || one.name.trim() === '') continue
    const spark = (Array.isArray(one.perBucket) ? one.perBucket : [])
      .slice(0, buckets)
      .map(n => (typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0))
    const count = spark.reduce((a, b) => a + b, 0)
    if (count === 0) continue
    themes.push({ name: one.name.trim().slice(0, 40), count, trend: trendOf(spark), spark })
  }
  const order = { up: 0, flat: 1, down: 2 } as const
  return themes.sort((a, b) => order[a.trend] - order[b.trend] || b.count - a.count).slice(0, limit)
}
