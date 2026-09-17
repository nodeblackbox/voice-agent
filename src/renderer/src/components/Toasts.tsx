import { AlertTriangle, Info, X } from 'lucide-react'
import { T } from '../theme'
import { useStore } from '../state/store'
import { IconBtn } from './primitives'

export function Toasts() {
  const toasts = useStore((s) => s.toasts)
  const dismiss = useStore((s) => s.dismissToast)
  if (toasts.length === 0) return null
  return (
    <div className="absolute right-4 bottom-4 flex flex-col gap-2" style={{ zIndex: 50, width: 320 }}>
      {toasts.map((t) => {
        const color = t.kind === 'error' ? T.red : t.kind === 'warn' ? T.amber : T.cyan
        const Icon = t.kind === 'info' ? Info : AlertTriangle
        return (
          <div
            key={t.id}
            className="rounded-xl shadow-2xl flex items-start gap-2 p-3 va-fade"
            style={{ background: T.raised, border: `1px solid ${T.border}` }}
          >
            <Icon size={14} style={{ color, marginTop: 2, flexShrink: 0 }} />
            <span className="text-sm flex-1" style={{ color: T.text, lineHeight: 1.45 }}>
              {t.text}
            </span>
            <IconBtn icon={X} label="Dismiss" size={13} w={22} onClick={() => dismiss(t.id)} />
          </div>
        )
      })}
    </div>
  )
}
