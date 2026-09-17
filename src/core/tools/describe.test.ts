import { describe, expect, it } from 'vitest'
import { describeInput, describeOutput, mcpServerOf, toolKind } from './describe'
import { mcpToolName, mcpTools } from './mcp-adapter'
import { fillerFor, toolLabel } from '../speech/fillers'

describe('toolKind / labels / fillers', () => {
  it('classifies tools by name', () => {
    expect(toolKind('web_search')).toBe('search')
    expect(toolKind('read_page')).toBe('read')
    expect(toolKind('remember')).toBe('memory')
    expect(toolKind('current_time')).toBe('time')
    expect(toolKind('mcp__demo__calculate')).toBe('mcp')
    expect(toolKind('whatever')).toBe('other')
  })

  it('extracts the MCP server name', () => {
    expect(mcpServerOf('mcp__demo__calculate')).toBe('demo')
    expect(mcpServerOf('web_search')).toBeUndefined()
  })

  it('labels MCP tools with their server', () => {
    expect(toolLabel('mcp__demo__roll_dice')).toBe('roll_dice via demo')
    expect(toolLabel('web_search')).toBe('Searching the web')
  })

  it('rotates fillers per tool and falls back for unknown tools', () => {
    const a = fillerFor('web_search')
    const b = fillerFor('web_search')
    expect(a).not.toBe(b)
    expect(fillerFor('mcp__x__y')).toBeTruthy()
  })
})

describe('describeInput', () => {
  it('quotes search queries and shows urls and memory keys', () => {
    expect(describeInput('web_search', { query: 'gym hours' })).toBe('“gym hours”')
    expect(describeInput('read_page', { url: 'https://a.b/c' })).toBe('https://a.b/c')
    expect(describeInput('remember', { key: 'Gym', value: 'Elephant & Castle' })).toBe('Gym: Elephant & Castle')
    expect(describeInput('current_time', {})).toBe('')
  })

  it('summarises unknown tool inputs as key=value and truncates long values', () => {
    const s = describeInput('mcp__demo__calculate', { expression: '1+1', note: 'x'.repeat(100) })
    expect(s.startsWith('expression=1+1 note=')).toBe(true)
    expect(s.length).toBeLessThan(80)
  })
})

describe('describeOutput', () => {
  it('turns search results into a count and source chips', () => {
    const out = describeOutput('web_search', {
      answers: ['42'],
      results: [
        { title: 'BBC', url: 'https://www.bbc.co.uk/x', snippet: 's' },
        { title: '', url: 'https://example.org/y' },
        { title: 'no url' }
      ]
    })
    expect(out.detail).toBe('2 results, 1 direct answer')
    expect(out.sources).toEqual([
      { title: 'BBC', url: 'https://www.bbc.co.uk/x', snippet: 's' },
      { title: 'example.org', url: 'https://example.org/y', snippet: undefined }
    ])
  })

  it('reports tool errors and memory statuses', () => {
    expect(describeOutput('web_search', { error: 'SearXNG down' }).detail).toBe('SearXNG down')
    expect(describeOutput('remember', { status: 'saved' }).detail).toBe('saved')
    expect(describeOutput('remember', { status: 'pending' }).detail).toBe('waiting for your OK')
    expect(describeOutput('recall', []).detail).toBe('nothing found')
    expect(describeOutput('recall', [{}, {}]).detail).toBe('2 matches')
  })

  it('describes a read page with its length and a single source', () => {
    const out = describeOutput('read_page', { title: 'Doc', url: 'https://d.io/p', text: 'x'.repeat(1234) })
    expect(out.detail).toBe('1,234 chars')
    expect(out.sources).toEqual([{ title: 'Doc', url: 'https://d.io/p' }])
  })
})

describe('mcpTools', () => {
  it('namespaces tool names and forwards calls with the abort signal', async () => {
    const calls: unknown[] = []
    const bridge = {
      tools: () => [{ server: 'demo srv', name: 'roll-dice', description: 'Roll', inputSchema: { type: 'object', properties: { sides: { type: 'number' } } } }],
      call: async (server: string, name: string, args: Record<string, unknown>, signal?: AbortSignal) => {
        calls.push([server, name, args, signal?.aborted])
        return 'ok'
      }
    }
    const tools = mcpTools(bridge)
    const name = mcpToolName('demo srv', 'roll-dice')
    expect(name).toBe('mcp__demo_srv__roll_dice')
    const tool = tools[name]!
    expect(tool.description).toContain('Roll')
    const ac = new AbortController()
    const result = await tool.execute?.({ sides: 6 }, { toolCallId: '1', messages: [], abortSignal: ac.signal, context: undefined as never })
    expect(result).toBe('ok')
    expect(calls).toEqual([['demo srv', 'roll-dice', { sides: 6 }, false]])
  })
})
