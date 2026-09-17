import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, openSync } from 'node:fs'
import { join } from 'node:path'
import type { ServiceStatus } from '@shared/types'
import { log, logDir } from './log'

export interface SearxngOptions {
  projectRoot: string
  url: () => string
  onStatus(status: ServiceStatus): void
}

export class SearxngService {
  private proc: ChildProcess | null = null
  private healthy = false
  private starting: Promise<boolean> | null = null
  status: ServiceStatus = { name: 'searxng', state: 'off' }

  constructor(private readonly opts: SearxngOptions) {}

  private setStatus(state: ServiceStatus['state'], detail?: string): void {
    this.status = { name: 'searxng', state, detail }
    this.opts.onStatus(this.status)
  }

  baseUrl(): string {
    return this.opts.url().replace(/\/$/, '')
  }

  private get srcDir(): string {
    return join(this.opts.projectRoot, 'search', 'searxng-src')
  }

  private get python(): string {
    return join(this.opts.projectRoot, 'search', '.venv-searxng', 'Scripts', 'python.exe')
  }

  installed(): boolean {
    return existsSync(join(this.srcDir, 'searx', 'webapp.py')) && existsSync(this.python)
  }

  configured(): boolean {
    return this.healthy || this.installed()
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl()}/healthz`, { signal: AbortSignal.timeout(1500) })
      this.healthy = res.ok
    } catch {
      this.healthy = false
    }
    if (this.healthy && this.status.state !== 'ready') this.setStatus('ready', this.baseUrl())
    if (!this.healthy && this.status.state === 'ready') this.setStatus('off')
    return this.healthy
  }

  async ensure(): Promise<boolean> {
    if (await this.health()) return true
    if (this.starting) return this.starting
    this.starting = this.launch().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private async launch(): Promise<boolean> {
    if (!this.installed()) {
      this.setStatus('error', 'SearXNG is not installed. Run `pnpm searxng:install`.')
      return false
    }
    const settings = ['settings.local.yml', 'settings.yml']
      .map((f) => join(this.opts.projectRoot, 'search', f))
      .find((p) => existsSync(p))
    if (!settings) {
      this.setStatus('error', 'search/settings.local.yml is missing. Run `pnpm searxng:install`.')
      return false
    }
    this.setStatus('starting', 'starting local SearXNG')
    mkdirSync(logDir(), { recursive: true })
    const out = openSync(join(logDir(), 'searxng.log'), 'a')
    log('searxng', `spawning ${this.python} -m searx.webapp`)
    this.proc = spawn(this.python, ['-m', 'searx.webapp'], {
      cwd: this.srcDir,
      env: { ...process.env, SEARXNG_SETTINGS_PATH: settings, PYTHONUNBUFFERED: '1' },
      stdio: ['ignore', out, out],
      windowsHide: true
    })
    this.proc.on('exit', (code) => {
      log('searxng', `exited code=${code}`)
      this.proc = null
      this.healthy = false
      if (this.status.state !== 'error') this.setStatus('off')
    })
    const deadline = Date.now() + 25_000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500))
      if (await this.health()) return true
      if (!this.proc) break
    }
    this.setStatus('error', 'SearXNG did not become healthy in 25s (see logs/searxng.log)')
    return false
  }

  stop(): void {
    this.proc?.kill()
    this.proc = null
  }
}
