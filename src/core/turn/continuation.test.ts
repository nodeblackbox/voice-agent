import { describe, expect, it } from 'vitest'
import { DEFAULT_FILLER_WORDS } from '@shared/tuning'
import { mergeTexts, parseFillerWords, unfinishedReason } from './continuation'

const fillers = parseFillerWords(DEFAULT_FILLER_WORDS)
const opts = { fillerWords: fillers, minWords: 4, lowP: 0.3 }

describe('unfinishedReason', () => {
  it('flags fragments that end on a filler or continuation word', () => {
    expect(unfinishedReason("Yeah, and then when it just waits for me, and then I'll.", { ...opts, endReason: 'done', turnP: 0.95 })).toBe('filler')
    expect(unfinishedReason('I was thinking about the project and basically', { ...opts, endReason: 'done', turnP: 0.9 })).toBe('filler')
  })

  it('flags very short transcripts', () => {
    expect(unfinishedReason('Yeah, so basically', { ...opts, endReason: 'done', turnP: 0.97 })).toBe('short')
    expect(unfinishedReason('Um I', opts)).toBe('short')
  })

  it('flags timeouts where the model still said not done', () => {
    expect(unfinishedReason('I want to make sure that the memory thing works properly', { ...opts, endReason: 'timeout', turnP: 0.05 })).toBe('timeout-low-p')
    expect(unfinishedReason('I want to make sure that the memory thing works properly', { ...opts, endReason: 'timeout', turnP: 0.6 })).toBeNull()
  })

  it('flags dangling punctuation and accepts real endings', () => {
    expect(unfinishedReason('So the thing about the karate project is,', { ...opts, endReason: 'done', turnP: 0.9 })).toBe('dangling')
    expect(unfinishedReason("What's the weather like in London today?", { ...opts, endReason: 'done', turnP: 0.95 })).toBeNull()
    expect(unfinishedReason('Tell me something about Anthropic.', { ...opts, endReason: 'done', turnP: 0.9 })).toBeNull()
  })
})

describe('mergeTexts', () => {
  it('joins a fragment with its continuation, dropping the fragment full stop', () => {
    expect(mergeTexts("and then I'll.", 'finish it off.')).toBe("and then I'll finish it off.")
    expect(mergeTexts('Yeah, so basically', 'Um I think it works.')).toBe('Yeah, so basically Um I think it works.')
    expect(mergeTexts('', 'x')).toBe('x')
    expect(mergeTexts('x', '')).toBe('x')
  })
})
