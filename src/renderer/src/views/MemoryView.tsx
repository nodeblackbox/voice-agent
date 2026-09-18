import { useCallback, useEffect, useState } from 'react'
import { BookOpen, Check, History, Pencil, Plus, RotateCcw, Search, Tag as TagIcon, Trash2, X } from 'lucide-react'
import type { MemoryEntry, MemoryHistoryEntry, MemoryKind, MemoryScope } from '@shared/types'
import { T } from '../theme'
import { useStore } from '../state/store'
import { Btn, Card, Empty, IconBtn, Page, Select, Tag, TextInput } from '../components/primitives'

const KINDS: Array<{ id: MemoryKind; label: string }> = [
  { id: 'profile', label: 'Profile' },
  { id: 'fact', label: 'Fact' },
  { id: 'decision', label: 'Decision' },
  { id: 'todo', label: 'To do' }
]

interface Form {
  id?: number
  key: string
  value: string
  kind: MemoryKind
  tags: string
}

const emptyForm = (): Form => ({ key: '', value: '', kind: 'fact', tags: '' })

const when = (ms: number): string => new Date(ms).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' })

function HistoryList({ entryId, scopeId, onChanged }: { entryId: number; scopeId: string; onChanged: () => void }) {
  const [rows, setRows] = useState<MemoryHistoryEntry[] | null>(null)
  const load = useCallback(async () => setRows(await window.api.memory.history(entryId)), [entryId])
  useEffect(() => {
    void load()
  }, [load])
  if (!rows) return null
  if (!rows.length) return <Empty>No history for this entry.</Empty>
  return (
    <div className="flex flex-col gap-1 px-4 pb-3">
      {rows.map((h) => (
        <div key={h.id} className="flex items-start gap-3 text-xs py-1.5" style={{ borderTop: `1px solid ${T.border}` }}>
          <span style={{ color: T.text3, fontFamily: T.mono, width: 120, flexShrink: 0 }}>
            {when(h.at)}
            <br />
            {h.source}
          </span>
          <span className="flex-1 min-w-0" style={{ lineHeight: 1.5 }}>
            {h.before ? (
              <span style={{ color: T.red, textDecoration: 'line-through', wordBreak: 'break-word' }}>{h.before.value}</span>
            ) : (
              <span style={{ color: T.text3 }}>(created)</span>
            )}
            <br />
            {h.after ? <span style={{ color: T.green, wordBreak: 'break-word' }}>{h.after.value}</span> : <span style={{ color: T.text3 }}>(deleted)</span>}
          </span>
          <Btn
            small
            icon={RotateCcw}
            onClick={() => {
              void window.api.memory.undo(h.id, scopeId).then(() => {
                onChanged()
                void load()
              })
            }}
          >
            Undo
          </Btn>
        </div>
      ))}
    </div>
  )
}

function EntryForm({ initial, onSave, onCancel }: { initial: Form; onSave: (f: Form) => void; onCancel: () => void }) {
  const [f, setF] = useState<Form>(initial)
  const valid = f.key.trim() && f.value.trim()
  return (
    <div className="flex flex-col gap-2 px-4 py-3" style={{ background: T.raised, borderBottom: `1px solid ${T.border}` }}>
      <div className="flex gap-2">
        <TextInput value={f.key} onChange={(v) => setF({ ...f, key: v })} placeholder="Key (e.g. Preferred gym)" autoFocus />
        <Select value={f.kind} onChange={(v) => setF({ ...f, kind: v as MemoryKind })} options={KINDS} width={130} />
      </div>
      <TextInput value={f.value} onChange={(v) => setF({ ...f, value: v })} placeholder="Value" />
      <div className="flex gap-2 items-center">
        <TextInput value={f.tags} onChange={(v) => setF({ ...f, tags: v })} placeholder="tags, comma separated" mono />
        <Btn small onClick={onCancel} icon={X}>
          Cancel
        </Btn>
        <Btn small primary disabled={!valid} onClick={() => onSave(f)} icon={Check}>
          Save
        </Btn>
      </div>
    </div>
  )
}

export function MemoryView() {
  const memoryVersion = useStore((s) => s.memoryVersion)
  const pushToast = useStore((s) => s.pushToast)
  const [scopes, setScopes] = useState<MemoryScope[]>([])
  const [scopeId, setScopeId] = useState<string>('global')
  const [q, setQ] = useState('')
  const [entries, setEntries] = useState<MemoryEntry[]>([])
  const [editing, setEditing] = useState<Form | null>(null)
  const [historyFor, setHistoryFor] = useState<number | null>(null)

  const load = useCallback(async () => {
    const s = await window.api.memory.scopes()
    setScopes(s)
    const list = await window.api.memory.list(scopeId, q || undefined)
    setEntries(list)
  }, [scopeId, q])

  useEffect(() => {
    void load()
  }, [load, memoryVersion])

  const save = async (f: Form) => {
    try {
      await window.api.memory.upsert({
        id: f.id,
        scopeId,
        key: f.key.trim(),
        value: f.value.trim(),
        kind: f.kind,
        tags: f.tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
        source: 'ui'
      })
      setEditing(null)
      await load()
    } catch (err) {
      pushToast('error', `Could not save: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const remove = async (id: number) => {
    await window.api.memory.delete(id)
    setHistoryFor(null)
    await load()
    pushToast('info', 'Deleted. A deleted entry can be restored from the history of any entry that changed it, or by undoing in the Memory tool pill.')
  }

  const scopeName = scopes.find((s) => s.id === scopeId)?.name ?? scopeId

  return (
    <Page
      title="Memory"
      sub="A notebook per scope. Global applies everywhere; project notebooks only load when that project is active."
      actions={
        <Btn primary icon={Plus} onClick={() => setEditing(emptyForm())}>
          Add entry
        </Btn>
      }
    >
      <div className="grid gap-4" style={{ gridTemplateColumns: '220px 1fr' }}>
        <div className="flex flex-col gap-1">
          {scopes.map((s) => (
            <button
              key={s.id}
              onClick={() => setScopeId(s.id)}
              className="text-left rounded-lg px-3 py-2 flex items-center gap-2"
              style={{ background: scopeId === s.id ? T.raised : 'transparent', border: 'none', cursor: 'pointer', color: scopeId === s.id ? T.text : T.text2 }}
            >
              <BookOpen size={14} style={{ color: s.id === 'global' ? T.cyan : T.violet }} />
              <span className="text-sm truncate">{s.name}</span>
              <span className="text-xs ml-auto" style={{ color: T.text3, fontFamily: T.mono }}>
                {s.count}
              </span>
            </button>
          ))}
        </div>
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 rounded-lg px-3" style={{ height: 34, background: T.surface, border: `1px solid ${T.border}` }}>
            <Search size={13} style={{ color: T.text3 }} />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={`Search ${scopeName}`}
              className="flex-1 bg-transparent text-sm"
              style={{ color: T.text, border: 'none' }}
            />
          </div>
          <Card pad={0}>
            {editing && editing.id === undefined && <EntryForm initial={editing} onSave={(f) => void save(f)} onCancel={() => setEditing(null)} />}
            {entries.map((e, i) =>
              editing?.id === e.id ? (
                <EntryForm key={e.id} initial={editing} onSave={(f) => void save(f)} onCancel={() => setEditing(null)} />
              ) : (
                <div key={e.id} style={{ borderBottom: i < entries.length - 1 ? `1px solid ${T.border}` : 'none' }}>
                  <div className="flex items-start gap-3 px-4 py-3">
                    <div className="flex flex-col gap-0.5 flex-1 min-w-0">
                      <span className="text-xs" style={{ color: T.text3 }}>
                        {e.key}
                        <span style={{ fontFamily: T.mono }}> · {e.kind}</span>
                      </span>
                      <span className="text-sm" style={{ wordBreak: 'break-word' }}>
                        {e.value}
                      </span>
                    </div>
                    <div className="flex gap-1 items-center flex-wrap justify-end" style={{ maxWidth: 220 }}>
                      {e.tags.map((t) => (
                        <Tag key={t}>
                          <TagIcon size={9} />
                          {t}
                        </Tag>
                      ))}
                      <Tag>{e.source}</Tag>
                    </div>
                    <div className="flex gap-0.5">
                      <IconBtn icon={History} label="History" size={13} w={26} active={historyFor === e.id} onClick={() => setHistoryFor(historyFor === e.id ? null : e.id)} />
                      <IconBtn
                        icon={Pencil}
                        label="Edit"
                        size={13}
                        w={26}
                        onClick={() => setEditing({ id: e.id, key: e.key, value: e.value, kind: e.kind, tags: e.tags.join(', ') })}
                      />
                      <IconBtn icon={Trash2} label="Delete" size={13} w={26} onClick={() => void remove(e.id)} />
                    </div>
                  </div>
                  {historyFor === e.id && <HistoryList entryId={e.id} scopeId={scopeId} onChanged={() => void load()} />}
                </div>
              )
            )}
            {entries.length === 0 && !editing && <Empty>{q ? `Nothing in ${scopeName} matches "${q}".` : `Nothing in ${scopeName} yet.`}</Empty>}
          </Card>
        </div>
      </div>
    </Page>
  )
}
