import type { ModelMessage, ToolSet } from 'ai'
import type {
  AgentEvent,
  AudioChunk,
  ChatMessage,
  ContextSnapshot,
  PendingMemorySave,
  PromptStyle,
  Session,
  Settings,
  Skill,
  TurnMetrics
} from '@shared/types'
import { GLOBAL_SCOPE, type MemoryStore } from './memory/store'
import { LocationProvider, timeContext } from './context'
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
import { EdgeTtsEngine, SystemTtsEngine, type TtsEngine } from './speech/tts'
import { currentTimeTool } from './tools/time'
import { memoryTools } from './tools/memory'
import { searchTools, type SearchDeps } from './tools/search'
import { mcpTools, type McpBridge } from './tools/mcp-adapter'
import { StateMachine } from './turn/state-machine'
import { TurnRunner } from './turn/runner'
import type { Trace } from './trace'

export interface EarsControl {
  agentSpeaking(on: boolean): void
  agentThinking(on: boolean): void
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
  emit(event: AgentEvent): void
  emitAudio(chunk: AudioChunk): void
  cancelAudio(turnId: string | null): void
  log(msg: string): void
  trace: Trace
}

interface ActiveTurn {
  id: string
  controller: AbortController
  assistant: ChatMessage | null
  chunkText: Map<number, string>
  startedSeqs: Set<number>
  speaker: Speaker
  llmDone: boolean
  drained: boolean
  startedAt: number
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

export class Agent {
  readonly sm: StateMachine
  private factory: ModelFactory
  private edge: EdgeTtsEngine
  private system = new SystemTtsEngine()
  private location = new LocationProvider()
  private sessionId = ''
  private messages: ChatMessage[] = []
  private turn: ActiveTurn | null = null
  private readTurn: { id: string; controller: AbortController } | null = null
  private pending: PendingMemorySave | null = null
  private micOn = false
  private lastSpokenText = ''
  selfCutSuspects = 0

  constructor(private readonly deps: AgentDeps) {
    this.sm = new StateMachine((state, event) => {
      deps.log(`state -> ${state} (${event})`)
      this.tr('state', { from: this.sm?.log.at(-1)?.from, to: state, event })
      deps.emit({ type: 'state', state })
    })
    this.factory = new ModelFactory(deps.keys)
    this.edge = new EdgeTtsEngine(deps.settings().speech.ttsPoolSize, () => deps.settings().speech.ttsTimeoutMs)
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
    this.sessionId = id
    this.messages = this.deps.store.messages(id)
    this.tr('session.select', { messages: this.messages.length })
    return this.messages
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
    this.sm.speechStart()
  }

  onPartial(text: string): void {
    this.deps.emit({ type: 'partial', text })
  }

  onSpeechEnd(): void {
    this.sm.speechEnd()
    this.deps.emit({ type: 'partial', text: '' })
  }

  onFinal(text: string, asrMs: number, meta: { afterCut?: boolean; durationMs?: number } = {}): void {
    const clean = text.trim()
    this.deps.emit({ type: 'partial', text: '' })
    const tooShort = clean.length < this.deps.settings().brain.minUtteranceChars || /^[\s.,!?]*$/.test(clean)
    if (meta.afterCut) {
      // an interruption whose transcript is empty or echoes what the agent was saying is probably
      // the agent hearing itself through the speakers; count it so the echo gate decision has data
      const overlap = tooShort ? 1 : wordOverlap(clean, this.lastSpokenText)
      if (overlap >= 0.6) {
        this.selfCutSuspects++
        this.tr('turn.self_cut_suspect', { text: clean, overlap: Math.round(overlap * 100) / 100, durationMs: meta.durationMs, total: this.selfCutSuspects })
      }
    }
    if (tooShort) {
      this.tr('turn.dropped', { reason: 'empty-transcript', chars: clean.length, asrMs, afterCut: meta.afterCut === true })
      this.sm.blip()
      if (this.sm.state === 'thinking') this.sm.done()
      return
    }
    void this.handleInput(clean, 'voice', asrMs)
  }

  onBargeIn(stage: 'duck' | 'cut' | 'release'): void {
    if (stage === 'duck') this.deps.emit({ type: 'duck', gain: this.deps.settings().endpoint.duckGain })
    else if (stage === 'release') this.deps.emit({ type: 'duck', gain: 1 })
    else {
      this.deps.emit({ type: 'duck', gain: 1 })
      if (this.sm.bargeIn()) this.cancelTurn('barge-in', true)
      this.stopReading()
    }
  }

  // ---- playback feedback from the renderer -----------------------------------------------
  onPlaybackStarted(turnId: string, seq: number): void {
    const t = this.turn
    if (!t || t.id !== turnId) return
    if (t.startedSeqs.size === 0) {
      this.sm.firstAudio()
      const m = t.assistant?.metrics ?? {}
      const started = t.assistant?.createdAt ?? Date.now()
      m.ttfaMs = Date.now() - started
      this.tr('turn.first_audio', { seq, ttfaMs: m.ttfaMs })
      if (t.assistant) {
        t.assistant.metrics = m
        this.upsert(t.assistant)
      }
    }
    t.startedSeqs.add(seq)
    this.tr('playback.started', { seq })
  }

  onPlaybackFinished(turnId?: string, seq?: number): void {
    if (turnId && this.turn?.id === turnId) this.tr('playback.finished', { seq })
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
    await this.handleInput(text.trim(), 'text')
  }

  private async handleInput(text: string, via: 'voice' | 'text', asrMs?: number): Promise<void> {
    if (!text) return
    if (this.turn) this.cancelTurn('new-input')
    this.stopReading()
    const settings = this.deps.settings()
    const turnId = crypto.randomUUID()
    const user: ChatMessage = { id: crypto.randomUUID(), turnId, sessionId: this.sessionId, role: 'user', text, via, createdAt: Date.now() }
    this.upsert(user)
    if (this.messages.filter((m) => m.role === 'user').length === 1) {
      this.deps.store.renameSession(this.sessionId, text.split(/\s+/).slice(0, 7).join(' ').slice(0, 60))
      this.deps.emit({ type: 'sessions-changed' })
    }

    const controller = new AbortController()
    const speakThisTurn = via === 'voice' || settings.behaviour.speakTypedReplies
    const speaker = new Speaker(
      turnId,
      {
        silent: !speakThisTurn,
        engine: this.engineFor(settings),
        fallback: this.system,
        voice: settings.voice,
        attempts: settings.speech.ttsAttempts,
        degradeAfter: settings.speech.ttsDegradeAfter,
        emit: (chunk) => {
          if (this.turn?.id !== turnId) return
          this.turn.chunkText.set(chunk.seq, chunk.text)
          this.deps.emitAudio(chunk)
        },
        onDegraded: () => this.toast('warn', 'Edge TTS is failing; using the system voice for now.'),
        log: this.deps.log
      },
      controller.signal
    )
    const turn: ActiveTurn = { id: turnId, controller, assistant: null, chunkText: new Map(), startedSeqs: new Set(), speaker, llmDone: false, drained: false, startedAt: Date.now() }
    this.turn = turn
    this.sm.think()
    this.deps.ears.agentThinking(true)
    this.deps.ears.agentSpeaking(true)

    const style = this.style(settings)
    const model = findModel(settings.modelId) ?? findModel('anthropic:claude-haiku-4-5')!
    const fallback = findModel(settings.fallbackModelId) ?? null
    const tools = this.tools(settings)
    const memoryBlock = this.memoryBlock(text, settings)
    const system = composeSystemPrompt(style, {
      agentName: settings.agentName,
      userName: settings.userName,
      ...timeContext(),
      location: await this.location.resolve(settings.location),
      projectName: this.projectName(settings),
      memoryBlock,
      skillsBlock: skillsBlock(this.deps.skills()),
      toolNames: Object.keys(tools),
      fillerEnabled: settings.behaviour.fillerBeforeTools
    })
    this.tr('turn.start', {
      via,
      text,
      asrMs,
      model: model.id,
      fallback: fallback?.id ?? null,
      style: style.id,
      mode: settings.mode,
      speak: speakThisTurn,
      tools: Object.keys(tools).length,
      memoryHints: memoryBlock ? memoryBlock.split('\n').length : 0,
      systemChars: system.length
    })

    const assistant: ChatMessage = {
      id: crypto.randomUUID(),
      turnId,
      sessionId: this.sessionId,
      role: 'assistant',
      text: '',
      streaming: true,
      metrics: asrMs !== undefined ? { asrMs } : {},
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
      messages: this.modelMessages(turnId, text),
      tools,
      maxSteps: settings.mode === 'ask' ? settings.brain.maxStepsAsk : settings.brain.maxStepsAgent,
      format: style.format,
      speaker,
      speech: settings.speech,
      fillerEnabled: settings.behaviour.fillerBeforeTools && (via === 'voice' || settings.behaviour.speakTypedReplies),
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

  private finishTurn(t: ActiveTurn): void {
    if (this.turn !== t) return
    this.tr('turn.end', {
      interrupted: false,
      totalMs: Date.now() - t.startedAt,
      chars: t.assistant?.text.length ?? 0,
      chunks: t.startedSeqs.size,
      metrics: t.assistant?.metrics ?? {}
    })
    this.turn = null
    this.deps.ears.agentSpeaking(false)
    this.deps.ears.agentThinking(false)
    this.deps.emit({ type: 'cue', on: false })
    this.sm.done()
    this.deps.emit({ type: 'context', snapshot: this.snapshot() })
  }

  cancelTurn(reason: string, keepInterrupted = false): void {
    const t = this.turn
    if (!t) return
    this.deps.log(`cancel turn ${t.id}: ${reason}`)
    this.tr('turn.cancel', { reason, totalMs: Date.now() - t.startedAt, chars: t.assistant?.text.length ?? 0, chunksStarted: t.startedSeqs.size, llmDone: t.llmDone })
    this.turn = null
    t.controller.abort()
    this.deps.cancelAudio(t.id)
    this.deps.emit({ type: 'cue', on: false })
    this.deps.emit({ type: 'duck', gain: 1 })
    this.deps.ears.agentSpeaking(false)
    this.deps.ears.agentThinking(false)
    if (t.assistant) {
      const a = t.assistant
      a.streaming = false
      if (a.text) {
        a.interrupted = true
        a.spokenText = [...t.startedSeqs].sort((x, y) => x - y).map((s) => t.chunkText.get(s) ?? '').filter(Boolean).join(' ')
        if (reason === 'barge-in') this.lastSpokenText = a.spokenText
      }
      if (!a.text) this.messages = this.messages.filter((m) => m.id !== a.id)
      this.upsert(a)
    }
    for (const m of this.messages) {
      if (m.turnId === t.id && m.tool?.status === 'running') {
        m.tool.status = 'cancelled'
        m.tool.endedAt = Date.now()
        this.upsert(m)
      }
    }
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
        fallback: this.system,
        voice,
        attempts: s.speech.ttsAttempts,
        degradeAfter: s.speech.ttsDegradeAfter,
        emit: (c) => {
          if (this.readTurn?.id === id) this.deps.emitAudio(c)
        },
        onDegraded: () => undefined,
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
      this.deps.store.upsert({ scopeId: GLOBAL_SCOPE, kind: p.kind, key: p.key, value: p.value, tags: p.tags, source: 'user' })
      this.deps.emit({ type: 'memory-changed' })
    }
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
    return s.voice.engine === 'system' ? this.system : this.edge
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

  private memoryBlock(userText: string, s: Settings): string {
    const scopes = this.scopeIds(s)
    const profile = this.deps.store.profile(scopes, s.memory.profileLimit)
    const relevant = this.deps.store.relevant(userText, scopes, s.memory.relevantLimit, s.memory.relevantMinScore)
    const seen = new Set<number>()
    const lines: string[] = []
    for (const e of [...profile, ...relevant]) {
      if (seen.has(e.id)) continue
      seen.add(e.id)
      lines.push(`- ${e.key}: ${e.value}${e.scopeId !== GLOBAL_SCOPE ? ` (project)` : ''}`)
    }
    return lines.join('\n')
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

  private modelMessages(currentTurnId: string, userText: string): ModelMessage[] {
    const history = this.messages.filter((m) => m.role !== 'tool' && m.turnId !== currentTurnId).slice(-this.deps.settings().brain.historyMessages)
    const out: ModelMessage[] = []
    for (const m of history) {
      if (m.role === 'user') out.push({ role: 'user', content: m.text })
      else if (m.text) {
        const content = m.interrupted ? `${m.spokenText || m.text}\n[the user interrupted here; the rest was never said]` : m.text
        out.push({ role: 'assistant', content })
      }
    }
    out.push({ role: 'user', content: userText })
    return out
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
    this.deps.store.saveMessage(m)
    this.deps.emit({ type: 'message', message: m })
  }

  private toast(kind: 'info' | 'warn' | 'error', text: string): void {
    this.tr('ui.toast', { kind, text })
    this.deps.emit({ type: 'toast', toast: { id: crypto.randomUUID(), kind, text } })
  }
}
