import { DatabaseSync } from 'node:sqlite'
import type { ChatMessage, MemoryEntry, MemoryKind, MemoryScope, Project, Session } from '@shared/types'
import { DEFAULT_TUNING } from '@shared/tuning'

export const GLOBAL_SCOPE = 'global'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS scopes(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS projects(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT, default_style_id TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS entries(
  id INTEGER PRIMARY KEY AUTOINCREMENT, scope_id TEXT NOT NULL, kind TEXT NOT NULL,
  key TEXT NOT NULL, value TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '', source TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS entries_scope ON entries(scope_id, kind);
CREATE VIRTUAL TABLE IF NOT EXISTS entries_fts USING fts5(key, value, tags, content='entries', content_rowid='id');
CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
  INSERT INTO entries_fts(rowid, key, value, tags) VALUES (new.id, new.key, new.value, new.tags); END;
CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, key, value, tags) VALUES ('delete', old.id, old.key, old.value, old.tags); END;
CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
  INSERT INTO entries_fts(entries_fts, rowid, key, value, tags) VALUES ('delete', old.id, old.key, old.value, old.tags);
  INSERT INTO entries_fts(rowid, key, value, tags) VALUES (new.id, new.key, new.value, new.tags); END;
CREATE TABLE IF NOT EXISTS sessions(
  id TEXT PRIMARY KEY, title TEXT NOT NULL, project_id TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS messages(
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, turn_id TEXT NOT NULL, role TEXT NOT NULL,
  text TEXT NOT NULL, json TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id, created_at);
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(text, content='messages', content_rowid='rowid');
CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text); END;
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text); END;
CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  INSERT INTO messages_fts(rowid, text) VALUES (new.rowid, new.text); END;
`

type EntryRow = {
  id: number
  scope_id: string
  kind: string
  key: string
  value: string
  tags: string
  source: string
  created_at: number
  updated_at: number
}

const STOPWORDS = new Set(
  'a an the and or but if then so of to in on at for with by from as is are was were be been it this that these those i you we they he she my your our their me us them what when where which who how why do does did can could would should will just like about into over under up down out not no yes'.split(' ')
)

export function ftsQuery(text: string, maxTerms = 8): string | null {
  const words = (text.toLowerCase().match(/[a-z0-9']{3,}/g) ?? []).filter((w) => !STOPWORDS.has(w))
  const unique = [...new Set(words)].slice(0, maxTerms)
  if (!unique.length) return null
  return unique.map((w) => `"${w.replaceAll('"', '')}"`).join(' OR ')
}

const toEntry = (r: EntryRow): MemoryEntry => ({
  id: r.id,
  scopeId: r.scope_id,
  kind: r.kind as MemoryKind,
  key: r.key,
  value: r.value,
  tags: r.tags ? r.tags.split(',').filter(Boolean) : [],
  source: r.source as MemoryEntry['source'],
  createdAt: r.created_at,
  updatedAt: r.updated_at
})

export class MemoryStore {
  private db: DatabaseSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec(SCHEMA)
    this.ensureScope(GLOBAL_SCOPE, 'Global')
  }

  close(): void {
    this.db.close()
  }

  // ---- scopes / projects ------------------------------------------------------------------
  ensureScope(id: string, name: string): void {
    this.db
      .prepare('INSERT INTO scopes(id, name, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name')
      .run(id, name, Date.now())
  }

  scopes(): MemoryScope[] {
    const rows = this.db
      .prepare(
        `SELECT s.id, s.name, (SELECT COUNT(*) FROM entries e WHERE e.scope_id = s.id) AS count
         FROM scopes s ORDER BY CASE WHEN s.id = ? THEN 0 ELSE 1 END, s.name`
      )
      .all(GLOBAL_SCOPE) as Array<{ id: string; name: string; count: number }>
    return rows
  }

  projects(): Project[] {
    const rows = this.db.prepare('SELECT * FROM projects ORDER BY created_at').all() as Array<{
      id: string
      name: string
      path: string | null
      default_style_id: string | null
      created_at: number
    }>
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      path: r.path ?? undefined,
      defaultStyleId: r.default_style_id ?? undefined,
      createdAt: r.created_at
    }))
  }

  saveProject(p: Project): void {
    this.db
      .prepare(
        `INSERT INTO projects(id, name, path, default_style_id, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, path = excluded.path, default_style_id = excluded.default_style_id`
      )
      .run(p.id, p.name, p.path ?? null, p.defaultStyleId ?? null, p.createdAt)
    this.ensureScope(p.id, p.name)
  }

  deleteProject(id: string): void {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id)
    this.db.prepare('DELETE FROM entries WHERE scope_id = ?').run(id)
    this.db.prepare('DELETE FROM scopes WHERE id = ?').run(id)
  }

  // ---- entries ----------------------------------------------------------------------------
  list(scopeId: string, query?: string): MemoryEntry[] {
    const q = query ? ftsQuery(query) : null
    if (q) {
      const rows = this.db
        .prepare(
          `SELECT e.* FROM entries_fts f JOIN entries e ON e.id = f.rowid
           WHERE entries_fts MATCH ? AND e.scope_id = ? ORDER BY bm25(entries_fts) LIMIT 100`
        )
        .all(q, scopeId) as EntryRow[]
      return rows.map(toEntry)
    }
    const rows = this.db.prepare('SELECT * FROM entries WHERE scope_id = ? ORDER BY updated_at DESC').all(scopeId) as EntryRow[]
    return rows.map(toEntry)
  }

  get(id: number): MemoryEntry | undefined {
    const row = this.db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as EntryRow | undefined
    return row ? toEntry(row) : undefined
  }

  upsert(e: {
    id?: number
    scopeId: string
    kind?: MemoryKind
    key: string
    value: string
    tags?: string[]
    source: MemoryEntry['source']
  }): MemoryEntry {
    const now = Date.now()
    const tags = (e.tags ?? []).map((t) => t.trim()).filter(Boolean).join(',')
    const kind = e.kind ?? 'fact'
    if (e.id) {
      this.db
        .prepare('UPDATE entries SET scope_id = ?, kind = ?, key = ?, value = ?, tags = ?, updated_at = ? WHERE id = ?')
        .run(e.scopeId, kind, e.key, e.value, tags, now, e.id)
      return this.get(e.id)!
    }
    const existing = this.db
      .prepare('SELECT id FROM entries WHERE scope_id = ? AND lower(key) = lower(?)')
      .get(e.scopeId, e.key) as { id: number } | undefined
    if (existing) {
      this.db
        .prepare('UPDATE entries SET kind = ?, value = ?, tags = ?, source = ?, updated_at = ? WHERE id = ?')
        .run(kind, e.value, tags, e.source, now, existing.id)
      return this.get(existing.id)!
    }
    const res = this.db
      .prepare('INSERT INTO entries(scope_id, kind, key, value, tags, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(e.scopeId, kind, e.key, e.value, tags, e.source, now, now)
    return this.get(Number(res.lastInsertRowid))!
  }

  delete(id: number): void {
    this.db.prepare('DELETE FROM entries WHERE id = ?').run(id)
  }

  profile(scopeIds: string[], limit: number = DEFAULT_TUNING.memory.profileLimit): MemoryEntry[] {
    if (limit <= 0) return []
    const marks = scopeIds.map(() => '?').join(',')
    const rows = this.db
      .prepare(`SELECT * FROM entries WHERE kind = 'profile' AND scope_id IN (${marks}) ORDER BY updated_at DESC LIMIT ?`)
      .all(...scopeIds, limit) as EntryRow[]
    return rows.map(toEntry)
  }

  /** BM25 hits for `text`. `minScore` is a floor on |bm25| (FTS5 ranks are negative, lower = better); 0 disables it. */
  relevant(text: string, scopeIds: string[], limit: number = DEFAULT_TUNING.memory.relevantLimit, minScore = 0): MemoryEntry[] {
    const q = ftsQuery(text)
    if (!q || limit <= 0) return []
    const marks = scopeIds.map(() => '?').join(',')
    const rows = this.db
      .prepare(
        `SELECT e.*, bm25(entries_fts) AS rank FROM entries_fts f JOIN entries e ON e.id = f.rowid
         WHERE entries_fts MATCH ? AND e.scope_id IN (${marks}) AND e.kind != 'profile'
           AND (? <= 0 OR -bm25(entries_fts) >= ?)
         ORDER BY rank LIMIT ?`
      )
      .all(q, ...scopeIds, minScore, minScore, limit) as Array<EntryRow & { rank: number }>
    return rows.map(toEntry)
  }

  // ---- sessions / messages ----------------------------------------------------------------
  createSession(s: Session): void {
    this.db.prepare('INSERT INTO sessions(id, title, project_id, created_at) VALUES (?, ?, ?, ?)').run(s.id, s.title, s.projectId, s.createdAt)
  }

  renameSession(id: string, title: string): void {
    this.db.prepare('UPDATE sessions SET title = ? WHERE id = ?').run(title, id)
  }

  deleteSession(id: string): void {
    this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(id)
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
  }

  sessions(): Session[] {
    const rows = this.db
      .prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS message_count
         FROM sessions s ORDER BY s.created_at DESC LIMIT 200`
      )
      .all() as Array<{ id: string; title: string; project_id: string; created_at: number; message_count: number }>
    return rows.map((r) => ({ id: r.id, title: r.title, projectId: r.project_id, createdAt: r.created_at, messageCount: r.message_count }))
  }

  saveMessage(m: ChatMessage): void {
    this.db
      .prepare(
        `INSERT INTO messages(id, session_id, turn_id, role, text, json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET text = excluded.text, json = excluded.json`
      )
      .run(m.id, m.sessionId, m.turnId, m.role, m.text, JSON.stringify(m), m.createdAt)
  }

  deleteMessage(id: string): void {
    this.db.prepare('DELETE FROM messages WHERE id = ?').run(id)
  }

  messages(sessionId: string): ChatMessage[] {
    const rows = this.db.prepare('SELECT json FROM messages WHERE session_id = ? ORDER BY created_at, rowid').all(sessionId) as Array<{ json: string }>
    return rows.map((r) => JSON.parse(r.json) as ChatMessage)
  }

  /** Past messages matching `query`, other sessions only. `minScore` is a floor on |bm25| (0 = off). */
  searchHistory(query: string, excludeSessionId: string | null, limit = 8, minScore = 0): Array<{ text: string; role: string; createdAt: number; sessionTitle: string }> {
    const q = ftsQuery(query)
    if (!q || limit <= 0) return []
    const rows = this.db
      .prepare(
        `SELECT m.text, m.role, m.created_at, s.title FROM messages_fts f
         JOIN messages m ON m.rowid = f.rowid JOIN sessions s ON s.id = m.session_id
         WHERE messages_fts MATCH ? AND m.role IN ('user', 'assistant') AND (? IS NULL OR m.session_id != ?)
           AND (? <= 0 OR -bm25(messages_fts) >= ?)
         ORDER BY bm25(messages_fts) LIMIT ?`
      )
      .all(q, excludeSessionId, excludeSessionId, minScore, minScore, limit) as Array<{ text: string; role: string; created_at: number; title: string }>
    return rows.map((r) => ({ text: r.text, role: r.role, createdAt: r.created_at, sessionTitle: r.title }))
  }
}
