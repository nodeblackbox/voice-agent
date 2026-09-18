import { describe, expect, it, vi } from 'vitest'
import { tool } from 'ai'
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test'
import type { LanguageModelV4StreamPart } from '@ai-sdk/provider'
import { z } from 'zod'
import type { AudioChunk, ModelInfo } from '@shared/types'
import { DEFAULT_TUNING } from '@shared/tuning'
import { TurnRunner, type RunnerDeps } from './runner'
import { Speaker } from '../speech/speaker'
import type { ModelFactory } from '../providers/factory'
import { findModel } from '../providers/models'

const usage = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: output, text: output, reasoning: undefined }
})

const textStream = (pieces: string[], tokens: [number, number] = [10, 5]): LanguageModelV4StreamPart[] => [
  { type: 'stream-start', warnings: [] },
  { type: 'text-start', id: 't' },
  ...pieces.map((delta) => ({ type: 'text-delta' as const, id: 't', delta })),
  { type: 'text-end', id: 't' },
  { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: usage(...tokens) }
]

const toolCallStream = (name: string, input: Record<string, unknown>): LanguageModelV4StreamPart[] => [
  { type: 'stream-start', warnings: [] },
  { type: 'tool-call', toolCallId: 'call-1', toolName: name, input: JSON.stringify(input) },
  { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage: usage(7, 3) }
]

type StreamSpec = LanguageModelV4StreamPart[] | Error
const mockModel = (streams: StreamSpec[]): MockLanguageModelV4 => {
  let i = 0
  return new MockLanguageModelV4({
    doStream: async () => {
      const spec = streams[Math.min(i++, streams.length - 1)]!
      if (spec instanceof Error) throw spec
      return { stream: simulateReadableStream({ chunks: spec }) }
    }
  })
}

const info = (id: string): ModelInfo => findModel(id)!

function harness(models: Record<string, MockLanguageModelV4>, over: Partial<RunnerDeps> = {}) {
  const chunks: AudioChunk[] = []
  const controller = new AbortController()
  const factory = {
    create: (m: ModelInfo) => {
      const model = models[m.id]
      if (!model) throw new Error(`no mock for ${m.id}`)
      return { model, key: 'k' }
    },
    groqPool: { report: vi.fn(), pick: () => 'k' }
  } as unknown as ModelFactory
  const speaker = new Speaker(
    'turn',
    {
      engine: { name: 'edge', synth: async (req) => Buffer.from(req.text) },
      fallback: { name: 'system', synth: async () => null },
      voice: { engine: 'edge', voice: 'v', rate: 1, pitch: 0 },
      emit: (c) => chunks.push(c),
      onDegraded: () => undefined,
      log: () => undefined
    },
    controller.signal
  )
  const deps: RunnerDeps = {
    factory,
    model: info('anthropic:claude-haiku-4-5'),
    fallback: info('groq:openai/gpt-oss-20b'),
    system: 'sys',
    messages: [{ role: 'user', content: 'hi' }],
    tools: {},
    maxSteps: 4,
    format: 'plain',
    speaker,
    speech: DEFAULT_TUNING.speech,
    fillerEnabled: true,
    firstTokenTimeoutMs: 2000,
    stallTimeoutMs: 2000,
    toolStallTimeoutMs: 2000,
    onDelta: vi.fn(),
    onToolStart: vi.fn(),
    onToolEnd: vi.fn(),
    onCue: vi.fn(),
    onMetrics: vi.fn(),
    onNotice: vi.fn(),
    log: vi.fn(),
    ...over
  }
  return { deps, chunks, controller, speaker, run: async () => {
    const r = await new TurnRunner(deps).run(controller.signal)
    await speaker.finish()
    return r
  } }
}

describe('TurnRunner', () => {
  it('streams text into deltas, sentences and metrics', async () => {
    const h = harness({ 'anthropic:claude-haiku-4-5': mockModel([textStream(['Hello ', 'there. ', 'Second one.'])]) })
    const r = await h.run()
    expect(r).toMatchObject({ text: 'Hello there. Second one.', aborted: false, modelUsed: 'anthropic:claude-haiku-4-5' })
    expect(h.chunks.filter((c) => c.text).map((c) => c.text)).toEqual(['Hello there.', 'Second one.'])
    expect(h.deps.onDelta).toHaveBeenCalledTimes(3)
    const metrics = vi.mocked(h.deps.onMetrics).mock.calls[0]![0]
    expect(metrics).toMatchObject({ inputTokens: 10, outputTokens: 5, steps: 1, model: 'anthropic:claude-haiku-4-5' })
    expect(metrics.ttftMs).toBeGreaterThanOrEqual(0)
  })

  it('runs a tool round, speaks a filler once, and reports input and output', async () => {
    const calc = tool({
      description: 'add',
      inputSchema: z.object({ a: z.number(), b: z.number() }),
      execute: async ({ a, b }) => ({ sum: a + b })
    })
    const h = harness(
      { 'anthropic:claude-haiku-4-5': mockModel([toolCallStream('calc', { a: 2, b: 3 }), textStream(['Five.'], [20, 2])]) },
      { tools: { calc } }
    )
    const r = await h.run()
    expect(r.text).toBe('Five.')
    expect(h.deps.onToolStart).toHaveBeenCalledWith('call-1', 'calc', { a: 2, b: 3 })
    expect(h.deps.onToolEnd).toHaveBeenCalledWith('call-1', 'calc', true, { sum: 5 })
    expect(h.deps.onCue).toHaveBeenNthCalledWith(1, true)
    expect(h.deps.onCue).toHaveBeenLastCalledWith(false)
    const spoken = h.chunks.filter((c) => c.text).map((c) => c.text)
    expect(spoken).toHaveLength(2)
    expect(spoken[1]).toBe('Five.')
    expect(vi.mocked(h.deps.onMetrics).mock.calls[0]![0]).toMatchObject({ inputTokens: 27, outputTokens: 5, steps: 2 })
  })

  it('reports a failing tool as an error and keeps going', async () => {
    const bad = tool({
      description: 'bad',
      inputSchema: z.object({}),
      execute: async (): Promise<string> => {
        throw new Error('tool exploded')
      }
    })
    const h = harness({ 'anthropic:claude-haiku-4-5': mockModel([toolCallStream('bad', {}), textStream(['Sorry.'])]) }, { tools: { bad }, fillerEnabled: false })
    const r = await h.run()
    expect(r.text).toBe('Sorry.')
    expect(h.deps.onToolEnd).toHaveBeenCalledWith('call-1', 'bad', false, undefined, expect.stringContaining('tool exploded'))
  })

  it('retries a transient failure on the same model before falling back', async () => {
    const overloaded = Object.assign(new Error('Overloaded'), { statusCode: 529 })
    const primary = mockModel([overloaded, textStream(['Back.'])])
    const h = harness({ 'anthropic:claude-haiku-4-5': primary, 'groq:openai/gpt-oss-20b': mockModel([textStream(['Fallback.'])]) })
    const r = await h.run()
    expect(r.text).toBe('Back.')
    expect(h.deps.onNotice).not.toHaveBeenCalled()
  })

  it('falls back to the second model when the primary keeps failing', async () => {
    const overloaded = Object.assign(new Error('Overloaded'), { statusCode: 529 })
    const h = harness({ 'anthropic:claude-haiku-4-5': mockModel([overloaded]), 'groq:openai/gpt-oss-20b': mockModel([textStream(['Fallback.'])]) })
    const r = await h.run()
    expect(r.text).toBe('Fallback.')
    expect(r.modelUsed).toBe('groq:openai/gpt-oss-20b')
    expect(h.deps.onNotice).toHaveBeenCalledWith(expect.stringContaining("isn't responding"))
  })

  it('does not retry non-transient errors', async () => {
    const forbidden = Object.assign(new Error('bad key'), { statusCode: 401 })
    const h = harness({ 'anthropic:claude-haiku-4-5': mockModel([forbidden, textStream(['nope'])]), 'groq:openai/gpt-oss-20b': mockModel([textStream(['nope'])]) })
    const r = await h.run()
    expect(r.text).toBe('')
    expect(r.error).toContain('401')
  })

  it('returns aborted when the outer signal fires', async () => {
    const h = harness({ 'anthropic:claude-haiku-4-5': mockModel([textStream(['a', 'b'])]) })
    h.controller.abort()
    const r = await h.run()
    expect(r.aborted).toBe(true)
  })

  it('treats a stall before the first token as a timeout that triggers fallback', async () => {
    const silent = new MockLanguageModelV4({
      doStream: (opts) => new Promise((_resolve, reject) => opts.abortSignal?.addEventListener('abort', () => reject(new Error('aborted by client'))))
    })
    const h = harness({ 'anthropic:claude-haiku-4-5': silent, 'groq:openai/gpt-oss-20b': mockModel([textStream(['Late.'])]) }, { firstTokenTimeoutMs: 50 })
    const r = await h.run()
    expect(r.text).toBe('Late.')
  }, 10_000)
})
