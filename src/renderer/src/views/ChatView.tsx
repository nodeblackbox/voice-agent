import { useStore } from '../state/store'
import { SessionsSidebar } from '../components/chat/SessionsSidebar'
import { ChatHeader } from '../components/chat/ChatHeader'
import { Transcript } from '../components/chat/Transcript'
import { InputBar } from '../components/chat/InputBar'
import { QuickPanel } from '../components/chat/QuickPanel'

export function ChatView() {
  const leftOpen = useStore((s) => s.leftOpen)
  const rightOpen = useStore((s) => s.rightOpen)
  return (
    <>
      {leftOpen && <SessionsSidebar />}
      <main className="flex-1 flex flex-col min-w-0 relative">
        <ChatHeader />
        <Transcript />
        <InputBar />
      </main>
      {rightOpen && <QuickPanel />}
    </>
  )
}
