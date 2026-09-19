import { Folder, Headphones, PanelLeft, PanelRight, Volume2, VolumeX } from 'lucide-react'
import { T } from '../../theme'
import { selectActiveProject, selectActiveSession, useStore } from '../../state/store'
import { IconBtn } from '../primitives'
import { StateIndicator } from './StateIndicator'
import { formatTokens } from '../../lib/format'

export function friendlyVoice(name: string | undefined): string {
  if (!name) return 'Ava'
  return name.replace(/^[a-z]{2}-[A-Z]{2}-/, '').replace(/(Multilingual)?Neural$/, '')
}

export function ChatHeader() {
  const settings = useStore((s) => s.settings)
  const project = useStore(selectActiveProject)
  const session = useStore(selectActiveSession)
  const leftOpen = useStore((s) => s.leftOpen)
  const rightOpen = useStore((s) => s.rightOpen)
  const setLeftOpen = useStore((s) => s.setLeftOpen)
  const setRightOpen = useStore((s) => s.setRightOpen)
  const muted = useStore((s) => s.muted)
  const setMuted = useStore((s) => s.setMuted)
  const agentState = useStore((s) => s.agentState)
  const micMuted = useStore((s) => s.micMuted)
  const services = useStore((s) => s.services)
  const lastMetrics = useStore((s) => s.lastMetrics)
  const messages = useStore((s) => s.messages)

  const runningTool = [...messages].reverse().find((m) => m.role === 'tool' && m.tool?.status === 'running')
  const toolLabel = runningTool?.tool?.label ?? null
  const toolSummary = runningTool?.tool?.summary ?? null
  const ttfa = lastMetrics?.speechEndToAudioMs ?? lastMetrics?.ttfaMs ?? lastMetrics?.ttftMs
  const ttfaTitle = lastMetrics?.speechEndToAudioMs !== undefined ? 'end of your speech to first audio' : 'time to first audio'
  const tokens = lastMetrics?.inputTokens !== undefined && lastMetrics?.outputTokens !== undefined ? lastMetrics : null

  return (
    <header className="flex items-center justify-between px-3 gap-3" style={{ height: 44, borderBottom: `1px solid ${T.border}` }}>
      <div className="flex items-center gap-2 text-xs min-w-0">
        {!leftOpen && <IconBtn icon={PanelLeft} label="Show sessions" size={15} w={28} onClick={() => setLeftOpen(true)} />}
        <Folder size={13} style={{ color: T.text3, flexShrink: 0 }} />
        <span className="truncate" style={{ color: T.text2, fontFamily: T.mono, maxWidth: 260 }}>
          {project?.path ?? project?.name ?? 'Global'}
        </span>
        <span style={{ color: T.text3 }}>/</span>
        <span className="truncate" style={{ color: T.text }}>
          {session?.title ?? 'New session'}
        </span>
        {settings && (
          <span className="rounded px-1.5 py-0.5" style={{ background: T.cyanTint, color: T.cyan, fontFamily: T.mono }}>
            {settings.mode}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <StateIndicator state={agentState} toolLabel={toolLabel} toolSummary={toolSummary} services={services} micMuted={micMuted} />
        <span className="text-xs ml-2 mr-1 inline-flex items-center gap-1.5" style={{ color: T.text3 }}>
          <Headphones size={12} />
          {friendlyVoice(settings?.voice.voice)}
        </span>
        {ttfa !== undefined && (
          <span className="text-xs mr-1" style={{ color: T.text3, fontFamily: T.mono }} title={ttfaTitle}>
            {Math.round(ttfa)}ms
          </span>
        )}
        {tokens && (
          <span className="text-xs mr-2" style={{ color: T.text3, fontFamily: T.mono }} title="tokens in / out for the last turn">
            {formatTokens(tokens.inputTokens ?? 0)}/{formatTokens(tokens.outputTokens ?? 0)}
          </span>
        )}
        <IconBtn icon={muted ? VolumeX : Volume2} label={muted ? 'Unmute her voice' : 'Mute her voice'} onClick={() => setMuted(!muted)} size={15} color={muted ? T.amber : undefined} />
        <IconBtn icon={PanelRight} label="Quick panel" active={rightOpen} onClick={() => setRightOpen(!rightOpen)} size={15} />
      </div>
    </header>
  )
}
