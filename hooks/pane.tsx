import type { Elements } from 'claude-code'

import type { CardData, CardSpec, CatchUp, Draft, Expanded, Row, Status } from '../types'
import { itemUrl } from './sources'
import { chips } from './spec'
import { ago, rate, sparkline } from './trend'

/** The elements the pane draws with; `Input` is absent where a surface draws no field. */
export type El = Pick<Elements['desktop'], 'Box' | 'Text' | 'Button' | 'Link'> & {
  Input?: Elements['desktop']['Input']
}

export type Actions = {
  refresh: () => void
  submit: (text: string) => void
  saveDraft: () => void
  cancelDraft: () => void
  edit: (id: string) => void
  move: (id: string, by: -1 | 1) => void
  remove: (id: string) => void
  toggle: (cardId: string, row: Row) => void
  dismissCatchup: () => void
}

export type PaneModel = {
  cards: readonly CardSpec[]
  data: Readonly<Record<string, CardData>>
  draft: Draft | null
  editing: string | null
  expanded: Expanded | null
  catchup: CatchUp | null
  status: Status
  now: number
  width: number
}

const clip = (text: string, width: number): string =>
  text.length <= width ? text : `${text.slice(0, Math.max(1, width - 1))}…`

const pad = (text: string, width: number): string => text.padStart(width)

const ARROW = { up: '↑', flat: '→', down: '↓' } as const

function rowLines(el: El, a: Actions, card: CardSpec, rows: readonly Row[], m: PaneModel, inner: number) {
  const { Box, Text, Button, Link } = el
  const showSpark = card.view === 'spark' && card.source !== 'search'
  const titleWidth = Math.max(12, inner - (showSpark ? 34 : 26))
  return rows.map((row, i) => {
    const isOpen = m.expanded?.cardId === card.id && m.expanded.itemId === row.id
    const delta = row.isNew === true ? 'new' : row.rankDelta ? `${row.rankDelta > 0 ? '↑' : '↓'}${Math.abs(row.rankDelta)}` : ''
    return (
      <Box key={`row-${card.id}-${row.id}`} flexDirection="column">
        <Box flexDirection="row">
          <Button key={`open-${card.id}-${row.id}`} label={isOpen ? '▾' : '▸'} plain onPress={() => a.toggle(card.id, row)} />
          <Text dimColor>{pad(String(i + 1), 3)} </Text>
          <Box flexGrow={1}>
            <Link href={row.url} label={clip(row.title, titleWidth)} />
          </Box>
          {showSpark && <Text color="suggestion"> {pad(sparkline(row.spark ?? []), 8)}</Text>}
          <Text> {pad(row.points === undefined ? '' : String(row.points), 5)}</Text>
          <Link href={itemUrl(row.id)} label={pad(row.comments === undefined ? '' : `${row.comments}c`, 6)} />
          <Text color={(row.velocity ?? 0) >= 20 ? 'success' : 'subtle'}> {pad(rate(row.velocity), 6)}</Text>
          <Text color={row.isNew === true ? 'suggestion' : (row.rankDelta ?? 0) > 0 ? 'success' : 'subtle'}> {pad(delta, 3)}</Text>
        </Box>
        {isOpen && (
          <Box paddingLeft={4}>
            <Text dimColor wrap="wrap">
              {m.expanded?.isBusy === true ? 'Reading the thread…' : (m.expanded?.text ?? '')}
            </Text>
          </Box>
        )}
      </Box>
    )
  })
}

function cardBox(el: El, a: Actions, card: CardSpec, index: number, m: PaneModel) {
  const { Box, Text, Button } = el
  const data = m.data[card.id]
  const inner = Math.max(20, m.width - 4)
  const rows = data?.rows ?? []
  const updated = data === undefined || data.updatedAt === 0 ? 'waiting' : ago(m.now - data.updatedAt)
  return (
    <Box key={`card-${card.id}`} flexDirection="column" borderStyle="round" borderColor={m.editing === card.id ? 'suggestion' : 'subtle'} paddingX={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text wrap="truncate-end">
          <Text bold>{card.title}</Text>
          <Text dimColor> · {data?.isLoading === true ? 'refreshing…' : updated}</Text>
        </Text>
        <Box flexDirection="row" columnGap={1}>
          <Button key={`edit-${card.id}`} label="edit" plain dimColor onPress={() => a.edit(card.id)} />
          {index > 0 && <Button key={`up-${card.id}`} label="↑" plain dimColor onPress={() => a.move(card.id, -1)} />}
          {index < m.cards.length - 1 && <Button key={`down-${card.id}`} label="↓" plain dimColor onPress={() => a.move(card.id, 1)} />}
          <Button key={`remove-${card.id}`} label="x" plain dimColor onPress={() => a.remove(card.id)} />
        </Box>
      </Box>
      <Text dimColor wrap="truncate-end">{chips(card).join(' · ')}</Text>
      {data?.error !== undefined && <Text color="error" wrap="wrap">{data.error}</Text>}
      {data?.digest !== undefined && card.view === 'digest' && <Text wrap="wrap">{data.digest}</Text>}
      {data?.spark !== undefined && card.view === 'spark' && (
        <Text>
          <Text color="suggestion">{sparkline(data.spark)}</Text>
          <Text dimColor> {data.spark.reduce((s, n) => s + n, 0)} stories over {card.window}</Text>
        </Text>
      )}
      {card.view === 'themes'
        ? (data?.themes ?? []).map(theme => (
            <Text key={`theme-${card.id}-${theme.name}`} wrap="truncate-end">
              <Text color={theme.trend === 'up' ? 'success' : theme.trend === 'down' ? 'error' : 'subtle'}>{ARROW[theme.trend]} </Text>
              <Text>{theme.name} </Text>
              <Text color="suggestion">{sparkline(theme.spark)}</Text>
              <Text dimColor> {theme.count} stories</Text>
            </Text>
          ))
        : rowLines(el, a, card, rows, m, inner)}
      {rows.length === 0 && card.view !== 'themes' && data?.error === undefined && (
        <Text dimColor>{data?.isLoading === false ? 'No stories match yet.' : 'Loading…'}</Text>
      )}
      {card.view === 'themes' && (data?.themes ?? []).length === 0 && data?.error === undefined && (
        <Text dimColor>{data?.isLoading === false ? 'No themes yet.' : 'Reading the archive…'}</Text>
      )}
    </Box>
  )
}

function catchupBox(el: El, a: Actions, c: CatchUp, m: PaneModel) {
  const { Box, Text, Button, Link } = el
  const span = c.days.length === 0 ? 'today' : c.days.length === 1 ? '1 day' : `${c.days.length} days`
  return (
    <Box key="catchup" flexDirection="column" borderStyle="round" borderColor="suggestion" paddingX={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text wrap="truncate-end">
          <Text bold>Since your last visit</Text>
          <Text dimColor> · {ago(m.now - c.since)} · {span}</Text>
        </Text>
        <Button key="catchup-dismiss" label="x" plain dimColor onPress={a.dismissCatchup} />
      </Box>
      {c.error !== undefined && <Text color="error" wrap="wrap">{c.error}</Text>}
      {c.digest !== undefined
        ? <Text wrap="wrap">{c.digest}</Text>
        : c.isBusy && <Text dimColor>Reading the days you missed…</Text>}
      {c.rows.slice(0, 5).map(row => (
        <Box key={`catchup-${row.id}`} flexDirection="row">
          <Box flexGrow={1}>
            <Link href={row.url} label={clip(row.title, Math.max(12, m.width - 20))} />
          </Box>
          <Text dimColor> {row.points ?? ''} pts</Text>
        </Box>
      ))}
    </Box>
  )
}

function programBox(el: El, a: Actions, m: PaneModel) {
  const { Box, Text, Button, Input } = el
  const editing = m.editing === null ? undefined : m.cards.find(card => card.id === m.editing)
  const draft = m.draft
  const placeholder = draft?.spec !== undefined
    ? 'Change the preview: only the last 6 hours'
    : editing !== undefined
      ? `Change "${editing.title}": only Rust, top 3`
      : 'Track something: Rust launches with 100+ points today'
  return (
    <Box key="program" flexDirection="column">
      {Input !== undefined
        ? (
            <Input
              key="program"
              label="+"
              placeholder={placeholder}
              value=""
              submitLabel={draft?.spec !== undefined ? 'refine' : editing !== undefined ? 'change' : 'add'}
              autoFocus
              onSubmit={text => a.submit(text)}
            />
          )
        : <Text dimColor>Open HN pulse in the terminal or the desktop app to add cards.</Text>}
      {draft?.isBusy === true && <Text dimColor>Writing the card spec for "{clip(draft.text, 40)}"…</Text>}
      {draft?.error !== undefined && <Text color="error" wrap="wrap">{draft.error}</Text>}
      {draft?.spec !== undefined && (
        <Box flexDirection="column" borderStyle="dashed" borderColor="suggestion" paddingX={1}>
          <Text wrap="wrap">
            <Text bold>{draft.spec.title}</Text>
            <Text dimColor> · {chips(draft.spec).join(' · ')}</Text>
          </Text>
          <Box flexDirection="row" columnGap={2}>
            <Button key="draft-save" label={draft.editId === undefined ? 'Add card' : 'Save card'} variant="primary" onPress={a.saveDraft} />
            <Button key="draft-cancel" label="Cancel" onPress={a.cancelDraft} />
          </Box>
        </Box>
      )}
      {editing !== undefined && draft?.spec === undefined && draft?.isBusy !== true && (
        <Box flexDirection="row" columnGap={1}>
          <Text dimColor>Type a change for "{editing.title}" and press Enter.</Text>
          <Button key="edit-cancel" label="Stop editing" plain dimColor onPress={a.cancelDraft} />
        </Box>
      )}
    </Box>
  )
}

/** The whole pane: header, the plain-language box, the catch-up card, then the cards. */
export function paneTree(el: El, a: Actions, m: PaneModel) {
  const { Box, Text, Button } = el
  const route = m.status.mode === 'api' ? 'TinyFish API' : 'TinyFish CLI'
  const refreshed = m.status.refreshedAt === 0 ? 'starting' : `refreshed ${ago(m.now - m.status.refreshedAt)}`
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text wrap="truncate-end">
          <Text bold color="claude">HN pulse</Text>
          <Text dimColor> · {route} · {refreshed}</Text>
        </Text>
        <Button key="refresh" label="Refresh" hotkey="r" plain onPress={a.refresh} />
      </Box>
      {programBox(el, a, m)}
      {m.catchup !== null && catchupBox(el, a, m.catchup, m)}
      {m.cards.map((card, i) => cardBox(el, a, card, i, m))}
      {m.cards.length === 0 && <Text dimColor>No cards. Type what to track in the box above.</Text>}
    </Box>
  )
}

/** One line above the prompt while the pane is not on screen. */
export function bandTree(el: El, top: Row | undefined, fresh: number, open: () => void, hide: () => void, width: number) {
  const { Box, Text, Button } = el
  return (
    <Box flexDirection="row" columnGap={1}>
      <Text bold color="claude">HN</Text>
      <Box flexGrow={1}>
        <Text wrap="truncate-end">
          {top === undefined ? 'Reading the front page…' : clip(top.title, Math.max(12, width - 34))}
          <Text color="success"> {rate(top?.velocity)}</Text>
          {fresh > 0 && <Text dimColor> · {fresh} new</Text>}
        </Text>
      </Box>
      <Button key="band-open" label="Open" onPress={open} />
      <Button key="band-hide" label="Hide" plain dimColor onPress={hide} />
    </Box>
  )
}
