import { describe, expect, it } from 'vitest'
import { SentenceChunker } from './chunker'

const feedAll = (c: SentenceChunker, pieces: string[]): string[] => pieces.flatMap((p) => c.feed(p))

describe('SentenceChunker', () => {
  it('emits a sentence once its terminator is followed by whitespace', () => {
    const c = new SentenceChunker()
    expect(c.feed('Hello there.')).toEqual([])
    expect(c.feed(' How are')).toEqual(['Hello there.'])
    expect(c.feed(' you? Fine.')).toEqual(['How are you?'])
    expect(c.flush()).toEqual(['Fine.'])
  })

  it('treats end of input as a boundary when the terminator is last', () => {
    const c = new SentenceChunker()
    expect(feedAll(c, ['Done', '!'])).toEqual([])
    expect(c.flush()).toEqual(['Done!'])
  })

  it('keeps closing quotes and brackets with the sentence', () => {
    const c = new SentenceChunker()
    expect(c.feed('She said "no." Then left.')).toEqual(['She said "no."'])
    expect(c.flush()).toEqual(['Then left.'])
  })

  it('splits on newlines and drops empty lines', () => {
    const c = new SentenceChunker()
    expect(c.feed('first line\n\nsecond line\n')).toEqual(['first line', 'second line'])
  })

  it('releases the first chunk early at a clause break once it has enough words', () => {
    const c = new SentenceChunker(220, 4)
    expect(c.feed('Honestly the best option here, given')).toEqual(['Honestly the best option here,'])
    expect(c.feed(' the budget, is the second one.')).toEqual([])
    expect(c.flush()).toEqual(['given the budget, is the second one.'])
  })

  it('does not release at a clause break after the first chunk', () => {
    const c = new SentenceChunker(220, 4)
    c.feed('One two three four, five. ')
    expect(c.feed('Six seven eight nine, ten')).toEqual([])
  })

  it('cuts run-on text at the last space before maxChars', () => {
    const c = new SentenceChunker(30, 0)
    const out = c.feed('word '.repeat(12))
    expect(out.length).toBeGreaterThan(0)
    for (const s of out) expect(s.length).toBeLessThanOrEqual(30)
  })

  it('never emits empty strings and flush clears the buffer', () => {
    const c = new SentenceChunker()
    expect(c.feed('   ')).toEqual([])
    expect(c.flush()).toEqual([])
    expect(c.flush()).toEqual([])
  })

  it('handles ellipses and multiple terminators as one boundary', () => {
    const c = new SentenceChunker()
    expect(c.feed('Wait… really?! Yes.')).toEqual(['Wait…', 'really?!'])
  })
})
