import { tool, type ToolSet } from 'ai'
import { z } from 'zod'

export interface SearchDeps {
  baseUrl(): string
  ensure(): Promise<boolean>
}

interface SearxResult {
  title?: string
  url?: string
  content?: string
  engine?: string
  publishedDate?: string
}

interface SearxResponse {
  results?: SearxResult[]
  answers?: string[]
  infoboxes?: Array<{ infobox?: string; content?: string }>
}

async function searx(deps: SearchDeps, query: string, signal: AbortSignal | undefined, limit: number) {
  if (!(await deps.ensure())) return { error: 'Web search is not available right now (SearXNG is not running).' }
  const url = new URL('/search', deps.baseUrl())
  url.searchParams.set('q', query)
  url.searchParams.set('format', 'json')
  url.searchParams.set('safesearch', '0')
  const res = await fetch(url, { signal: signal ?? null })
  if (!res.ok) return { error: `Search failed with status ${res.status}` }
  const data = (await res.json()) as SearxResponse
  return {
    answers: data.answers ?? [],
    infobox: data.infoboxes?.map((i) => `${i.infobox ?? ''}: ${i.content ?? ''}`).filter((s) => s.length > 2) ?? [],
    results: (data.results ?? []).slice(0, limit).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: (r.content ?? '').slice(0, 300),
      published: r.publishedDate
    }))
  }
}

export async function readPage(url: string, signal?: AbortSignal, maxChars = 6000): Promise<{ title: string; text: string; url: string } | { error: string }> {
  const pypi = /^https?:\/\/pypi\.org\/project\/([^/]+)\/?/.exec(url)
  if (pypi) {
    const res = await fetch(`https://pypi.org/pypi/${pypi[1]}/json`, { signal: signal ?? null })
    if (!res.ok) return { error: `PyPI returned ${res.status}` }
    const j = (await res.json()) as { info?: { name?: string; version?: string; summary?: string; description?: string } }
    const text = `${j.info?.name} ${j.info?.version}\n${j.info?.summary}\n\n${j.info?.description ?? ''}`
    return { title: j.info?.name ?? url, text: text.slice(0, maxChars), url }
  }
  const res = await fetch(url, {
    signal: signal ?? null,
    headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) VoiceAgent/0.1', accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5' }
  })
  if (!res.ok) return { error: `Fetch failed with status ${res.status}` }
  const ctype = res.headers.get('content-type') ?? ''
  const body = await res.text()
  if (!ctype.includes('html')) return { title: url, text: body.slice(0, maxChars), url }
  const [{ JSDOM }, { Readability }] = await Promise.all([import('jsdom'), import('@mozilla/readability')])
  const dom = new JSDOM(body, { url })
  const article = new Readability(dom.window.document).parse()
  const text = (article?.textContent ?? dom.window.document.body?.textContent ?? '').replace(/\s+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').trim()
  return { title: article?.title ?? dom.window.document.title ?? url, text: text.slice(0, maxChars), url }
}

export function searchTools(deps: SearchDeps): ToolSet {
  return {
    web_search: tool({
      description: 'Search the web (via a local SearXNG instance). Returns titles, URLs and snippets. Use for anything current: news, prices, opening hours, docs, weather.',
      inputSchema: z.object({ query: z.string().describe('A natural search query, like you would type into Google') }),
      execute: ({ query }, { abortSignal }) => searx(deps, query, abortSignal, 6)
    }),
    read_page: tool({
      description: 'Fetch a web page and return its readable text (up to ~6000 characters). Use after web_search when a snippet is not enough.',
      inputSchema: z.object({ url: z.string().url() }),
      execute: ({ url }, { abortSignal }) => readPage(url, abortSignal)
    }),
    research: tool({
      description: 'Search, then read the top pages in parallel and return their text. Heavier than web_search; use when you need detail from several sources.',
      inputSchema: z.object({ query: z.string(), pages: z.number().int().min(1).max(4).default(3) }),
      execute: async ({ query, pages }, { abortSignal }) => {
        const found = await searx(deps, query, abortSignal, pages)
        if ('error' in found) return found
        const docs = await Promise.all(
          found.results.filter((r) => r.url).map((r) => readPage(r.url!, abortSignal, 3500).catch((e: Error) => ({ error: e.message })))
        )
        return { answers: found.answers, sources: docs }
      }
    })
  }
}
