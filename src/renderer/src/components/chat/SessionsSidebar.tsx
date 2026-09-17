import { useState } from 'react'
import { PanelLeft, Plus, Search, Trash2 } from 'lucide-react'
import { T } from '../../theme'
import { useStore } from '../../state/store'
import { Dot, IconBtn } from '../primitives'

export function SessionsSidebar() {
  const sessions = useStore((s) => s.sessions)
  const projects = useStore((s) => s.projects)
  const activeId = useStore((s) => s.activeSessionId)
  const selectSession = useStore((s) => s.selectSession)
  const newSession = useStore((s) => s.newSession)
  const deleteSession = useStore((s) => s.deleteSession)
  const setLeftOpen = useStore((s) => s.setLeftOpen)
  const [query, setQuery] = useState('')

  const filtered = sessions.filter((s) => s.title.toLowerCase().includes(query.toLowerCase()))
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? 'Global'

  return (
    <aside className="flex flex-col" style={{ width: 236, background: T.rail, borderRight: `1px solid ${T.border}` }}>
      <div className="flex items-center justify-between px-3 pt-3 pb-2">
        <span className="text-xs font-medium" style={{ color: T.text2 }}>
          Sessions
        </span>
        <div className="flex gap-0.5">
          <IconBtn icon={Plus} label="New session" size={14} w={26} onClick={() => void newSession()} />
          <IconBtn icon={PanelLeft} label="Collapse" size={14} w={26} onClick={() => setLeftOpen(false)} />
        </div>
      </div>
      <div className="mx-3 mb-2 flex items-center gap-2 rounded-lg px-2" style={{ height: 30, background: T.surface, border: `1px solid ${T.border}` }}>
        <Search size={12} style={{ color: T.text3 }} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search sessions"
          className="flex-1 bg-transparent text-xs min-w-0"
          style={{ color: T.text, border: 'none' }}
        />
      </div>
      <div className="va-scroll flex-1 overflow-y-auto px-2 pb-3 flex flex-col gap-0.5">
        {filtered.map((s) => {
          const active = s.id === activeId
          return (
            <div key={s.id} className="group relative">
              <button
                onClick={() => void selectSession(s.id)}
                className="w-full text-left rounded-lg px-2 py-2 flex gap-2"
                style={{ background: active ? T.raised : 'transparent', border: 'none', cursor: 'pointer' }}
              >
                <span style={{ paddingTop: 6 }}>
                  <Dot color={active ? T.cyan : T.text3} size={5} />
                </span>
                <span className="flex flex-col gap-0.5 min-w-0 flex-1 pr-5">
                  <span className="text-sm truncate" style={{ color: active ? T.text : T.text2 }}>
                    {s.title}
                  </span>
                  <span className="text-xs truncate" style={{ color: T.text3, fontFamily: T.mono }}>
                    {projectName(s.projectId)}
                    {s.messageCount > 0 ? ` · ${s.messageCount}` : ''}
                  </span>
                </span>
              </button>
              <span className="absolute right-1 top-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                <IconBtn icon={Trash2} label="Delete session" size={12} w={22} onClick={() => void deleteSession(s.id)} />
              </span>
            </div>
          )
        })}
        {filtered.length === 0 && (
          <div className="text-xs px-2 py-4" style={{ color: T.text3 }}>
            {sessions.length === 0 ? 'No sessions yet.' : 'No matches.'}
          </div>
        )}
      </div>
    </aside>
  )
}
