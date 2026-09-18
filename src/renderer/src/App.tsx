import { useEffect } from 'react'
import { Activity, AlignLeft, Brain, FolderKanban, MessageSquare, Settings, Zap } from 'lucide-react'
import { T } from './theme'
import { useStore, type View } from './state/store'
import { IconBtn } from './components/primitives'
import { Toasts } from './components/Toasts'
import { ChatView } from './views/ChatView'
import { PromptsView } from './views/PromptsView'
import { SkillsView } from './views/SkillsView'
import { MemoryView } from './views/MemoryView'
import { ProjectsView } from './views/ProjectsView'
import { SettingsView } from './views/SettingsView'
import { DiagnosticsView } from './views/DiagnosticsView'
import { toggleListening } from './audio/voice'

const NAV: Array<{ id: View; icon: typeof MessageSquare; label: string }> = [
  { id: 'chat', icon: MessageSquare, label: 'Chat' },
  { id: 'prompts', icon: AlignLeft, label: 'Prompts' },
  { id: 'skills', icon: Zap, label: 'Skills' },
  { id: 'memory', icon: Brain, label: 'Memory' },
  { id: 'projects', icon: FolderKanban, label: 'Projects' },
  { id: 'diagnostics', icon: Activity, label: 'Diagnostics' }
]

export default function App() {
  const ready = useStore((s) => s.ready)
  const view = useStore((s) => s.view)
  const setView = useStore((s) => s.setView)
  const init = useStore((s) => s.init)

  useEffect(() => {
    void init()
  }, [init])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.code === 'Space') {
        e.preventDefault()
        void toggleListening()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="flex h-screen w-full overflow-hidden" style={{ background: T.bg, color: T.text }}>
      <nav className="flex flex-col items-center py-3 gap-1" style={{ width: 48, background: T.rail, borderRight: `1px solid ${T.border}` }}>
        {NAV.map((n) => (
          <IconBtn key={n.id} icon={n.icon} label={n.label} active={view === n.id} onClick={() => setView(n.id)} />
        ))}
        <div className="flex-1" />
        <IconBtn icon={Settings} label="Settings" active={view === 'settings'} onClick={() => setView('settings')} />
      </nav>

      {!ready ? (
        <div className="flex-1 flex items-center justify-center text-sm" style={{ color: T.text3 }}>
          Starting…
        </div>
      ) : (
        <>
          {view === 'chat' && <ChatView />}
          {view === 'prompts' && <PromptsView />}
          {view === 'skills' && <SkillsView />}
          {view === 'memory' && <MemoryView />}
          {view === 'projects' && <ProjectsView />}
          {view === 'diagnostics' && <DiagnosticsView />}
          {view === 'settings' && <SettingsView />}
        </>
      )}
      <Toasts />
    </div>
  )
}
