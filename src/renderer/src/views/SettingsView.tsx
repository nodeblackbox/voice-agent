import { useCallback, useEffect, useState, type ReactNode } from 'react'
import {
  Check,
  CircleDot,
  Globe,
  Headphones,
  KeyRound,
  Mic,
  Pencil,
  Play,
  RefreshCw,
  Clock,
  type LucideIcon
} from 'lucide-react'
import type { KeyStatus, Provider, ServiceStatus, VoiceInfo } from '@shared/types'
import { T, serviceColor, serviceLabel } from '../theme'
import { useStore } from '../state/store'
import { Btn, Card, Dot, Page, Row, Select, TextInput, Toggle } from '../components/primitives'
import { listDevices, type DeviceLists } from '../audio/devices'
import { McpSection } from './settings/McpSection'
import { TuningSection } from './settings/TuningSection'

function Section({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 mb-1">
        <Icon size={14} style={{ color: T.text2 }} />
        <span className="text-sm font-medium">{title}</span>
      </div>
      {children}
    </div>
  )
}

const PROVIDERS: Array<{ id: Provider; label: string }> = [
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'groq', label: 'Groq' },
  { id: 'google', label: 'Google Gemini' },
  { id: 'xai', label: 'xAI Grok' }
]

function VoiceOutput() {
  const settings = useStore((s) => s.settings)
  const updateSettings = useStore((s) => s.updateSettings)
  const services = useStore((s) => s.services)
  const [voices, setVoices] = useState<VoiceInfo[]>([])
  const [previewing, setPreviewing] = useState<string | null>(null)

  useEffect(() => {
    window.api.speak
      .voices()
      .then((v) => {
        const en = v.filter((x) => x.locale.startsWith('en-'))
        en.sort((a, b) => {
          const aAva = /Ava/.test(a.shortName) ? 0 : 1
          const bAva = /Ava/.test(b.shortName) ? 0 : 1
          return aAva - bAva || a.locale.localeCompare(b.locale) || a.name.localeCompare(b.name)
        })
        setVoices(en)
      })
      .catch(() => setVoices([]))
  }, [])

  if (!settings) return null
  const v = settings.voice
  const preview = async (name: string) => {
    setPreviewing(name)
    try {
      await window.api.speak.preview(name)
    } finally {
      setPreviewing(null)
    }
  }
  const tts = services.tts

  return (
    <Section icon={Headphones} title="Voice output">
      <Card pad={0}>
        <div className="px-4">
          <Row label="Engine" sub="Edge TTS, streamed sentence by sentence. Falls back to the Windows voice if Edge is unreachable.">
            <span className="inline-flex items-center gap-2 text-xs" style={{ color: T.text2 }}>
              <Dot color={serviceColor(tts?.state)} />
              <span style={{ fontFamily: T.mono }}>{v.engine === 'edge' ? 'edge-tts' : 'system'}</span>
              <span style={{ color: T.text3 }}>{tts?.detail ?? serviceLabel(tts?.state)}</span>
            </span>
          </Row>
          <Row label="Rate" sub={`${v.rate > 0 ? '+' : ''}${Math.round(v.rate * 100)}%`}>
            <input type="range" min={-0.5} max={0.5} step={0.05} value={v.rate} onChange={(e) => void updateSettings({ voice: { ...v, rate: Number(e.target.value) } })} />
          </Row>
          <Row label="Pitch" sub={`${v.pitch > 0 ? '+' : ''}${Math.round(v.pitch)}Hz`}>
            <input type="range" min={-50} max={50} step={5} value={v.pitch} onChange={(e) => void updateSettings({ voice: { ...v, pitch: Number(e.target.value) } })} />
          </Row>
        </div>
        <div className="px-4 py-3 flex flex-col gap-1.5">
          <span className="text-xs font-medium" style={{ color: T.text3 }}>
            Voice
          </span>
          {voices.length === 0 && (
            <span className="text-xs" style={{ color: T.text3 }}>
              Voice list unavailable (offline?). Current: {v.voice}
            </span>
          )}
          {voices.map((voice) => {
            const selected = v.voice === voice.shortName
            const isDefault = voice.shortName === 'en-US-AvaNeural'
            return (
              <button
                key={voice.shortName}
                onClick={() => void updateSettings({ voice: { ...v, voice: voice.shortName } })}
                className="flex items-center gap-3 rounded-lg px-3 py-2 text-left"
                style={{ background: selected ? T.raised : 'transparent', border: `1px solid ${selected ? T.cyanBorder : 'transparent'}`, cursor: 'pointer' }}
              >
                <span style={{ width: 14, color: T.cyan }}>{selected ? <Check size={13} /> : null}</span>
                <span className="text-sm" style={{ width: 110 }}>
                  {voice.name}
                </span>
                <span className="text-xs" style={{ color: T.text3, fontFamily: T.mono, width: 50 }}>
                  {voice.locale}
                </span>
                <span className="text-xs flex-1" style={{ color: T.text2 }}>
                  {isDefault ? 'Default · warm, quick' : voice.gender}
                </span>
                <span
                  className="inline-flex items-center gap-1 text-xs"
                  style={{ color: previewing === voice.shortName ? T.cyan : T.text3, cursor: 'pointer' }}
                  onClick={(e) => {
                    e.stopPropagation()
                    void preview(voice.shortName)
                  }}
                >
                  <Play size={11} /> preview
                </span>
              </button>
            )
          })}
        </div>
      </Card>
    </Section>
  )
}

function VoiceInput() {
  const settings = useStore((s) => s.settings)
  const updateSettings = useStore((s) => s.updateSettings)
  const services = useStore((s) => s.services)
  const pushToast = useStore((s) => s.pushToast)
  const [devices, setDevices] = useState<DeviceLists>({ inputs: [], outputs: [] })
  const [restarting, setRestarting] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setDevices(await listDevices())
    } catch {
      pushToast('warn', 'Could not list audio devices')
    }
  }, [pushToast])

  useEffect(() => {
    void refresh()
    navigator.mediaDevices.addEventListener('devicechange', refresh)
    return () => navigator.mediaDevices.removeEventListener('devicechange', refresh)
  }, [refresh])

  if (!settings) return null
  const a = settings.audio
  const ear = services.sidecar

  const inputOptions = [{ id: '', label: 'System default' }, ...devices.inputs.map((d) => ({ id: d.deviceId, label: d.label || `Microphone ${d.deviceId.slice(0, 6)}` }))]
  const outputOptions = [{ id: '', label: 'System default' }, ...devices.outputs.map((d) => ({ id: d.deviceId, label: d.label || `Output ${d.deviceId.slice(0, 6)}` }))]

  const setInput = (id: string) => {
    const label = devices.inputs.find((d) => d.deviceId === id)?.label
    void updateSettings({ audio: { ...a, inputDeviceId: id || undefined, inputLabel: label } })
  }
  const setOutput = (id: string) => {
    const label = devices.outputs.find((d) => d.deviceId === id)?.label
    void updateSettings({ audio: { ...a, outputDeviceId: id || undefined, outputLabel: label } })
  }

  const restart = async () => {
    setRestarting(true)
    try {
      await window.api.services.sidecarRestart()
    } finally {
      setRestarting(false)
    }
  }

  return (
    <Section icon={Mic} title="Voice input">
      <Card pad={0}>
        <div className="px-4">
          <Row label="Microphone" sub={a.inputLabel ?? 'Picks a Blue Yeti automatically when present'}>
            <Select value={a.inputDeviceId ?? ''} onChange={setInput} options={inputOptions} width={260} />
          </Row>
          <Row label="Output device" sub={a.outputLabel}>
            <Select value={a.outputDeviceId ?? ''} onChange={setOutput} options={outputOptions} width={260} />
          </Row>
          <Row label="Speech to text" sub={`Parakeet via onnx-asr · ${ear?.detail ?? serviceLabel(ear?.state)}`}>
            <span className="inline-flex items-center gap-2">
              <Dot color={serviceColor(ear?.state)} pulse={ear?.state === 'starting' || ear?.state === 'reconnecting'} />
              <Select
                value={settings.stt.device}
                onChange={(v) => void updateSettings({ stt: { ...settings.stt, device: v as 'hybrid' | 'cuda' | 'cpu' } })}
                options={[
                  { id: 'hybrid', label: 'GPU encoder + CPU decoder' },
                  { id: 'cuda', label: 'GPU' },
                  { id: 'cpu', label: 'CPU only' }
                ]}
              />
              <Btn small icon={RefreshCw} onClick={() => void restart()} disabled={restarting}>
                Restart ears
              </Btn>
            </span>
          </Row>
          <Row label="Turn detection" sub="Silero VAD + Smart Turn v3.2; barge-in cancels generation and playback. Every threshold is in the Tuning section below." />
        </div>
      </Card>
    </Section>
  )
}

function Behaviour() {
  const settings = useStore((s) => s.settings)
  const updateSettings = useStore((s) => s.updateSettings)
  if (!settings) return null
  const b = settings.behaviour
  const set = (patch: Partial<typeof b>) => void updateSettings({ behaviour: { ...b, ...patch } })
  return (
    <Section icon={CircleDot} title="Behaviour">
      <Card pad={0}>
        <div className="px-4">
          <Row label="Confirm before saving to memory" sub="Off: writes silently. On: asks in the chat first.">
            <Toggle on={b.confirmBeforeSave} onChange={(v) => set({ confirmBeforeSave: v })} />
          </Row>
          <Row label="Spoken filler before tool calls" sub='"Let me check that" while a search runs'>
            <Toggle on={b.fillerBeforeTools} onChange={(v) => set({ fillerBeforeTools: v })} />
          </Row>
          <Row label="Loading sound during tool calls" sub="Subtle cue instead of silence">
            <Toggle on={b.loadingSound} onChange={(v) => set({ loadingSound: v })} />
          </Row>
          <Row label="Speak typed replies" sub="Read answers aloud even when you typed the question">
            <Toggle on={b.speakTypedReplies} onChange={(v) => set({ speakTypedReplies: v })} />
          </Row>
          <Row label="Listen on launch" sub="Open the microphone as soon as the ears are ready">
            <Toggle on={b.listenOnLaunch} onChange={(v) => set({ listenOnLaunch: v })} />
          </Row>
        </div>
      </Card>
    </Section>
  )
}

function ContextSection() {
  const settings = useStore((s) => s.settings)
  const updateSettings = useStore((s) => s.updateSettings)
  const [agentName, setAgentName] = useState(settings?.agentName ?? '')
  const [userName, setUserName] = useState(settings?.userName ?? '')
  const [aboutUser, setAboutUser] = useState(settings?.aboutUser ?? '')
  const [manual, setManual] = useState(settings?.location.manual ?? '')
  if (!settings) return null
  const loc = settings.location
  return (
    <Section icon={Clock} title="Context injected every turn">
      <Card pad={0}>
        <div className="px-4">
          <Row label="Location" sub="Manual text, a city-level IP lookup, or nothing">
            <span className="flex items-center gap-2">
              <Select
                value={loc.mode}
                onChange={(v) => void updateSettings({ location: { ...loc, mode: v as 'manual' | 'ip' | 'off' } })}
                options={[
                  { id: 'manual', label: 'Manual' },
                  { id: 'ip', label: 'IP lookup' },
                  { id: 'off', label: 'Off' }
                ]}
              />
              {loc.mode === 'manual' && (
                <TextInput
                  value={manual}
                  onChange={setManual}
                  placeholder="e.g. London, UK"
                  style={{ width: 200 }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void updateSettings({ location: { ...loc, manual } })
                  }}
                />
              )}
              {loc.mode === 'manual' && manual !== loc.manual && (
                <Btn small primary onClick={() => void updateSettings({ location: { ...loc, manual } })} icon={Check} />
              )}
            </span>
          </Row>
          <Row label="Agent name" sub="How the assistant refers to itself">
            <span className="flex items-center gap-2">
              <TextInput value={agentName} onChange={setAgentName} style={{ width: 160 }} />
              {agentName !== settings.agentName && <Btn small primary icon={Check} onClick={() => void updateSettings({ agentName })} />}
            </span>
          </Row>
          <Row label="Your name" sub="How the assistant addresses you">
            <span className="flex items-center gap-2">
              <TextInput value={userName} onChange={setUserName} style={{ width: 160 }} />
              {userName !== settings.userName && <Btn small primary icon={Check} onClick={() => void updateSettings({ userName })} />}
            </span>
          </Row>
          <Row label="About you" sub="One line the assistant always knows, e.g. “technical, prefers direct answers over hedging”">
            <span className="flex items-center gap-2">
              <TextInput
                value={aboutUser}
                onChange={setAboutUser}
                placeholder="optional"
                style={{ width: 300 }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void updateSettings({ aboutUser })
                }}
              />
              {aboutUser !== settings.aboutUser && <Btn small primary icon={Check} onClick={() => void updateSettings({ aboutUser })} />}
            </span>
          </Row>
        </div>
      </Card>
    </Section>
  )
}

function Providers() {
  const keys = useStore((s) => s.keys)
  const models = useStore((s) => s.models)
  const settings = useStore((s) => s.settings)
  const updateSettings = useStore((s) => s.updateSettings)
  const reloadKeys = useStore((s) => s.reloadKeys)
  const pushToast = useStore((s) => s.pushToast)
  const [editing, setEditing] = useState<Provider | null>(null)
  const [value, setValue] = useState('')

  const save = async (p: Provider) => {
    try {
      await window.api.keys.set(p, value.trim())
      await reloadKeys()
      setEditing(null)
      setValue('')
    } catch (err) {
      pushToast('error', `Could not save key: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const status = (p: Provider): KeyStatus | undefined => keys.find((k) => k.provider === p)

  return (
    <Section icon={KeyRound} title="Providers">
      <Card pad={0}>
        <div className="px-4">
          {PROVIDERS.map((p) => {
            const st = status(p.id)
            const isDefault = models.find((m) => m.id === settings?.modelId)?.provider === p.id
            return (
              <Row key={p.id} label={p.label} sub={isDefault ? 'default' : p.id === 'groq' ? 'one key, or a JSON list of keys to rotate' : undefined}>
                {editing === p.id ? (
                  <span className="inline-flex items-center gap-2">
                    <TextInput type="password" value={value} onChange={setValue} placeholder="API key" autoFocus style={{ width: 260 }} onKeyDown={(e) => e.key === 'Enter' && void save(p.id)} />
                    <Btn small onClick={() => setEditing(null)}>
                      Cancel
                    </Btn>
                    <Btn small primary onClick={() => void save(p.id)} icon={Check}>
                      Save
                    </Btn>
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-2 text-xs" style={{ color: T.text2 }}>
                    <Dot color={st?.set ? T.green : T.text3} />
                    <span style={{ fontFamily: T.mono }}>{st?.set ? (st.hint ?? '••••••••') : 'not set'}</span>
                    <Btn
                      small
                      icon={Pencil}
                      onClick={() => {
                        setEditing(p.id)
                        setValue('')
                      }}
                    >
                      Edit
                    </Btn>
                  </span>
                )}
              </Row>
            )
          })}
          <Row label="Fallback model" sub="Used for one turn when the chosen model is overloaded or times out">
            <Select
              value={settings?.fallbackModelId ?? ''}
              onChange={(v) => void updateSettings({ fallbackModelId: v })}
              options={models.map((m) => ({ id: m.id, label: `${m.label} · ${m.providerLabel}` }))}
              width={260}
            />
          </Row>
        </div>
      </Card>
    </Section>
  )
}

function WebSearch() {
  const settings = useStore((s) => s.settings)
  const updateSettings = useStore((s) => s.updateSettings)
  const services = useStore((s) => s.services)
  const [url, setUrl] = useState(settings?.searxng.url ?? '')
  const [status, setStatus] = useState<ServiceStatus | null>(null)
  const [busy, setBusy] = useState(false)
  if (!settings) return null
  const sx = status ?? services.searxng

  const start = async () => {
    setBusy(true)
    try {
      setStatus(await window.api.services.searxngEnsure())
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section icon={Globe} title="Web search">
      <Card pad={0}>
        <div className="px-4">
          <Row label="SearXNG" sub={sx?.detail ?? 'Local metasearch, started from source on demand'}>
            <span className="inline-flex items-center gap-2">
              <Dot color={serviceColor(sx?.state)} pulse={sx?.state === 'starting'} />
              <TextInput
                value={url}
                onChange={setUrl}
                mono
                style={{ width: 200 }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void updateSettings({ searxng: { ...settings.searxng, url } })
                }}
              />
              {url !== settings.searxng.url && <Btn small primary icon={Check} onClick={() => void updateSettings({ searxng: { ...settings.searxng, url } })} />}
              <Btn small icon={Play} onClick={() => void start()} disabled={busy}>
                {busy ? 'Starting…' : 'Start now'}
              </Btn>
            </span>
          </Row>
          <Row label="Start at launch" sub="Otherwise it starts on the first search">
            <Toggle on={settings.searxng.autostart} onChange={(v) => void updateSettings({ searxng: { ...settings.searxng, autostart: v } })} />
          </Row>
        </div>
      </Card>
    </Section>
  )
}

export function SettingsView() {
  return (
    <Page title="Settings">
      <div className="flex flex-col gap-6">
        <VoiceOutput />
        <VoiceInput />
        <Behaviour />
        <TuningSection />
        <ContextSection />
        <Providers />
        <WebSearch />
        <McpSection />
      </div>
    </Page>
  )
}
