import { useEffect, useRef, useState } from 'react'
import { Brain, Check, Copy, Keyboard, Mic, Square, Volume2 } from 'lucide-react'
import type { ChatMessage } from '@shared/types'
import { T } from '../../theme'
import { useStore } from '../../state/store'
import { Bars } from '../primitives'
import { ToolPill } from './ToolPill'
import { formatTokens } from '../../lib/format'

function UserBubble({ m }: { m: ChatMessage }) {
  return (
    <div className="self-end va-fade" style={{ maxWidth: '70%' }}>
      <div className="px-4 py-3 text-sm flex items-start gap-2" style={{ background: T.raised, borderRadius: '16px 16px 4px 16px', lineHeight: 1.5 }}>
        {m.via === 'voice' ? (
          <Mic size={12} style={{ color: T.text2, flexShrink: 0, marginTop: 4 }} />
        ) : (
          <Keyboard size={12} style={{ color: T.text2, flexShrink: 0, marginTop: 4 }} />
        )}
        <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.text}</span>
      </div>
    </div>
  )
}

function AssistantBubble({
  m,
  speaking,
  onSpeak,
  onStop
}: {
  m: ChatMessage
  speaking: boolean
  onSpeak: () => void
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
        {m.text || (m.streaming ? <span style={{ color: T.text3 }}>…</span> : '')}
        {m.streaming && m.text && (
          <span className="va-pulse" style={{ color: T.text3 }}>
            {' ▍'}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1 pl-1">
        <button
          aria-label={speaking ? 'Stop' : 'Read aloud'}
          onClick={speaking ? onStop : onSpeak}
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
          <span className="inline-flex items-center gap-1 text-xs rounded px-1.5 py-0.5 ml-1" style={{ color: T.amber, background: T.amberTint }}>
            <Square size={9} /> interrupted
          </span>
        )}
        {m.metrics?.ttfaMs !== undefined && (
          <span className="text-xs ml-1" style={{ color: T.text3, fontFamily: T.mono }} title="time to first audio">
            {Math.round(m.metrics.ttfaMs)}ms
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
}

function MemoryConfirmChip() {
  const pending = useStore((s) => s.pendingSave)
  if (!pending) return null
  const answer = (accept: boolean) => void window.api.memory.confirm(pending.id, accept)
  return (
    <div className="self-start inline-flex items-center gap-2 rounded-lg px-3 py-2 text-xs va-fade" style={{ background: T.amberTint, color: T.amber }}>
      <Brain size={12} />
      <span>
        Save "{pending.key}" as {pending.kind}?
      </span>
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

export function Transcript() {
  const messages = useStore((s) => s.messages)
  const agentState = useStore((s) => s.agentState)
  const partial = useStore((s) => s.partial)
  const listening = useStore((s) => s.listening)
  const [readingId, setReadingId] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  useEffect(() => {
    if (agentState !== 'speaking' && agentState !== 'thinking' && agentState !== 'tool') setReadingId(null)
  }, [agentState])

  useEffect(() => {
    const el = scrollRef.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [messages, partial, agentState])

  const onScroll = () => {
    const el = scrollRef.current
    if (!el) return
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant')
  const speakingId = readingId ?? (agentState === 'speaking' ? (lastAssistant?.id ?? null) : null)

  const speak = (id: string) => {
    setReadingId(id)
    void window.api.speak.message(id)
  }
  const stop = () => {
    setReadingId(null)
    void window.api.speak.stop()
  }

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
        {messages.map((m) => {
          if (m.role === 'tool' && m.tool) return <ToolPill key={m.id} tool={m.tool} />
          if (m.role === 'user') return <UserBubble key={m.id} m={m} />
          if (m.role === 'assistant')
            return <AssistantBubble key={m.id} m={m} speaking={speakingId === m.id} onSpeak={() => speak(m.id)} onStop={stop} />
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
