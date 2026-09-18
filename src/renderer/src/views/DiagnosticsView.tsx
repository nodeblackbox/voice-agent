import { useCallback, useEffect, useMemo, useState } from 'react'
import { Activity, AlertTriangle, Check, Copy, Download, Ear, FolderOpen, RefreshCw, SlidersHorizontal, Sparkles, Timer } from 'lucide-react'
import type { LogFileInfo, SessionAnalysis, SessionSummary, Settings, TraceEvent, TuningSuggestion } from '@shared/types'
import { TUNING, type TuningGroup } from '@shared/tuning'
import { T } from '../theme'
import { useStore } from '../state/store'
import { Btn, Card, Empty, Page, SectionTitle, Tag } from '../components/primitives'

function Analysis({ a }: { a: SessionAnalysis | null }) {
  if (!a || a.voiceTurns === 0) return <Empty>No voice turns in this session yet.</Empty>
  const caps = Object.entries(a.timeoutsByCap)
    .map(([cap, n]) => `${cap === 'unknown' ? '?' : Number(cap) >= 60_000 ? 'max length' : `${Number(cap) / 1000}s cap`} ×${n}`)
    .join(', ')
  const row = (label: string, value: string, warn = false) => (
    <div key={label} className="flex items-start gap-3 text-xs py-1" style={{ borderBottom: `1px solid ${T.border}` }}>
      <span style={{ width: 170, flexShrink: 0, color: T.text3 }}>{label}</span>
      <span style={{ color: warn ? T.amber : T.text2, fontFamily: T.mono }}>{value}</span>
    </div>
  )
  const timeoutShare = a.endReasons.done + a.endReasons.timeout ? Math.round((a.endReasons.timeout / (a.endReasons.done + a.endReasons.timeout)) * 100) : 0
  return (
    <div className="flex flex-col">
      {row('voice turns', `${a.voiceTurns} of ${a.turns} in ${a.spanMin} min`)}
      {row('turn ends', `${a.endReasons.done} by Smart Turn (${a.doneAtFirstCheck} at the first check), ${a.endReasons.timeout} by a hard cap (${timeoutShare}%)${caps ? `: ${caps}` : ''}`, timeoutShare >= 30)}
      {row('score at the end', `<0.3 ×${a.turnP.low} · 0.3–0.7 ×${a.turnP.mid} · 0.7–0.9 ×${a.turnP.high} · ≥0.9 ×${a.turnP.confident} · filler holds ${a.fillerHolds}`)}
      {a.timeoutLastWords.length > 0 && row('last word at timeouts', a.timeoutLastWords.map(([w, n]) => `${w} ×${n}`).join(', '))}
      {row('fragments', `${a.mergeable} looked unfinished · ${a.continuations} resumed in the window · ${a.merged} merged · ${a.segments} segments`)}
      {row('cancels', `${a.cancels.newInput} new input · ${a.cancels.bargeIn} barge-in · ${a.cancels.continuation} continuation`, a.cancels.newInput + a.cancels.bargeIn > a.turns / 2)}
      {row('barge-in', `duck ${a.bargein.duck} · cut ${a.bargein.cut} · release ${a.bargein.release} · self-cut suspects ${a.selfCutSuspects}`, a.selfCutSuspects > 0)}
      {row('trouble', `dropped ${a.dropped} · stalls ${a.stalls} · fallbacks ${a.fallbacks} · step limits ${a.stepLimits} · note echoes ${a.noteEchoes} · ASR failures ${a.asrFailures} (reloads ${a.asrReloads}) · crashes ${a.crashes}${a.gpuMiB !== null ? ` · GPU ${a.gpuMiB} MiB` : ''}`, a.asrFailures > 0 || a.crashes > 0)}
    </div>
  )
}

function Suggestions({ result, busy, onRun, onApply }: { result: { suggestions: TuningSuggestion[]; model: string; raw?: string } | null; busy: boolean; onRun: () => void; onApply: (s: TuningSuggestion[]) => void }) {
  const [applied, setApplied] = useState<Set<string>>(new Set())
  const key = (s: TuningSuggestion) => `${s.group}.${s.key}`
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-xs" style={{ color: T.text3, lineHeight: 1.5 }}>
        <span className="flex-1">The current model reads the analysis above and the parameter docs, and proposes changes with a reason each. Nothing is applied until you press Apply; applied changes land in Settings → Tuning like any other edit.</span>
        <Btn small primary icon={Sparkles} onClick={onRun} disabled={busy}>
          {busy ? 'Thinking…' : 'Suggest tuning'}
        </Btn>
      </div>
      {result && result.suggestions.length === 0 && (
        <Empty>
          No changes suggested by {result.model}.{result.raw ? ` It said: “${result.raw}”` : ''}
        </Empty>
      )}
      {result && result.suggestions.length > 0 && (
        <div className="flex flex-col">
          {result.suggestions.map((s) => {
            const param = (TUNING as Record<string, Record<string, { label: string }>>)[s.group]?.[s.key]
            const done = applied.has(key(s))
            return (
              <div key={key(s)} className="flex items-start gap-3 text-xs py-2" style={{ borderBottom: `1px solid ${T.border}` }}>
                <span className="flex flex-col gap-0.5" style={{ width: 200, flexShrink: 0 }}>
                  <span style={{ color: T.text }}>{param?.label ?? s.key}</span>
                  <span style={{ color: T.text3, fontFamily: T.mono }}>
                    {String(s.current)} → <span style={{ color: T.cyan }}>{String(s.value)}</span>
                  </span>
                </span>
                <span className="flex-1" style={{ color: T.text2, lineHeight: 1.5 }}>
                  {s.reason}
                </span>
                <Btn
                  small
                  primary={!done}
                  icon={done ? Check : undefined}
                  disabled={done}
                  onClick={() => {
                    onApply([s])
                    setApplied(new Set([...applied, key(s)]))
                  }}
                >
                  {done ? 'Applied' : 'Apply'}
                </Btn>
              </div>
            )
          })}
          {result.suggestions.some((s) => !applied.has(key(s))) && (
            <div className="flex justify-end pt-2">
              <Btn
                small
                onClick={() => {
                  const rest = result.suggestions.filter((s) => !applied.has(key(s)))
                  onApply(rest)
                  setApplied(new Set([...applied, ...rest.map(key)]))
                }}
              >
                Apply all
              </Btn>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const LATENCY_LABELS: Record<string, string> = {
  asrMs: 'ASR',
  ttftMs: 'first token',
  ttfsMs: 'first sentence',
  ttsFirstMs: 'TTS first sentence',
  ttfaMs: 'turn → audio',
  speechEndToAudioMs: 'speech end → audio',
  totalMs: 'turn total'
}

const HIDE = new Set(['t', 'sid', 'turn', 'ev'])

function eventColor(ev: string): string {
  if (ev.startsWith('ear.')) return T.cyan
  if (ev.startsWith('turn.') || ev === 'state') return T.violet
  if (ev.startsWith('tts.') || ev.startsWith('playback.')) return T.green
  if (ev.startsWith('sidecar.') || ev.startsWith('settings.')) return T.amber
  if (ev === 'ui.toast' || ev === 'trace.dropped') return T.red
  return T.text2
}

function fields(e: TraceEvent): string {
  return Object.entries(e)
    .filter(([k, v]) => !HIDE.has(k) && v !== undefined && v !== null)
    .map(([k, v]) => {
      if (typeof v === 'string') return `${k}=${JSON.stringify(v.length > 70 ? `${v.slice(0, 69)}…` : v)}`
      if (typeof v === 'object') {
        const s = JSON.stringify(v)
        return `${k}=${s.length > 90 ? `${s.slice(0, 89)}…` : s}`
      }
      return `${k}=${String(v)}`
    })
    .join('  ')
}

function Timeline({ events }: { events: TraceEvent[] }) {
  const t0 = events[0]?.t ? Date.parse(events[0].t) : NaN
  if (!events.length) return <Empty>No turn in this session yet. Say or type something, then come back.</Empty>
  const key = (e: TraceEvent): Array<[string, unknown]> => {
    const picks: Array<[string, unknown]> = []
    for (const k of ['asrMs', 'ttftMs', 'ttfsMs', 'ttsFirstMs', 'speechEndToAudioMs', 'reason', 'silenceMs', 'turnP', 'stage', 'spokenChars', 'unspokenChars']) if (e[k] !== undefined && e[k] !== null) picks.push([k, e[k]])
    return picks
  }
  return (
    <div className="flex flex-col" style={{ fontFamily: T.mono, fontSize: 11.5, lineHeight: 1.6 }}>
      {events.map((e, i) => {
        const ms = e.t && Number.isFinite(t0) ? Date.parse(e.t) - t0 : NaN
        return (
          <div key={i} className="flex items-start gap-3 px-1 py-0.5" style={{ borderBottom: `1px solid ${T.border}` }}>
            <span style={{ width: 70, textAlign: 'right', color: T.text3, flexShrink: 0 }}>{Number.isFinite(ms) ? `+${ms}ms` : ''}</span>
            <span style={{ width: 170, color: eventColor(e.ev), flexShrink: 0 }}>{e.ev}</span>
            <span className="flex flex-wrap gap-1" style={{ minWidth: 0 }}>
              {key(e).map(([k, v]) => (
                <Tag key={k}>
                  {k} {typeof v === 'number' ? Math.round(v * 100) / 100 : String(v)}
                </Tag>
              ))}
              <span style={{ color: T.text2, wordBreak: 'break-word' }}>{fields(e)}</span>
            </span>
          </div>
        )
      })}
    </div>
  )
}

function Summary({ s }: { s: SessionSummary | null }) {
  if (!s || s.turns === 0) return <Empty>No completed turns yet.</Empty>
  return (
    <div className="flex flex-col gap-2 text-xs">
      <div className="flex flex-wrap gap-1">
        <Tag>{s.turns} turns</Tag>
        <Tag>{s.voiceTurns} voice</Tag>
        <Tag>{s.interrupted} interrupted</Tag>
        <Tag>{s.fallbacks} fallbacks</Tag>
        <Tag>{s.stalls} stalls</Tag>
        <Tag>{s.stepLimits} step limits</Tag>
        <Tag>{s.fillers} fillers</Tag>
      </div>
      <table style={{ borderCollapse: 'collapse', fontFamily: T.mono }}>
        <thead>
          <tr style={{ color: T.text3 }}>
            <th className="text-left pr-4 font-normal">stage</th>
            <th className="text-right pr-4 font-normal">p50</th>
            <th className="text-right pr-4 font-normal">p95</th>
            <th className="text-right font-normal">n</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(s.latency).map(([k, v]) =>
            v ? (
              <tr key={k} style={{ color: k === 'speechEndToAudioMs' ? T.text : T.text2 }}>
                <td className="pr-4">{LATENCY_LABELS[k] ?? k}</td>
                <td className="text-right pr-4">{v.p50} ms</td>
                <td className="text-right pr-4">{v.p95} ms</td>
                <td className="text-right">{v.n}</td>
              </tr>
            ) : null
          )}
        </tbody>
      </table>
    </div>
  )
}

function Section({ icon: Icon, title, children, actions }: { icon: typeof Activity; title: string; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 mb-1">
        <Icon size={14} style={{ color: T.text2 }} />
        <span className="text-sm font-medium flex-1">{title}</span>
        {actions}
      </div>
      <Card pad={12}>{children}</Card>
    </div>
  )
}

export function DiagnosticsView() {
  const pushToast = useStore((s) => s.pushToast)
  const activeSessionId = useStore((s) => s.activeSessionId)
  const messages = useStore((s) => s.messages)
  const [lastTurn, setLastTurn] = useState<TraceEvent[]>([])
  const [summary, setSummary] = useState<SessionSummary | null>(null)
  const [errors, setErrors] = useState<string[]>([])
  const [logs, setLogs] = useState<LogFileInfo[]>([])
  const [analysis, setAnalysis] = useState<SessionAnalysis | null>(null)
  const [suggested, setSuggested] = useState<{ suggestions: TuningSuggestion[]; model: string; raw?: string } | null>(null)
  const [suggesting, setSuggesting] = useState(false)
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const settings = useStore((s) => s.settings)
  const updateSettings = useStore((s) => s.updateSettings)

  const refresh = useCallback(async () => {
    setBusy(true)
    try {
      const [turn, sum, err, files, an] = await Promise.all([window.api.diag.lastTurn(), window.api.diag.summary(), window.api.diag.tail('errors.log', 40), window.api.diag.logs(), window.api.diag.analysis()])
      setLastTurn(turn)
      setSummary(sum)
      setErrors(err)
      setLogs(files)
      setAnalysis(an)
    } catch (e) {
      pushToast('warn', `Could not load diagnostics: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }, [pushToast])

  useEffect(() => {
    void refresh()
  }, [refresh, activeSessionId, messages.length])

  const stats = useMemo(() => [...lastTurn].reverse().find((e) => e.ev === 'ear.stats') ?? null, [lastTurn])

  const copyReport = async () => {
    try {
      const md = await window.api.diag.report()
      await navigator.clipboard.writeText(md)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (e) {
      pushToast('error', `Could not copy diagnostics: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const exportTrace = async () => {
    try {
      const events = await window.api.diag.trace(activeSessionId, 5000)
      const blob = new Blob([events.map((e) => JSON.stringify(e)).join('\n')], { type: 'application/x-ndjson' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `voice-agent-trace-${(activeSessionId ?? 'session').slice(0, 8)}.jsonl`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      pushToast('error', `Could not export the trace: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const traceFile = logs.find((l) => activeSessionId && l.name === `sessions/${activeSessionId}.jsonl`)

  const runSuggest = async () => {
    setSuggesting(true)
    try {
      const r = await window.api.diag.suggest()
      setSuggested(r)
      setAnalysis(r.analysis)
    } catch (e) {
      pushToast('error', `Tuning advisor failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSuggesting(false)
    }
  }

  const applySuggestions = (list: TuningSuggestion[]) => {
    if (!settings) return
    const patch: Record<string, Record<string, unknown>> = {}
    for (const s of list) {
      const group = s.group as TuningGroup
      patch[group] = { ...(patch[group] ?? (settings[group] as object)), [s.key]: s.value }
    }
    void updateSettings(patch as Partial<Settings>)
    pushToast('info', `Applied ${list.length} tuning change${list.length === 1 ? '' : 's'}`)
  }

  return (
    <Page
      title="Diagnostics"
      sub="What actually happened, turn by turn. Copy the report and paste it to whoever is debugging; it needs no other context."
      actions={
        <span className="inline-flex items-center gap-2">
          <Btn small icon={RefreshCw} onClick={() => void refresh()} disabled={busy}>
            Refresh
          </Btn>
          <Btn small icon={FolderOpen} onClick={() => void window.api.diag.openLogsFolder()}>
            Open logs folder
          </Btn>
          <Btn small icon={Download} onClick={() => void exportTrace()}>
            Export session trace
          </Btn>
          <Btn small primary icon={copied ? Check : Copy} onClick={() => void copyReport()}>
            {copied ? 'Copied' : 'Copy diagnostics'}
          </Btn>
        </span>
      }
    >
      <div className="flex flex-col gap-6">
        <Section icon={Timer} title="Last turn">
          <Timeline events={lastTurn} />
        </Section>
        <Section icon={Activity} title="This session">
          <Summary s={summary} />
        </Section>
        <Section icon={SlidersHorizontal} title="Turn-taking analysis">
          <div className="flex flex-col gap-4">
            <Analysis a={analysis} />
            <Suggestions result={suggested} busy={suggesting} onRun={() => void runSuggest()} onApply={applySuggestions} />
          </div>
        </Section>
        <Section icon={Ear} title="Ear stats (last report)">
          {stats ? (
            <div className="flex flex-wrap gap-1 text-xs">
              {Object.entries(stats)
                .filter(([k, v]) => !HIDE.has(k) && v !== undefined && v !== null)
                .map(([k, v]) => (
                  <Tag key={k}>
                    {k} {String(v)}
                  </Tag>
                ))}
            </div>
          ) : (
            <Empty>No ear stats yet; they arrive after each voice turn.</Empty>
          )}
        </Section>
        <Section
          icon={AlertTriangle}
          title="Recent errors"
          actions={
            <span className="text-xs" style={{ color: T.text3 }}>
              errors.log · {logs.find((l) => l.name === 'errors.log') ? `${Math.round((logs.find((l) => l.name === 'errors.log')!.bytes / 1024) * 10) / 10} KB` : 'empty'}
              {traceFile ? ` · trace ${Math.round((traceFile.bytes / 1024) * 10) / 10} KB` : ''}
            </span>
          }
        >
          {errors.length ? (
            <pre className="va-scroll text-xs m-0" style={{ fontFamily: T.mono, color: T.text2, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 260, overflowY: 'auto', lineHeight: 1.5 }}>
              {errors.join('\n')}
            </pre>
          ) : (
            <Empty>No warnings or errors logged.</Empty>
          )}
        </Section>
      </div>
    </Page>
  )
}
