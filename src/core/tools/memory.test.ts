import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tool } from 'ai'
import type { PendingMemorySave } from '@shared/types'
import { GLOBAL_SCOPE, MemoryStore } from '../memory/store'
import { memoryTools } from './memory'

let dir: string
let store: MemoryStore
let pending: PendingMemorySave[]
let tools: ReturnType<typeof memoryTools>

const run = async (name: string, input: unknown): Promise<Record<string, unknown>> => {
  const t = tools[name] as Tool & { execute: (input: unknown, opts: unknown) => Promise<unknown> }
  return (await t.execute(input, { toolCallId: 'c', messages: [] })) as Record<string, unknown>
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'va-memtool-'))
  store = new MemoryStore(join(dir, 'm.sqlite'))
  pending = []
  tools = memoryTools({
    store,
    scopeIds: () => [GLOBAL_SCOPE],
    activeScope: () => GLOBAL_SCOPE,
    sessionId: () => 's1',
    confirmBeforeSave: () => false,
    requestConfirm: (p) => pending.push(p),
    changed: vi.fn()
  })
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('memory tools', () => {
  it('update_memory appends, replaces and reports before/after; remember over a key reports the change', async () => {
    const saved = await run('remember', { key: 'Karate AI', value: 'Uses SAM 3D for poses', kind: 'decision', tags: [], scope: 'global' })
    expect(saved).toMatchObject({ status: 'saved' })
    const id = saved.id as number
    const appended = await run('update_memory', { id, append: 'voice commands play the matching segment' })
    expect(appended).toMatchObject({ status: 'updated', before: 'Karate AI: Uses SAM 3D for poses', after: 'Karate AI: Uses SAM 3D for poses. voice commands play the matching segment' })
    const byKey = await run('update_memory', { key: 'karate ai', replace: { find: 'SAM 3D', with: 'SAM 3' } })
    expect((byKey.after as string).includes('SAM 3 for')).toBe(true)
    const again = await run('remember', { key: 'Karate AI', value: 'Rewritten', kind: 'decision', tags: [], scope: 'global' })
    expect(again).toMatchObject({ status: 'updated', before: expect.stringContaining('SAM 3 for'), after: 'Karate AI: Rewritten' })
    expect(store.history(id)).toHaveLength(4)
  })

  it('update_memory explains missing entries and empty patches', async () => {
    expect(await run('update_memory', { key: 'nope', append: 'x' })).toMatchObject({ status: 'not_found' })
    const saved = await run('remember', { key: 'A', value: 'b', kind: 'fact', tags: [], scope: 'global' })
    expect(await run('update_memory', { id: saved.id })).toMatchObject({ status: 'no_change' })
    expect(await run('update_memory', { id: saved.id, replace: { find: 'zzz', with: 'y' } })).toMatchObject({ status: 'error', current: 'A: b' })
  })

  it('forget never deletes on its own: it asks the user', async () => {
    const saved = await run('remember', { key: 'Gym', value: 'E&C', kind: 'profile', tags: [], scope: 'global' })
    const r = await run('forget', { id: saved.id })
    expect(r).toMatchObject({ status: 'pending', key: 'Gym' })
    expect(store.get(saved.id as number)).toBeDefined()
    expect(pending[0]).toMatchObject({ action: 'delete', entryId: saved.id, key: 'Gym' })
    expect(await run('forget', { id: 999 })).toEqual({ status: 'not_found' })
  })
})
