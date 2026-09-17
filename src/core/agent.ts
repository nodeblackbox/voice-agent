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
}

const MIN_UTTERANCE_CHARS = 2

export class Agent {
  readonly sm: StateMachine
  private factory: ModelFactory
  private edge = new EdgeTtsEngine()
  private system = new SystemTtsEngine()
  private location = new LocationProvider()
  private sessionId = ''
  private messages: ChatMessage[] = []
  private turn: ActiveTurn | null = null
  private readTurn: { id: string; controller: AbortController } | null = null
  private pending: PendingMemorySave | null = null
  private micOn = false

  constructor(private readonly deps: AgentDeps) {
    this.sm = new StateMachine((state, event) => {
      deps.log(`state -> ${state} (${event})`)
      deps.emit({ type: 'state', state })
    })
    this.factory = new ModelFactory(deps.keys)
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
    this.deps.emit({ type: 'sessions-changed' })
    return s
  }

  selectSession(id: string): ChatMessage[] {
    this.cancelTurn('session-switch')
    this.sessionId = id
    this.messages = this.deps.store.messages(id)
    return this.messages
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

  onFinal(text: string, asrMs: number): void {
    const clean = text.trim()
    this.deps.emit({ type: 'partial', text: '' })
    if (clean.length < MIN_UTTERANCE_CHARS || /^[\s.,!?]*$/.test(clean)) {
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
      if (t.assistant) {
        t.assistant.metrics = m
        this.upsert(t.assistant)
      }
    }
    t.startedSeqs.add(seq)
  }

  onPlaybackFinished(): void {}

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
    const turn: ActiveTurn = { id: turnId, controller, assistant: null, chunkText: new Map(), startedSeqs: new Set(), speaker, llmDone: false, drained: false }
    this.turn = turn
    this.sm.think()
    this.deps.ears.agentThinking(true)
    this.deps.ears.agentSpeaking(true)

    const style = this.style(settings)
    const model = findModel(settings.modelId) ?? findModel('anthropic:claude-haiku-4-5')!
    const fallback = findModel(settings.fallbackModelId) ?? null
    const tools = this.tools(settings)
    const system = composeSystemPrompt(style, {
      agentName: settings.agentName,
      userName: settings.userName,
      ...timeContext(),
      location: await this.location.resolve(settings.location),
      projectName: this.projectName(settings),
      memoryBlock: this.memoryBlock(text, settings),
      skillsBlock: skillsBlock(this.deps.skills()),
      toolNames: Object.keys(tools),
      fillerEnabled: settings.behaviour.fillerBeforeTools
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
      maxSteps: settings.mode === 'ask' ? 2 : 8,
      format: style.format,
      speaker,
      fillerEnabled: settings.behaviour.fillerBeforeTools && (via === 'voice' || settings.behaviour.speakTypedReplies),
      firstTokenTimeoutMs: 8000,
      stallTimeoutMs: 8000,
      toolStallTimeoutMs: 25000,
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
      onNotice: (t) => this.toast('warn', t),
      log: this.deps.log
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
      assistant.text ||= `Something went wrong: ${(e as Error).message}`
      assistant.streaming = false
      this.upsert(assistant)
      this.finishTurn(turn)
    }
  }

  private finishTurn(t: ActiveTurn): void {
    if (this.turn !== t) return
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
    const speaker = new Speaker(
      id,
      {
        engine: this.engineFor(this.deps.settings()),
        fallback: this.system,
        voice,
        emit: (c) => {
          if (this.readTurn?.id === id) this.deps.emitAudio(c)
        },
        onDegraded: () => undefined,
        log: this.deps.log
      },
      controller.signal
    )
    const filter = new SpeakableFilter(format)
    const chunker = new SentenceChunker()
    for (const s of chunker.feed(filter.feed(text))) speaker.say(s)
    for (const s of chunker.flush()) speaker.say(s)
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
      memoryEntries: this.deps.store.profile(this.scopeIds(s)).length,
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
    const profile = this.deps.store.profile(scopes)
    const relevant = this.deps.store.relevant(userText, scopes)
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
    const history = this.messages.filter((m) => m.role !== 'tool' && m.turnId !== currentTurnId).slice(-40)
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
    this.deps.emit({ type: 'toast', toast: { id: crypto.randomUUID(), kind, text } })
  }
}
