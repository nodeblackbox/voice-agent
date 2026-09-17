import { useState, type KeyboardEvent } from 'react'
import { AlignLeft, ChevronDown, Folder, Lock, MessageSquare, Mic, Send, Sparkles, Wand2 } from 'lucide-react'
import type { Mode } from '@shared/types'
import { T } from '../../theme'
import { selectActiveModel, selectActiveProject, selectActiveStyle, useStore } from '../../state/store'
import { toggleListening } from '../../audio/voice'
import { Bars, Dropdown, MenuItem } from '../primitives'

const MODES: Array<{ id: Mode; label: string; desc: string }> = [
  { id: 'ask', label: 'Ask', desc: 'Single reply, tools only if needed' },
  { id: 'agent', label: 'Agent', desc: 'Multi-step: plans, calls tools, reports back' }
]

type Menu = 'mode' | 'model' | 'style' | null

export function InputBar() {
  const settings = useStore((s) => s.settings)
  const models = useStore((s) => s.models)
  const styles = useStore((s) => s.styles)
  const model = useStore(selectActiveModel)
  const style = useStore(selectActiveStyle)
  const project = useStore(selectActiveProject)
  const listening = useStore((s) => s.listening)
  const agentState = useStore((s) => s.agentState)
  const updateSettings = useStore((s) => s.updateSettings)
  const setView = useStore((s) => s.setView)
  const [open, setOpen] = useState<Menu>(null)
  const [draft, setDraft] = useState('')

  const mode = MODES.find((m) => m.id === settings?.mode) ?? MODES[0]
  const busy = agentState === 'thinking' || agentState === 'tool' || agentState === 'speaking'

  const send = () => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    void window.api.chat.send(text)
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      void window.api.chat.cancel()
    }
  }

  const menuBtn = (id: Exclude<Menu, null>, Icon: typeof MessageSquare, label: string) => (
    <button
      onClick={() => setOpen(open === id ? null : id)}
      className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs"
      style={{ color: T.text2, background: open === id ? T.surface : 'transparent', border: 'none', cursor: 'pointer' }}
    >
      <Icon size={13} />
      {label}
      <ChevronDown size={11} style={{ color: T.text3 }} />
    </button>
  )

  return (
    <div className="absolute left-0 right-0 flex justify-center px-6" style={{ bottom: 20, pointerEvents: 'none' }}>
      <div className="w-full flex flex-col gap-2" style={{ maxWidth: 720, pointerEvents: 'auto' }}>
        <div className="flex items-center gap-2 px-1">
          <button
            onClick={() => setView('projects')}
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs"
            style={{ color: T.text2, background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: T.mono }}
          >
            <Folder size={12} />
            {project?.path ?? project?.name ?? 'Global'}
            <ChevronDown size={11} style={{ color: T.text3 }} />
          </button>
          <Lock size={11} style={{ color: T.text3 }} />
          <span className="text-xs" style={{ color: T.text3 }}>
            {project ? 'memory scoped to this project' : 'global memory only'}
          </span>
        </div>
        <div
          className="rounded-2xl shadow-2xl"
          style={{ background: T.raised, border: `1px solid ${listening ? T.cyanBorder : T.border}`, transition: 'border-color .2s' }}
        >
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            placeholder={listening ? 'Listening — or type to override…' : 'Ask anything, or press Voice to talk…'}
            rows={2}
            className="w-full bg-transparent px-4 pt-3 pb-1 text-sm resize-none"
            style={{ color: T.text, border: 'none', lineHeight: 1.5 }}
          />
          <div className="flex items-center justify-between px-2 pb-2 pt-1">
            <div className="flex items-center gap-1">
              <div className="relative">
                {menuBtn('mode', MessageSquare, mode?.label ?? 'Ask')}
                <Dropdown open={open === 'mode'} onClose={() => setOpen(null)} width={260}>
                  {MODES.map((m) => (
                    <MenuItem
                      key={m.id}
                      title={m.label}
                      sub={m.desc}
                      selected={mode?.id === m.id}
                      onClick={() => {
                        void updateSettings({ mode: m.id })
                        setOpen(null)
                      }}
                    />
                  ))}
                </Dropdown>
              </div>
              <div className="relative">
                {menuBtn('model', Sparkles, model?.label ?? 'Model')}
                <Dropdown open={open === 'model'} onClose={() => setOpen(null)} width={260}>
                  {models.map((m) => (
                    <MenuItem
                      key={m.id}
                      title={m.label}
                      sub={m.note ? `${m.providerLabel} · ${m.note}` : m.providerLabel}
                      selected={model?.id === m.id}
                      onClick={() => {
                        void updateSettings({ modelId: m.id })
                        setOpen(null)
                      }}
                    />
                  ))}
                </Dropdown>
              </div>
              <div className="relative">
                {menuBtn('style', AlignLeft, style?.label ?? 'Style')}
                <Dropdown open={open === 'style'} onClose={() => setOpen(null)} width={300}>
                  {styles.map((s) => (
                    <MenuItem
                      key={s.id}
                      title={s.label}
                      sub={s.desc}
                      selected={style?.id === s.id}
                      onClick={() => {
                        void updateSettings({ styleId: s.id })
                        setOpen(null)
                      }}
                    />
                  ))}
                  <button
                    onClick={() => {
                      setOpen(null)
                      setView('prompts')
                    }}
                    className="w-full text-left px-3 py-2 text-xs inline-flex items-center gap-2"
                    style={{ color: T.violet, background: 'transparent', border: 'none', borderTop: `1px solid ${T.border}`, cursor: 'pointer' }}
                  >
                    <Wand2 size={12} /> Create a new style with AI
                  </button>
                </Dropdown>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {busy && (
                <button
                  onClick={() => void window.api.chat.cancel()}
                  className="text-xs rounded-lg px-2 py-1.5"
                  style={{ color: T.text3, background: 'transparent', border: 'none', cursor: 'pointer' }}
                  title="Esc"
                >
                  stop
                </button>
              )}
              <button
                aria-label={listening ? 'Stop listening' : 'Start voice'}
                onClick={() => void toggleListening()}
                className={`inline-flex items-center justify-center gap-2 rounded-lg text-xs ${listening ? 'va-ring' : ''}`}
                style={{
                  height: 32,
                  minWidth: listening ? 96 : 76,
                  padding: '0 12px',
                  color: listening ? T.cyan : T.text,
                  background: listening ? T.cyanTint : T.surface,
                  border: `1px solid ${listening ? T.cyan : T.border}`,
                  cursor: 'pointer',
                  transition: 'all .2s ease'
                }}
              >
                {listening ? <Bars color={T.cyan} h={12} /> : <Mic size={13} />}
                <span>{listening ? 'Live' : 'Voice'}</span>
              </button>
              <button
                aria-label="Send"
                onClick={send}
                disabled={!draft.trim()}
                className="flex items-center justify-center rounded-lg"
                style={{
                  width: 32,
                  height: 32,
                  background: draft.trim() ? T.text : T.surface,
                  color: draft.trim() ? T.bg : T.text3,
                  border: `1px solid ${T.border}`,
                  cursor: draft.trim() ? 'pointer' : 'default'
                }}
              >
                <Send size={13} />
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
