import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocationProvider, relativeTime, timeContext } from './index'

describe('timeContext', () => {
  it('returns a human date with the resolved timezone', () => {
    const t = timeContext()
    expect(t.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
    expect(t.now).toMatch(/\d{4}/)
    expect(t.now).toMatch(/\d{2}:\d{2}/)
    expect(t.now).toMatch(/^(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day/)
  })
})

describe('relativeTime', () => {
  it('renders relative times coarsely', () => {
    const now = 1_000_000_000_000
    const m = 60_000
    expect(relativeTime(now - 10_000, now)).toBe('just now')
    expect(relativeTime(now - 5 * m, now)).toBe('5 min ago')
    expect(relativeTime(now - 3 * 60 * m, now)).toBe('3 h ago')
    expect(relativeTime(now - 24 * 60 * m, now)).toBe('yesterday')
    expect(relativeTime(now - 4 * 24 * 60 * m, now)).toBe('4 days ago')
    expect(relativeTime(now - 21 * 24 * 60 * m, now)).toBe('3 weeks ago')
    expect(relativeTime(now - 90 * 24 * 60 * m, now)).toBe('3 months ago')
    expect(relativeTime(now - 800 * 24 * 60 * m, now)).toBe('2 years ago')
  })
})

describe('LocationProvider', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('returns the manual value or a placeholder', async () => {
    const p = new LocationProvider()
    expect(await p.resolve({ mode: 'manual', manual: ' London ' })).toBe('London')
    expect(await p.resolve({ mode: 'manual', manual: '' })).toBe('not set')
    expect(await p.resolve({ mode: 'off', manual: '' })).toContain('unknown')
  })

  it('looks up by IP once and caches the result', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ city: 'London', region: 'England', country_name: 'United Kingdom' })))
    vi.stubGlobal('fetch', fetchMock)
    const p = new LocationProvider()
    const [a, b] = await Promise.all([p.resolve({ mode: 'ip', manual: '' }), p.resolve({ mode: 'ip', manual: '' })])
    expect(a).toBe('London, England, United Kingdom (approximate, from IP)')
    expect(b).toBe(a)
    expect(await p.resolve({ mode: 'ip', manual: '' })).toBe(a)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('degrades gracefully when the lookup fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 503 })))
    const p = new LocationProvider()
    expect(await p.resolve({ mode: 'ip', manual: '' })).toBe('unknown (IP lookup failed)')
  })
})
