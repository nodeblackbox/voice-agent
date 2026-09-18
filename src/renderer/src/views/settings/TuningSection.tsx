import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, Download, RotateCcw, SlidersHorizontal, Upload } from 'lucide-react'
import type { Settings } from '@shared/types'
import {
  TUNING_GROUP_INFO,
  TUNING_GROUPS,
  defaultTuning,
  pickTuning,
  sanitizeTuning,
  tuningDiff,
  tuningParams,
  type TuningGroup,
  type TuningParam
} from '@shared/tuning'
import { T } from '../../theme'
import { useStore } from '../../state/store'
import { Btn, Card, Select, Tag, Toggle } from '../../components/primitives'

type Value = number | boolean | string

function formatValue(p: TuningParam, v: Value): string {
  if (p.kind === 'text') return String(v).length > 40 ? `${String(v).slice(0, 39)}…` : String(v)
  if (p.kind !== 'number') return String(v)
  const n = Number(v)
  if (p.unit === 'ms' && n >= 10000) return `${(n / 1000).toFixed(n % 1000 ? 1 : 0)}s`
  return `${Number.isInteger(p.step) ? n : n.toFixed(2).replace(/\.?0+$/, '')}${p.unit && p.unit !== 'x' && p.unit !== 'p' ? ` ${p.unit}` : ''}`
}

function TextControl({ value, onCommit, maxChars }: { value: string; onCommit: (v: string) => void; maxChars: number }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const commit = () => {
    const next = draft.slice(0, maxChars)
    if (next !== value) onCommit(next)
  }
  return (
    <textarea
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault()
          commit()
        }
      }}
      rows={3}
      className="rounded px-2 py-1 text-xs w-full resize-y"
      style={{ flex: 1, color: T.text, background: T.bg, border: `1px solid ${T.border}`, fontFamily: T.mono, lineHeight: 1.5 }}
    />
  )
}

function ParamControl({ param, value, onChange }: { param: TuningParam; value: Value; onChange: (v: Value) => void }) {
  if (param.kind === 'boolean') return <Toggle on={Boolean(value)} onChange={onChange} />
  if (param.kind === 'enum') return <Select value={String(value)} onChange={onChange} options={param.options.map((o) => ({ id: o, label: o }))} width={120} />
  if (param.kind === 'text') return <TextControl value={String(value)} onCommit={onChange} maxChars={param.maxChars ?? 2000} />
  return (
    <span className="flex items-center gap-2" style={{ flex: 1 }}>
      <input type="range" min={param.min} max={param.max} step={param.step} value={Number(value)} onChange={(e) => onChange(Number(e.target.value))} style={{ flex: 1 }} />
      <input
        type="number"
        min={param.min}
        max={param.max}
        step={param.step}
        value={Number(value)}
        onChange={(e) => {
          const n = Number(e.target.value)
          if (Number.isFinite(n)) onChange(Math.min(param.max, Math.max(param.min, n)))
        }}
        className="rounded px-1.5 py-0.5 text-xs"
        style={{ width: 84, color: T.text, background: T.bg, border: `1px solid ${T.border}`, fontFamily: T.mono, textAlign: 'right' }}
      />
    </span>
  )
}

function Group({ group, settings, onSet, onReset }: { group: TuningGroup; settings: Settings; onSet: (key: string, v: Value) => void; onReset: (key?: string) => void }) {
  const [open, setOpen] = useState(group === 'endpoint')
  const info = TUNING_GROUP_INFO[group]
  const values = settings[group] as Record<string, Value>
  const changed = tuningDiff(pickTuning(settings)).filter((d) => d.group === group).length
  return (
    <div style={{ borderBottom: `1px solid ${T.border}` }}>
      <div className="flex items-center gap-2 py-3">
        <button onClick={() => setOpen(!open)} className="flex items-center gap-2 text-left" style={{ background: 'none', border: 'none', cursor: 'pointer', color: T.text, flex: 1, padding: 0 }}>
          {open ? <ChevronDown size={13} style={{ color: T.text3 }} /> : <ChevronRight size={13} style={{ color: T.text3 }} />}
          <span className="text-sm">{info.label}</span>
          {changed > 0 && <Tag>{changed} changed</Tag>}
        </button>
        {changed > 0 && (
          <Btn small icon={RotateCcw} onClick={() => onReset()}>
            Reset group
          </Btn>
        )}
      </div>
      {open && (
        <div className="flex flex-col gap-1 pb-3">
          <span className="text-xs pb-1" style={{ color: T.text3, lineHeight: 1.5 }}>
            {info.doc}
          </span>
          {tuningParams(group).map(({ key, param }) => {
            const value = values[key] ?? param.default
            const isDefault = value === param.default
            return (
              <div key={key} className="flex items-start gap-3 py-1.5 text-xs" title={param.doc}>
                <span className="flex flex-col gap-0.5" style={{ width: 170, flexShrink: 0 }}>
                  <span style={{ color: isDefault ? T.text2 : T.text }}>{param.label}</span>
                  <span style={{ color: T.text3, fontFamily: T.mono }}>
                    {formatValue(param, value)}
                    {!isDefault && <span style={{ color: T.text3 }}> · default {formatValue(param, param.default)}</span>}
                  </span>
                </span>
                <ParamControl param={param} value={value} onChange={(v) => onSet(key, v)} />
                <span style={{ width: 22, flexShrink: 0 }}>
                  {!isDefault && (
                    <button onClick={() => onReset(key)} title="Reset to default" style={{ background: 'none', border: 'none', cursor: 'pointer', color: T.text3, padding: 0 }}>
                      <RotateCcw size={12} />
                    </button>
                  )}
                </span>
                <span className="flex flex-col gap-1" style={{ width: 300, flexShrink: 0, color: T.text3, lineHeight: 1.45 }}>
                  <span>{param.doc}</span>
                  {param.restart && <Tag>applies on next launch</Tag>}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 mb-1">
        <SlidersHorizontal size={14} style={{ color: T.text2 }} />
        <span className="text-sm font-medium">{title}</span>
      </div>
      {children}
    </div>
  )
}

export function TuningSection() {
  const settings = useStore((s) => s.settings)
  const updateSettings = useStore((s) => s.updateSettings)
  const pushToast = useStore((s) => s.pushToast)
  const fileRef = useRef<HTMLInputElement>(null)
  if (!settings) return null

  const setParam = (group: TuningGroup, key: string, v: Value) => void updateSettings({ [group]: { ...(settings[group] as object), [key]: v } } as Partial<Settings>)
  const resetGroup = (group: TuningGroup, key?: string) => {
    const defaults = defaultTuning()[group] as Record<string, Value>
    const next = key ? { ...(settings[group] as Record<string, Value>), [key]: defaults[key]! } : defaults
    void updateSettings({ [group]: next } as Partial<Settings>)
  }
  const resetAll = () => void updateSettings(defaultTuning() as Partial<Settings>)

  const exportProfile = () => {
    const payload = { version: 1, exportedAt: new Date().toISOString(), tuning: pickTuning(settings), changed: tuningDiff(pickTuning(settings)) }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `voice-agent-tuning-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const importProfile = async (file: File) => {
    try {
      const raw = JSON.parse(await file.text()) as { tuning?: unknown }
      const tuning = sanitizeTuning(raw.tuning ?? raw)
      await updateSettings(tuning as Partial<Settings>)
      pushToast('info', `Imported tuning profile (${tuningDiff(tuning).length} values differ from defaults)`)
    } catch (e) {
      pushToast('error', `Could not import profile: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const totalChanged = tuningDiff(pickTuning(settings)).length

  return (
    <Section title="Tuning">
      <Card pad={0}>
        <div className="px-4">
          <div className="flex items-center justify-between gap-4 py-3" style={{ borderBottom: `1px solid ${T.border}` }}>
            <span className="text-xs" style={{ color: T.text3, lineHeight: 1.5, maxWidth: 520 }}>
              Every number that shapes how the agent feels. Hover a row for what it does; docs/TUNING.md explains how they interact. Ear values apply live, brain and speech values on the next turn.
              {totalChanged > 0 ? ` ${totalChanged} value${totalChanged === 1 ? '' : 's'} differ from the defaults.` : ' All at defaults.'}
            </span>
            <span className="inline-flex items-center gap-2">
              <Btn small icon={Download} onClick={exportProfile}>
                Export
              </Btn>
              <Btn small icon={Upload} onClick={() => fileRef.current?.click()}>
                Import
              </Btn>
              <input
                ref={fileRef}
                type="file"
                accept="application/json"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) void importProfile(f)
                  e.target.value = ''
                }}
              />
              {totalChanged > 0 && (
                <Btn small icon={RotateCcw} onClick={resetAll}>
                  Reset all
                </Btn>
              )}
            </span>
          </div>
          {TUNING_GROUPS.map((g) => (
            <Group key={g} group={g} settings={settings} onSet={(k, v) => setParam(g, k, v)} onReset={(k) => resetGroup(g, k)} />
          ))}
        </div>
      </Card>
    </Section>
  )
}
