import type { Provider } from '@shared/types'

export interface KeySource {
  keysFor(provider: Provider): string[]
}

// Round-robin over several Groq keys; a 429 benches a key for a minute, a 401 permanently.
export class GroqKeyPool {
  private idx = 0
  private benched = new Map<string, number>()

  constructor(private readonly source: KeySource) {}

  pick(): string | undefined {
    const keys = this.source.keysFor('groq')
    if (!keys.length) return undefined
    const now = Date.now()
    for (let i = 0; i < keys.length; i++) {
      const key = keys[(this.idx + i) % keys.length]!
      const until = this.benched.get(key) ?? 0
      if (until > now) continue
      this.idx = (this.idx + i + 1) % keys.length
      return key
    }
    return keys[this.idx % keys.length]
  }

  report(key: string, status: number): void {
    if (status === 429) this.benched.set(key, Date.now() + 60_000)
    else if (status === 401 || status === 403) this.benched.set(key, Number.MAX_SAFE_INTEGER)
  }
}
