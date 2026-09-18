import { app, BrowserWindow, session, shell } from 'electron'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { IPC } from '@shared/ipc'
import type { AgentEvent, AudioChunk, ServiceStatus, Settings } from '@shared/types'
import { earConfig } from '@shared/tuning'
import { Agent } from '@core/agent'
import { MemoryStore } from '@core/memory/store'
import { findModel } from '@core/providers/models'
import { initLog, log, logAt, trace, type LogLevel } from './services/log'
import { SettingsService } from './services/settings'
import { SidecarService } from './services/sidecar'
import { SearxngService } from './services/searxng'
import { McpService } from './services/mcp'
import { registerIpc } from './ipc/register'

const here = fileURLToPath(new URL('.', import.meta.url))
const projectRoot = resolve(here, '..', '..')
const isDev = !app.isPackaged

app.setName('Voice Agent')
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

let win: BrowserWindow | null = null

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 620,
    show: false,
    backgroundColor: '#0B0D10',
    title: 'Voice Agent',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  })
  w.once('ready-to-show', () => {
    w.show()
    const shot = process.env.VA_SCREENSHOT
    if (isDev && shot) {
      setTimeout(async () => {
        const img = await w.webContents.capturePage()
        const { writeFileSync } = await import('node:fs')
        writeFileSync(shot, img.toPNG())
        log('app', `screenshot -> ${shot}`)
      }, Number(process.env.VA_SCREENSHOT_DELAY ?? 4000))
    }
  })
  w.webContents.on('console-message', (event) => {
    if (event.level === 'error' || event.level === 'warning') logAt(event.level === 'error' ? 'error' : 'warn', 'renderer', `${event.message} (${event.sourceId}:${event.lineNumber})`)
  })
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (isDev && process.env.ELECTRON_RENDERER_URL) void w.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void w.loadFile(join(here, '../renderer/index.html'))
  return w
}

// Leaf paths whose value changed between two settings objects, e.g. { 'endpoint.prerollMs': 1000 }.
function changedPaths(a: unknown, b: unknown, prefix = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  if (isObj(a) && isObj(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) changedPaths(a[k], b[k], prefix ? `${prefix}.${k}` : k, out)
  } else if (JSON.stringify(a) !== JSON.stringify(b)) out[prefix] = b
  return out
}

app.whenReady().then(async () => {
  const userData = app.getPath('userData')
  const settings = new SettingsService(userData, join(projectRoot, '.env'))
  initLog(userData, {
    level: () => settings.get().runtime.logLevel as LogLevel,
    transcripts: () => settings.get().runtime.logTranscripts
  })
  log('app', `starting (dev=${isDev}) root=${projectRoot} userData=${userData}`)

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(['media', 'speaker-selection', 'clipboard-read', 'clipboard-sanitized-write'].includes(permission))
  })
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => ['media', 'speaker-selection'].includes(permission))

  const store = new MemoryStore(join(userData, 'memory.sqlite'))
  for (const p of store.projects()) store.ensureScope(p.id, p.name)

  const send = (channel: string, ...args: unknown[]): void => {
    if (win && !win.isDestroyed()) win.webContents.send(channel, ...args)
  }
  const emitRef = { current: (event: AgentEvent): void => send(IPC.event, event) }
  const emit = (event: AgentEvent): void => emitRef.current(event)
  const statuses = new Map<ServiceStatus['name'], ServiceStatus>()
  const onStatus = (status: ServiceStatus): void => {
    statuses.set(status.name, status)
    emit({ type: 'service', status })
  }

  const sidecar = new SidecarService({
    projectRoot,
    stt: () => settings.get().stt,
    earConfig: () => earConfig(settings.get()),
    idleShutdownMs: () => settings.get().runtime.idleShutdownMs,
    onStatus,
    trace,
    onEvent: (evt) => {
      if (evt.type !== 'level' && evt.type !== 'pong') {
        const { type, ...data } = evt as Record<string, unknown> & { type: string }
        // the sidecar's `t` is its own perf-counter clock; keep it, but never under the trace's timestamp key
        if ('t' in data) {
          data.earT = data.t
          delete data.t
        }
        trace({ ...data, ev: `ear.${type}`, sid: agent.currentSessionId })
      }
      switch (evt.type) {
        case 'speech_start':
          agent.onSpeechStart()
          break
        case 'partial':
          agent.onPartial(evt.text)
          break
        case 'speech_end':
          agent.onSpeechEnd()
          break
        case 'final':
          agent.onFinal(evt.text, evt.asrMs, { afterCut: evt.afterCut === true, durationMs: evt.durationMs })
          break
        case 'bargein':
          agent.onBargeIn(evt.stage)
          break
        case 'level':
          emit({ type: 'level', p: evt.p })
          break
        case 'error':
          if (!evt.fatal) logAt('warn', 'ear', `error: ${evt.message}`)
          break
        default:
          break
      }
    }
  })

  const searxng = new SearxngService({ projectRoot, url: () => settings.get().searxng.url, onStatus })
  const mcp = new McpService({
    projectRoot,
    userData,
    projectPath: () => store.projects().find((p) => p.id === settings.get().projectId)?.path ?? '',
    enabled: () => settings.get().mcp.enabled,
    onStatus
  })

  const agent = new Agent({
    store,
    settings: () => settings.get(),
    keys: settings,
    customStyles: () => settings.styles(),
    skills: () => settings.skills(),
    mcp,
    search: { baseUrl: () => searxng.baseUrl(), ensure: () => searxng.ensure(), configured: () => searxng.configured() },
    ears: { agentSpeaking: (on) => sidecar.agentSpeaking(on), agentThinking: (on) => sidecar.agentThinking(on) },
    emit,
    emitAudio: (chunk: AudioChunk) => send(IPC.audioChunk, chunk),
    cancelAudio: (turnId) => send(IPC.audioCancel, turnId),
    log: (m) => log('agent', m),
    trace
  })

  const services = (): ServiceStatus[] => {
    const model = findModel(settings.get().modelId)
    const hasKey = model ? settings.keysFor(model.provider).length > 0 : false
    return [
      sidecar.status,
      { name: 'tts', state: settings.get().voice.engine === 'edge' ? 'ready' : 'off', detail: settings.get().voice.voice },
      { name: 'llm', state: hasKey ? 'ready' : 'error', detail: hasKey ? model?.label : `no API key for ${model?.providerLabel ?? 'model'}` },
      searxng.status,
      mcp.status
    ]
  }

  let previousSettings: Settings = settings.get()
  settings.onChange((s: Settings) => {
    const changed = changedPaths(previousSettings, s)
    previousSettings = s
    if (Object.keys(changed).length) trace({ ev: 'settings.changed', sid: agent.currentSessionId, changed })
    sidecar.applyConfig()
    emit({ type: 'settings-changed', settings: s })
    emit({ type: 'context', snapshot: agent.snapshot() })
  })
  let lastStt = JSON.stringify(settings.get().stt)
  let lastProject = settings.get().projectId
  settings.onChange((s) => {
    const stt = JSON.stringify(s.stt)
    if (stt !== lastStt) {
      lastStt = stt
      sidecar.restart()
    }
    if (s.projectId !== lastProject) {
      lastProject = s.projectId
      void mcp.reload()
    }
  })

  registerIpc({
    win: () => win,
    agent,
    store,
    settings,
    sidecar,
    searxng,
    mcp,
    services,
    broadcastSettings: (s) => emit({ type: 'settings-changed', settings: s })
  })

  win = createWindow()
  win.on('closed', () => {
    win = null
  })

  // The ears hold Parakeet on the GPU and several GB of RAM, so they are only started when the
  // microphone is actually wanted. Typed chat never needs them.
  if (settings.get().behaviour.listenOnLaunch) sidecar.start()
  void mcp.reload()
  if (isDev && process.env.VA_SAY) setTimeout(() => void agent.send(process.env.VA_SAY!), 4000)
  if (isDev && process.env.VA_MIC) {
    // press the Voice button from outside to exercise the real getUserMedia -> worklet -> sidecar path
    const press = (): void => {
      void win?.webContents
        .executeJavaScript(`(() => { const b = document.querySelector('button[aria-label="Start voice"]'); if (!b) return 'no-button'; b.click(); return 'clicked' })()`)
        .then((r) => log('devtools', `voice button: ${String(r)}`))
    }
    const poll = setInterval(() => {
      if (sidecar.ready && win) {
        clearInterval(poll)
        setTimeout(press, 1500)
      }
    }, 500)
  }
  if (isDev && process.env.VA_WAV) {
    const stateListeners: Array<(s: string) => void> = []
    const origEmit = emitRef.current
    emitRef.current = (event) => {
      if (event.type === 'state') for (const fn of stateListeners) fn(event.state)
      origEmit(event)
    }
    const { replayWav } = await import('./services/devtools')
    const start = (): void =>
      replayWav({ wav: process.env.VA_WAV!, bargeInWav: process.env.VA_WAV2, sidecar, agent, onState: (fn) => stateListeners.push(fn) })
    const poll = setInterval(() => {
      if (sidecar.ready) {
        clearInterval(poll)
        setTimeout(start, 1000)
      }
    }, 500)
  }
  void searxng.health().then((ok) => {
    if (!ok && settings.get().searxng.autostart) void searxng.ensure()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) win = createWindow()
  })

  app.on('before-quit', () => {
    agent.cancel()
    sidecar.stop()
    searxng.stop()
    void mcp.stop()
    store.close()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})
