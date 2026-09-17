import { useEffect } from 'react'
import { X } from 'lucide-react'
import type { ServiceName } from '@shared/types'
import { T, serviceColor, serviceLabel } from '../../theme'
import { selectActiveStyle, useStore } from '../../state/store'
import { Dot, IconBtn, SectionTitle } from '../primitives'

const SERVICE_LABELS: Record<ServiceName, string> = {
  sidecar: 'Ears (Parakeet)',
  tts: 'Voice (Edge TTS)',
  llm: 'Brain',
  searxng: 'SearXNG',
  mcp: 'MCP'
}

const ORDER: ServiceName[] = ['sidecar', 'tts', 'llm', 'searxng', 'mcp']

export function QuickPanel() {
  const services = useStore((s) => s.services)
  const context = useStore((s) => s.context)
  const style = useStore(selectActiveStyle)
  const setRightOpen = useStore((s) => s.setRightOpen)
  const reloadContext = useStore((s) => s.reloadContext)

  useEffect(() => {
    void reloadContext()
  }, [reloadContext])

  return (
    <aside className="flex flex-col p-4 gap-5" style={{ width: 260, background: T.rail, borderLeft: `1px solid ${T.border}` }}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium" style={{ color: T.text2 }}>
          At a glance
        </span>
        <IconBtn icon={X} label="Close" size={13} w={22} onClick={() => setRightOpen(false)} />
      </div>
      <div className="flex flex-col gap-2">
        <SectionTitle>Services</SectionTitle>
        {ORDER.map((name) => {
          const s = services[name]
          return (
            <div key={name} className="flex items-center gap-2 text-sm" title={s?.detail}>
              <Dot color={serviceColor(s?.state)} pulse={s?.state === 'starting' || s?.state === 'reconnecting'} />
              <span className="truncate">{SERVICE_LABELS[name]}</span>
              <span className="text-xs ml-auto shrink-0" style={{ color: T.text3 }}>
                {serviceLabel(s?.state)}
              </span>
            </div>
          )
        })}
      </div>
      <div className="flex flex-col gap-2">
        <SectionTitle>Injected every turn</SectionTitle>
        <span className="text-xs" style={{ color: T.text2, fontFamily: T.mono, lineHeight: 1.7, wordBreak: 'break-word' }}>
          {context ? (
            <>
              {context.now}
              <br />
              tz: {context.timezone}
              <br />
              location: {context.location}
              <br />
              project: {context.project}
              <br />
              style: {context.style}
              <br />
              memory: {context.memoryEntries} entries
            </>
          ) : (
            'time · timezone · location'
          )}
        </span>
      </div>
      {context && (
        <div className="flex flex-col gap-2">
          <SectionTitle>Skills on</SectionTitle>
          {context.skills.length === 0 ? (
            <span className="text-xs" style={{ color: T.text3 }}>
              none
            </span>
          ) : (
            <div className="flex flex-wrap gap-1">
              {context.skills.map((s) => (
                <span key={s} className="text-xs rounded px-1.5 py-0.5" style={{ background: T.violetTint, color: T.violet }}>
                  {s}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
      {context && (
        <div className="flex flex-col gap-2">
          <SectionTitle>Tools available</SectionTitle>
          {context.tools.length === 0 ? (
            <span className="text-xs" style={{ color: T.text3 }}>
              none
            </span>
          ) : (
            <div className="flex flex-wrap gap-1">
              {context.tools.map((t) => (
                <span key={t} className="text-xs rounded px-1.5 py-0.5" style={{ background: T.raised, color: T.text2, fontFamily: T.mono }}>
                  {t.replace(/^mcp__/, '')}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
      {style && (
        <div className="flex flex-col gap-2">
          <SectionTitle>Active style</SectionTitle>
          <span className="text-sm">{style.label}</span>
          <span className="text-xs" style={{ color: T.text3, lineHeight: 1.5 }}>
            {style.desc}
          </span>
          <span className="text-xs" style={{ color: T.text3, fontFamily: T.mono }}>
            {style.length} · {style.format}
          </span>
        </div>
      )}
    </aside>
  )
}
