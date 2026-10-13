# HN pulse

A Claude Code mod that shows what is trending on Hacker News in a pane beside your session.
You program the pane in plain language. The main chat stays free.

- **Trends:** every 15 minutes, the mod reads the HN lists through [TinyFish Fetch](https://docs.tinyfish.ai/fetch-api) and measures points per hour and rank movement.
- **Programmable cards:** type "Rust launches with 100+ points today" in the pane. Claude (Haiku) turns it into a card spec. You see a preview, then you add it.
- **Search cards:** topics go through [TinyFish Search](https://docs.tinyfish.ai/search-api), limited to `news.ycombinator.com`. The official HN item API adds points, comments and time.
- **Catch-up:** after more than 12 hours away, a card lists the top stories of each day that you missed, with a short digest.
- **Thread summaries:** press `▸` beside a story. The mod reads the thread and writes three lines under it, in the pane.

## Install

```
/plugin install hn-mod --marketplace aravindputrevu/claude-code-mods
```

Answer `y` to add the marketplace, then select a scope.

To run it from a folder while you develop it:

```bash
claude --plugin-dir /path/to/hn-mod
```

## TinyFish access

The mod uses the first of these that it finds:

1. The **TinyFish API key** option (stored in secure storage).
2. The `TINYFISH_API_KEY` environment variable.
3. The `tinyfish` CLI and its own login (`tinyfish auth login`). The CLI has no time-window filter, so search cards filter the results by story time.

Get a key at [agent.tinyfish.ai/api-keys](https://agent.tinyfish.ai/api-keys). Search is free up to 12,000 requests a day, and Fetch up to 1,000 URLs a day.

## Use

| Action | How |
| --- | --- |
| Open the pane | It opens at session start. In a narrow terminal, press **Open** on the band above the prompt, or run `/hn` |
| Add a card | Type what to track in the `+` box and press Enter, then press **Add card** |
| Change a card | Press **edit** on the card, type the change ("only the last 6 hours"), then press **Save card** |
| Move or remove a card | Press **↑**, **↓** or **x** on the card |
| Read a thread | Press **▸** beside a story |
| Refresh every card | Press **Refresh** (`r`), or run `/hn refresh` |

### The card spec

Each card is one JSON spec. Haiku writes it, and the pane checks it before it adds the card.

| Field | Values |
| --- | --- |
| `source` | `front`, `new`, `show`, `ask`, `search` |
| `query` | Search terms for `search`; a title filter for the lists (split alternatives with `\|`) |
| `window` | `1h`, `6h`, `24h`, `7d`, `30d` (`front` with `7d` or `30d` reads the daily archive) |
| `minPoints`, `minComments` | Whole numbers |
| `sort` | `velocity` (points per hour), `points`, `comments`, `new` |
| `view` | `list`, `spark`, `themes`, `digest` |
| `limit` | 1 to 15 |
| `everyMinutes` | 5 to 1440 |

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `tinyfish_api_key` | empty | TinyFish API key (sensitive) |
| `tinyfish_cli` | `tinyfish` | The CLI command when no key is set. Use an absolute path if Claude Code does not find it on `PATH` |
| `model` | `haiku` | The model for card specs, digests, themes and thread summaries |
| `snapshot_minutes` | `15` | How often the mod reads the HN lists |
| `auto_open` | `true` | Open the pane at session start |

The model calls use your Claude Code usage. Digests and themes run again only when their stories change.

## Develop

```bash
claude plugin validate .
claude plugin test .
```

- `hooks/register.tsx` holds every call on `$`. The validator follows `$` only into functions of the same file.
- `hooks/sources.ts` reads the TinyFish replies and the HN list pages. `hooks/trend.ts` has the trend math. `hooks/spec.ts` checks card specs. `hooks/compile.ts` and `hooks/digest.ts` hold the model prompts. `hooks/pane.tsx` draws the pane and the band.
- `tests/fixtures.ts` is a real TinyFish Fetch reply for the HN front page, with the user names replaced.
