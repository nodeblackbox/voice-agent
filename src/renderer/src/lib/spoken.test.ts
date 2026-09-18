import { describe, expect, it } from 'vitest'
import { splitBySentences, splitInterrupted } from './spoken'

const text = 'The first sentence is short. The second one has eight words in it. A third that never started.'
const chunks = [
  { seq: 0, text: 'Let me check.', kind: 'filler' as const },
  { seq: 1, text: 'The first sentence is short.', kind: 'speech' as const },
  { seq: 2, text: 'The second one has eight words in it.', kind: 'speech' as const },
  { seq: 3, text: 'A third that never started.', kind: 'speech' as const }
]

describe('splitBySentences', () => {
  it('marks spoken, current and upcoming sentences, ignoring fillers', () => {
    const spans = splitBySentences(text, chunks, 2)
    expect(spans.map((s) => [s.state, s.text.trim()])).toEqual([
      ['spoken', 'The first sentence is short.'],
      ['current', 'The second one has eight words in it.'],
      ['upcoming', 'A third that never started.']
    ])
  })

  it('treats streamed text after the last chunk as upcoming', () => {
    const spans = splitBySentences(text, chunks.slice(0, 2), 1)
    expect(spans.at(-1)).toEqual({ text: ' The second one has eight words in it. A third that never started.', state: 'upcoming' })
  })

  it('falls back to plain when chunks cannot be located or nothing is playing', () => {
    expect(splitBySentences(text, [{ seq: 0, text: 'nope', kind: 'speech' }], 0)).toEqual([{ text, state: 'plain' }])
    expect(splitBySentences(text, chunks, null)).toEqual([{ text, state: 'plain' }])
  })

  it('locates chunks despite newlines in the transcript', () => {
    const md = 'First line.\n\nSecond line here.'
    const spans = splitBySentences(md, [{ seq: 0, text: 'First line.', kind: 'speech' }, { seq: 1, text: 'Second line here.', kind: 'speech' }], 1)
    expect(spans.map((s) => s.state)).toEqual(['spoken', 'current'])
  })
})

describe('splitInterrupted', () => {
  it('splits heard and unheard text', () => {
    expect(splitInterrupted('One. Two. Three.', 'One.', 'Two. Three.')).toEqual({ heard: 'One. ', rest: 'Two. Three.' })
    expect(splitInterrupted('One. Two.', '', undefined)).toEqual({ heard: '', rest: 'One. Two.' })
    expect(splitInterrupted('One. Two.', 'One. Two.', '')).toBeNull()
  })
})
