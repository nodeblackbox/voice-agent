import { describe, expect, it } from 'vitest'
import type { ChatMessage, ToolActivity } from '@shared/types'
import { buildModelMessages, compactToolResult } from './history'

const base = (over: Partial<ChatMessage>): ChatMessage => ({ id: over.id ?? crypto.randomUUID(), turnId: 't1', sessionId: 's', role: 'user', text: '', createdAt: 1, ...over })
const toolRow = (id: string, status: ToolActivity['status'], extra: Partial<ToolActivity> = {}): ChatMessage =>
  base({ id, role: 'tool', text: 'web_search', tool: { name: 'web_search', label: 'Searching', kind: 'search', status, startedAt: 1, input: { query: 'q' }, ...extra } })

const opts = { maxMessages: 40, toolResultKeepChars: 40 }

describe('buildModelMessages', () => {
  it('keeps finished tool calls as call/result pairs with compacted results, drops unfinished ones', () => {
    const msgs = [
      base({ role: 'user', text: 'search it' }),
      toolRow('c1', 'done', { resultText: 'x'.repeat(100) }),
      toolRow('c2', 'running'),
      toolRow('c3', 'error', { detail: 'SearXNG down' }),
      base({ role: 'assistant', text: 'Here is what I found.' })
    ]
    const out = buildModelMessages(msgs, 't2', 'thanks', opts)
    expect(out.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'user'])
    const calls = out[1]!.content as Array<{ type: string; toolCallId: string }>
    expect(calls.map((c) => c.toolCallId)).toEqual(['c1', 'c3'])
    const results = out[2]!.content as Array<{ toolCallId: string; output: { type: string; value: string } }>
    expect(results[0]!.output.type).toBe('text')
    expect(results[0]!.output.value).toMatch(/^x{39}… \[truncated 61 chars\]$/)
    expect(results[1]!.output).toEqual({ type: 'error-text', value: 'SearXNG down' })
    expect(out[3]).toEqual({ role: 'assistant', content: 'Here is what I found.' })
    expect(out.at(-1)).toEqual({ role: 'user', content: 'thanks' })
  })

  it('renders an interrupted reply as what was heard plus the remainder note', () => {
    const msgs = [
      base({ role: 'user', text: 'tell me' }),
      base({ role: 'assistant', text: 'One. Two. Three.', interrupted: true, spokenText: 'One.', unspokenText: 'Two. Three.' })
    ]
    const out = buildModelMessages(msgs, 't2', 'go on', opts)
    expect(out[1]!.content).toBe('One.\n[interrupted by the user here; the rest was never spoken: "Two. Three."]')
  })

  it('marks a reply interrupted before any audio as such', () => {
    const msgs = [base({ role: 'user', text: 'x' }), base({ role: 'assistant', text: 'Never heard.', interrupted: true, spokenText: '' })]
    expect(buildModelMessages(msgs, 't2', 'y', opts)[1]!.content).toBe('[interrupted by the user before saying anything]')
  })

  it('excludes the current turn and trims to maxMessages without starting on a dangling tool message', () => {
    const msgs: ChatMessage[] = []
    for (let i = 0; i < 6; i++) {
      msgs.push(base({ turnId: `t${i}`, role: 'user', text: `q${i}` }))
      msgs.push(toolRow(`c${i}`, 'done', { resultText: 'r' }))
      msgs.push(base({ turnId: `t${i}`, role: 'assistant', text: `a${i}` }))
    }
    msgs.forEach((m, i) => {
      m.turnId = `t${Math.floor(i / 3)}`
    })
    msgs.push(base({ turnId: 'cur', role: 'user', text: 'current' }))
    const out = buildModelMessages(msgs, 'cur', 'current', { maxMessages: 7, toolResultKeepChars: 10 })
    expect(out[0]!.role).toBe('user')
    expect(out.some((m) => (m as { content: string }).content === 'current' && m.role === 'user')).toBe(true)
    expect(out.filter((m) => (m as { content: string }).content === 'current')).toHaveLength(1)
    expect(out.length).toBeLessThanOrEqual(8)
  })

  it('compactToolResult stringifies objects and truncates with a marker', () => {
    expect(compactToolResult({ a: 1 }, 100)).toBe('{"a":1}')
    expect(compactToolResult('abcdef', 4)).toBe('abc… [truncated 3 chars]')
  })
})
