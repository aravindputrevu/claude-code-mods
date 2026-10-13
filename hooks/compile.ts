import type { CardSpec } from '../types'
import { normalize, type Checked } from './spec'

const RULES = `You write card specs for HN pulse, a Hacker News widget inside Claude Code.
Reply with one JSON object and nothing else: no prose, no code fence.

Fields:
- title: a short card title, at most 40 characters.
- source: "front" (the front page), "new" (newest stories), "show" (Show HN), "ask" (Ask HN), or "search" (a web search limited to news.ycombinator.com; it needs "query").
- query: for "search", the search terms. For the other sources, an optional title filter; split alternatives with "|".
- window: "1h", "6h", "24h", "7d" or "30d". For "front", "7d" and "30d" read the daily front-page archive.
- minPoints, minComments: optional whole numbers.
- sort: "velocity" (points per hour, for what rises now), "points", "comments" (for debates) or "new".
- view: "list"; "spark" (a points sparkline per story, or stories over time for a search); "themes" (groups the titles into topics); or "digest" (a two-sentence summary above the list).
- limit: 1 to 15 stories. Default 5.
- everyMinutes: how often the card refreshes, 5 to 1440. Default 15.

Rules:
- Use a list source when the request names an HN section: front page, new, Show HN, Ask HN.
- Use "search" for a topic, product, company, language or person that is not tied to a section.
- "launches" or "projects" means Show HN. "questions" means Ask HN. "debates" or "discussions" means sort by comments.
- "today" means "24h". "this week" means "7d". "this month" means "30d". "trending", "hot" or "rising" means sort by velocity.
- When a current card is given, change only what the request asks for and keep every other field.

Examples:
Request: Rust launches with 100+ points today
{"title":"Rust launches","source":"show","query":"rust","window":"24h","minPoints":100,"sort":"points","view":"list","limit":5,"everyMinutes":15}
Request: what is hot on the front page right now
{"title":"Hot now","source":"front","window":"6h","sort":"velocity","view":"list","limit":8,"everyMinutes":15}
Request: MCP and agent tooling chatter this week, summarized
{"title":"MCP and agents","source":"search","query":"MCP agent tooling","window":"7d","sort":"points","view":"digest","limit":6,"everyMinutes":60}
Request: biggest debates on Ask HN this week
{"title":"Ask HN debates","source":"ask","window":"7d","minComments":50,"sort":"comments","view":"list","limit":5,"everyMinutes":60}
Request: themes of the front page this month
{"title":"Monthly themes","source":"front","window":"30d","sort":"points","view":"themes","limit":8,"everyMinutes":720}
Request: show how Postgres stories trend
{"title":"Postgres","source":"search","query":"Postgres","window":"7d","sort":"new","view":"spark","limit":5,"everyMinutes":60}
Request: brand new posts about LLMs or local models
{"title":"New on LLMs","source":"new","query":"llm|local model|llama|inference","window":"6h","sort":"new","view":"list","limit":6,"everyMinutes":10}
Current card: {"title":"Rust launches","source":"show","query":"rust","window":"24h","minPoints":100,"sort":"points","view":"list","limit":5,"everyMinutes":15}
Request: only the last 6 hours, and show 3
{"title":"Rust launches","source":"show","query":"rust","window":"6h","minPoints":100,"sort":"points","view":"list","limit":3,"everyMinutes":15}`

/** The first JSON object in a reply, with or without a code fence around it. */
export function jsonIn(reply: string): unknown {
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start === -1 || end <= start) return undefined
  try {
    return JSON.parse(reply.slice(start, end + 1))
  } catch {
    return undefined
  }
}

/** The model request that turns plain language into a spec; `current` is the card a change edits. */
export function compileAsk(request: string, current?: CardSpec): { system: string; prompt: string } {
  if (current === undefined) return { system: RULES, prompt: `Request: ${request}` }
  const { id: _id, ...shown } = current
  return { system: RULES, prompt: `Current card: ${JSON.stringify(shown)}\nRequest: ${request}` }
}

/** The model reply as a checked spec, under the card id the pane chose. */
export function checkReply(reply: string, id: string): Checked {
  const raw = jsonIn(reply)
  if (raw === undefined) return { error: 'The model reply was not a JSON spec. Try other words.' }
  return normalize(raw, id)
}
