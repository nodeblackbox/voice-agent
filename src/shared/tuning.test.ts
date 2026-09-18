import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_TUNING, TUNING, TUNING_GROUPS, coerceParam, earConfig, sanitizeTuning, tuningDiff, tuningParams } from './tuning'

const allParams = TUNING_GROUPS.flatMap((g) => tuningParams(g).map((p) => ({ group: g, ...p })))

describe('tuning schema', () => {
  it('every numeric default sits inside its own range and steps cleanly', () => {
    for (const { group, key, param } of allParams) {
      if (param.kind !== 'number') continue
      expect(param.default, `${group}.${key}`).toBeGreaterThanOrEqual(param.min)
      expect(param.default, `${group}.${key}`).toBeLessThanOrEqual(param.max)
      expect(param.step, `${group}.${key}`).toBeGreaterThan(0)
    }
  })

  it('enum defaults are one of their options and every param has a doc', () => {
    for (const { group, key, param } of allParams) {
      if (param.kind === 'enum') expect(param.options, `${group}.${key}`).toContain(param.default)
      expect(param.doc.length, `${group}.${key}`).toBeGreaterThan(20)
    }
  })

  it('preroll covers the barge-in cut window by default', () => {
    const e = DEFAULT_TUNING.endpoint
    expect(e.prerollMs).toBeGreaterThan(e.bargeInChunks * 32)
  })

  it('earConfig flattens every endpoint field plus ear-scoped runtime fields', () => {
    const cfg = earConfig(DEFAULT_TUNING)
    for (const key of Object.keys(TUNING.endpoint)) expect(cfg).toHaveProperty(key)
    expect(cfg.levelEveryFrames).toBe(DEFAULT_TUNING.runtime.levelEveryFrames)
    expect(cfg).not.toHaveProperty('logLevel')
  })

  it('sanitizeTuning clamps, drops unknown keys and fills gaps with defaults', () => {
    const t = sanitizeTuning({ endpoint: { vadThreshold: 5, bogus: 1 }, brain: { groqReasoningEffort: 'turbo' }, nonsense: {} })
    expect(t.endpoint.vadThreshold).toBe(TUNING.endpoint.vadThreshold.max)
    expect((t.endpoint as Record<string, unknown>).bogus).toBeUndefined()
    expect(t.brain.groqReasoningEffort).toBe('low')
    expect(t.speech).toEqual(DEFAULT_TUNING.speech)
    expect(coerceParam(TUNING.runtime.logTranscripts, 'yes')).toBe(true)
  })

  it('tuningDiff lists only values that differ from the defaults', () => {
    const t = sanitizeTuning({ speech: { firstMinWords: 4 } })
    expect(tuningDiff(t)).toEqual([{ group: 'speech', key: 'firstMinWords', value: 4, default: 6 }])
    expect(tuningDiff(DEFAULT_TUNING)).toEqual([])
  })

  it('docs/TUNING.md documents every parameter and the sidecar protocol matches the ear defaults', () => {
    const root = join(__dirname, '..', '..')
    const doc = readFileSync(join(root, 'docs', 'TUNING.md'), 'utf8')
    for (const { group, key } of allParams) expect(doc, `${group}.${key} missing from docs/TUNING.md`).toContain(`\`${key}\``)
    const protocol = readFileSync(join(root, 'sidecar', 'PROTOCOL.md'), 'utf8')
    for (const [key, value] of Object.entries(earConfig(DEFAULT_TUNING))) {
      if (typeof value === 'string') expect(protocol, `PROTOCOL.md entry for ${key}`).toContain(`\`${key}\``)
      else expect(protocol, `PROTOCOL.md default for ${key}`).toContain(`\`${key}\` (${value})`)
    }
  })

  it('text params are clamped to their max length and default when not a string', () => {
    expect(coerceParam(TUNING.endpoint.fillerWords, 42)).toBe(TUNING.endpoint.fillerWords.default)
    expect(coerceParam(TUNING.endpoint.fillerWords, 'x'.repeat(5000))).toHaveLength(2000)
    expect(earConfig(DEFAULT_TUNING).fillerWords).toContain('basically')
  })
})
