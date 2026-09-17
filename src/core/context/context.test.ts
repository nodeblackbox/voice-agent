import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocationProvider, timeContext } from './index'

describe('timeContext', () => {
  it('returns a human date with the resolved timezone', () => {
    const t = timeContext()
    expect(t.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
    expect(t.now).toMatch(/\d{4}/)
    expect(t.now).toMatch(/\d{2}:\d{2}/)
    expect(t.now).toMatch(/^(Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)day/)
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
