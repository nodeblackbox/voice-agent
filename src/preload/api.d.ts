import type {
  AgentEvent,
  AudioChunk,
  ChatMessage,
  ContextSnapshot,
  KeyStatus,
  LogFileInfo,
  LogLevel,
  McpServerConfig,
  McpServerStatus,
  Skill,
  StyleDraft,
  MemoryEntry,
  MemoryHistoryEntry,
  MemoryScope,
  ModelInfo,
  Project,
  PromptStyle,
  Provider,
  ServiceStatus,
  Session,
  SessionSummary,
  Settings,
  TraceEvent,
  VoiceInfo
} from '../shared/types'

export interface VoiceAgentApi {
  settings: {
    get(): Promise<Settings>
    set(patch: Partial<Settings>): Promise<Settings>
  }
  models: { list(): Promise<ModelInfo[]> }
  keys: {
    status(): Promise<KeyStatus[]>
    set(provider: Provider, key: string): Promise<KeyStatus[]>
  }
  chat: {
    send(text: string): Promise<void>
    cancel(): Promise<void>
    history(sessionId?: string): Promise<ChatMessage[]>
  }
  voice: {
    start(): Promise<void>
    stop(): Promise<void>
    sendFrame(pcm: ArrayBuffer): void
  }
  speak: {
    message(messageId: string): Promise<void>
    stop(): Promise<void>
    preview(voice: string): Promise<void>
    voices(): Promise<VoiceInfo[]>
  }
  playback: {
    started(turnId: string, seq: number): void
    finished(turnId: string, seq: number): void
    /** The chunk that was playing when the turn was cancelled, and how far into it the cut landed. */
    cancelled(turnId: string, seq: number, offsetS: number, durationS: number): void
    drained(turnId: string): void
  }
  styles: {
    list(): Promise<PromptStyle[]>
    save(style: PromptStyle): Promise<PromptStyle[]>
    delete(id: string): Promise<PromptStyle[]>
    /** Draft a new style from a brief, or — when `base` is given — rewrite that existing prompt body per the brief. */
    generate(brief: string, base?: { label: string; body: string }): Promise<StyleDraft>
  }
  skills: {
    list(): Promise<Skill[]>
    save(skill: Skill): Promise<Skill[]>
    delete(id: string): Promise<Skill[]>
    generate(brief: string): Promise<{ name: string; trigger: string; procedure: string }>
  }
  memory: {
    scopes(): Promise<MemoryScope[]>
    list(scopeId: string, query?: string): Promise<MemoryEntry[]>
    upsert(entry: Partial<MemoryEntry> & { scopeId: string; key: string; value: string }): Promise<MemoryEntry>
    delete(id: number): Promise<void>
    confirm(pendingId: string, accept: boolean): Promise<void>
    history(entryId: number): Promise<MemoryHistoryEntry[]>
    /** Restore the entry to its state before that history row (re-creating it in `scopeId` if it was deleted). */
    undo(historyId: number, scopeId?: string): Promise<MemoryEntry | undefined>
  }
  projects: {
    list(): Promise<Project[]>
    save(project: Project): Promise<Project[]>
    delete(id: string): Promise<Project[]>
  }
  sessions: {
    list(): Promise<Session[]>
    new: () => Promise<Session>
    select(id: string): Promise<ChatMessage[]>
    delete(id: string): Promise<Session[]>
  }
  services: {
    status(): Promise<ServiceStatus[]>
    mcpStatus(): Promise<McpServerStatus[]>
    mcpReload(): Promise<McpServerStatus[]>
    mcpTestTool(server: string, tool: string, input: unknown): Promise<unknown>
    mcpConfig(): Promise<McpServerConfig[]>
    /** Persists the full server list to the user-data mcp.json and reconnects. */
    mcpSetConfig(servers: McpServerConfig[]): Promise<McpServerStatus[]>
    searxngEnsure(): Promise<ServiceStatus>
    sidecarRestart(): Promise<void>
  }
  context: { snapshot(): Promise<ContextSnapshot> }
  shell: { open(url: string): Promise<void> }
  /** Renderer log lines land in the main process log files (through the same flood guard). */
  log: { write(level: LogLevel, scope: string, msg: string): void }
  diag: {
    logs(): Promise<LogFileInfo[]>
    tail(name: string, lines?: number): Promise<string[]>
    openLogsFolder(): Promise<void>
    /** Markdown report: setup, services, tuning diff, session summary, last turn timeline, recent errors. */
    report(): Promise<string>
    trace(sessionId?: string | null, limit?: number): Promise<TraceEvent[]>
    lastTurn(): Promise<TraceEvent[]>
    summary(): Promise<SessionSummary>
  }
  onEvent(handler: (event: AgentEvent) => void): () => void
  onAudioChunk(handler: (chunk: AudioChunk) => void): () => void
  onAudioCancel(handler: (turnId: string | null) => void): () => void
}

declare global {
  interface Window {
    api: VoiceAgentApi
  }
}
