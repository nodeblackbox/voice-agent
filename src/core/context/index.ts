import type { LocationSettings } from '@shared/types'

export interface TimeContext {
  now: string
  timezone: string
}

export function timeContext(): TimeContext {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const now = new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(new Date())
  return { now, timezone }
}

const IP_TTL_MS = 60 * 60 * 1000

export class LocationProvider {
  private cached: { value: string; at: number } | null = null
  private inflight: Promise<string> | null = null

  async resolve(settings: LocationSettings): Promise<string> {
    if (settings.mode === 'manual') return settings.manual.trim() || 'not set'
    if (settings.mode === 'off') return 'unknown (ask if it matters)'
    if (this.cached && Date.now() - this.cached.at < IP_TTL_MS) return this.cached.value
    if (!this.inflight) {
      this.inflight = this.lookup().finally(() => {
        this.inflight = null
      })
    }
    return this.inflight
  }

  private async lookup(): Promise<string> {
    try {
      const res = await fetch('https://ipapi.co/json/', { signal: AbortSignal.timeout(4000) })
      if (!res.ok) throw new Error(String(res.status))
      const j = (await res.json()) as { city?: string; region?: string; country_name?: string }
      const value = [j.city, j.region, j.country_name].filter(Boolean).join(', ') || 'unknown'
      this.cached = { value: `${value} (approximate, from IP)`, at: Date.now() }
      return this.cached.value
    } catch {
      return this.cached?.value ?? 'unknown (IP lookup failed)'
    }
  }
}
