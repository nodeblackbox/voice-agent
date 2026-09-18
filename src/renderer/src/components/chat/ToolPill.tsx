import { useEffect, useState } from 'react'
import { BookOpen, Brain, ChevronDown, ChevronRight, Clock, ExternalLink, Globe, Plug, Wrench, type LucideIcon } from 'lucide-react'
import type { ToolActivity, ToolSource } from '@shared/types'
import { T } from '../../theme'
import { faviconUrl, formatElapsed, hostOf, truncate } from '../../lib/format'

const ICONS: Record<ToolActivity['kind'], LucideIcon> = {
  search: Globe,
  read: BookOpen,
  memory: Brain,
  mcp: Plug,
  time: Clock,
  other: Wrench
}

export function useElapsedMs(startedAt: number, endedAt: number | undefined): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (endedAt !== undefined) return
    const id = setInterval(() => setNow(Date.now()), 200)
    return () => clearInterval(id)
  }, [endedAt])
  return Math.max(0, (endedAt ?? now) - startedAt)
}

function SourceChip({ source }: { source: ToolSource }) {
  const [broken, setBroken] = useState(false)
  return (
    <button
      onClick={() => void window.api.shell.open(source.url)}
      title={source.snippet ? `${source.title}\n\n${source.snippet}` : source.url}
      className="inline-flex items-center gap-1.5 rounded-full pl-1.5 pr-2.5 py-1 text-xs va-fade"
      style={{ background: T.surface, border: `1px solid ${T.border}`, color: T.text2, cursor: 'pointer', maxWidth: 240 }}
    >
      {broken ? (
        <Globe size={12} style={{ color: T.text3, flexShrink: 0 }} />
      ) : (
        <img src={faviconUrl(source.url)} width={14} height={14} alt="" style={{ borderRadius: 3, flexShrink: 0 }} onError={() => setBroken(true)} />
      )}
      <span className="truncate">{truncate(source.title || hostOf(source.url), 40)}</span>
      <span className="shrink-0" style={{ color: T.text3, fontFamily: T.mono }}>
        {hostOf(source.url)}
      </span>
      <ExternalLink size={10} style={{ color: T.text3, flexShrink: 0 }} />
    </button>
  )
}

export function ToolPill({ tool }: { tool: ToolActivity }) {
  const elapsed = useElapsedMs(tool.startedAt, tool.endedAt)
  const [open, setOpen] = useState(true)
  const Icon = ICONS[tool.kind] ?? Wrench
  const running = tool.status === 'running'
  const error = tool.status === 'error'
  const cancelled = tool.status === 'cancelled'
  const color = error ? T.amber : cancelled ? T.text3 : T.violet
  const bg = error ? T.amberTint : cancelled ? 'transparent' : T.violetTint
  const sources = tool.sources ?? []
  const hasSources = sources.length > 0

  return (
    <div className="self-center flex flex-col items-center gap-1.5 va-slide" style={{ maxWidth: '85%' }}>
      <div
        className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs ${running ? 'va-glow' : ''}`}
        style={{ background: bg, color, border: `1px solid ${cancelled ? T.border : 'transparent'}`, opacity: cancelled ? 0.7 : 1 }}
        title={tool.detail}
      >
        <Icon size={12} className={running ? 'va-spin-slow' : undefined} style={{ flexShrink: 0 }} />
        <span className={running ? 'va-shimmer' : undefined} style={{ fontWeight: 500 }}>
          {tool.label}
        </span>
        {tool.summary && (
          <span className="truncate" style={{ color: running ? T.text2 : T.text3, maxWidth: 320 }}>
            {tool.kind === 'search' ? `“${tool.summary}”` : tool.summary}
          </span>
        )}
        {tool.server && (
          <span className="rounded px-1.5 py-0.5" style={{ background: 'rgba(185,139,255,.16)', color: T.violet, fontFamily: T.mono, fontSize: 10 }}>
            {tool.server}
          </span>
        )}
        <span style={{ color: T.text3, fontFamily: T.mono }}>
          {cancelled ? 'cancelled' : error ? (tool.detail ? truncate(tool.detail, 60) : 'failed') : formatElapsed(elapsed)}
        </span>
        {!running && !error && !cancelled && tool.detail && (
          <span style={{ color: T.text3 }}>· {tool.detail}</span>
        )}
        {hasSources && (
          <button
            aria-label={open ? 'Hide sources' : 'Show sources'}
            onClick={() => setOpen(!open)}
            className="inline-flex items-center"
            style={{ background: 'none', border: 'none', color: T.text3, cursor: 'pointer', padding: 0 }}
          >
            {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
        )}
      </div>
      {hasSources && open && (
        <div className="flex flex-wrap justify-center gap-1.5 px-2">
          {sources.slice(0, 8).map((s, i) => (
            <SourceChip key={`${s.url}-${i}`} source={s} />
          ))}
        </div>
      )}
      {tool.diff && <MemoryDiff before={tool.diff.before} after={tool.diff.after} />}
    </div>
  )
}

/** Word-level diff of a memory edit: removed words struck through in red, added words in green. */
export function wordDiff(before: string, after: string): Array<{ text: string; kind: 'same' | 'removed' | 'added' }> {
  const tokens = (s: string): string[] => s.split(/(\s+|[.,;:!?()"])/).filter((w) => w !== '')
  const a = tokens(before)
  const b = tokens(after)
  // longest common subsequence over words
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
  const out: Array<{ text: string; kind: 'same' | 'removed' | 'added' }> = []
  let i = 0
  let j = 0
  const push = (text: string, kind: 'same' | 'removed' | 'added'): void => {
    const last = out.at(-1)
    if (last && last.kind === kind) last.text += text
    else out.push({ text, kind })
  }
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push(a[i]!, 'same')
      i++
      j++
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) push(a[i++]!, 'removed')
    else push(b[j++]!, 'added')
  }
  while (i < a.length) push(a[i++]!, 'removed')
  while (j < b.length) push(b[j++]!, 'added')
  return out
}

function MemoryDiff({ before, after }: { before: string; after: string }) {
  const parts = wordDiff(before, after)
  return (
    <div className="text-xs px-3 py-2 rounded-lg" style={{ background: T.surface, border: `1px solid ${T.border}`, maxWidth: 560, lineHeight: 1.6, wordBreak: 'break-word' }}>
      {parts.map((p, i) =>
        p.kind === 'same' ? (
          <span key={i} style={{ color: T.text2 }}>
            {p.text}
          </span>
        ) : p.kind === 'removed' ? (
          <span key={i} style={{ color: T.red, background: T.redTint, textDecoration: 'line-through', borderRadius: 2 }}>
            {p.text}
          </span>
        ) : (
          <span key={i} style={{ color: T.green, background: 'rgba(74,222,128,.12)', borderRadius: 2 }}>
            {p.text}
          </span>
        )
      )}
    </div>
  )
}
