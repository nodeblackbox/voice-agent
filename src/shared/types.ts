// Shared contracts between main, preload, renderer and the agent core.
// Everything crossing an IPC boundary is defined here.

import type { TuningValues } from './tuning'

export type Provider = 'anthropic' | 'groq' | 'google' | 'xai'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface ModelInfo {
  id: string
  provider: Provider
  providerLabel: string
  model: string
  label: string
  note?: string
  fast?: boolean
  /** Reasoning model: the reasoning-effort tuning applies. */
  reasoning?: boolean
}

export type Mode = 'ask' | 'agent'

export type AgentState =
  | 'idle'
  | 'listening'
  | 'user_speaking'
  | 'thinking'
  | 'tool'
  | 'speaking'
  | 'interrupted'

export type ServiceName = 'sidecar' | 'searxng' | 'mcp' | 'tts' | 'llm'
export type ServiceState = 'off' | 'starting' | 'ready' | 'error' | 'reconnecting'

export interface ServiceStatus {
  name: ServiceName
  state: ServiceState
  detail?: string
}

export type StyleLength = 'short' | 'balanced' | 'comprehensive'
export type StyleFormat = 'plain' | 'markdown'

export interface PromptStyle {
  id: string
  label: string
  desc: string
  kind: 'built-in' | 'custom'
  body: string
  length: StyleLength
  format: StyleFormat
}

export type ToolStatus = 'running' | 'done' | 'error' | 'cancelled'

export interface ToolSource {
  title: string
  url: string
  snippet?: string
}

export interface ToolActivity {
  name: string
  label: string
  kind: 'search' | 'read' | 'memory' | 'mcp' | 'time' | 'other'
  status: ToolStatus
  startedAt: number
  endedAt?: number
  /** One line describing what the tool is doing, e.g. the search query or the URL being read. */
  summary?: string
  /** Human-readable outcome, e.g. "6 results" or "saved". */
  detail?: string
  sources?: ToolSource[]
  server?: string
  /** The call's arguments, kept so the call can be replayed into the model's history. */
  input?: unknown
  /** Compacted result text kept in history for later turns (see brain.toolResultKeepChars). */
  resultText?: string
  /** Before/after of a memory edit, shown as a diff under the pill. */
  diff?: { before: string; after: string }
}

export interface TurnMetrics {
  /** Final ASR decode time reported by the ears. */
  asrMs?: number
  /** Time the utterance waited for the decoder. */
  queuedMs?: number
  /** Turn start (final transcript received) -> first token. */
  ttftMs?: number
  /** Turn start -> first complete sentence handed to TTS. */
  ttfsMs?: number
  /** Synthesis time of the first sentence (request -> full audio). */
  ttsFirstMs?: number
  /** Edge TTS request -> first audio byte for the first sentence. */
  ttsFirstByteMs?: number
  /** Turn start -> first audio playing. */
  ttfaMs?: number
  /** First chunk leaving the agent -> the renderer starting it (IPC + decode + scheduling). Over ~150 ms means the UI is too busy. */
  rendererMs?: number
  /** End of the user's speech -> first audio playing: the number humans feel. Voice turns only. */
  speechEndToAudioMs?: number
  totalMs?: number
  model?: string
  inputTokens?: number
  outputTokens?: number
  steps?: number
  /** Why the ears closed the turn, and the Smart Turn score that did it. */
  endReason?: 'done' | 'timeout'
  silenceMs?: number
  speechMs?: number
  turnP?: number | null
  interrupted?: boolean
  spokenChars?: number
  unspokenChars?: number
  fillers?: number
  stallReason?: string
  fallbackUsed?: boolean
  hitStepLimit?: boolean
}

/** One line of the session trace (logs/sessions/<sid>.jsonl); vocabulary in docs/DEBUGGING.md. */
export interface TraceEvent {
  /** Dotted event name: state, ear.final, turn.start, tts.sentence, playback.started, sidecar.ready … */
  ev: string
  /** Session the event belongs to; omitted for process-level events, which land in the current session. */
  sid?: string
  turn?: string
  t?: string
  [key: string]: unknown
}

/** Turn-taking statistics computed from a session trace (the numbers a tuner needs). */
export interface SessionAnalysis {
  events: number
  spanMin: number
  turns: number
  voiceTurns: number
  endReasons: { done: number; timeout: number }
  /** Timeouts by the cap that fired: keys are the cap in ms, or 'unknown'. */
  timeoutsByCap: Record<string, number>
  doneAtFirstCheck: number
  fillerHolds: number
  /** Last partial word at the check that ended a turn by timeout, most frequent first. */
  timeoutLastWords: Array<[string, number]>
  turnP: { low: number; mid: number; high: number; confident: number }
  mergeable: number
  continuations: number
  merged: number
  segments: number
  cancels: { newInput: number; bargeIn: number; continuation: number; other: number }
  bargein: { duck: number; cut: number; release: number }
  selfCutSuspects: number
  dropped: number
  stalls: number
  fallbacks: number
  stepLimits: number
  noteEchoes: number
  asrFailures: number
  asrReloads: number
  gpuMiB: number | null
  crashes: number
  latency: SessionSummary['latency']
}

export interface TuningSuggestion {
  group: string
  key: string
  value: number | boolean | string
  current: number | boolean | string
  reason: string
}

export interface LogFileInfo {
  /** File name, with a `sessions/` prefix for per-session traces. */
  name: string
  bytes: number
  modifiedAt: number
}

export interface SessionSummary {
  turns: number
  voiceTurns: number
  interrupted: number
  fallbacks: number
  stalls: number
  stepLimits: number
  fillers: number
  latency: Partial<Record<'asrMs' | 'ttftMs' | 'ttfsMs' | 'ttsFirstMs' | 'rendererMs' | 'ttfaMs' | 'speechEndToAudioMs' | 'totalMs', { p50: number; p95: number; n: number }>>
}

export interface Skill {
  id: string
  name: string
  trigger: string
  procedure: string
  enabled: boolean
  kind: 'built-in' | 'custom'
}

export interface McpServerConfig {
  name: string
  enabled: boolean
  transport: 'stdio' | 'http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
}

/** How the ears closed a user's turn; drawn as chips on the user bubble. */
export interface UserTiming {
  speechMs?: number
  silenceMs?: number
  endReason?: 'done' | 'timeout'
  turnP?: number | null
  /** Which silence/utterance cap fired on a timeout. */
  capMs?: number | null
  /** This turn was assembled from a fragment plus what the user said next. */
  merged?: boolean
  parts?: number
  /** Long-utterance segments transcribed before the final tail. */
  segments?: number
  /** This utterance interrupted the agent (barge-in cut). */
  cutAgent?: boolean
  speechEndAt?: number
}

export interface ChatMessage {
  id: string
  turnId: string
  sessionId: string
  role: 'user' | 'assistant' | 'tool'
  text: string
  via?: 'voice' | 'text'
  timing?: UserTiming
  streaming?: boolean
  interrupted?: boolean
  /** What the user actually heard before an interruption. */
  spokenText?: string
  /** What was generated but never played. */
  unspokenText?: string
  tool?: ToolActivity
  metrics?: TurnMetrics
  createdAt: number
}

export interface Session {
  id: string
  title: string
  projectId: string
  createdAt: number
  messageCount: number
}

export type MemoryKind = 'profile' | 'fact' | 'decision' | 'todo'

export interface MemoryEntry {
  id: number
  scopeId: string
  kind: MemoryKind
  key: string
  value: string
  tags: string[]
  source: 'user' | 'agent' | 'ui'
  createdAt: number
  updatedAt: number
}

export interface MemoryScope {
  id: string
  name: string
  count: number
}

export interface Project {
  id: string
  name: string
  path?: string
  defaultStyleId?: string
  createdAt: number
}

export interface PendingMemorySave {
  id: string
  key: string
  value: string
  kind: MemoryKind
  tags: string[]
  /** `delete` asks before forgetting an existing entry (`entryId`). */
  action?: 'save' | 'delete'
  entryId?: number
}

/** One change to a memory entry; `before`/`after` are JSON snapshots ({key, value, kind, tags}) or null for create/delete. */
export interface MemoryHistoryEntry {
  id: number
  entryId: number
  before: MemorySnapshot | null
  after: MemorySnapshot | null
  source: string
  at: number
}

export interface MemorySnapshot {
  key: string
  value: string
  kind: MemoryKind
  tags: string[]
}

export interface AudioDeviceSettings {
  inputDeviceId?: string
  inputLabel?: string
  outputDeviceId?: string
  outputLabel?: string
}

// Behavioural numbers are defined once in ./tuning; these aliases keep call sites readable.
export type EndpointSettings = TuningValues['endpoint']
export type BrainSettings = TuningValues['brain']
export type SpeechSettings = TuningValues['speech']
export type PlaybackSettings = TuningValues['playback']
export type MemorySettings = TuningValues['memory']
export type RuntimeSettings = TuningValues['runtime']

export interface SttSettings {
  model: string
  device: 'hybrid' | 'cuda' | 'cpu'
  pythonPath: string
}

export interface VoiceSettings {
  engine: 'edge' | 'system'
  voice: string
  rate: number
  pitch: number
}

export interface BehaviourSettings {
  confirmBeforeSave: boolean
  fillerBeforeTools: boolean
  loadingSound: boolean
  speakTypedReplies: boolean
  listenOnLaunch: boolean
}

export interface LocationSettings {
  mode: 'manual' | 'ip' | 'off'
  manual: string
}

export interface Settings {
  modelId: string
  fallbackModelId: string
  mode: Mode
  styleId: string
  projectId: string
  agentName: string
  userName: string
  /** One line about the user for the prompt ("technical, prefers direct answers"). */
  aboutUser: string
  voice: VoiceSettings
  audio: AudioDeviceSettings
  endpoint: EndpointSettings
  brain: BrainSettings
  speech: SpeechSettings
  playback: PlaybackSettings
  memory: MemorySettings
  runtime: RuntimeSettings
  stt: SttSettings
  behaviour: BehaviourSettings
  location: LocationSettings
  searxng: { url: string; autostart: boolean }
  mcp: { enabled: boolean }
}

export interface KeyStatus {
  provider: Provider
  set: boolean
  hint?: string
}

export interface McpToolInfo {
  server: string
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export interface McpServerStatus {
  name: string
  enabled: boolean
  command: string
  transport: 'stdio' | 'http'
  state: ServiceState
  error?: string
  tools: McpToolInfo[]
  stderrTail: string[]
  connectedAt?: number
  calls: number
}

export interface StyleDraft {
  label: string
  desc: string
  body: string
}

export interface VoiceInfo {
  name: string
  shortName: string
  locale: string
  gender: string
}

export interface ContextSnapshot {
  now: string
  timezone: string
  location: string
  project: string
  style: string
  memoryEntries: number
  skills: string[]
  tools: string[]
}

export interface Toast {
  id: string
  kind: 'info' | 'warn' | 'error'
  text: string
}

// ---- events main -> renderer --------------------------------------------------------------
export type AgentEvent =
  | { type: 'state'; state: AgentState }
  | { type: 'service'; status: ServiceStatus }
  | { type: 'message'; message: ChatMessage }
  | { type: 'message-removed'; id: string }
  | { type: 'partial'; text: string }
  | { type: 'level'; p: number }
  | { type: 'metrics'; turnId: string; metrics: TurnMetrics }
  | { type: 'duck'; gain: number }
  | { type: 'cue'; on: boolean }
  | { type: 'memory-confirm'; pending: PendingMemorySave | null }
  | { type: 'memory-changed' }
  | { type: 'sessions-changed' }
  | { type: 'settings-changed'; settings: Settings }
  | { type: 'toast'; toast: Toast }
  | { type: 'context'; snapshot: ContextSnapshot }
  | { type: 'skills-changed' }
  | { type: 'mcp-changed' }

export interface AudioChunk {
  turnId: string
  seq: number
  text: string
  mp3: ArrayBuffer
  last: boolean
  /** Fillers are spoken but never count as part of the reply the user heard. */
  kind: 'speech' | 'filler'
  /** Main-process clock when the chunk left the agent; the renderer echoes it back so the UI stage can be timed. */
  emittedAt?: number
}
