import { Loader2 } from 'lucide-react'
import type { AgentState, ServiceStatus } from '@shared/types'
import { T } from '../../theme'
import { Dot } from '../primitives'
import { VoiceBars } from '../VoiceBars'
import { truncate } from '../../lib/format'

function describe(state: AgentState, toolLabel: string | null, micMuted: boolean): { text: string; color: string; kind: 'mic' | 'output' | 'pulse' | 'spin' | 'dot' } {
  switch (state) {
    case 'listening':
      return micMuted ? { text: 'Muted', color: T.red, kind: 'dot' } : { text: 'Listening', color: T.cyan, kind: 'mic' }
    case 'user_speaking':
      return { text: 'Hearing you', color: T.cyan, kind: 'mic' }
    case 'thinking':
      return { text: 'Thinking', color: T.violet, kind: 'pulse' }
    case 'tool':
      return { text: toolLabel ?? 'Working', color: T.violet, kind: 'spin' }
    case 'speaking':
      return { text: 'Speaking', color: T.cyan, kind: 'output' }
    case 'interrupted':
      return { text: 'Interrupted', color: T.amber, kind: 'dot' }
    default:
      return { text: 'Idle', color: T.text3, kind: 'dot' }
  }
}

export function StateIndicator({
  state,
  toolLabel,
  toolSummary,
  services,
  micMuted = false
}: {
  state: AgentState
  toolLabel: string | null
  toolSummary?: string | null
  services: Partial<Record<string, ServiceStatus>>
  micMuted?: boolean
}) {
  const warming = Object.values(services).find((s) => s && (s.state === 'starting' || s.state === 'reconnecting'))
  if (warming && (state === 'idle' || state === 'listening')) {
    const text = warming.state === 'starting' ? `Warming up ${warming.name}` : `Reconnecting ${warming.name}`
    return (
      <span className="inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-xs" style={{ background: T.amberTint, color: T.amber }}>
        <Loader2 size={12} className="va-spin" />
        {text}
      </span>
    )
  }
  const d = describe(state, toolLabel, micMuted)
  const tint = state === 'idle' ? 'transparent' : `${d.color}1A`
  return (
    <span className="inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-xs" style={{ background: tint, color: d.color, maxWidth: 360 }}>
      {(d.kind === 'mic' || d.kind === 'output') && <VoiceBars source={d.kind} color={d.color} h={10} n={4} />}
      {d.kind === 'pulse' && <Dot color={d.color} pulse />}
      {d.kind === 'spin' && <Loader2 size={12} className="va-spin" />}
      {d.kind === 'dot' && <Dot color={d.color} />}
      <span className="shrink-0">{d.text}</span>
      {state === 'tool' && toolSummary && (
        <span className="truncate" style={{ color: T.text2 }}>
          {truncate(toolSummary, 48)}
        </span>
      )}
    </span>
  )
}
