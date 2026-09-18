import type { ToolActivity, ToolSource } from '@shared/types'

export function toolKind(name: string): ToolActivity['kind'] {
  if (name.startsWith('mcp__')) return 'mcp'
  if (name === 'web_search' || name === 'research') return 'search'
  if (name === 'read_page') return 'read'
  if (name === 'remember' || name === 'recall' || name === 'forget' || name === 'search_history' || name === 'update_memory') return 'memory'
  if (name === 'current_time') return 'time'
  return 'other'
}

export function mcpServerOf(name: string): string | undefined {
  if (!name.startsWith('mcp__')) return undefined
  return name.split('__')[1]
}

const str = (v: unknown, max = 120): string => {
  if (v === undefined || v === null) return ''
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

export function describeInput(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>
  switch (name) {
    case 'web_search':
    case 'research':
      return typeof i.query === 'string' ? `“${i.query}”` : ''
    case 'read_page':
      return typeof i.url === 'string' ? i.url : ''
    case 'remember':
      return typeof i.key === 'string' ? `${i.key}: ${str(i.value, 60)}` : ''
    case 'update_memory': {
      const what = i.append !== undefined ? `append ${str(i.append, 50)}` : i.replace ? `replace ${str((i.replace as { find?: unknown }).find, 30)}` : i.value !== undefined ? `rewrite` : 'edit'
      return `${typeof i.key === 'string' ? i.key : i.id !== undefined ? `#${String(i.id)}` : ''} · ${what}`
    }
    case 'recall':
    case 'search_history':
      return typeof i.query === 'string' ? `“${i.query}”` : ''
    case 'forget':
      return i.id !== undefined ? `#${String(i.id)}` : ''
    case 'current_time':
      return ''
    default: {
      const entries = Object.entries(i)
      return entries.length ? entries.map(([k, v]) => `${k}=${str(v, 40)}`).join(' ') : ''
    }
  }
}

const host = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

export function describeOutput(name: string, output: unknown): { detail?: string; sources?: ToolSource[] } {
  const o = output as Record<string, unknown> | string | null | undefined
  if (o && typeof o === 'object' && 'error' in o) return { detail: str((o as { error: unknown }).error, 90) }
  switch (name) {
    case 'web_search': {
      const results = ((o as { results?: Array<{ title?: string; url?: string; snippet?: string }> })?.results ?? []).filter((r) => r.url)
      const answers = (o as { answers?: string[] })?.answers ?? []
      return {
        detail: `${results.length} result${results.length === 1 ? '' : 's'}${answers.length ? `, ${answers.length} direct answer${answers.length === 1 ? '' : 's'}` : ''}`,
        sources: results.map((r) => ({ title: r.title || host(r.url!), url: r.url!, snippet: r.snippet }))
      }
    }
    case 'research': {
      const sources = ((o as { sources?: Array<{ title?: string; url?: string; text?: string; error?: string }> })?.sources ?? []).filter((s) => s.url)
      return {
        detail: `read ${sources.length} page${sources.length === 1 ? '' : 's'}`,
        sources: sources.map((s) => ({ title: s.title || host(s.url!), url: s.url!, snippet: s.text?.slice(0, 160) }))
      }
    }
    case 'read_page': {
      const r = o as { title?: string; url?: string; text?: string } | undefined
      return r?.url ? { detail: `${(r.text?.length ?? 0).toLocaleString()} chars`, sources: [{ title: r.title || host(r.url), url: r.url }] } : {}
    }
    case 'remember':
    case 'update_memory': {
      const s = (o as { status?: string })?.status
      return { detail: s === 'saved' ? 'saved' : s === 'updated' ? 'updated' : s === 'pending' ? 'waiting for your OK' : s === 'not_found' ? 'no such memory' : s === 'no_change' ? 'nothing to change' : s }
    }
    case 'recall':
    case 'search_history': {
      const n = Array.isArray(o) ? o.length : 0
      return { detail: n ? `${n} match${n === 1 ? '' : 'es'}` : 'nothing found' }
    }
    case 'forget': {
      const s = (o as { status?: string })?.status
      return { detail: s === 'pending' ? 'waiting for your OK' : s }
    }
    case 'current_time':
      return { detail: (o as { now?: string })?.now }
    default:
      return { detail: str(o, 90) }
  }
}
