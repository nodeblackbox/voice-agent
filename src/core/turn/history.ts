// Rebuilds the model's view of the conversation from stored messages. Tool calls stay in history
// with compacted results (the model already consumed the full result when the tool ran); tool
// calls that never finished are dropped so the model never believes a tool ran; interrupted
// replies carry only what the user heard plus a note with the unspoken remainder.

import type { ModelMessage, ToolCallPart, ToolResultPart } from 'ai'
import type { ChatMessage } from '@shared/types'
import { INTERRUPTED_BEFORE_SPEAKING, interruptionNote } from './spoken'

export interface HistoryOptions {
  maxMessages: number
  toolResultKeepChars: number
}

export function compactToolResult(output: unknown, keepChars: number): string {
  const text = typeof output === 'string' ? output : safeJson(output)
  return text.length > keepChars ? `${text.slice(0, keepChars - 1)}… [truncated ${text.length - keepChars + 1} chars]` : text
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v)
  } catch {
    return String(v)
  }
}

export function assistantHistoryText(m: ChatMessage): string {
  if (!m.interrupted) return m.text
  const spoken = m.spokenText ?? ''
  if (!spoken.trim()) return INTERRUPTED_BEFORE_SPEAKING
  return `${spoken}\n${interruptionNote(m.unspokenText ?? '')}`
}

/** Messages for the model: history (excluding the current turn) followed by the new user text. */
export function buildModelMessages(messages: ChatMessage[], currentTurnId: string, userText: string, opts: HistoryOptions): ModelMessage[] {
  const history = messages.filter((m) => m.turnId !== currentTurnId)
  const turnOrder: string[] = []
  const byTurn = new Map<string, ChatMessage[]>()
  for (const m of history) {
    if (!byTurn.has(m.turnId)) {
      byTurn.set(m.turnId, [])
      turnOrder.push(m.turnId)
    }
    byTurn.get(m.turnId)!.push(m)
  }

  const out: ModelMessage[] = []
  for (const turnId of turnOrder) {
    const rows = byTurn.get(turnId)!
    for (const u of rows.filter((m) => m.role === 'user')) out.push({ role: 'user', content: u.text })
    const tools = rows.filter((m) => m.role === 'tool' && m.tool && (m.tool.status === 'done' || m.tool.status === 'error'))
    if (tools.length) {
      const calls: ToolCallPart[] = tools.map((m) => ({ type: 'tool-call', toolCallId: m.id, toolName: m.tool!.name, input: m.tool!.input ?? {} }))
      const results: ToolResultPart[] = tools.map((m) => ({
        type: 'tool-result',
        toolCallId: m.id,
        toolName: m.tool!.name,
        output:
          m.tool!.status === 'error'
            ? { type: 'error-text', value: compactToolResult(m.tool!.detail ?? 'tool failed', opts.toolResultKeepChars) }
            : { type: 'text', value: compactToolResult(m.tool!.resultText ?? m.tool!.detail ?? '', opts.toolResultKeepChars) }
      }))
      out.push({ role: 'assistant', content: calls })
      out.push({ role: 'tool', content: results })
    }
    for (const a of rows.filter((m) => m.role === 'assistant')) {
      if (!a.text && !a.interrupted) continue
      const text = assistantHistoryText(a)
      if (text) out.push({ role: 'assistant', content: text })
    }
  }

  // keep the most recent messages, starting on a user message so no tool result dangles and the
  // conversation opens the way providers require
  let kept = out.slice(-opts.maxMessages)
  const firstUser = kept.findIndex((m) => m.role === 'user')
  kept = firstUser >= 0 ? kept.slice(firstUser) : []
  kept.push({ role: 'user', content: userText })
  return kept
}
