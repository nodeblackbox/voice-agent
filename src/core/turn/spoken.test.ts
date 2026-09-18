import { describe, expect, it } from 'vitest'
import { interruptionNote, remainder, splitSpoken, type SpokenChunk } from './spoken'

const chunks: SpokenChunk[] = [
  { seq: 0, text: 'Let me check that.', kind: 'filler' },
  { seq: 1, text: 'The first sentence is short.', kind: 'speech' },
  { seq: 2, text: 'The second one has exactly eight words in it.', kind: 'speech' },
  { seq: 3, text: 'A third that never started.', kind: 'speech' }
]
const full = 'The first sentence is short. The second one has exactly eight words in it. A third that never started.'

describe('splitSpoken', () => {
  it('counts finished sentences in full, slices the cut sentence by time, ignores fillers', () => {
    const r = splitSpoken(full, chunks, new Set([0, 1]), new Set([0, 1, 2]), { seq: 2, offsetS: 1.0, durationS: 2.0 })
    expect(r.spoken).toBe('The first sentence is short. The second one has exactly')
    expect(r.unspoken).toBe('eight words in it. A third that never started.')
    expect(r.heardSeqs).toEqual([1, 2])
  })

  it('never claims less than one word of a sentence that had started', () => {
    const r = splitSpoken(full, chunks, new Set([1]), new Set([1, 2]), { seq: 2, offsetS: 0.01, durationS: 5 })
    expect(r.spoken).toBe('The first sentence is short. The')
  })

  it('is provisional without a cut report: started sentences count in full', () => {
    const r = splitSpoken(full, chunks, new Set([1]), new Set([0, 1, 2]), null)
    expect(r.spoken).toBe('The first sentence is short. The second one has exactly eight words in it.')
    expect(r.unspoken).toBe('A third that never started.')
  })

  it('reports nothing heard when the cut landed before any speech', () => {
    const r = splitSpoken(full, chunks, new Set(), new Set([0]), null)
    expect(r).toEqual({ spoken: '', unspoken: full, heardSeqs: [] })
  })

  it('remainder tolerates whitespace and text the voice filtered out', () => {
    expect(remainder('Hello\n\nthere friend. Bye.', 'Hello there friend.')).toBe('Bye.')
    expect(remainder('Intro. ```code``` After the code. End.', 'Intro. the code is in the conversation. After the code.')).toBe('End.')
  })

  it('formats the interruption note with a bounded remainder', () => {
    expect(interruptionNote('')).toBe('[interrupted by the user here]')
    expect(interruptionNote('rest of it')).toBe('[interrupted by the user here; the rest was never spoken: "rest of it"]')
    expect(interruptionNote('x'.repeat(400), 50)).toMatch(/^\[interrupted by the user here; the rest was never spoken: "x{49}…"\]$/)
  })
})
