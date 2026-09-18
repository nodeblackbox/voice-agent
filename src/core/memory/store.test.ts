import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GLOBAL_SCOPE, MemoryStore, ftsQuery } from './store'
import type { ChatMessage } from '@shared/types'

let dir: string
let store: MemoryStore

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'va-store-'))
  store = new MemoryStore(join(dir, 'm.sqlite'))
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

const msg = (over: Partial<ChatMessage>): ChatMessage => ({
  id: crypto.randomUUID(),
  turnId: 't',
  sessionId: 's1',
  role: 'user',
  text: '',
  createdAt: Date.now(),
  ...over
})

describe('ftsQuery', () => {
  it('drops stopwords and short words, quotes terms and ORs them', () => {
    expect(ftsQuery('what is the best gym near me?')).toBe('"best" OR "gym" OR "near"')
  })
  it('returns null when nothing usable remains', () => {
    expect(ftsQuery('is it me?')).toBeNull()
  })
  it('caps the number of terms', () => {
    const q = ftsQuery('alpha beta gamma delta epsilon zeta eta theta iota kappa', 3)
    expect(q?.split(' OR ')).toHaveLength(3)
  })
})

describe('MemoryStore entries', () => {
  it('creates the global scope on open', () => {
    expect(store.scopes().map((s) => s.id)).toEqual([GLOBAL_SCOPE])
  })

  it('upserts by key within a scope (case-insensitive) and counts per scope', () => {
    const a = store.upsert({ scopeId: GLOBAL_SCOPE, key: 'Preferred gym', value: 'Old', source: 'agent' })
    const b = store.upsert({ scopeId: GLOBAL_SCOPE, key: 'preferred GYM', value: 'Elephant & Castle', source: 'user', tags: ['pref', ' loc '] })
    expect(b.id).toBe(a.id)
    expect(b.value).toBe('Elephant & Castle')
    expect(b.tags).toEqual(['pref', 'loc'])
    expect(store.scopes()[0]?.count).toBe(1)
  })

  it('lists newest first and supports full-text filtering', () => {
    store.upsert({ scopeId: GLOBAL_SCOPE, key: 'Dog', value: 'Called Biscuit', source: 'ui' })
    store.upsert({ scopeId: GLOBAL_SCOPE, key: 'Coffee', value: 'Flat white, oat milk', source: 'ui' })
    expect(store.list(GLOBAL_SCOPE).map((e) => e.key)).toEqual(['Coffee', 'Dog'])
    expect(store.list(GLOBAL_SCOPE, 'biscuit').map((e) => e.key)).toEqual(['Dog'])
    expect(store.list(GLOBAL_SCOPE, 'zzz')).toEqual([])
  })

  it('separates profile entries from relevance search and respects scopes', () => {
    store.saveProject({ id: 'p1', name: 'Proj', createdAt: 1 })
    store.upsert({ scopeId: GLOBAL_SCOPE, kind: 'profile', key: 'Home', value: 'London', source: 'user' })
    store.upsert({ scopeId: 'p1', kind: 'decision', key: 'TTS', value: 'Dropped Kokoro for Edge', source: 'agent' })
    store.upsert({ scopeId: GLOBAL_SCOPE, kind: 'fact', key: 'Kokoro note', value: 'Kokoro needed a resident model', source: 'agent' })
    expect(store.profile([GLOBAL_SCOPE, 'p1']).map((e) => e.key)).toEqual(['Home'])
    const hits = store.relevant('why did we drop kokoro', [GLOBAL_SCOPE, 'p1'])
    expect(hits.map((e) => e.key).sort()).toEqual(['Kokoro note', 'TTS'])
    expect(store.relevant('why did we drop kokoro', [GLOBAL_SCOPE]).map((e) => e.key)).toEqual(['Kokoro note'])
  })

  it('deletes entries and projects (with their scope and entries)', () => {
    store.saveProject({ id: 'p1', name: 'Proj', createdAt: 1 })
    const e = store.upsert({ scopeId: 'p1', key: 'k', value: 'v', source: 'ui' })
    store.delete(e.id)
    expect(store.get(e.id)).toBeUndefined()
    store.upsert({ scopeId: 'p1', key: 'k2', value: 'v', source: 'ui' })
    store.deleteProject('p1')
    expect(store.projects()).toEqual([])
    expect(store.scopes().map((s) => s.id)).toEqual([GLOBAL_SCOPE])
  })
})

describe('MemoryStore sessions and messages', () => {
  it('stores messages per session, replays them in order and searches other sessions only', () => {
    store.createSession({ id: 's1', title: 'One', projectId: GLOBAL_SCOPE, createdAt: 1, messageCount: 0 })
    store.createSession({ id: 's2', title: 'Two', projectId: GLOBAL_SCOPE, createdAt: 2, messageCount: 0 })
    store.saveMessage(msg({ sessionId: 's1', text: 'remember the gym closes at ten', createdAt: 10 }))
    store.saveMessage(msg({ sessionId: 's1', role: 'assistant', text: 'Noted, ten pm.', createdAt: 11 }))
    store.saveMessage(msg({ sessionId: 's2', text: 'unrelated question', createdAt: 12 }))
    expect(store.messages('s1').map((m) => m.text)).toEqual(['remember the gym closes at ten', 'Noted, ten pm.'])
    expect(store.sessions().map((s) => [s.id, s.messageCount])).toEqual([
      ['s2', 1],
      ['s1', 2]
    ])
    expect(store.searchHistory('gym closes', 's2').map((r) => r.sessionTitle)).toEqual(['One'])
    expect(store.searchHistory('gym closes', 's1')).toEqual([])
    // a min score high enough filters weak matches out; 0 keeps them; a zero limit returns nothing
    expect(store.searchHistory('gym closes', 's2', 8, 100)).toEqual([])
    expect(store.searchHistory('gym closes', 's2', 0)).toEqual([])
  })

  it('relevant() honours the min score and limit', () => {
    store.upsert({ scopeId: GLOBAL_SCOPE, kind: 'fact', key: 'Kokoro note', value: 'Kokoro needed a resident model', source: 'agent' })
    expect(store.relevant('kokoro', [GLOBAL_SCOPE], 6, 0)).toHaveLength(1)
    expect(store.relevant('kokoro', [GLOBAL_SCOPE], 6, 100)).toHaveLength(0)
    expect(store.relevant('kokoro', [GLOBAL_SCOPE], 0, 0)).toHaveLength(0)
  })

  it('updates a message in place on conflict and deletes sessions with messages', () => {
    store.createSession({ id: 's1', title: 'One', projectId: GLOBAL_SCOPE, createdAt: 1, messageCount: 0 })
    const m = msg({ sessionId: 's1', role: 'assistant', text: 'partial', streaming: true })
    store.saveMessage(m)
    store.saveMessage({ ...m, text: 'partial and complete', streaming: false })
    expect(store.messages('s1')).toHaveLength(1)
    expect(store.messages('s1')[0]?.text).toBe('partial and complete')
    store.renameSession('s1', 'Renamed')
    expect(store.sessions()[0]?.title).toBe('Renamed')
    store.deleteSession('s1')
    expect(store.sessions()).toEqual([])
    expect(store.messages('s1')).toEqual([])
  })
})
