import { ipcMain, shell, type BrowserWindow } from 'electron'
import { generateText } from 'ai'
import { IPC } from '@shared/ipc'
import type { LogLevel, McpServerConfig, MemoryEntry, Project, PromptStyle, Provider, ServiceStatus, Settings, Skill, StyleDraft } from '@shared/types'
import type { Agent } from '@core/agent'
import { MODELS, findModel } from '@core/providers/models'
import { BUILTIN_STYLES } from '@core/prompts/styles'
import { ModelFactory } from '@core/providers/factory'
import type { MemoryStore } from '@core/memory/store'
import type { SettingsService } from '../services/settings'
import type { SidecarService } from '../services/sidecar'
import type { SearxngService } from '../services/searxng'
import type { McpService } from '../services/mcp'
import { log, logAt } from '../services/log'
import { diagnosticsReport, lastTurn, listLogs, openLogsFolder, readTrace, tailLog } from '../services/diagnostics'

const LEVELS = new Set<LogLevel>(['debug', 'info', 'warn', 'error'])

export interface IpcDeps {
  win: () => BrowserWindow | null
  agent: Agent
  store: MemoryStore
  settings: SettingsService
  sidecar: SidecarService
  searxng: SearxngService
  mcp: McpService
  services: () => ServiceStatus[]
  broadcastSettings(s: Settings): void
}

const STYLE_DRAFT_PROMPT = `You write system prompts for a spoken voice assistant. Given a short brief, produce a JSON object with keys "label" (2-3 words), "desc" (one sentence, under 90 characters) and "body" (the system prompt: 3-6 sentences, second person, about how the assistant should talk and behave; remember the text is spoken aloud, so mention sentence length and no reading of code or markdown when relevant). Output only the JSON.`

const STYLE_REFINE_PROMPT = `You edit system prompts for a spoken voice assistant. You are given the CURRENT prompt and an INSTRUCTION describing what to change. Rewrite the prompt applying the instruction while keeping everything else intact (same voice, same length, second person). Produce a JSON object with keys "label" (keep the current label unless the instruction changes the character), "desc" (one sentence, under 90 characters) and "body" (the rewritten prompt). Output only the JSON.`

const SKILL_DRAFT_PROMPT = `You write "skills" for a voice assistant: short reusable procedures for a kind of situation. Given a brief, produce a JSON object with keys "name" (2-4 words), "trigger" (one sentence starting with "When", describing when this applies) and "procedure" (2-4 sentences, imperative, concrete; the assistant reads this before acting). Output only the JSON.`

const parseJson = <T>(text: string): T | null => {
  const json = /\{[\s\S]*\}/.exec(text)?.[0]
  if (!json) return null
  try {
    return JSON.parse(json) as T
  } catch {
    return null
  }
}

export function registerIpc(d: IpcDeps): void {
  const h = ipcMain.handle.bind(ipcMain)

  h(IPC.settingsGet, () => d.settings.get())
  h(IPC.settingsSet, (_e, patch: Partial<Settings>) => {
    const s = d.settings.set(patch)
    d.broadcastSettings(s)
    return s
  })
  h(IPC.modelsList, () => MODELS)
  h(IPC.keysStatus, () => d.settings.keyStatus())
  h(IPC.keysSet, (_e, provider: Provider, key: string) => d.settings.setKey(provider, key))

  h(IPC.chatSend, (_e, text: string) => d.agent.send(text))
  h(IPC.chatCancel, () => d.agent.cancel())
  h(IPC.chatHistory, (_e, sessionId?: string) => d.agent.history(sessionId))

  h(IPC.voiceStart, () => {
    d.sidecar.setListening(true)
    d.agent.setMic(true)
  })
  h(IPC.voiceStop, () => {
    d.sidecar.setListening(false)
    d.agent.setMic(false)
  })
  ipcMain.on(IPC.audioFrame, (_e, pcm: ArrayBuffer) => d.sidecar.sendFrame(pcm))
  ipcMain.on(IPC.logWrite, (_e, level: LogLevel, scope: string, msg: string) => {
    if (LEVELS.has(level) && typeof msg === 'string') logAt(level, `renderer:${String(scope).slice(0, 32)}`, msg.slice(0, 2000))
  })

  h(IPC.speakMessage, (_e, id: string) => d.agent.speakMessage(id))
  h(IPC.speakStop, () => d.agent.stopReading())
  h(IPC.ttsPreview, (_e, voice: string) => d.agent.preview(voice))
  h(IPC.voicesList, () => d.agent.voices())

  ipcMain.on(IPC.playbackStarted, (_e, turnId: string, seq: number) => d.agent.onPlaybackStarted(turnId, seq))
  ipcMain.on(IPC.playbackFinished, (_e, turnId: string, seq: number) => d.agent.onPlaybackFinished(turnId, seq))
  ipcMain.on(IPC.playbackCancelled, (_e, turnId: string, seq: number, offsetS: number, durationS: number) => d.agent.onPlaybackCancelled(turnId, seq, offsetS, durationS))
  ipcMain.on(IPC.playbackDrained, (_e, turnId: string) => d.agent.onPlaybackDrained(turnId))

  const allStyles = (): PromptStyle[] => [...BUILTIN_STYLES, ...d.settings.styles()]
  h(IPC.stylesList, () => allStyles())
  h(IPC.stylesSave, (_e, style: PromptStyle) => {
    d.settings.saveStyle(style)
    return allStyles()
  })
  h(IPC.stylesDelete, (_e, id: string) => {
    d.settings.deleteStyle(id)
    return allStyles()
  })
  const draftModel = () => new ModelFactory(d.settings).create(findModel(d.settings.get().modelId) ?? MODELS[0]!).model
  h(IPC.stylesGenerate, async (_e, brief: string, base?: { label: string; body: string }): Promise<StyleDraft> => {
    const prompt = base ? `CURRENT LABEL: ${base.label}\nCURRENT PROMPT:\n${base.body}\n\nINSTRUCTION: ${brief}` : brief
    const { text } = await generateText({ model: draftModel(), system: base ? STYLE_REFINE_PROMPT : STYLE_DRAFT_PROMPT, prompt, abortSignal: AbortSignal.timeout(30_000) })
    const parsed = parseJson<Partial<StyleDraft>>(text)
    return { label: parsed?.label ?? base?.label ?? 'New style', desc: parsed?.desc ?? brief, body: parsed?.body ?? text }
  })

  const skillsChanged = (skills: Skill[]): Skill[] => {
    d.win()?.webContents.send(IPC.event, { type: 'skills-changed' })
    return skills
  }
  h(IPC.skillsList, () => d.settings.skills())
  h(IPC.skillsSave, (_e, skill: Skill) => skillsChanged(d.settings.saveSkill(skill)))
  h(IPC.skillsDelete, (_e, id: string) => skillsChanged(d.settings.deleteSkill(id)))
  h(IPC.skillsGenerate, async (_e, brief: string) => {
    const { text } = await generateText({ model: draftModel(), system: SKILL_DRAFT_PROMPT, prompt: brief, abortSignal: AbortSignal.timeout(30_000) })
    const parsed = parseJson<{ name?: string; trigger?: string; procedure?: string }>(text)
    return { name: parsed?.name ?? 'New skill', trigger: parsed?.trigger ?? `When ${brief}`, procedure: parsed?.procedure ?? text }
  })

  h(IPC.memoryScopes, () => d.store.scopes())
  h(IPC.memoryList, (_e, scopeId: string, query?: string) => d.store.list(scopeId, query))
  h(IPC.memoryUpsert, (_e, entry: Partial<MemoryEntry> & { scopeId: string; key: string; value: string }) => {
    const saved = d.store.upsert({ ...entry, source: 'ui' })
    d.win()?.webContents.send(IPC.event, { type: 'memory-changed' })
    return saved
  })
  h(IPC.memoryDelete, (_e, id: number) => {
    d.store.delete(id)
    d.win()?.webContents.send(IPC.event, { type: 'memory-changed' })
  })
  h(IPC.memoryConfirm, (_e, pendingId: string, accept: boolean) => d.agent.confirmPending(pendingId, accept))

  h(IPC.projectsList, () => d.store.projects())
  h(IPC.projectsSave, (_e, project: Project) => {
    d.store.saveProject(project)
    return d.store.projects()
  })
  h(IPC.projectsDelete, (_e, id: string) => {
    d.store.deleteProject(id)
    if (d.settings.get().projectId === id) d.broadcastSettings(d.settings.set({ projectId: 'global' }))
    return d.store.projects()
  })

  h(IPC.sessionsList, () => d.store.sessions())
  h(IPC.sessionsNew, () => d.agent.newSession())
  h(IPC.sessionsSelect, (_e, id: string) => d.agent.selectSession(id))
  h(IPC.sessionsDelete, (_e, id: string) => {
    d.agent.deleteSession(id)
    return d.store.sessions()
  })

  h(IPC.servicesStatus, () => d.services())
  h(IPC.mcpStatus, () => d.mcp.statuses())
  h(IPC.mcpReload, () => d.mcp.reload())
  h(IPC.mcpConfig, () => d.mcp.config())
  h(IPC.mcpSetConfig, async (_e, servers: McpServerConfig[]) => {
    const statuses = await d.mcp.setConfig(servers)
    d.win()?.webContents.send(IPC.event, { type: 'mcp-changed' })
    return statuses
  })
  h(IPC.mcpTestTool, async (_e, server: string, tool: string, input: unknown) => {
    try {
      return await d.mcp.call(server, tool, (input ?? {}) as Record<string, unknown>, AbortSignal.timeout(30_000))
    } catch (e) {
      return { error: (e as Error).message }
    }
  })
  h(IPC.searxngEnsure, async () => {
    await d.searxng.ensure()
    return d.searxng.status
  })
  h(IPC.sidecarRestart, () => d.sidecar.restart())
  h(IPC.contextSnapshot, () => d.agent.snapshot())
  h(IPC.logsList, () => listLogs())
  h(IPC.logsTail, (_e, name: string, lines?: number) => tailLog(String(name), lines))
  h(IPC.logsOpenFolder, () => openLogsFolder())
  h(IPC.diagReport, () => diagnosticsReport({ agent: d.agent, settings: () => d.settings.get(), services: d.services }))
  h(IPC.traceSession, (_e, sessionId?: string | null, limit?: number) => readTrace(sessionId ?? d.agent.currentSessionId, limit))
  h(IPC.traceLastTurn, () => lastTurn(d.agent.currentSessionId))
  h(IPC.sessionSummary, () => d.agent.summary())
  h(IPC.openExternal, (_e, url: string) => {
    if (/^https?:\/\//.test(url)) return shell.openExternal(url)
    log('ipc', `refused to open ${url}`)
    return Promise.resolve()
  })
}
