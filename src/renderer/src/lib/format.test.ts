import { describe, expect, it } from 'vitest'
import { envToLines, faviconUrl, formatElapsed, formatTokens, hostOf, parseArgs, parseEnvLines, truncate } from './format'

describe('formatElapsed', () => {
  it('formats sub-minute durations with one decimal', () => {
    expect(formatElapsed(0)).toBe('0.0s')
    expect(formatElapsed(930)).toBe('0.9s')
    expect(formatElapsed(12_345)).toBe('12.3s')
  })
  it('formats minutes', () => {
    expect(formatElapsed(61_000)).toBe('1m 01s')
    expect(formatElapsed(125_400)).toBe('2m 05s')
  })
  it('is safe on garbage', () => {
    expect(formatElapsed(-5)).toBe('0.0s')
    expect(formatElapsed(Number.NaN)).toBe('0.0s')
  })
})

describe('formatTokens', () => {
  it('abbreviates thousands', () => {
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(1000)).toBe('1k')
    expect(formatTokens(1234)).toBe('1.2k')
    expect(formatTokens(150_000)).toBe('150k')
  })
})

describe('hostOf / faviconUrl', () => {
  it('extracts the host without www', () => {
    expect(hostOf('https://www.bbc.co.uk/news/x')).toBe('bbc.co.uk')
    expect(hostOf('not a url')).toBe('not a url')
  })
  it('builds a favicon url for the host', () => {
    expect(faviconUrl('https://www.example.com/a')).toBe('https://www.google.com/s2/favicons?domain=example.com&sz=32')
  })
})

describe('truncate', () => {
  it('leaves short strings alone and ellipsises long ones', () => {
    expect(truncate('abc', 5)).toBe('abc')
    expect(truncate('abcdefgh', 5)).toBe('abcd…')
  })
})

describe('parseArgs', () => {
  it('splits on spaces and honours quotes', () => {
    expect(parseArgs('-y pkg "C:\\My Dir\\x" \'a b\'')).toEqual(['-y', 'pkg', 'C:\\My Dir\\x', 'a b'])
    expect(parseArgs('')).toEqual([])
  })
})

describe('env lines', () => {
  it('round-trips KEY=VALUE lines and ignores comments', () => {
    const env = parseEnvLines('A=1\n# note\nB=two=three\n\nbad line\n')
    expect(env).toEqual({ A: '1', B: 'two=three' })
    expect(envToLines(env)).toBe('A=1\nB=two=three')
    expect(envToLines(undefined)).toBe('')
  })
})
