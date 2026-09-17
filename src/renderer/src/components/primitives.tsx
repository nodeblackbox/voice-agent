import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import { Check, ChevronDown, type LucideIcon } from 'lucide-react'
import { T } from '../theme'

export function Bars({ color, h = 14, n = 5 }: { color: string; h?: number; n?: number }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'flex-end', gap: 3, height: h }}>
      {Array.from({ length: n }).map((_, i) => (
        <span key={i} className="va-bar" style={{ height: h, background: color, animationDelay: `${i * 0.11}s` }} />
      ))}
    </span>
  )
}

export function Dot({ color, size = 7, pulse }: { color: string; size?: number; pulse?: boolean }) {
  return (
    <span
      className={pulse ? 'va-pulse' : undefined}
      style={{ width: size, height: size, borderRadius: '50%', background: color, flexShrink: 0, display: 'inline-block' }}
    />
  )
}

export function IconBtn({
  icon: Icon,
  label,
  active,
  onClick,
  size = 16,
  w = 36,
  color,
  disabled
}: {
  icon: LucideIcon
  label: string
  active?: boolean
  onClick?: () => void
  size?: number
  w?: number
  color?: string
  disabled?: boolean
}) {
  return (
    <button
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className="flex items-center justify-center rounded-lg transition-colors"
      style={{
        width: w,
        height: w,
        color: color ?? (active ? T.text : T.text3),
        background: active ? T.raised : 'transparent',
        border: 'none',
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1
      }}
    >
      <Icon size={size} />
    </button>
  )
}

export function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      aria-pressed={on}
      onClick={() => onChange(!on)}
      style={{
        width: 34,
        height: 20,
        borderRadius: 20,
        background: on ? T.cyan : T.border,
        border: 'none',
        cursor: 'pointer',
        position: 'relative',
        flexShrink: 0,
        transition: 'background .15s'
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 2,
          left: on ? 16 : 2,
          width: 16,
          height: 16,
          borderRadius: '50%',
          background: on ? T.bg : T.text2,
          transition: 'left .15s'
        }}
      />
    </button>
  )
}

export function Btn({
  children,
  primary,
  danger,
  onClick,
  icon: Icon,
  small,
  disabled,
  type = 'button'
}: {
  children?: ReactNode
  primary?: boolean
  danger?: boolean
  onClick?: () => void
  icon?: LucideIcon
  small?: boolean
  disabled?: boolean
  type?: 'button' | 'submit'
}) {
  const color = primary ? T.bg : danger ? T.red : T.text2
  const bg = primary ? T.text : T.surface
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1.5 rounded-lg whitespace-nowrap ${small ? 'px-2 py-1 text-xs' : 'px-3 py-1.5 text-sm'}`}
      style={{
        color,
        background: bg,
        border: `1px solid ${primary ? T.text : T.border}`,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.5 : 1
      }}
    >
      {Icon && <Icon size={small ? 12 : 13} />}
      {children}
    </button>
  )
}

export interface SelectOption {
  id: string
  label: string
}

export function Select({
  value,
  onChange,
  options,
  width
}: {
  value: string
  onChange: (v: string) => void
  options: SelectOption[]
  width?: number
}) {
  return (
    <div className="relative inline-flex items-center" style={{ width }}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="appearance-none rounded-lg pl-2 pr-6 py-1.5 text-xs w-full"
        style={{ color: T.text, background: T.surface, border: `1px solid ${T.border}`, cursor: 'pointer' }}
      >
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown size={11} style={{ position: 'absolute', right: 8, color: T.text3, pointerEvents: 'none' }} />
    </div>
  )
}

export function TextInput({
  value,
  onChange,
  placeholder,
  mono,
  onKeyDown,
  autoFocus,
  type = 'text',
  style
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  mono?: boolean
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void
  autoFocus?: boolean
  type?: 'text' | 'password'
  style?: CSSProperties
}) {
  return (
    <input
      type={type}
      value={value}
      autoFocus={autoFocus}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      placeholder={placeholder}
      className="rounded-lg px-2.5 py-1.5 text-sm w-full"
      style={{
        color: T.text,
        background: T.bg,
        border: `1px solid ${T.border}`,
        fontFamily: mono ? T.mono : undefined,
        ...style
      }}
    />
  )
}

export function Page({
  title,
  sub,
  actions,
  children
}: {
  title: string
  sub?: string
  actions?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className="va-scroll flex-1 overflow-y-auto">
      <div className="mx-auto px-8 py-8 flex flex-col gap-6" style={{ maxWidth: 960 }}>
        <div className="flex items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <h1 className="text-xl font-semibold" style={{ color: T.text, margin: 0 }}>
              {title}
            </h1>
            {sub && (
              <p className="text-sm" style={{ color: T.text2, margin: 0, lineHeight: 1.5 }}>
                {sub}
              </p>
            )}
          </div>
          {actions}
        </div>
        {children}
      </div>
    </div>
  )
}

export function Card({
  children,
  pad = 16,
  style,
  onClick,
  active,
  className
}: {
  children?: ReactNode
  pad?: number
  style?: CSSProperties
  onClick?: () => void
  active?: boolean
  className?: string
}) {
  return (
    <div
      onClick={onClick}
      className={`rounded-xl ${className ?? ''}`}
      style={{
        padding: pad,
        background: active ? T.raised : T.surface,
        border: `1px solid ${active ? T.cyanBorder : T.border}`,
        cursor: onClick ? 'pointer' : 'default',
        ...style
      }}
    >
      {children}
    </div>
  )
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <div className="text-xs font-medium" style={{ color: T.text3 }}>
      {children}
    </div>
  )
}

export function Dropdown({
  open,
  onClose,
  children,
  width = 240,
  align = 'left'
}: {
  open: boolean
  onClose: () => void
  children: ReactNode
  width?: number
  align?: 'left' | 'right'
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', h)
    document.addEventListener('keydown', k)
    return () => {
      document.removeEventListener('mousedown', h)
      document.removeEventListener('keydown', k)
    }
  }, [open, onClose])
  if (!open) return null
  return (
    <div
      ref={ref}
      className="absolute rounded-xl shadow-2xl overflow-hidden va-fade"
      style={{
        bottom: 'calc(100% + 8px)',
        [align]: 0,
        width,
        background: T.raised,
        border: `1px solid ${T.border}`,
        zIndex: 30
      }}
    >
      {children}
    </div>
  )
}

export function MenuItem({
  title,
  sub,
  selected,
  onClick
}: {
  title: string
  sub?: string
  selected?: boolean
  onClick?: () => void
}) {
  return (
    <button
      onClick={onClick}
      className="w-full text-left px-3 py-2 flex items-start gap-2"
      style={{ background: selected ? 'rgba(255,255,255,0.04)' : 'transparent', border: 'none', cursor: 'pointer' }}
    >
      <span style={{ width: 14, paddingTop: 3, color: T.cyan, flexShrink: 0 }}>{selected ? <Check size={12} /> : null}</span>
      <span className="flex flex-col gap-0.5 min-w-0">
        <span className="text-sm" style={{ color: T.text }}>
          {title}
        </span>
        {sub && (
          <span className="text-xs" style={{ color: T.text3, lineHeight: 1.4 }}>
            {sub}
          </span>
        )}
      </span>
    </button>
  )
}

export function Row({ label, sub, children }: { label: string; sub?: string; children?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3" style={{ borderBottom: `1px solid ${T.border}` }}>
      <div className="flex flex-col gap-0.5 min-w-0">
        <span className="text-sm">{label}</span>
        {sub && (
          <span className="text-xs" style={{ color: T.text3, lineHeight: 1.4 }}>
            {sub}
          </span>
        )}
      </div>
      {children}
    </div>
  )
}

export function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="text-xs rounded px-1.5 py-0.5 inline-flex items-center gap-1" style={{ background: T.raised, color: T.text3 }}>
      {children}
    </span>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="px-4 py-8 text-sm" style={{ color: T.text3 }}>
      {children}
    </div>
  )
}
