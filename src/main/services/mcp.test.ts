import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { McpService } from './mcp'

// Real end-to-end MCP: spawns the bundled demo server over stdio through the official SDK.
const projectRoot = resolve(__dirname, '../../..')
let userData: string
let mcp: McpService

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'va-mcp-'))
  mcp = new McpService({ projectRoot, userData, projectPath: () => '', enabled: () => true, onStatus: () => undefined })
})

afterEach(async () => {
  await mcp.stop()
  rmSync(userData, { recursive: true, force: true })
})

describe('McpService with the demo server', () => {
  it('connects, lists tools with schemas, and calls them', async () => {
    const statuses = await mcp.reload()
    const demo = statuses.find((s) => s.name === 'demo')
    expect(demo?.state).toBe('ready')
    expect(demo?.tools.map((t) => t.name).sort()).toEqual(['calculate', 'get_time', 'roll_dice'])
    const calc = demo?.tools.find((t) => t.name === 'calculate')
    expect(calc?.inputSchema).toMatchObject({ type: 'object', properties: { expression: { type: 'string' } } })
    expect(mcp.enabled()).toBe(true)

    expect(await mcp.call('demo', 'calculate', { expression: '17 * 23' })).toBe('391')
    expect(await mcp.call('demo', 'calculate', { expression: 'sqrt(144) + 2^3' })).toBe('20')
    const dice = String(await mcp.call('demo', 'roll_dice', { sides: 6, count: 3 }))
    expect(dice).toMatch(/^\d, \d, \d \(total \d+\)$/)
    expect(demo && mcp.statuses().find((s) => s.name === 'demo')?.calls).toBe(3)
  }, 30_000)

  it('surfaces tool errors and invalid input as thrown errors', async () => {
    await mcp.reload()
    await expect(mcp.call('demo', 'calculate', { expression: 'rm -rf /' })).rejects.toThrow(/Only arithmetic/)
    await expect(mcp.call('demo', 'calculate', {})).rejects.toThrow(/expression|invalid|required/i)
    await expect(mcp.call('nope', 'calculate', {})).rejects.toThrow(/not connected/)
  }, 30_000)

  it('honours the abort signal', async () => {
    await mcp.reload()
    const ac = new AbortController()
    ac.abort()
    await expect(mcp.call('demo', 'get_time', {}, ac.signal)).rejects.toThrow()
  }, 30_000)

  it('reads the user-data override and reports failures for bad servers', async () => {
    writeFileSync(
      join(userData, 'mcp.json'),
      JSON.stringify({
        servers: [
          { name: 'demo', enabled: true, transport: 'stdio', command: '${NODE}', args: ['${ROOT}/mcp/servers/demo/server.mjs'] },
          { name: 'broken', enabled: true, transport: 'stdio', command: '${NODE}', args: ['${ROOT}/does-not-exist.mjs'] },
          { name: 'off', enabled: false, transport: 'stdio', command: 'whatever' }
        ]
      })
    )
    const statuses = await mcp.reload()
    expect(statuses.find((s) => s.name === 'demo')?.state).toBe('ready')
    expect(statuses.find((s) => s.name === 'broken')?.state).toBe('error')
    expect(statuses.find((s) => s.name === 'off')?.state).toBe('off')
    expect(mcp.tools().map((t) => t.server)).toEqual(['demo', 'demo', 'demo'])
  }, 30_000)

  it('persists config through setConfig and reconnects', async () => {
    const statuses = await mcp.setConfig([{ name: 'demo', enabled: true, transport: 'stdio', command: '${NODE}', args: ['${ROOT}/mcp/servers/demo/server.mjs'] }])
    expect(statuses).toHaveLength(1)
    expect(statuses[0]?.state).toBe('ready')
    expect(mcp.config()[0]).toMatchObject({ name: 'demo', enabled: true })
  }, 30_000)
})
