import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type { VoiceAgentApi } from './api'

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(channel, ...args)

const api: VoiceAgentApi = {
  settings: {
    get: () => invoke(IPC.settingsGet),
    set: (patch) => invoke(IPC.settingsSet, patch)
  },
  models: { list: () => invoke(IPC.modelsList) },
  keys: {
    status: () => invoke(IPC.keysStatus),
    set: (provider, key) => invoke(IPC.keysSet, provider, key)
  },
  chat: {
    send: (text) => invoke(IPC.chatSend, text),
    cancel: () => invoke(IPC.chatCancel),
    history: (sessionId) => invoke(IPC.chatHistory, sessionId)
  },
  voice: {
    start: () => invoke(IPC.voiceStart),
    stop: () => invoke(IPC.voiceStop),
    sendFrame: (pcm) => ipcRenderer.send(IPC.audioFrame, pcm)
  },
  speak: {
    message: (id) => invoke(IPC.speakMessage, id),
    stop: () => invoke(IPC.speakStop),
    preview: (voice) => invoke(IPC.ttsPreview, voice),
    voices: () => invoke(IPC.voicesList)
  },
  playback: {
    started: (turnId, seq) => ipcRenderer.send(IPC.playbackStarted, turnId, seq),
    finished: (turnId, seq) => ipcRenderer.send(IPC.playbackFinished, turnId, seq),
    cancelled: (turnId, seq, offsetS, durationS) => ipcRenderer.send(IPC.playbackCancelled, turnId, seq, offsetS, durationS),
    drained: (turnId) => ipcRenderer.send(IPC.playbackDrained, turnId)
  },
  styles: {
    list: () => invoke(IPC.stylesList),
    save: (style) => invoke(IPC.stylesSave, style),
    delete: (id) => invoke(IPC.stylesDelete, id),
    generate: (brief, base) => invoke(IPC.stylesGenerate, brief, base)
  },
  skills: {
    list: () => invoke(IPC.skillsList),
    save: (skill) => invoke(IPC.skillsSave, skill),
    delete: (id) => invoke(IPC.skillsDelete, id),
    generate: (brief) => invoke(IPC.skillsGenerate, brief)
  },
  memory: {
    scopes: () => invoke(IPC.memoryScopes),
    list: (scopeId, query) => invoke(IPC.memoryList, scopeId, query),
    upsert: (entry) => invoke(IPC.memoryUpsert, entry),
    delete: (id) => invoke(IPC.memoryDelete, id),
    confirm: (pendingId, accept) => invoke(IPC.memoryConfirm, pendingId, accept)
  },
  projects: {
    list: () => invoke(IPC.projectsList),
    save: (project) => invoke(IPC.projectsSave, project),
    delete: (id) => invoke(IPC.projectsDelete, id)
  },
  sessions: {
    list: () => invoke(IPC.sessionsList),
    new: () => invoke(IPC.sessionsNew),
    select: (id) => invoke(IPC.sessionsSelect, id),
    delete: (id) => invoke(IPC.sessionsDelete, id)
  },
  services: {
    status: () => invoke(IPC.servicesStatus),
    mcpStatus: () => invoke(IPC.mcpStatus),
    mcpReload: () => invoke(IPC.mcpReload),
    mcpTestTool: (server, tool, input) => invoke(IPC.mcpTestTool, server, tool, input),
    mcpConfig: () => invoke(IPC.mcpConfig),
    mcpSetConfig: (servers) => invoke(IPC.mcpSetConfig, servers),
    searxngEnsure: () => invoke(IPC.searxngEnsure),
    sidecarRestart: () => invoke(IPC.sidecarRestart)
  },
  context: { snapshot: () => invoke(IPC.contextSnapshot) },
  shell: { open: (url) => invoke(IPC.openExternal, url) },
  log: { write: (level, scope, msg) => ipcRenderer.send(IPC.logWrite, level, scope, msg) },
  diag: {
    logs: () => invoke(IPC.logsList),
    tail: (name, lines) => invoke(IPC.logsTail, name, lines),
    openLogsFolder: () => invoke(IPC.logsOpenFolder),
    report: () => invoke(IPC.diagReport),
    trace: (sessionId, limit) => invoke(IPC.traceSession, sessionId, limit),
    lastTurn: () => invoke(IPC.traceLastTurn),
    summary: () => invoke(IPC.sessionSummary)
  },
  onEvent: (handler) => {
    const listener = (_e: Electron.IpcRendererEvent, event: Parameters<typeof handler>[0]) => handler(event)
    ipcRenderer.on(IPC.event, listener)
    return () => ipcRenderer.removeListener(IPC.event, listener)
  },
  onAudioChunk: (handler) => {
    const listener = (_e: Electron.IpcRendererEvent, chunk: Parameters<typeof handler>[0]) => handler(chunk)
    ipcRenderer.on(IPC.audioChunk, listener)
    return () => ipcRenderer.removeListener(IPC.audioChunk, listener)
  },
  onAudioCancel: (handler) => {
    const listener = (_e: Electron.IpcRendererEvent, turnId: string | null) => handler(turnId)
    ipcRenderer.on(IPC.audioCancel, listener)
    return () => ipcRenderer.removeListener(IPC.audioCancel, listener)
  }
}

contextBridge.exposeInMainWorld('api', api)
