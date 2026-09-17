import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { McpServerConfig, McpServerStatus, ServiceStatus } from '@shared/types'
import type { McpBridge, McpToolDef } from '@core/tools/mcp-adapter'
import { log } from './log'

type ServerConfig = McpServerConfig

interface Live {
  config: ServerConfig
  client: Client | null
  tools: McpToolDef[]
  state: ServiceStatus['state']
  error?: string
  stderr: string[]
  resolvedCommand: string
  connectedAt?: number
  calls: number
}

export interface McpOptions {
  projectRoot: string
  userData: string
  projectPath: () => string
  enabled: () => boolean
  onStatus(status: ServiceStatus): void
}

export class McpService implements McpBridge {
  private servers = new Map<string, Live>()
  status: ServiceStatus = { name: 'mcp', state: 'off' }

  constructor(private readonly opts: McpOptions) {}

  enabled(): boolean {
    return this.opts.enabled() && [...this.servers.values()].some((s) => s.state === 'ready')
  }

  private configPath(): string {
    const user = join(this.opts.userData, 'mcp.json')
    return existsSync(user) ? user : join(this.opts.projectRoot, 'mcp', 'mcp.json')
  }

  private substitute(s: string): string {
    return s
      .replaceAll('${ROOT}', this.opts.projectRoot)
      .replaceAll('${PROJECT_PATH}', this.opts.projectPath() || this.opts.projectRoot)
      .replaceAll('${USER_DATA}', this.opts.userData)
  }

  private setStatus(): void {
    const live = [...this.servers.values()].filter((s) => s.config.enabled)
    const ready = live.filter((s) => s.state === 'ready').length
    const failed = live.filter((s) => s.state === 'error').length
    const state: ServiceStatus['state'] = live.length === 0 ? 'off' : ready === live.length ? 'ready' : failed === live.length ? 'error' : ready > 0 ? 'ready' : 'starting'
    const tools = live.reduce((n, s) => n + s.tools.length, 0)
    this.status = { name: 'mcp', state, detail: live.length ? `${ready}/${live.length} servers, ${tools} tools` : 'no servers enabled' }
    this.opts.onStatus(this.status)
  }

  config(): ServerConfig[] {
    try {
      const raw = JSON.parse(readFileSync(this.configPath(), 'utf8')) as { servers?: ServerConfig[] }
      return raw.servers ?? []
    } catch (e) {
      log('mcp', `could not read ${this.configPath()}: ${(e as Error).message}`)
      return []
    }
  }

  async setConfig(servers: ServerConfig[]): Promise<McpServerStatus[]> {
    const clean = servers
      .filter((s) => s.name?.trim())
      .map((s) => ({
        name: s.name.trim(),
        enabled: Boolean(s.enabled),
        transport: s.transport === 'http' ? ('http' as const) : ('stdio' as const),
        command: s.command?.trim() || undefined,
        args: (s.args ?? []).map((a) => String(a)).filter(Boolean),
        env: s.env && Object.keys(s.env).length ? s.env : undefined,
        cwd: s.cwd?.trim() || undefined,
        url: s.url?.trim() || undefined
      }))
    const target = join(this.opts.userData, 'mcp.json')
    writeFileSync(target, JSON.stringify({ $comment: 'Managed by the app (Settings > MCP). ${ROOT}, ${PROJECT_PATH}, ${NODE} are substituted.', servers: clean }, null, 2))
    log('mcp', `saved ${clean.length} server(s) to ${target}`)
    return this.reload()
  }

  async reload(): Promise<McpServerStatus[]> {
    await this.disconnectAll()
    for (const config of this.config()) {
      const command = config.transport === 'http' ? (config.url ?? '') : [config.command ?? '', ...(config.args ?? [])].map((a) => this.substitute(a)).join(' ')
      this.servers.set(config.name, { config, client: null, tools: [], state: config.enabled ? 'starting' : 'off', stderr: [], resolvedCommand: command, calls: 0 })
    }
    this.setStatus()
    await Promise.all([...this.servers.values()].filter((s) => s.config.enabled).map((s) => this.connect(s)))
    this.setStatus()
    return this.statuses()
  }

  private async connect(live: Live): Promise<void> {
    const { config } = live
    live.state = 'starting'
    live.error = undefined
    live.stderr = []
    try {
      const client = new Client({ name: 'voice-agent', version: '0.1.0' })
      if (config.transport === 'http') {
        if (!config.url) throw new Error('http transport needs a url')
        await client.connect(new StreamableHTTPClientTransport(new URL(this.substitute(config.url))))
      } else {
        if (!config.command) throw new Error('stdio transport needs a command')
        let command = this.substitute(config.command)
        const env: Record<string, string> = { ...(process.env as Record<string, string>) }
        for (const [k, v] of Object.entries(config.env ?? {})) env[k] = this.substitute(v)
        if (command === '${NODE}' || config.command === '${NODE}') {
          command = process.execPath
          env.ELECTRON_RUN_AS_NODE = '1'
        }
        const transport = new StdioClientTransport({
          command,
          args: (config.args ?? []).map((a) => this.substitute(a)),
          env,
          cwd: config.cwd ? this.substitute(config.cwd) : undefined,
          stderr: 'pipe'
        })
        transport.stderr?.on('data', (d: Buffer) => {
          for (const line of d.toString().split(/\r?\n/)) {
            if (!line.trim()) continue
            live.stderr.push(line.trim())
            if (live.stderr.length > 30) live.stderr.shift()
            log(`mcp:${config.name}`, line.trim())
          }
        })
        transport.onclose = () => {
          if (live.client === client) {
            live.client = null
            live.state = live.state === 'error' ? 'error' : 'off'
            live.error ??= 'server exited'
            this.setStatus()
          }
        }
        await client.connect(transport)
      }
      const listed = await client.listTools()
      live.client = client
      live.tools = listed.tools.map((t) => ({ server: config.name, name: t.name, description: t.description, inputSchema: t.inputSchema as Record<string, unknown> }))
      live.state = 'ready'
      live.connectedAt = Date.now()
      log('mcp', `${config.name}: ${live.tools.length} tools (${live.tools.map((t) => t.name).join(', ')})`)
    } catch (e) {
      live.state = 'error'
      live.error = (e as Error).message
      live.client = null
      log('mcp', `${config.name} failed: ${live.error}`)
    }
  }

  private async disconnectAll(): Promise<void> {
    for (const s of this.servers.values()) {
      try {
        await s.client?.close()
      } catch {
        // already gone
      }
    }
    this.servers.clear()
  }

  statuses(): McpServerStatus[] {
    return [...this.servers.values()].map((s) => ({
      name: s.config.name,
      enabled: s.config.enabled,
      command: s.resolvedCommand,
      transport: s.config.transport,
      state: s.state,
      error: s.error,
      tools: s.tools.map((t) => ({ server: t.server, name: t.name, description: t.description })),
      stderrTail: s.stderr.slice(-8),
      connectedAt: s.connectedAt,
      calls: s.calls
    }))
  }

  tools(): McpToolDef[] {
    return [...this.servers.values()].filter((s) => s.state === 'ready').flatMap((s) => s.tools)
  }

  async call(server: string, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const live = this.servers.get(server)
    if (!live?.client) throw new Error(`MCP server "${server}" is not connected`)
    live.calls++
    const result = await live.client.callTool({ name, arguments: args }, undefined, { signal, timeout: 60_000, resetTimeoutOnProgress: true })
    const content = (result as { content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean }).content ?? []
    const text = content
      .map((c) => (c.type === 'text' ? c.text ?? '' : `[${c.type}${c.mimeType ? ` ${c.mimeType}` : ''}]`))
      .join('\n')
      .trim()
    if ((result as { isError?: boolean }).isError) throw new Error(text || 'tool reported an error')
    if (text) return text
    const structured = (result as { structuredContent?: unknown }).structuredContent
    return structured ?? result
  }

  async stop(): Promise<void> {
    await this.disconnectAll()
    this.setStatus()
  }
}
