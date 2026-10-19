import { describe, expect, it } from 'vitest'
import { GroqKeyPool, type KeySource } from './keys'
import { DEFAULT_MODEL_ID, MODELS, findModel } from './models'
import { MissingKeyError, ModelFactory } from './factory'

const source = (keys: string[]): KeySource => ({ keysFor: (p) => (p === 'groq' ? keys : []) })

describe('GroqKeyPool', () => {
  it('returns undefined with no keys', () => {
    expect(new GroqKeyPool(source([])).pick()).toBeUndefined()
  })

  it('round-robins across keys', () => {
    const pool = new GroqKeyPool(source(['a', 'b', 'c']))
    expect([pool.pick(), pool.pick(), pool.pick(), pool.pick()]).toEqual(['a', 'b', 'c', 'a'])
  })

  it('benches a key on 429 and skips it, permanently on 401', () => {
    const pool = new GroqKeyPool(source(['a', 'b']))
    pool.report('a', 429)
    expect(pool.pick()).toBe('b')
    expect(pool.pick()).toBe('b')
    pool.report('b', 401)
    expect(['a', 'b']).toContain(pool.pick())
  })

  it('ignores success codes', () => {
    const pool = new GroqKeyPool(source(['a']))
    pool.report('a', 200)
    expect(pool.pick()).toBe('a')
  })
})

describe('models registry', () => {
  it('has a default that exists and is marked fast', () => {
    const def = findModel(DEFAULT_MODEL_ID)
    expect(def).toBeDefined()
    expect(def?.fast).toBe(true)
  })

  it('has unique ids of the form provider:model', () => {
    const ids = MODELS.map((m) => m.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const m of MODELS) expect(m.id).toBe(`${m.provider}:${m.model}`)
  })

  it('accepts an ad-hoc provider:model id and rejects unknown providers', () => {
    expect(findModel('groq:some/new-model')).toMatchObject({ provider: 'groq', model: 'some/new-model', label: 'some/new-model' })
    expect(findModel('openai:gpt-4o')).toBeUndefined()
    expect(findModel('nonsense')).toBeUndefined()
  })
})

describe('ModelFactory', () => {
  it('throws MissingKeyError when the provider has no key', () => {
    const f = new ModelFactory({ keysFor: () => [] })
    expect(() => f.create(findModel('anthropic:claude-haiku-4-5')!)).toThrow(MissingKeyError)
  })

  it('creates a model for every provider when keys exist', () => {
    const f = new ModelFactory({ keysFor: () => ['k1'] })
    for (const info of MODELS) {
      const { model, key } = f.create(info)
      expect(key).toBe('k1')
      expect(model).toBeTruthy()
    }
  })

  it('sends the workspace header on Anthropic requests when the key source supplies one', async () => {
    const seen: Array<Headers> = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      seen.push(new Headers(init?.headers))
      return new Response('{}', { status: 400 })
    }) as typeof fetch
    try {
      const f = new ModelFactory({
        keysFor: () => ['k1'],
        headersFor: (p) => (p === 'anthropic' ? { 'anthropic-workspace-id': 'wrkspc_x' } : undefined)
      })
      const { model } = f.create(findModel('anthropic:claude-haiku-4-5')!)
      try {
        await (model as unknown as { doGenerate: (o: unknown) => PromiseLike<unknown> }).doGenerate({
          prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
        })
      } catch {
        // the stub answers 400; only the outgoing headers matter here
      }
    } finally {
      globalThis.fetch = realFetch
    }
    expect(seen[0]?.get('anthropic-workspace-id')).toBe('wrkspc_x')
  })
})
