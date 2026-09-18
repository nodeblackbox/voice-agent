import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { MemoryEntry, MemoryKind, PendingMemorySave } from '@shared/types'
import type { MemoryStore } from '../memory/store'

export interface MemoryToolDeps {
  store: MemoryStore
  scopeIds(): string[]
  activeScope(): string
  sessionId(): string
  confirmBeforeSave(): boolean
  requestConfirm(pending: PendingMemorySave): void
  changed(): void
}

const kindSchema = z.enum(['profile', 'fact', 'decision', 'todo'])

const line = (e: MemoryEntry): string => `${e.key}: ${e.value}`

export function memoryTools(deps: MemoryToolDeps): ToolSet {
  const resolve = (id: number | undefined, key: string | undefined): MemoryEntry | undefined => {
    if (id !== undefined) return deps.store.get(id)
    if (!key) return undefined
    for (const scope of deps.scopeIds()) {
      const hit = deps.store.findByKey(scope, key)
      if (hit) return hit
    }
    return undefined
  }

  return {
    remember: tool({
      description:
        'Save something NEW and stable about the user for future sessions: a preference, a fact about them, a decision they made, or a todo. Use kind "profile" for things that should always be in context (home location, preferred gym, the stack they work in). Never store guesses or one-off details. Write the corrected, canonical wording, not the raw transcript: speech recognition mangles names and technical terms, so if a word is clearly a mis-hearing of something you know ("edge TTS" heard as "HTTS", "Parakeet" as "parakeets"), save the correct form. If you cannot tell what a mangled term was meant to be, ask before saving rather than storing nonsense. To change or extend something already saved, use update_memory instead; never delete and re-save.',
      inputSchema: z.object({
        key: z.string().describe('Short label, e.g. "Preferred gym"'),
        value: z.string().describe('The fact itself, one sentence'),
        kind: kindSchema.default('fact'),
        tags: z.array(z.string()).default([]),
        scope: z.enum(['global', 'project']).default('global').describe('"project" only if it is specific to the active project')
      }),
      execute: async ({ key, value, kind, tags, scope }) => {
        const scopeId = scope === 'project' ? deps.activeScope() : 'global'
        if (deps.confirmBeforeSave()) {
          deps.requestConfirm({ id: crypto.randomUUID(), key, value, kind: kind as MemoryKind, tags, action: 'save' })
          return { status: 'pending', note: 'Queued; the user is being asked to confirm in the app. Do not mention the queue, just continue.' }
        }
        const existing = deps.store.findByKey(scopeId, key)
        const entry = deps.store.upsert({ scopeId, kind: kind as MemoryKind, key, value, tags, source: 'agent' })
        deps.changed()
        if (existing) return { status: 'updated', id: entry.id, before: line(existing), after: line(entry) }
        return { status: 'saved', id: entry.id }
      }
    }),
    update_memory: tool({
      description:
        'Change or extend a memory that already exists, keeping its history. Give the id (from recall) or the exact key. Use "append" to add a detail, "replace" to fix a phrase, or "value" to rewrite the whole entry. Returns the text before and after. Prefer this over forget + remember.',
      inputSchema: z.object({
        id: z.number().optional(),
        key: z.string().optional().describe('The entry key, when you do not have the id'),
        value: z.string().optional().describe('Rewrite the whole value'),
        append: z.string().optional().describe('Add this to the end of the value'),
        replace: z.object({ find: z.string(), with: z.string() }).optional().describe('Substitute one phrase inside the value'),
        tags: z.array(z.string()).optional(),
        kind: kindSchema.optional()
      }),
      execute: async ({ id, key, value, append, replace, tags, kind }) => {
        const target = resolve(id, key)
        if (!target) return { status: 'not_found', note: 'No such memory; use recall to find the id or key, or remember to create it.' }
        if (value === undefined && append === undefined && replace === undefined && tags === undefined && kind === undefined) return { status: 'no_change', note: 'Say what to change: value, append, replace or tags.' }
        try {
          const { before, after } = deps.store.update(target.id, { value, append, replace, tags, kind: kind as MemoryKind | undefined }, 'agent')
          deps.changed()
          return { status: 'updated', id: after.id, before: line(before), after: line(after) }
        } catch (e) {
          return { status: 'error', error: (e as Error).message, current: line(target) }
        }
      }
    }),
    recall: tool({
      description: 'Search saved memory (preferences, facts, decisions) by keywords. Returns ids you can pass to update_memory or forget.',
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => {
        const hits = deps.scopeIds().flatMap((s) => deps.store.list(s, query)).slice(0, 10)
        return hits.map((h) => ({ id: h.id, key: h.key, value: h.value, kind: h.kind, scope: h.scopeId }))
      }
    }),
    forget: tool({
      description: 'Ask the user to delete a memory entry by id (get the id from recall first). The user confirms in the app; nothing is deleted until they say yes. To change an entry, use update_memory instead.',
      inputSchema: z.object({ id: z.number() }),
      execute: async ({ id }) => {
        const existing = deps.store.get(id)
        if (!existing) return { status: 'not_found' }
        deps.requestConfirm({ id: crypto.randomUUID(), key: existing.key, value: existing.value, kind: existing.kind, tags: existing.tags, action: 'delete', entryId: existing.id })
        return { status: 'pending', key: existing.key, note: 'The user is being asked to confirm the deletion in the app. Do not mention the queue, just continue.' }
      }
    }),
    search_history: tool({
      description: 'Search what was said in earlier conversations (not this one).',
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) =>
        deps.store.searchHistory(query, deps.sessionId()).map((r) => ({
          when: new Date(r.createdAt).toISOString(),
          session: r.sessionTitle,
          role: r.role,
          text: r.text.slice(0, 400)
        }))
    })
  }
}
