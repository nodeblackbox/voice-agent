import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false } }))

import { DEFAULT_SETTINGS } from '../main/services/settings'
import { Agent, FINAL_OVERDUE_MS } from './agent'
import type { AgentEvent } from '@shared/types'
import { MemoryStore } from './memory/store'

let dir: string
let store: MemoryStore

beforeEach(() => {
  vi.useFakeTimers()
  dir = mkdtempSync(join(tmpdir(), 'va-agent-'))
  store = new MemoryStore(join(dir, 'm.sqlite'))
})

afterEach(() => {
  vi.useRealTimers()
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

const make = () => {
  const events: AgentEvent[] = []
  const traces: Array<Record<string, unknown>> = []
  const restartStuck = vi.fn()
  const agent = new Agent({
    store,
    settings: () => DEFAULT_SETTINGS,
    keys: { keysFor: () => [] },
    customStyles: () => [],
    skills: () => [],
    mcp: { enabled: () => false, tools: () => ({}) } as never,
    search: { configured: () => false } as never,
    ears: { agentSpeaking: () => undefined, agentThinking: () => undefined, restartStuck },
    emit: (e) => events.push(e),
    emitAudio: () => undefined,
    cancelAudio: () => undefined,
    log: () => undefined,
    trace: (e) => traces.push(e)
  })
  agent.setMic(true)
  const speak = (): void => {
    agent.onSpeechStart()
    agent.onSpeechEnd({ reason: 'done', silenceMs: 300, turnP: 0.9 })
  }
  return { agent, events, traces, restartStuck, speak }
}

describe('Agent: waiting for a transcript', () => {
  it('gives up on a transcript that never arrives: back to listening, ears restarted, user told', () => {
    const { agent, events, traces, restartStuck, speak } = make()
    speak()
    expect(agent.sm.state).toBe('thinking')
    vi.advanceTimersByTime(FINAL_OVERDUE_MS - 1)
    expect(restartStuck).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(agent.sm.state).toBe('listening')
    expect(restartStuck).toHaveBeenCalledTimes(1)
    expect(traces.some((t) => t.ev === 'turn.final_overdue')).toBe(true)
    expect(events.some((e) => e.type === 'toast' && e.toast.kind === 'warn')).toBe(true)
  })

  it('does not fire when the transcript arrives, even for several queued utterances', () => {
    const { agent, restartStuck, speak } = make()
    speak()
    speak()
    vi.advanceTimersByTime(FINAL_OVERDUE_MS / 2)
    agent.onFinal('', 120)
    vi.advanceTimersByTime(FINAL_OVERDUE_MS / 2)
    agent.onFinal('', 130)
    vi.advanceTimersByTime(FINAL_OVERDUE_MS * 2)
    expect(restartStuck).not.toHaveBeenCalled()
  })

  it('still fires when only the first of two utterances got its transcript', () => {
    const { agent, restartStuck, speak } = make()
    speak()
    speak()
    agent.onFinal('', 120)
    vi.advanceTimersByTime(FINAL_OVERDUE_MS)
    expect(restartStuck).toHaveBeenCalledTimes(1)
  })
})
