import type { ToolSet } from 'ai'
import type {
  AgentEvent,
  AudioChunk,
  ChatMessage,
  ContextSnapshot,
  PendingMemorySave,
  PromptStyle,
  Session,
  SessionSummary,
  Settings,
  Skill,
  TurnMetrics,
  UserTiming
} from '@shared/types'
import { GLOBAL_SCOPE, type MemoryStore } from './memory/store'
import { LocationProvider, relativeTime, timeContext } from './context'
import { composeSystemPrompt } from './prompts/compose'
import { BUILTIN_STYLES, DEFAULT_STYLE_ID } from './prompts/styles'
import { SpeakableFilter } from './prompts/speakable'
import { ModelFactory } from './providers/factory'
import type { KeySource } from './providers/keys'
import { findModel } from './providers/models'
import { SentenceChunker } from './speech/chunker'
import { toolLabel } from './speech/fillers'
import { describeInput, describeOutput, mcpServerOf, toolKind } from './tools/describe'
import { skillsBlock } from './prompts/skills'
import { Speaker } from './speech/speaker'
import { EdgeTtsEngine, KokoroTtsEngine, SystemTtsEngine, edgeTtsStats, type KokoroBackend, type TtsEngine } from './speech/tts'
import { currentTimeTool } from './tools/time'
import { memoryTools } from './tools/memory'
import { searchTools, type SearchDeps } from './tools/search'
import { mcpTools, type McpBridge } from './tools/mcp-adapter'
import { StateMachine } from './turn/state-machine'
import { TurnRunner } from './turn/runner'
import { buildModelMessages, compactToolResult } from './turn/history'
import { splitSpoken, type CutPoint, type SpokenChunk } from './turn/spoken'
import { mergeTexts, parseFillerWords, unfinishedReason } from './turn/continuation'
import { Coalescer } from './turn/coalesce'
import { classifyAfterCut, resumeText } from './turn/resume'

/** Why an interrupted reply is being replayed: asked for, acknowledged, or cut by a wordless interruption. */
type ResumeKind = 'resume' | 'backchannel' | 'empty'
import { summarize } from './metrics/summary'
import type { Trace } from './trace'

export interface EarsControl {
  agentSpeaking(on: boolean): void
  agentThinking(on: boolean): void
  /** Restart the ears if they are up but not producing transcripts. */
  restartStuck?(): void
}

export interface AgentDeps {
  store: MemoryStore
  settings: () => Settings
  keys: KeySource
  customStyles: () => PromptStyle[]
  skills: () => Skill[]
  mcp: McpBridge & { enabled(): boolean }
  search: SearchDeps & { configured(): boolean }
  ears: EarsControl
  /** Local Kokoro voice, the contingency when Edge TTS is unreachable. */
  kokoro?: KokoroBackend
  emit(event: AgentEvent): void
  emitAudio(chunk: AudioChunk): void
  cancelAudio(turnId: string | null): void
  log(msg: string): void
  trace: Trace
}

export interface SpeechEndInfo {
  reason: 'done' | 'timeout'
  silenceMs: number
  turnP: number | null
  speechMs?: number
  capMs?: number | null
  segments?: number
}

interface VoiceMeta {
  asrMs?: number
  queuedMs?: number
  afterCut?: boolean
  /** Continue an existing user bubble (segments, merged fragments) instead of creating one. */
  reuseUserId?: string
  parts?: number
  segments?: number
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted || ms <= 0) return resolve()
    const t = setTimeout(done, ms)
    function done(): void {
      clearTimeout(t)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })

interface ActiveTurn {
  id: string
  controller: AbortController
  assistant: ChatMessage | null
  chunks: Map<number, SpokenChunk>
  startedSeqs: Set<number>
  finishedSeqs: Set<number>
  speaker: Speaker
  llmDone: boolean
  drained: boolean
  startedAt: number
  /** Wall-clock moment the ears closed the user's turn (voice turns only). */
  speechEndAt?: number
  ttsDroppedBefore: number
  /** This turn replays an interrupted reply from its cut sentence; no model call. */
  resume?: { kind: ResumeKind; heardBefore: string }
}

const words = (s: string): string[] => s.toLowerCase().match(/[a-z0-9']+/g) ?? []

/** Share of `a`'s words that also occur in `b` (0..1); 0 when either side is empty. */
export function wordOverlap(a: string, b: string): number {
  const wa = words(a)
  if (!wa.length) return 0
  const wb = new Set(words(b))
  if (!wb.size) return 0
  return wa.filter((w) => wb.has(w)).length / wa.length
}

const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s)

/** A cut with an empty transcript resumes the reply at most this often per message (guards a self-cut loop). */
const MAX_EMPTY_RESUMES = 2
/** A transcript normally lands well under 2 s after speech ends; past this the ears are stuck. */
export const FINAL_OVERDUE_MS = 25_000
/** How long turns stay on the fallback voice after Edge failed before Edge is tried again. */
const EDGE_RETRY_AFTER_MS = 60_000

export class Agent {
  readonly sm: StateMachine
  private factory: ModelFactory
  private edge: EdgeTtsEngine
  private system = new SystemTtsEngine()
  private kokoro: KokoroTtsEngine | null = null
  /** After Edge degrades a turn, later turns skip straight to the fallback voice until then. */
  private edgeDownUntil = 0
  private location = new LocationProvider()
  private sessionId = ''
  private messages: ChatMessage[] = []
  private turn: ActiveTurn | null = null
  /** The last cancelled turn, kept until the renderer reports where the cut landed. */
  private cancelled: { turn: ActiveTurn; assistant: ChatMessage } | null = null
  private readTurn: { id: string; controller: AbortController } | null = null
  private pending: PendingMemorySave | null = null
  private micOn = false
  private lastSpokenText = ''
  private lastSpeechEnd: (SpeechEndInfo & { at: number }) | null = null
  /** The running turn answers a transcript that looked unfinished; a resume inside the window merges. */
  private mergeable: { turnId: string; userMsgId: string; text: string; expiresAt: number; parts: number; reason: string } | null = null
  /** A fragment whose reply was cancelled; the next final is appended to it. */
  private mergePending: { userMsgId: string; text: string; parts: number; since: number } | null = null
  /** Segments of a long utterance that is still open. */
  private segmentBuffer: { userMsgId: string; texts: string[] } | null = null
  /** speech_end events still waiting for their final transcript, and the timer guarding them. */
  private awaitingFinals = 0
  private finalTimer: ReturnType<typeof setTimeout> | null = null
  selfCutSuspects = 0
  /** Streaming message updates are persisted and pushed to the UI at `brain.uiFlushMs`, not per token. */
  private readonly flusher = new Coalescer<ChatMessage>(
    (m) => {
      this.deps.store.saveMessage(m)
      this.deps.emit({ type: 'message', message: m })
    },
    () => this.deps.settings().brain.uiFlushMs
  )

  constructor(private readonly deps: AgentDeps) {
    this.sm = new StateMachine((state, event) => {
      deps.log(`state -> ${state} (${event})`)
      this.tr('state', { from: this.sm?.log.at(-1)?.from, to: state, event })
      deps.emit({ type: 'state', state })
    })
    this.factory = new ModelFactory(deps.keys)
    this.edge = new EdgeTtsEngine(deps.settings().speech.ttsPoolSize, () => deps.settings().speech.ttsTimeoutMs)
    if (deps.kokoro) this.kokoro = new KokoroTtsEngine(deps.kokoro, () => deps.settings().voice.kokoroVoice, deps.log)
    const sessions = deps.store.sessions()
    const latest = sessions[0]
    if (latest && latest.messageCount === 0) this.selectSession(latest.id)
    else this.newSession()
  }

  // ---- sessions ---------------------------------------------------------------------------
  get currentSessionId(): string {
    return this.sessionId
  }

  newSession(): Session {
    this.closeSession()
    const s: Session = { id: crypto.randomUUID(), title: 'New session', projectId: this.deps.settings().projectId, createdAt: Date.now(), messageCount: 0 }
    this.deps.store.createSession(s)
    this.sessionId = s.id
    this.messages = []
    this.tr('session.start', { projectId: s.projectId })
    this.deps.emit({ type: 'sessions-changed' })
    return s
  }

  selectSession(id: string): ChatMessage[] {
    this.cancelTurn('session-switch')
    if (id !== this.sessionId) this.closeSession()
    this.sessionId = id
    this.messages = this.deps.store.messages(id)
    this.tr('session.select', { messages: this.messages.length })
    return this.messages
  }

  /** p50/p95 latencies and counts over the turns of the current session. */
  summary(): SessionSummary {
    return summarize(this.messages.filter((m) => m.role === 'assistant' && m.metrics).map((m) => m.metrics!))
  }

  private closeSession(): void {
    if (!this.sessionId || !this.messages.some((m) => m.role === 'assistant')) return
    this.tr('session.summary', { ...this.summary(), selfCutSuspects: this.selfCutSuspects })
  }

  /** Called on quit: cancel what is running and write the session summary. */
  shutdown(): void {
    this.clearFinalWatch()
    this.cancel()
    this.closeSession()
  }

  private tr(ev: string, data: Record<string, unknown> = {}): void {
    this.deps.trace({ ev, sid: this.sessionId, turn: this.turn?.id, ...data })
  }

  deleteSession(id: string): void {
    this.deps.store.deleteSession(id)
    if (id === this.sessionId) this.newSession()
    this.deps.emit({ type: 'sessions-changed' })
  }

  history(sessionId?: string): ChatMessage[] {
    return sessionId && sessionId !== this.sessionId ? this.deps.store.messages(sessionId) : this.messages
  }

  // ---- mic / ears -------------------------------------------------------------------------
  setMic(on: boolean): void {
    this.micOn = on
    this.sm.setMic(on)
  }

  onSpeechStart(): void {
    if (this.sm.state === 'interrupted') {
      this.sm.resumeUser()
      return
    }
    this.tryContinuation()
    this.sm.speechStart()
  }

  /** The user resumed inside the continuation window: drop the fragment's reply, keep its text for merging. */
  private tryContinuation(): boolean {
    const m = this.mergeable
    if (!m) return false
    const now = Date.now()
    if (this.turn?.id !== m.turnId || now > m.expiresAt) {
      this.mergeable = null
      return false
    }
    const window = this.deps.settings().brain.continuationWindowMs
    this.tr('turn.continuation', { reason: m.reason, gapMs: Math.max(0, now - (m.expiresAt - window)), parts: m.parts, text: m.text })
    this.mergePending = { userMsgId: m.userMsgId, text: m.text, parts: m.parts, since: now }
    this.mergeable = null
    this.cancelTurn('continuation')
    return true
  }

  /** A long utterance's older part arrived while the user is still talking. */
  onSegment(text: string, index: number): void {
    const clean = text.trim()
    if (!this.segmentBuffer) {
      const id = crypto.randomUUID()
      this.segmentBuffer = { userMsgId: id, texts: [] }
      const base = this.mergePending ? this.mergePending.text : ''
      const user: ChatMessage = { id, turnId: `pending-${id}`, sessionId: this.sessionId, role: 'user', text: base, via: 'voice', streaming: true, createdAt: Date.now() }
      this.upsert(user)
    }
    this.segmentBuffer.texts[index] = clean
    const msg = this.messages.find((x) => x.id === this.segmentBuffer!.userMsgId)
    if (msg) {
      const base = this.mergePending ? this.mergePending.text : ''
      msg.text = this.segmentBuffer.texts.reduce((acc, t) => mergeTexts(acc, t ?? ''), base)
      this.upsert(msg)
    }
    this.tr('turn.segment', { index, chars: clean.length, text: clean })
  }

  onPartial(text: string): void {
    this.deps.emit({ type: 'partial', text })
  }

  onSpeechEnd(info?: SpeechEndInfo): void {
    this.lastSpeechEnd = info ? { ...info, at: Date.now() } : { reason: 'done', silenceMs: 0, turnP: null, at: Date.now() }
    this.sm.speechEnd()
    this.deps.emit({ type: 'partial', text: '' })
    this.awaitingFinals++
    this.armFinalWatch()
  }

  private armFinalWatch(): void {
    if (this.finalTimer) clearTimeout(this.finalTimer)
    this.finalTimer = setTimeout(() => this.finalOverdue(), FINAL_OVERDUE_MS)
    this.finalTimer.unref?.()
  }

  private clearFinalWatch(): void {
    if (this.finalTimer) clearTimeout(this.finalTimer)
    this.finalTimer = null
    this.awaitingFinals = 0
  }

  // The ears said the user stopped talking but no transcript followed (a decode frozen on a busy
  // GPU, a dead sidecar). Without this the agent sits on "thinking" until the app is restarted.
  private finalOverdue(): void {
    const waiting = this.awaitingFinals
    this.clearFinalWatch()
    this.tr('turn.final_overdue', { waitingMs: FINAL_OVERDUE_MS, finals: waiting, state: this.sm.state })
    this.deps.log(`no transcript ${FINAL_OVERDUE_MS / 1000}s after speech ended (${waiting} pending); restarting the ears`)
    const segments = this.segmentBuffer
    this.segmentBuffer = null
    this.mergePending = null
    const partial = segments && this.messages.find((x) => x.id === segments.userMsgId)
    if (partial) this.upsert({ ...partial, streaming: false })
    if (this.sm.state === 'thinking' && !this.turn) this.sm.done()
    this.deps.ears.restartStuck?.()
    this.toast('warn', "Speech recognition stopped responding, so I didn't catch that. Restarting the ears; type, or speak again in a few seconds.")
  }

  onFinal(text: string, asrMs: number, meta: { afterCut?: boolean; durationMs?: number; queuedMs?: number; segments?: number } = {}): void {
    const tail = text.trim()
    this.deps.emit({ type: 'partial', text: '' })
    if (this.awaitingFinals > 0 && --this.awaitingFinals > 0) this.armFinalWatch()
    else this.clearFinalWatch()
    const tooShort = tail.length < this.deps.settings().brain.minUtteranceChars || /^[\s.,!?]*$/.test(tail)
    if (meta.afterCut) {
      // an interruption whose transcript is empty or echoes what the agent was saying is probably
      // the agent hearing itself through the speakers; count it so the echo gate decision has data
      const overlap = tooShort ? 1 : wordOverlap(tail, this.lastSpokenText)
      if (overlap >= 0.6) {
        this.selfCutSuspects++
        this.tr('turn.self_cut_suspect', { text: tail, overlap: Math.round(overlap * 100) / 100, durationMs: meta.durationMs, total: this.selfCutSuspects })
      }
    }
    // assemble: [fragment whose reply was cancelled] + [segments of a long utterance] + tail
    const segments = this.segmentBuffer
    const pending = this.mergePending
    this.segmentBuffer = null
    this.mergePending = null
    let full = segments ? segments.texts.reduce((acc, t) => mergeTexts(acc, t ?? ''), '') : ''
    full = mergeTexts(full, tail)
    if (pending) full = mergeTexts(pending.text, full)
    const parts = (pending?.parts ?? 1) + (pending ? 1 : 0)
    if (!full.trim() || (tooShort && !segments && !pending)) {
      this.tr('turn.dropped', { reason: 'empty-transcript', chars: tail.length, asrMs, afterCut: meta.afterCut === true })
      // the ears cut the agent but heard nothing usable (speaker bleed, a cough): pick the reply back up
      const target = meta.afterCut ? this.resumable() : null
      if (target && (target.resumeCount ?? 0) < MAX_EMPTY_RESUMES) {
        void this.resumeReply(target, 'empty', '', 'voice', { asrMs, afterCut: true })
        return
      }
      this.sm.blip()
      if (this.sm.state === 'thinking') this.sm.done()
      return
    }
    if (pending) this.tr('turn.merged', { parts, waitedMs: Date.now() - pending.since, text: full })
    const voiceMeta: VoiceMeta = {
      asrMs,
      queuedMs: meta.queuedMs,
      afterCut: meta.afterCut,
      reuseUserId: segments?.userMsgId ?? pending?.userMsgId,
      parts: pending ? parts : undefined,
      segments: segments ? segments.texts.length : meta.segments
    }
    if (!segments && !pending) {
      const target = this.resumable()
      const kind = target ? this.afterCutKind(full) : null
      if (target && kind) {
        void this.resumeReply(target, kind, full, 'voice', voiceMeta)
        return
      }
    }
    void this.handleInput(full, 'voice', voiceMeta)
  }

  /** The interrupted reply that "go on" would refer to, while the resume window is open. */
  private resumable(): ChatMessage | null {
    if (this.turn) return null
    const windowMs = this.deps.settings().brain.resumeWindowMs
    if (windowMs <= 0) return null
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i]!
      if (m.role !== 'assistant') continue
      if (!m.interrupted || !m.unspokenText?.trim()) return null
      return Date.now() - (m.interruptedAt ?? 0) <= windowMs ? m : null
    }
    return null
  }

  /** 'resume' or 'backchannel' when the utterance asks for the rest of an interrupted reply; null when it is a new turn. */
  private afterCutKind(text: string): Exclude<ResumeKind, 'empty'> | null {
    const b = this.deps.settings().brain
    const kind = classifyAfterCut(text, { resumePhrases: b.resumePhrases, backchannelWords: b.backchannelWords })
    if (kind === 'resume') return kind
    if (kind === 'backchannel' && b.resumeOnBackchannel) return kind
    return null
  }

  /**
   * Replay an interrupted reply from the start of its cut sentence: same assistant message, new turn,
   * no model call. The user's utterance still becomes a bubble so the transcript shows what happened.
   */
  private async resumeReply(target: ChatMessage, kind: ResumeKind, userText: string, via: 'voice' | 'text', voiceMeta: VoiceMeta = {}): Promise<void> {
    const text = resumeText(target.spokenText, target.unspokenText)
    if (!text) {
      if (userText) await this.handleInput(userText, via, voiceMeta)
      return
    }
    if (this.turn) this.cancelTurn('new-input')
    this.stopReading()
    const settings = this.deps.settings()
    const turnId = crypto.randomUUID()
    const speechEnd = via === 'voice' ? this.lastSpeechEnd : null
    this.lastSpeechEnd = null
    if (userText) {
      const timing = this.userTiming(speechEnd, voiceMeta)
      this.upsert({ id: crypto.randomUUID(), turnId, sessionId: this.sessionId, role: 'user', text: userText, via, timing: { ...timing, resumed: kind }, createdAt: Date.now() })
    }
    const controller = new AbortController()
    const speaker = this.newSpeaker(turnId, settings, false, controller)
    const heardBefore = target.spokenText ?? ''
    const turn: ActiveTurn = {
      id: turnId,
      controller,
      assistant: target,
      chunks: new Map(),
      startedSeqs: new Set(),
      finishedSeqs: new Set(),
      speaker,
      llmDone: false,
      drained: false,
      startedAt: Date.now(),
      speechEndAt: speechEnd?.at,
      ttsDroppedBefore: edgeTtsStats.droppedFrames,
      resume: { kind, heardBefore }
    }
    this.turn = turn
    this.mergeable = null
    target.turnId = turnId
    target.interrupted = false
    target.streaming = false
    target.resumeCount = (target.resumeCount ?? 0) + 1
    target.metrics = { ...target.metrics, interrupted: false }
    this.upsert(target)
    this.sm.think()
    this.deps.ears.agentSpeaking(true)
    this.tr('turn.resume', { kind, userText, heardChars: heardBefore.length, remainingChars: text.length, count: target.resumeCount, text })

    const filter = new SpeakableFilter(this.style(settings).format)
    const chunker = new SentenceChunker(settings.speech.maxChars, settings.speech.firstMinWords)
    for (const sentence of chunker.feed(filter.feed(text))) speaker.say(sentence)
    for (const sentence of chunker.flush()) speaker.say(sentence)
    try {
      await speaker.finish()
      if (this.turn !== turn) return
      turn.llmDone = true
      if (turn.drained) this.finishTurn(turn)
      else this.armDrainTimeout(turn)
    } catch (e) {
      if (this.turn !== turn) return
      this.deps.log(`resume failed: ${(e as Error).message}`)
      this.finishTurn(turn)
    }
  }

  onBargeIn(stage: 'duck' | 'cut' | 'release'): void {
    if (stage === 'duck') this.deps.emit({ type: 'duck', gain: this.deps.settings().endpoint.duckGain })
    else if (stage === 'release') this.deps.emit({ type: 'duck', gain: 1 })
    else {
      this.deps.emit({ type: 'duck', gain: 1 })
      if (this.tryContinuation()) {
        this.stopReading()
        return
      }
      if (this.sm.bargeIn()) this.cancelTurn('barge-in', true)
      this.stopReading()
    }
  }

  // ---- playback feedback from the renderer -----------------------------------------------
  onPlaybackStarted(turnId: string, seq: number, emittedAt?: number): void {
    const t = this.turn
    if (!t || t.id !== turnId) return
    if (t.startedSeqs.size === 0) {
      this.sm.firstAudio()
      const m = t.assistant?.metrics ?? {}
      const now = Date.now()
      m.ttfaMs = now - t.startedAt
      if (t.speechEndAt !== undefined) m.speechEndToAudioMs = now - t.speechEndAt
      if (t.speaker.firstSynthMs !== undefined) m.ttsFirstMs = t.speaker.firstSynthMs
      if (t.speaker.firstByteMs !== undefined) m.ttsFirstByteMs = t.speaker.firstByteMs
      if (emittedAt !== undefined) m.rendererMs = Math.max(0, now - emittedAt)
      this.tr('turn.first_audio', { seq, ttfaMs: m.ttfaMs, speechEndToAudioMs: m.speechEndToAudioMs, ttsFirstMs: m.ttsFirstMs, ttsFirstByteMs: m.ttsFirstByteMs, rendererMs: m.rendererMs })
      if (t.assistant) {
        t.assistant.metrics = m
        this.upsert(t.assistant)
        this.deps.emit({ type: 'metrics', turnId, metrics: m })
      }
    }
    t.startedSeqs.add(seq)
    this.tr('playback.started', { seq, kind: t.chunks.get(seq)?.kind })
  }

  onPlaybackFinished(turnId?: string, seq?: number): void {
    if (!turnId || seq === undefined) return
    const t = this.turn?.id === turnId ? this.turn : this.cancelled?.turn.id === turnId ? this.cancelled.turn : null
    if (!t) return
    t.finishedSeqs.add(seq)
    if (t === this.turn) this.tr('playback.finished', { seq })
  }

  /** The renderer's report of where a cancelled turn's audio actually stopped. */
  onPlaybackCancelled(turnId: string, seq: number, offsetS: number, durationS: number): void {
    const c = this.cancelled
    if (!c || c.turn.id !== turnId) return
    this.applySpokenSplit(c.turn, c.assistant, { seq, offsetS, durationS })
    this.tr('turn.spoken_split', { seq, offsetS: Math.round(offsetS * 100) / 100, durationS: Math.round(durationS * 100) / 100, spokenChars: c.assistant.spokenText?.length ?? 0, unspokenChars: c.assistant.unspokenText?.length ?? 0 })
  }

  onPlaybackDrained(turnId: string): void {
    if (this.readTurn && this.readTurn.id === turnId) {
      this.readTurn = null
      this.deps.ears.agentSpeaking(false)
      if (!this.turn) this.sm.done()
      return
    }
    const t = this.turn
    if (!t || t.id !== turnId) return
    t.drained = true
    this.tr('playback.drained', { chunks: t.startedSeqs.size })
    if (t.llmDone) this.finishTurn(t)
  }

  // ---- turns ------------------------------------------------------------------------------
  async send(text: string): Promise<void> {
    const clean = text.trim()
    const target = clean ? this.resumable() : null
    const kind = target ? this.afterCutKind(clean) : null
    if (target && kind) await this.resumeReply(target, kind, clean, 'text')
    else await this.handleInput(clean, 'text')
  }

  private userTiming(speechEnd: (SpeechEndInfo & { at: number }) | null, voiceMeta: VoiceMeta): UserTiming | undefined {
    if (!speechEnd) return undefined
    return {
      speechMs: speechEnd.speechMs,
      silenceMs: speechEnd.silenceMs,
      endReason: speechEnd.reason,
      turnP: speechEnd.turnP,
      capMs: speechEnd.capMs,
      merged: voiceMeta.parts !== undefined && voiceMeta.parts > 1 ? true : undefined,
      parts: voiceMeta.parts,
      segments: voiceMeta.segments || undefined,
      cutAgent: voiceMeta.afterCut || undefined,
      speechEndAt: speechEnd.at
    }
  }

  private newSpeaker(turnId: string, settings: Settings, silent: boolean, controller: AbortController): Speaker {
    return new Speaker(
      turnId,
      {
        silent,
        engine: this.engineFor(settings),
        fallback: this.fallbackEngine(),
        voice: settings.voice,
        attempts: settings.speech.ttsAttempts,
        degradeAfter: settings.speech.ttsDegradeAfter,
        emit: (chunk) => {
          if (this.turn?.id !== turnId) return
          this.turn.chunks.set(chunk.seq, { seq: chunk.seq, text: chunk.text, kind: chunk.kind })
          this.deps.emitAudio({ ...chunk, emittedAt: Date.now() })
        },
        onDegraded: () => this.edgeDegraded(),
        log: this.deps.log,
        trace: (ev, data) => this.tr(ev, data)
      },
      controller.signal
    )
  }

  private async handleInput(text: string, via: 'voice' | 'text', voiceMeta: VoiceMeta = {}): Promise<void> {
    if (!text) return
    if (this.turn) this.cancelTurn('new-input')
    this.stopReading()
    const settings = this.deps.settings()
    const turnId = crypto.randomUUID()
    const speechEnd = via === 'voice' ? this.lastSpeechEnd : null
    this.lastSpeechEnd = null
    const timing = this.userTiming(speechEnd, voiceMeta)
    const existing = voiceMeta.reuseUserId ? this.messages.find((m) => m.id === voiceMeta.reuseUserId) : undefined
    const user: ChatMessage = existing
      ? { ...existing, turnId, text, timing, streaming: false }
      : { id: crypto.randomUUID(), turnId, sessionId: this.sessionId, role: 'user', text, via, timing, createdAt: Date.now() }
    this.upsert(user)
    if (this.messages.filter((m) => m.role === 'user').length === 1) {
      this.deps.store.renameSession(this.sessionId, text.split(/\s+/).slice(0, 7).join(' ').slice(0, 60))
      this.deps.emit({ type: 'sessions-changed' })
    }

    const controller = new AbortController()
    const speakThisTurn = via === 'voice' || settings.behaviour.speakTypedReplies
    const speaker = this.newSpeaker(turnId, settings, !speakThisTurn, controller)
    // Open the Edge socket while the model thinks so the first sentence skips the handshake.
    const engine = this.engineFor(settings)
    if (speakThisTurn && engine === this.edge) {
      const t0 = Date.now()
      void this.edge.warm(settings.voice.voice).then((ok) => {
        if (ok) this.tr('tts.warm', { turnId, ms: Date.now() - t0 })
        // Edge can't even open a socket: get the contingency voice loading before the sentences fail
        else void this.deps.kokoro?.start()
      })
    } else if (speakThisTurn && engine === this.kokoro) void this.deps.kokoro?.start()
    const turn: ActiveTurn = {
      id: turnId,
      controller,
      assistant: null,
      chunks: new Map(),
      startedSeqs: new Set(),
      finishedSeqs: new Set(),
      speaker,
      llmDone: false,
      drained: false,
      startedAt: Date.now(),
      speechEndAt: speechEnd?.at,
      ttsDroppedBefore: edgeTtsStats.droppedFrames
    }
    this.turn = turn
    this.sm.think()
    this.deps.ears.agentThinking(true)
    this.deps.ears.agentSpeaking(true)

    // an unfinished-looking transcript: answer, but let a quick resume merge into this turn instead
    this.mergeable = null
    if (via === 'voice' && settings.brain.continuationWindowMs > 0) {
      const reason = unfinishedReason(text, {
        endReason: speechEnd?.reason,
        turnP: speechEnd?.turnP,
        fillerWords: parseFillerWords(settings.endpoint.fillerWords),
        minWords: settings.brain.mergeMinWords,
        lowP: settings.endpoint.turnLowThreshold
      })
      if (reason) {
        const from = speechEnd?.at ?? Date.now()
        this.mergeable = { turnId, userMsgId: user.id, text, expiresAt: from + settings.brain.continuationWindowMs, parts: voiceMeta.parts ?? 1, reason }
        this.tr('turn.mergeable', { reason, windowMs: settings.brain.continuationWindowMs, holdMs: settings.brain.mergeHoldMs })
        if (settings.brain.mergeHoldMs > 0) {
          await sleep(settings.brain.mergeHoldMs, controller.signal)
          if (this.turn !== turn) return
        }
      }
    }

    const style = this.style(settings)
    const model = findModel(settings.modelId) ?? findModel('anthropic:claude-haiku-4-5')!
    const fallback = findModel(settings.fallbackModelId) ?? null
    const tools = this.tools(settings)
    const memory = this.memoryBlock(text, settings)
    const system = composeSystemPrompt(style, {
      agentName: settings.agentName,
      userName: settings.userName,
      aboutUser: settings.aboutUser,
      ...timeContext(),
      location: await this.location.resolve(settings.location),
      projectName: this.projectName(settings),
      memoryBlock: memory.block,
      skillsBlock: skillsBlock(this.deps.skills()),
      toolNames: Object.keys(tools),
      fillerEnabled: settings.behaviour.fillerBeforeTools
    })
    this.tr('turn.start', {
      via,
      text,
      asrMs: voiceMeta.asrMs,
      queuedMs: voiceMeta.queuedMs,
      endReason: speechEnd?.reason,
      silenceMs: speechEnd?.silenceMs,
      turnP: speechEnd?.turnP,
      capMs: speechEnd?.capMs,
      parts: voiceMeta.parts,
      segments: voiceMeta.segments,
      afterCut: voiceMeta.afterCut,
      model: model.id,
      fallback: fallback?.id ?? null,
      style: style.id,
      mode: settings.mode,
      speak: speakThisTurn,
      tools: Object.keys(tools).length,
      memoryHints: memory.profile + memory.relevant + memory.history,
      memoryProfile: memory.profile,
      memoryRelevant: memory.relevant,
      memoryHistory: memory.history,
      systemChars: system.length
    })

    const metrics: TurnMetrics = {}
    if (voiceMeta.asrMs !== undefined) metrics.asrMs = voiceMeta.asrMs
    if (voiceMeta.queuedMs !== undefined) metrics.queuedMs = voiceMeta.queuedMs
    if (speechEnd) {
      metrics.endReason = speechEnd.reason
      metrics.silenceMs = speechEnd.silenceMs
      metrics.turnP = speechEnd.turnP
      if (speechEnd.speechMs !== undefined) metrics.speechMs = speechEnd.speechMs
    }
    const assistant: ChatMessage = {
      id: crypto.randomUUID(),
      turnId,
      sessionId: this.sessionId,
      role: 'assistant',
      text: '',
      streaming: true,
      metrics,
      createdAt: Date.now()
    }
    turn.assistant = assistant
    this.upsert(assistant)

    const toolMessages = new Map<string, ChatMessage>()
    const runner = new TurnRunner({
      factory: this.factory,
      model,
      fallback,
      system,
      messages: buildModelMessages(this.messages, turnId, text, { maxMessages: settings.brain.historyMessages, toolResultKeepChars: settings.brain.toolResultKeepChars }),
      tools,
      maxSteps: settings.mode === 'ask' ? settings.brain.maxStepsAsk : settings.brain.maxStepsAgent,
      format: style.format,
      speaker,
      speech: settings.speech,
      brain: settings.brain,
      fillerEnabled: settings.behaviour.fillerBeforeTools && speakThisTurn,
      firstTokenTimeoutMs: settings.brain.firstTokenTimeoutMs,
      stallTimeoutMs: settings.brain.stallTimeoutMs,
      toolStallTimeoutMs: settings.brain.toolStallTimeoutMs,
      onDelta: (delta) => {
        assistant.text += delta
        this.upsert(assistant)
      },
      onToolStart: (id, name, input) => {
        this.sm.tool(true)
        const m: ChatMessage = {
          id,
          turnId,
          sessionId: this.sessionId,
          role: 'tool',
          text: name,
          tool: {
            name,
            label: toolLabel(name),
            kind: toolKind(name),
            server: mcpServerOf(name),
            summary: describeInput(name, input),
            input,
            status: 'running',
            startedAt: Date.now()
          },
          createdAt: Date.now()
        }
        toolMessages.set(id, m)
        this.tr('turn.tool_start', { id, name, summary: m.tool?.summary })
        this.upsert(m)
      },
      onToolEnd: (id, name, ok, output, error) => {
        const m = toolMessages.get(id)
        if (m?.tool) {
          m.tool.status = ok ? 'done' : 'error'
          m.tool.endedAt = Date.now()
          if (ok) {
            const described = describeOutput(name, output)
            m.tool.detail = described.detail
            m.tool.sources = described.sources
            m.tool.resultText = compactToolResult(output, settings.brain.toolResultKeepChars)
            const o = output as { before?: unknown; after?: unknown } | null
            if (o && typeof o.before === 'string' && typeof o.after === 'string') m.tool.diff = { before: o.before, after: o.after }
          } else m.tool.detail = error
          this.tr('turn.tool_end', { id, name, ok, ms: m.tool.endedAt - m.tool.startedAt, detail: m.tool.detail })
          this.upsert(m)
        }
        if ([...toolMessages.values()].every((x) => x.tool?.status !== 'running')) this.sm.tool(false)
      },
      onCue: (on) => {
        if (settings.behaviour.loadingSound) this.deps.emit({ type: 'cue', on })
      },
      onMetrics: (m: TurnMetrics) => {
        assistant.metrics = { ...assistant.metrics, ...m }
        this.deps.emit({ type: 'metrics', turnId, metrics: assistant.metrics })
      },
      onNotice: (t) => {
        this.tr('turn.notice', { text: t })
        this.toast('warn', t)
      },
      log: this.deps.log,
      trace: (ev, data) => this.tr(ev, data)
    })

    try {
      const result = await runner.run(controller.signal)
      if (this.turn !== turn) return
      if (result.error && !assistant.text) {
        assistant.text = `I couldn't get a reply: ${result.error}`
        speaker.say(assistant.text)
      }
      assistant.streaming = false
      this.upsert(assistant)
      for (const m of toolMessages.values()) {
        if (m.tool?.status === 'running') {
          m.tool.status = 'cancelled'
          this.upsert(m)
        }
      }
      this.deps.emit({ type: 'cue', on: false })
      this.deps.ears.agentThinking(false)
      await speaker.finish()
      if (this.turn !== turn) return
      turn.llmDone = true
      if (turn.drained) this.finishTurn(turn)
      else this.armDrainTimeout(turn)
    } catch (e) {
      if (this.turn !== turn) return
      this.deps.log(`turn failed: ${(e as Error).message}`)
      this.tr('turn.error', { message: (e as Error).message })
      assistant.text ||= `Something went wrong: ${(e as Error).message}`
      assistant.streaming = false
      this.upsert(assistant)
      this.finishTurn(turn)
    }
  }

  /** If the renderer never reports the audio drained (device error, closed window), do not hang in "speaking". */
  private armDrainTimeout(t: ActiveTurn): void {
    const waitMs = Math.round(t.speaker.busyForMs() + 10_000)
    const timer = setTimeout(() => {
      if (this.turn !== t || t.drained) return
      this.tr('turn.drain_timeout', { waitMs, chunksStarted: t.startedSeqs.size, chunksFinished: t.finishedSeqs.size })
      this.deps.log(`turn ${t.id}: playback never drained after ${waitMs} ms; finishing anyway`)
      this.finishTurn(t)
    }, waitMs)
    timer.unref?.()
  }

  private finishTurn(t: ActiveTurn): void {
    if (this.turn !== t) return
    if (this.mergeable?.turnId === t.id) this.mergeable = null
    const a = t.assistant
    if (a) {
      a.metrics = { ...a.metrics, totalMs: Date.now() - t.startedAt, fillers: t.speaker.fillers, interrupted: false }
      if (t.resume) {
        // the whole reply has now been heard
        a.spokenText = undefined
        a.unspokenText = undefined
      }
      this.upsert(a)
      this.deps.emit({ type: 'metrics', turnId: t.id, metrics: a.metrics })
    }
    this.tr('turn.end', {
      resumed: t.resume?.kind,
      interrupted: false,
      totalMs: Date.now() - t.startedAt,
      chars: a?.text.length ?? 0,
      chunks: t.startedSeqs.size,
      fillers: t.speaker.fillers,
      ttsDroppedFrames: edgeTtsStats.droppedFrames - t.ttsDroppedBefore,
      metrics: a?.metrics ?? {}
    })
    this.turn = null
    this.deps.ears.agentSpeaking(false)
    this.deps.ears.agentThinking(false)
    this.deps.emit({ type: 'cue', on: false })
    this.sm.done()
    this.deps.emit({ type: 'context', snapshot: this.snapshot() })
  }

  private applySpokenSplit(t: ActiveTurn, a: ChatMessage, cut: CutPoint | null): void {
    const split = splitSpoken(a.text, [...t.chunks.values()], t.finishedSeqs, t.startedSeqs, cut)
    if (t.resume) {
      // a replay starts mid-text: what was heard is everything up to the new cut, not just this turn's chunks
      const full = a.text.replace(/\s+/g, ' ').trim()
      a.unspokenText = split.unspoken
      a.spokenText = split.unspoken ? full.slice(0, Math.max(0, full.length - split.unspoken.length)).trim() : full
    } else {
      a.spokenText = split.spoken
      a.unspokenText = split.unspoken
    }
    a.metrics = { ...a.metrics, spokenChars: split.spoken.length, unspokenChars: split.unspoken.length }
    this.upsert(a)
    this.deps.emit({ type: 'metrics', turnId: t.id, metrics: a.metrics })
  }

  cancelTurn(reason: string, keepInterrupted = false): void {
    const t = this.turn
    if (!t) return
    this.deps.log(`cancel turn ${t.id}: ${reason}`)
    this.turn = null
    if (this.mergeable?.turnId === t.id) this.mergeable = null
    t.controller.abort()
    this.deps.cancelAudio(t.id)
    this.deps.emit({ type: 'cue', on: false })
    this.deps.emit({ type: 'duck', gain: 1 })
    this.deps.ears.agentSpeaking(false)
    this.deps.ears.agentThinking(false)
    let a = t.assistant
    if (a && reason === 'continuation' && t.startedSeqs.size === 0) {
      // the user was still talking; nothing was heard, so the reply never happened
      this.messages = this.messages.filter((m) => m.id !== a!.id)
      this.deps.store.deleteMessage(a.id)
      this.deps.emit({ type: 'message-removed', id: a.id })
      t.assistant = null
      a = null
    }
    if (a) {
      a.streaming = false
      if (a.text) {
        a.interrupted = true
        a.interruptedAt = Date.now()
        a.metrics = { ...a.metrics, interrupted: true, totalMs: Date.now() - t.startedAt, fillers: t.speaker.fillers }
        // provisional split now; refined when the renderer reports where the cut landed
        this.applySpokenSplit(t, a, null)
        this.cancelled = { turn: t, assistant: a }
        if (reason === 'barge-in') this.lastSpokenText = a.spokenText ?? ''
      } else {
        this.messages = this.messages.filter((m) => m.id !== a.id)
        this.cancelled = null
      }
      this.upsert(a)
    }
    for (const m of this.messages) {
      if (m.turnId === t.id && m.tool?.status === 'running') {
        m.tool.status = 'cancelled'
        m.tool.endedAt = Date.now()
        this.upsert(m)
      }
    }
    this.deps.trace({
      ev: 'turn.cancel',
      sid: this.sessionId,
      turn: t.id,
      reason,
      totalMs: Date.now() - t.startedAt,
      chars: a?.text.length ?? 0,
      chunksStarted: t.startedSeqs.size,
      chunksFinished: t.finishedSeqs.size,
      spokenText: a?.spokenText,
      unspokenText: a?.unspokenText,
      llmDone: t.llmDone,
      metrics: a?.metrics ?? {}
    })
    if (!keepInterrupted) this.sm.done()
  }

  cancel(): void {
    this.cancelTurn('user-cancel')
    this.stopReading()
  }

  // ---- read aloud / preview -------------------------------------------------------------
  async speakMessage(messageId: string): Promise<void> {
    const m = this.messages.find((x) => x.id === messageId)
    if (!m?.text) return
    await this.readText(m.text, this.style(this.deps.settings()).format, this.deps.settings().voice)
  }

  async preview(voice: string): Promise<void> {
    const s = this.deps.settings()
    await this.readText(`Hi, I'm ${s.agentName}. This is how I sound with this voice.`, 'plain', { ...s.voice, voice })
  }

  async voices() {
    return this.edge.listVoices()
  }

  private async readText(text: string, format: PromptStyle['format'], voice: Settings['voice']): Promise<void> {
    this.stopReading()
    if (this.turn) this.cancelTurn('read-aloud')
    const id = `read-${crypto.randomUUID()}`
    const controller = new AbortController()
    this.readTurn = { id, controller }
    this.sm.think()
    this.deps.ears.agentSpeaking(true)
    const s = this.deps.settings()
    const speaker = new Speaker(
      id,
      {
        engine: this.engineFor(s),
        fallback: this.fallbackEngine(),
        voice,
        attempts: s.speech.ttsAttempts,
        degradeAfter: s.speech.ttsDegradeAfter,
        emit: (c) => {
          if (this.readTurn?.id === id) this.deps.emitAudio(c)
        },
        onDegraded: () => this.edgeDegraded(),
        log: this.deps.log
      },
      controller.signal
    )
    const filter = new SpeakableFilter(format)
    const chunker = new SentenceChunker(s.speech.maxChars, s.speech.firstMinWords)
    for (const sentence of chunker.feed(filter.feed(text))) speaker.say(sentence)
    for (const sentence of chunker.flush()) speaker.say(sentence)
    await speaker.finish()
  }

  stopReading(): void {
    const r = this.readTurn
    if (!r) return
    this.readTurn = null
    r.controller.abort()
    this.deps.cancelAudio(r.id)
    this.deps.ears.agentSpeaking(false)
    if (!this.turn) this.sm.done()
  }

  // ---- memory confirmation ----------------------------------------------------------------
  confirmPending(id: string, accept: boolean): void {
    const p = this.pending
    if (!p || p.id !== id) return
    this.pending = null
    if (accept) {
      if (p.action === 'delete' && p.entryId !== undefined) this.deps.store.delete(p.entryId, 'user')
      else this.deps.store.upsert({ scopeId: GLOBAL_SCOPE, kind: p.kind, key: p.key, value: p.value, tags: p.tags, source: 'user' })
      this.deps.emit({ type: 'memory-changed' })
    }
    this.tr('memory.confirm', { action: p.action ?? 'save', key: p.key, accepted: accept })
    this.deps.emit({ type: 'memory-confirm', pending: null })
  }

  // ---- context ----------------------------------------------------------------------------
  snapshot(): ContextSnapshot {
    const s = this.deps.settings()
    const t = timeContext()
    return {
      now: t.now,
      timezone: t.timezone,
      location: s.location.mode === 'manual' ? s.location.manual || 'not set' : s.location.mode === 'ip' ? 'from IP (resolved each turn)' : 'off',
      project: this.projectName(s),
      style: this.style(s).label,
      memoryEntries: this.deps.store.profile(this.scopeIds(s), s.memory.profileLimit).length,
      skills: this.deps.skills().filter((k) => k.enabled).map((k) => k.name),
      tools: Object.keys(this.tools(s))
    }
  }

  // ---- helpers ----------------------------------------------------------------------------
  private engineFor(s: Settings): TtsEngine {
    if (s.voice.engine === 'system') return this.system
    if (s.voice.engine === 'kokoro') return this.kokoro ?? this.system
    return Date.now() < this.edgeDownUntil ? this.fallbackEngine() : this.edge
  }

  private fallbackEngine(): TtsEngine {
    return this.kokoro ?? this.system
  }

  private edgeDegraded(): void {
    const wasDown = Date.now() < this.edgeDownUntil
    this.edgeDownUntil = Date.now() + EDGE_RETRY_AFTER_MS
    this.tr('tts.edge_down', { retryInMs: EDGE_RETRY_AFTER_MS, fallback: this.fallbackEngine().name })
    if (this.kokoro) void this.deps.kokoro?.start()
    if (!wasDown) this.toast('warn', this.kokoro ? "Edge TTS is unreachable; switching to the local Kokoro voice (the Windows voice covers while it loads)." : 'Edge TTS is failing; using the system voice for now.')
  }

  private style(s: Settings): PromptStyle {
    const all = [...BUILTIN_STYLES, ...this.deps.customStyles()]
    return all.find((x) => x.id === s.styleId) ?? all.find((x) => x.id === DEFAULT_STYLE_ID)!
  }

  private scopeIds(s: Settings): string[] {
    return s.projectId && s.projectId !== GLOBAL_SCOPE ? [GLOBAL_SCOPE, s.projectId] : [GLOBAL_SCOPE]
  }

  private projectName(s: Settings): string {
    if (!s.projectId || s.projectId === GLOBAL_SCOPE) return 'none'
    return this.deps.store.projects().find((p) => p.id === s.projectId)?.name ?? 'none'
  }

  /** Profile entries, BM25-relevant entries and matching lines from past sessions, as prompt lines. */
  private memoryBlock(userText: string, s: Settings): { block: string; profile: number; relevant: number; history: number } {
    const scopes = this.scopeIds(s)
    const max = s.memory.hintMaxChars
    const profile = this.deps.store.profile(scopes, s.memory.profileLimit)
    const relevant = this.deps.store.relevant(userText, scopes, s.memory.relevantLimit, s.memory.relevantMinScore)
    const seen = new Set<number>()
    const lines: string[] = []
    let relevantCount = 0
    for (const e of profile) {
      seen.add(e.id)
      lines.push(`- ${e.key}: ${clip(e.value, max)}${e.scopeId !== GLOBAL_SCOPE ? ' (project)' : ''}`)
    }
    for (const e of relevant) {
      if (seen.has(e.id)) continue
      seen.add(e.id)
      relevantCount++
      lines.push(`- ${e.key}: ${clip(e.value, max)} (${e.kind}, ${relativeTime(e.updatedAt)}${e.scopeId !== GLOBAL_SCOPE ? ', project' : ''})`)
    }
    const history = this.deps.store.searchHistory(userText, this.sessionId, s.memory.historyHits, s.memory.relevantMinScore)
    for (const h of history) {
      const who = h.role === 'user' ? s.userName : 'you'
      lines.push(`- ${relativeTime(h.createdAt)}, in "${clip(h.sessionTitle, 40)}", ${who} said: "${clip(h.text, max)}"`)
    }
    return { block: lines.join('\n'), profile: profile.length, relevant: relevantCount, history: history.length }
  }

  private tools(s: Settings): ToolSet {
    const tools: ToolSet = {
      current_time: currentTimeTool,
      ...memoryTools({
        store: this.deps.store,
        scopeIds: () => this.scopeIds(s),
        activeScope: () => (s.projectId && s.projectId !== GLOBAL_SCOPE ? s.projectId : GLOBAL_SCOPE),
        sessionId: () => this.sessionId,
        confirmBeforeSave: () => s.behaviour.confirmBeforeSave,
        requestConfirm: (p) => {
          this.pending = p
          this.deps.emit({ type: 'memory-confirm', pending: p })
        },
        changed: () => this.deps.emit({ type: 'memory-changed' })
      })
    }
    if (this.deps.search.configured()) Object.assign(tools, searchTools(this.deps.search))
    if (this.deps.mcp.enabled()) Object.assign(tools, mcpTools(this.deps.mcp))
    return tools
  }

  private upsert(m: ChatMessage): void {
    const idx = this.messages.findIndex((x) => x.id === m.id)
    if (idx >= 0) this.messages[idx] = m
    else if (m.role === 'tool') {
      // a tool ran before the reply it belongs to, so it reads above that reply
      const reply = this.messages.findIndex((x) => x.turnId === m.turnId && x.role === 'assistant')
      if (reply >= 0) {
        m.createdAt = Math.min(m.createdAt, this.messages[reply]!.createdAt - 1)
        this.messages.splice(reply, 0, m)
      } else this.messages.push(m)
    } else this.messages.push(m)
    if (m.streaming) this.flusher.push(m.id, m)
    else this.flusher.now(m.id, m)
  }

  private toast(kind: 'info' | 'warn' | 'error', text: string): void {
    this.tr('ui.toast', { kind, text })
    this.deps.emit({ type: 'toast', toast: { id: crypto.randomUUID(), kind, text } })
  }
}
