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

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", "3 weeks ago", "2 months ago". */
export function relativeTime(then: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - then) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  if (d === 1) return 'yesterday'
  if (d < 14) return `${d} days ago`
  const w = Math.round(d / 7)
  if (w < 9) return `${w} weeks ago`
  const mo = Math.round(d / 30)
  return mo < 12 ? `${mo} months ago` : `${Math.round(d / 365)} years ago`
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
