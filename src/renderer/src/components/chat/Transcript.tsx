import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Brain, Check, Copy, Keyboard, Mic, Play, Scissors, Square, Volume2, Zap } from 'lucide-react'
import type { ChatMessage, UserTiming } from '@shared/types'
import { T } from '../../theme'
import { useStore } from '../../state/store'
import { Bars } from '../primitives'
import { ToolPill } from './ToolPill'
import { formatTokens } from '../../lib/format'
import { splitBySentences, splitInterrupted } from '../../lib/spoken'

/**
 * Only this many of the newest messages are mounted. A long session has hundreds of bubbles, and
 * mounting them all made every streamed token a full-transcript render that starved audio playback.
 */
const RENDER_WINDOW = 80

const secs = (ms: number): string => `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)} s`

function Chip({ children, color, title }: { children: ReactNode; color?: string; title?: string }) {
  return (
    <span className="inline-flex items-center gap-1 text-xs rounded px-1.5 py-0.5" style={{ background: T.raised, color: color ?? T.text3, fontFamily: T.mono }} title={title}>
      {children}
    </span>
  )
}

/** How the ears closed this turn, as small chips under the user's bubble. */
function TimingChips({ t }: { t: UserTiming }) {
  const chips: ReactNode[] = []
  if (t.speechMs !== undefined) chips.push(<Chip key="len" title="how long you spoke">{secs(t.speechMs)}</Chip>)
  if (t.endReason === 'done') {
    chips.push(
      <Chip key="end" title="Smart Turn ended the turn: pause length and its confidence that you were done">
        pause {t.silenceMs ?? 0} ms{t.turnP !== undefined && t.turnP !== null ? ` · p ${t.turnP.toFixed(2)}` : ''}
      </Chip>
    )
  } else if (t.endReason === 'timeout') {
    const cap = t.capMs ?? undefined
    const label = cap !== undefined && cap >= 60_000 ? 'max length' : cap !== undefined ? `waited ${secs(cap)}` : 'timeout'
    chips.push(
      <Chip key="end" color={T.amber} title="the turn ended on a hard cap, not on Smart Turn: you were probably still going (see docs/TUNING.md)">
        {label}{t.turnP !== undefined && t.turnP !== null ? ` · p ${t.turnP.toFixed(2)}` : ''}
      </Chip>
    )
  }
  if (t.merged) chips.push(<Chip key="merged" color={T.cyan} title="you kept talking after a pause; the pieces were joined into one turn">merged{t.parts ? ` ${t.parts} parts` : ''}</Chip>)
  if (t.segments) chips.push(<Chip key="seg" title="a long monologue transcribed in segments while you spoke">{t.segments + 1} segments</Chip>)
  if (t.cutAgent) {
    chips.push(
      <Chip key="cut" color={T.amber} title="this utterance interrupted the agent">
        <Zap size={10} /> cut in
      </Chip>
    )
  }
  if (t.resumed) {
    chips.push(
      <Chip key="resumed" color={T.cyan} title={t.resumed === 'backchannel' ? 'just an acknowledgement: the reply carried on from the cut sentence' : t.resumed === 'empty' ? 'the cut had no words in it: the reply carried on' : 'you asked for the rest: replayed from the cut sentence, no model call'}>
        <Play size={10} /> resumed
      </Chip>
    )
  }
  if (!chips.length) return null
  return <div className="flex flex-wrap gap-1 justify-end pr-1">{chips}</div>
}

const UserBubble = memo(function UserBubble({ m, gapMs }: { m: ChatMessage; gapMs: number | null }) {
  return (
    <div className="flex flex-col gap-2 items-end">
      {gapMs !== null && (
        <span className="self-center text-xs" style={{ color: T.text3, fontFamily: T.mono }} title="quiet time between the reply finishing and you speaking">
          · {secs(gapMs)} later
        </span>
      )}
      <div className="self-end flex flex-col gap-1 va-fade" style={{ maxWidth: '70%' }}>
        <div className="px-4 py-3 text-sm flex items-start gap-2" style={{ background: T.raised, borderRadius: '16px 16px 4px 16px', lineHeight: 1.5 }}>
          {m.via === 'voice' ? (
            <Mic size={12} style={{ color: T.text2, flexShrink: 0, marginTop: 4 }} />
          ) : (
            <Keyboard size={12} style={{ color: T.text2, flexShrink: 0, marginTop: 4 }} />
          )}
          <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: m.streaming ? T.text2 : T.text }}>
            {m.text}
            {m.streaming && (
              <span className="va-pulse" style={{ color: T.text3 }}>
                {' ▍'}
              </span>
            )}
          </span>
        </div>
        {m.timing && <TimingChips t={m.timing} />}
      </div>
    </div>
  )
})

/**
 * Reply text with the sentence being spoken highlighted, spoken ones plain, upcoming ones dimmed.
 * Subscriptions are scoped to this turn so a bubble that is not playing never re-renders when
 * another one does.
 */
function ReplyText({ m }: { m: ChatMessage }) {
  const live = useStore((s) => (s.speaking && s.speaking.turnId === m.turnId ? s.speaking.seq : null))
  const chunks = useStore((s) => s.chunkTexts[m.turnId])
  const spans = useMemo(() => (m.text && !m.interrupted ? splitBySentences(m.text, chunks ?? [], live) : null), [m.text, m.interrupted, chunks, live])
  if (!m.text) return m.streaming ? <span style={{ color: T.text3 }}>…</span> : null

  if (m.interrupted) {
    const split = splitInterrupted(m.text, m.spokenText, m.unspokenText)
    if (split) {
      return (
        <>
          {split.heard}
          <span title="you cut in here" style={{ color: T.amber, margin: '0 4px', verticalAlign: 'middle', display: 'inline-flex' }}>
            <Scissors size={11} />
          </span>
          <span style={{ color: T.text3 }} title="generated but never spoken">
            {split.rest}
          </span>
        </>
      )
    }
    return <>{m.text}</>
  }

  if (!spans || (spans.length === 1 && spans[0]!.state === 'plain')) return <>{m.text}</>
  return (
    <>
      {spans.map((s, i) => {
        if (s.state === 'current') {
          return (
            <span key={i} style={{ color: T.text, background: T.cyanTint, boxShadow: `inset 3px 0 0 ${T.cyan}`, paddingLeft: 4, marginLeft: -4, borderRadius: 3 }}>
              {s.text}
            </span>
          )
        }
        return (
          <span key={i} style={{ color: s.state === 'upcoming' ? T.text3 : T.text }}>
            {s.text}
          </span>
        )
      })}
    </>
  )
}

const AssistantBubble = memo(function AssistantBubble({
  m,
  speaking,
  onSpeak,
  onStop
}: {
  m: ChatMessage
  speaking: boolean
  onSpeak: (id: string) => void
  onStop: () => void
}) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(m.text)
    } catch {
      // clipboard blocked
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1200)
  }
  const interruptedTitle = m.interrupted ? `heard: "${m.spokenText ?? ''}"\nnot heard: "${m.unspokenText ?? ''}"` : undefined
  return (
    <div className="self-start flex flex-col gap-1.5 va-fade" style={{ maxWidth: '70%' }}>
      <div
        className="px-4 py-3 text-sm"
        style={{
          background: T.surface,
          border: `1px solid ${T.border}`,
          borderRadius: '16px 16px 16px 4px',
          lineHeight: 1.55,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word'
        }}
      >
        <ReplyText m={m} />
        {m.streaming && m.text && (
          <span className="va-pulse" style={{ color: T.text3 }}>
            {' ▍'}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1 pl-1">
        <button
          aria-label={speaking ? 'Stop' : 'Read aloud'}
          onClick={speaking ? onStop : () => onSpeak(m.id)}
          className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs"
          style={{ color: speaking ? T.cyan : T.text3, background: 'transparent', border: 'none', cursor: 'pointer' }}
        >
          {speaking ? <Bars color={T.cyan} h={12} /> : <Volume2 size={13} />}
          {speaking && <span>tap to stop</span>}
        </button>
        <button
          aria-label="Copy"
          onClick={() => void copy()}
          className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs"
          style={{ color: copied ? T.green : T.text3, background: 'transparent', border: 'none', cursor: 'pointer' }}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied && <span>copied</span>}
        </button>
        {m.interrupted && (
          <span className="inline-flex items-center gap-1 text-xs rounded px-1.5 py-0.5 ml-1" style={{ color: T.amber, background: T.amberTint }} title={interruptedTitle}>
            <Square size={9} /> interrupted
          </span>
        )}
        {!m.interrupted && (m.resumeCount ?? 0) > 0 && (
          <span className="inline-flex items-center gap-1 text-xs rounded px-1.5 py-0.5 ml-1" style={{ color: T.cyan, background: T.cyanTint }} title="replayed from the cut sentence after an interruption">
            <Play size={9} /> resumed{(m.resumeCount ?? 0) > 1 ? ` ×${m.resumeCount}` : ''}
          </span>
        )}
        {(m.metrics?.speechEndToAudioMs ?? m.metrics?.ttfaMs) !== undefined && (
          <span
            className="text-xs ml-1"
            style={{ color: T.text3, fontFamily: T.mono }}
            title={m.metrics?.speechEndToAudioMs !== undefined ? 'end of your speech to first audio' : 'time to first audio'}
          >
            {Math.round((m.metrics?.speechEndToAudioMs ?? m.metrics?.ttfaMs)!)}ms
          </span>
        )}
        {m.metrics?.inputTokens !== undefined && m.metrics?.outputTokens !== undefined && (
          <span className="text-xs ml-1" style={{ color: T.text3, fontFamily: T.mono }} title="tokens in / out">
            {formatTokens(m.metrics.inputTokens)}/{formatTokens(m.metrics.outputTokens)}
          </span>
        )}
      </div>
    </div>
  )
})

function MemoryConfirmChip() {
  const pending = useStore((s) => s.pendingSave)
  if (!pending) return null
  const answer = (accept: boolean) => void window.api.memory.confirm(pending.id, accept)
  const deleting = pending.action === 'delete'
  return (
    <div className="self-start inline-flex items-center gap-2 rounded-lg px-3 py-2 text-xs va-fade" style={{ background: deleting ? T.redTint : T.amberTint, color: deleting ? T.red : T.amber }}>
      <Brain size={12} />
      <span>{deleting ? `Forget "${pending.key}"?` : `Save "${pending.key}" as ${pending.kind}?`}</span>
      <span style={{ color: T.text2 }}>{pending.value}</span>
      <button className="underline" style={{ background: 'none', border: 'none', color: T.amber, cursor: 'pointer', padding: 0 }} onClick={() => answer(true)}>
        Yes
      </button>
      <button className="underline" style={{ background: 'none', border: 'none', color: T.text3, cursor: 'pointer', padding: 0 }} onClick={() => answer(false)}>
        No
      </button>
    </div>
  )
}

/** A quiet gap between the previous reply finishing and the user speaking again. */
export function pauseBefore(messages: ChatMessage[], index: number): number | null {
  const m = messages[index]
  if (!m || m.role !== 'user' || !m.timing?.speechEndAt || m.timing.speechMs === undefined) return null
  for (let i = index - 1; i >= 0; i--) {
    const p = messages[i]!
    if (p.role !== 'assistant') continue
    const end = p.createdAt + (p.metrics?.totalMs ?? 0)
    const start = m.timing.speechEndAt - m.timing.speechMs
    const gap = start - end
    return gap >= 1500 ? gap : null
  }
  return null
}

export function Transcript() {
  const messages = useStore((s) => s.messages)
  const agentState = useStore((s) => s.agentState)
  const partial = useStore((s) => s.partial)
  const listening = useStore((s) => s.listening)
  const activeSessionId = useStore((s) => s.activeSessionId)
  const [readingId, setReadingId] = useState<string | null>(null)
  const [extraShown, setExtraShown] = useState(0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  useEffect(() => {
    if (agentState !== 'speaking' && agentState !== 'thinking' && agentState !== 'tool') setReadingId(null)
  }, [agentState])

  useEffect(() => setExtraShown(0), [activeSessionId])

  const last = messages[messages.length - 1]
  const lastKey = last ? `${last.id}:${last.text.length}:${last.streaming ? 1 : 0}` : ''
  useEffect(() => {
    const el = scrollRef.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [messages.length, lastKey, partial, agentState])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  const lastAssistantId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === 'assistant') return messages[i]!.id
    return null
  }, [messages])
  const speakingId = readingId ?? (agentState === 'speaking' ? lastAssistantId : null)

  const speak = useCallback((id: string) => {
    setReadingId(id)
    void window.api.speak.message(id)
  }, [])
  const stop = useCallback(() => {
    setReadingId(null)
    void window.api.speak.stop()
  }, [])

  const from = Math.max(0, messages.length - RENDER_WINDOW - extraShown)
  const hidden = from

  return (
    <div ref={scrollRef} onScroll={onScroll} className="va-scroll flex-1 overflow-y-auto px-6 pt-6" style={{ paddingBottom: 200 }}>
      <div className="mx-auto flex flex-col gap-5" style={{ maxWidth: 720 }}>
        {messages.length === 0 && (
          <div className="text-sm mt-16 text-center" style={{ color: T.text3, lineHeight: 1.6 }}>
            Press Voice and start talking, or type below.
            <br />
            <span style={{ fontFamily: T.mono }}>Ctrl+Shift+Space</span> toggles the microphone from anywhere.
          </div>
        )}
        {hidden > 0 && (
          <button
            className="self-center text-xs rounded-full px-3 py-1.5"
            style={{ color: T.text3, background: T.raised, border: `1px solid ${T.border}`, cursor: 'pointer' }}
            onClick={() => setExtraShown((n) => n + RENDER_WINDOW)}
            title="older messages are kept but not rendered, so a long session stays responsive"
          >
            Show {Math.min(hidden, RENDER_WINDOW)} earlier ({hidden} hidden)
          </button>
        )}
        {messages.map((m, i) => {
          if (i < from) return null
          if (m.role === 'tool' && m.tool) return <ToolPill key={m.id} tool={m.tool} />
          if (m.role === 'user') return <UserBubble key={m.id} m={m} gapMs={pauseBefore(messages, i)} />
          if (m.role === 'assistant') return <AssistantBubble key={m.id} m={m} speaking={speakingId === m.id} onSpeak={speak} onStop={stop} />
          return null
        })}
        <MemoryConfirmChip />
        {agentState === 'user_speaking' && (
          <div className="self-center inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs va-fade" style={{ background: T.cyanTint, color: T.cyan, maxWidth: '80%' }}>
            <Bars color={T.cyan} h={10} n={4} />
            <span className="truncate">{partial || 'Listening'}</span>
          </div>
        )}
        {agentState === 'listening' && listening && messages.length > 0 && (
          <div className="self-center inline-flex items-center gap-2 rounded-full px-3 py-1.5 text-xs" style={{ color: T.text3 }}>
            <Bars color={T.text3} h={8} n={3} />
            <span>Listening</span>
          </div>
        )}
      </div>
    </div>
  )
}
