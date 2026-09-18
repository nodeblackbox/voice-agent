import { describe, expect, it } from 'vitest'
import { DEFAULT_BACKCHANNEL_WORDS, DEFAULT_RESUME_PHRASES, classifyAfterCut, resumeText } from './resume'

const opts = { resumePhrases: DEFAULT_RESUME_PHRASES, backchannelWords: DEFAULT_BACKCHANNEL_WORDS }

describe('classifyAfterCut', () => {
  it('recognises backchannels', () => {
    for (const t of ['mhm', 'Yeah.', 'ok ok', 'uh huh', 'Yeah, right.', 'got it']) expect(classifyAfterCut(t, opts), t).toBe('backchannel')
  })

  it('recognises resume phrases, with or without a backchannel around them', () => {
    for (const t of ['continue', 'Go on.', 'yeah go on', 'okay, keep going', 'and then?'.replace('?', ''), 'where were you', 'carry on please'.replace(' please', '')])
      expect(classifyAfterCut(t, opts), t).toBe('resume')
  })

  it('treats questions and real content as a new turn', () => {
    for (const t of ['ok?', 'go on, what about the price?', 'wait, what about X', 'yeah but I meant the other one', 'continue the story about the dog please tell me', ''])
      expect(classifyAfterCut(t, opts), t).toBe('new')
  })

  it('honours custom lists', () => {
    expect(classifyAfterCut('weiter', { resumePhrases: 'weiter', backchannelWords: 'ja' })).toBe('resume')
    expect(classifyAfterCut('ja', { resumePhrases: 'weiter', backchannelWords: 'ja' })).toBe('backchannel')
    expect(classifyAfterCut('go on', { resumePhrases: 'weiter', backchannelWords: 'ja' })).toBe('new')
  })
})

describe('resumeText', () => {
  it('replays from the start of the interrupted sentence', () => {
    expect(resumeText('First point done. Second point is that we', 'should wait. Third point.')).toBe('Second point is that we should wait. Third point.')
    expect(resumeText('Is it done? Then the next', 'step is easy!')).toBe('Then the next step is easy!')
  })

  it('does not repeat anything when the cut landed on a sentence boundary', () => {
    expect(resumeText('First point done.', 'Second point.')).toBe('Second point.')
    expect(resumeText('', 'Everything.')).toBe('Everything.')
    expect(resumeText(undefined, 'Everything.')).toBe('Everything.')
  })

  it('caps a run-on heard part to the last few words', () => {
    const heard = Array.from({ length: 40 }, (_, i) => `w${i}`).join(' ')
    const out = resumeText(heard, 'rest')
    expect(out.split(' ')).toHaveLength(15)
    expect(out.endsWith('w39 rest')).toBe(true)
  })

  it('is empty when nothing is left to say', () => {
    expect(resumeText('All said.', '')).toBe('')
    expect(resumeText('All said.', undefined)).toBe('')
  })
})
