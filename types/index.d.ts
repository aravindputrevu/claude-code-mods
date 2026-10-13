export type Source = 'front' | 'new' | 'show' | 'ask' | 'search'
export type Window = '1h' | '6h' | '24h' | '7d' | '30d'
export type Sort = 'velocity' | 'points' | 'comments' | 'new'
export type View = 'list' | 'spark' | 'themes' | 'digest'

/** One card of the pane: the program the plain-language box writes. */
export type CardSpec = {
  id: string
  title: string
  source: Source
  /** Search terms for `search`; a title filter (alternatives split by `|`) for the lists. */
  query?: string
  window: Window
  minPoints?: number
  minComments?: number
  sort: Sort
  view: View
  limit: number
  everyMinutes: number
}

/** One HN story as a card draws it. */
export type Row = {
  id: number
  title: string
  url: string
  site?: string
  points?: number
  comments?: number
  /** When the story was posted, in ms since the epoch. */
  time?: number
  rank?: number
  /** Points per hour: between snapshots when there are two, else since the post. */
  velocity?: number
  /** Ranks moved up since the snapshot the velocity compares with. */
  rankDelta?: number
  isNew?: boolean
  /** Points at each snapshot, oldest first. */
  spark?: number[]
}

export type Theme = { name: string; count: number; trend: 'up' | 'flat' | 'down'; spark: number[] }

export type CardData = {
  rows: Row[]
  /** Stories per time bucket over the card's window, oldest first. */
  spark?: number[]
  themes?: Theme[]
  digest?: string
  updatedAt: number
  error?: string
  isLoading?: boolean
}

/** What the plain-language box holds while a spec is written or checked. */
export type Draft = {
  text: string
  spec?: CardSpec
  error?: string
  isBusy: boolean
  /** The card a saved draft replaces. */
  editId?: string
}

export type Expanded = { cardId: string; itemId: number; text?: string; isBusy: boolean }

export type CatchUp = {
  since: number
  days: string[]
  rows: Row[]
  digest?: string
  isBusy: boolean
  error?: string
}

export type Status = { mode: 'api' | 'cli'; refreshedAt: number; note?: string }

declare module 'claude-code' {
  interface PluginState {
    'hn-mod': {
      cards: CardSpec[]
      data: Record<string, CardData>
      draft: Draft | null
      editing: string | null
      expanded: Expanded | null
      catchup: CatchUp | null
      status: Status
      paneShown: boolean
      bandHidden: boolean
    }
  }
}
