import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { MemoryKind, PendingMemorySave } from '@shared/types'
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

export function memoryTools(deps: MemoryToolDeps): ToolSet {
  return {
    remember: tool({
      description:
        'Save something stable about the user for future sessions: a preference, a fact about them, a decision they made, or a todo. Use kind "profile" for things that should always be in context (home location, preferred gym, the stack they work in). Never store guesses or one-off details. Write the corrected, canonical wording, not the raw transcript: speech recognition mangles names and technical terms, so if a word is clearly a mis-hearing of something you know ("edge TTS" heard as "HTTS", "Parakeet" as "parakeets"), save the correct form. If you cannot tell what a mangled term was meant to be, ask before saving rather than storing nonsense. Saving with an existing key overwrites it, which is how you correct a wrong entry.',
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
          deps.requestConfirm({ id: crypto.randomUUID(), key, value, kind: kind as MemoryKind, tags })
          return { status: 'pending', note: 'Queued; the user is being asked to confirm in the app. Do not mention the queue, just continue.' }
        }
        const entry = deps.store.upsert({ scopeId, kind: kind as MemoryKind, key, value, tags, source: 'agent' })
        deps.changed()
        return { status: 'saved', id: entry.id }
      }
    }),
    recall: tool({
      description: 'Search saved memory (preferences, facts, decisions) by keywords.',
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => {
        const hits = deps.scopeIds().flatMap((s) => deps.store.list(s, query)).slice(0, 10)
        return hits.map((h) => ({ id: h.id, key: h.key, value: h.value, kind: h.kind, scope: h.scopeId }))
      }
    }),
    forget: tool({
      description: 'Delete a memory entry by id (get the id from recall first).',
      inputSchema: z.object({ id: z.number() }),
      execute: async ({ id }) => {
        const existing = deps.store.get(id)
        if (!existing) return { status: 'not_found' }
        deps.store.delete(id)
        deps.changed()
        return { status: 'deleted', key: existing.key }
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
