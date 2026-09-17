import { afterEach, describe, expect, it, vi } from 'vitest'
import { readPage, searchTools } from './search'

const exec = async (tools: ReturnType<typeof searchTools>, name: string, input: unknown, signal?: AbortSignal) =>
  tools[name]!.execute!(input, { toolCallId: '1', messages: [], abortSignal: signal, context: undefined as never })

describe('web_search', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('calls SearXNG with the query and maps results', async () => {
    const fetchMock = vi.fn(async (url: URL | string) => {
      const u = new URL(String(url))
      expect(u.pathname).toBe('/search')
      expect(u.searchParams.get('q')).toBe('gym hours')
      expect(u.searchParams.get('format')).toBe('json')
      return new Response(
        JSON.stringify({
          answers: ['Opens 6am'],
          infoboxes: [{ infobox: 'Gym', content: 'A gym' }],
          results: Array.from({ length: 10 }, (_, i) => ({ title: `R${i}`, url: `https://r${i}.com`, content: 'x'.repeat(500), engine: 'brave' }))
        })
      )
    })
    vi.stubGlobal('fetch', fetchMock)
    const tools = searchTools({ baseUrl: () => 'http://127.0.0.1:8888', ensure: async () => true })
    const out = (await exec(tools, 'web_search', { query: 'gym hours' })) as { results: Array<{ snippet: string }>; answers: string[]; infobox: string[] }
    expect(out.answers).toEqual(['Opens 6am'])
    expect(out.infobox).toEqual(['Gym: A gym'])
    expect(out.results).toHaveLength(6)
    expect(out.results[0]?.snippet).toHaveLength(300)
  })

  it('reports when SearXNG is unavailable instead of throwing', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const tools = searchTools({ baseUrl: () => 'http://x', ensure: async () => false })
    expect(await exec(tools, 'web_search', { query: 'q' })).toEqual({ error: expect.stringContaining('not available') })
  })

  it('surfaces HTTP failures as an error result', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })))
    const tools = searchTools({ baseUrl: () => 'http://x', ensure: async () => true })
    expect(await exec(tools, 'web_search', { query: 'q' })).toEqual({ error: 'Search failed with status 500' })
  })

  it('forwards the abort signal to fetch', async () => {
    const fetchMock = vi.fn(async (_u: unknown, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal)
      return new Response(JSON.stringify({ results: [] }))
    })
    vi.stubGlobal('fetch', fetchMock)
    const tools = searchTools({ baseUrl: () => 'http://x', ensure: async () => true })
    await exec(tools, 'web_search', { query: 'q' }, new AbortController().signal)
    expect(fetchMock).toHaveBeenCalled()
  })
})

describe('readPage', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('extracts readable text from HTML with Readability', async () => {
    const html = `<html><head><title>Doc Title</title></head><body><nav>menu menu</nav><article><h1>Doc Title</h1>${'<p>Real content paragraph that is long enough to matter for readability scoring.</p>'.repeat(5)}</article></body></html>`
    vi.stubGlobal('fetch', vi.fn(async () => new Response(html, { headers: { 'content-type': 'text/html' } })))
    const out = await readPage('https://example.com/doc')
    expect(out).toMatchObject({ url: 'https://example.com/doc' })
    expect('text' in out && out.text).toContain('Real content paragraph')
    expect('title' in out && out.title).toContain('Doc Title')
  })

  it('returns plain bodies as-is, truncated', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('a'.repeat(10_000), { headers: { 'content-type': 'text/plain' } })))
    const out = await readPage('https://example.com/t.txt', undefined, 100)
    expect('text' in out && out.text.length).toBe(100)
  })

  it('uses the PyPI JSON API for pypi project pages', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('https://pypi.org/pypi/onnx-asr/json')
      return new Response(JSON.stringify({ info: { name: 'onnx-asr', version: '0.12.0', summary: 'ASR', description: 'desc' } }))
    })
    vi.stubGlobal('fetch', fetchMock)
    const out = await readPage('https://pypi.org/project/onnx-asr/')
    expect(out).toMatchObject({ title: 'onnx-asr' })
    expect('text' in out && out.text).toContain('0.12.0')
  })
})
