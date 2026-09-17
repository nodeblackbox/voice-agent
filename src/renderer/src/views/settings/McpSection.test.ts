import { describe, expect, it } from 'vitest'
import { fromForm, toForm } from './McpSection'

describe('MCP server form mapping', () => {
  it('round-trips a stdio config through the form', () => {
    const cfg = { name: 'fs', enabled: true, transport: 'stdio' as const, command: 'npx', args: ['-y', 'server', 'C:\\My Dir'], env: { A: '1' }, cwd: 'D:\\x' }
    const form = toForm(cfg)
    expect(form.args).toBe('-y server "C:\\My Dir"')
    expect(fromForm(form)).toEqual(cfg)
  })

  it('drops stdio fields for http servers and vice versa', () => {
    const http = fromForm({ ...toForm({ name: 'h', enabled: false, transport: 'http', url: 'http://x/mcp' }), command: 'ignored', args: 'a b' })
    expect(http).toEqual({ name: 'h', enabled: false, transport: 'http', command: undefined, args: [], url: 'http://x/mcp', env: undefined, cwd: undefined })
  })
})
