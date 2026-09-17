import { useEffect, useState } from 'react'
import { Check, Clock, Copy, Pencil, Plus, Sparkles, Trash2, Wand2, X, Zap } from 'lucide-react'
import type { Skill } from '@shared/types'
import { T } from '../theme'
import { useStore } from '../state/store'
import { Btn, Card, Empty, Page, SectionTitle, TextInput, Toggle } from '../components/primitives'

type Draft = { name: string; trigger: string; procedure: string }

const EMPTY: Draft = { name: '', trigger: '', procedure: '' }

function SkillEditor({ initial, onSave, onCancel, saving }: { initial: Draft; onSave: (d: Draft) => void; onCancel: () => void; saving?: boolean }) {
  const [d, setD] = useState<Draft>(initial)
  const valid = d.name.trim() && d.trigger.trim() && d.procedure.trim()
  return (
    <div className="flex flex-col gap-2">
      <TextInput value={d.name} onChange={(v) => setD({ ...d, name: v })} placeholder="Name, e.g. Web research" autoFocus />
      <div className="flex flex-col gap-1">
        <SectionTitle>Trigger</SectionTitle>
        <TextInput value={d.trigger} onChange={(v) => setD({ ...d, trigger: v })} placeholder="When the user asks to find, check, or look up something current" />
      </div>
      <div className="flex flex-col gap-1">
        <SectionTitle>Procedure</SectionTitle>
        <textarea
          value={d.procedure}
          onChange={(e) => setD({ ...d, procedure: e.target.value })}
          rows={5}
          placeholder="What the agent should do, step by step, in the active prompt style."
          className="w-full rounded-lg p-3 text-sm resize-none"
          style={{ background: T.bg, color: T.text, border: `1px solid ${T.border}`, lineHeight: 1.55 }}
        />
      </div>
      <div className="flex gap-1.5 justify-end">
        <Btn small onClick={onCancel} icon={X}>
          Cancel
        </Btn>
        <Btn small primary onClick={() => onSave(d)} icon={Check} disabled={!valid || saving}>
          {saving ? 'Saving…' : 'Save'}
        </Btn>
      </div>
    </div>
  )
}

export function SkillsView() {
  const skills = useStore((s) => s.skills)
  const reloadSkills = useStore((s) => s.reloadSkills)
  const pushToast = useStore((s) => s.pushToast)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [brief, setBrief] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void reloadSkills()
  }, [reloadSkills])

  const save = async (skill: Skill) => {
    setSaving(true)
    try {
      await window.api.skills.save(skill)
      await reloadSkills()
    } catch (err) {
      pushToast('error', `Could not save skill: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSaving(false)
    }
  }

  const toggle = (s: Skill, on: boolean) => void save({ ...s, enabled: on })

  const saveEdited = async (s: Skill, d: Draft) => {
    const isBuiltIn = s.kind === 'built-in'
    const next: Skill = isBuiltIn
      ? { id: `custom-${Date.now()}`, kind: 'custom', enabled: s.enabled, name: d.name.trim().endsWith(' (copy)') ? d.name.trim() : `${d.name.trim()} (copy)`, trigger: d.trigger.trim(), procedure: d.procedure.trim() }
      : { ...s, name: d.name.trim(), trigger: d.trigger.trim(), procedure: d.procedure.trim() }
    await save(next)
    if (isBuiltIn) pushToast('info', `Saved as a custom copy: ${next.name}`)
    setEditingId(null)
  }

  const duplicate = (s: Skill) =>
    void save({ id: `custom-${Date.now()}`, kind: 'custom', enabled: s.enabled, name: `${s.name} (copy)`, trigger: s.trigger, procedure: s.procedure })

  const remove = async (s: Skill) => {
    await window.api.skills.delete(s.id)
    await reloadSkills()
  }

  const createNew = async (d: Draft) => {
    await save({ id: `custom-${Date.now()}`, kind: 'custom', enabled: true, name: d.name.trim(), trigger: d.trigger.trim(), procedure: d.procedure.trim() })
    setCreating(false)
    setDraft(null)
    setBrief('')
  }

  const generate = async () => {
    if (!brief.trim()) return
    setBusy(true)
    try {
      setDraft(await window.api.skills.generate(brief.trim()))
    } catch (err) {
      pushToast('error', `Could not draft a skill: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const on = skills.filter((s) => s.enabled).length

  return (
    <Page
      title="Skills"
      sub="Reusable instructions for how the agent handles a kind of task. Each has a trigger and a procedure; enabled skills are injected into the system prompt so the agent reads the matching one before acting."
      actions={
        <div className="flex gap-2">
          <Btn icon={Plus} primary onClick={() => setCreating(true)}>
            New skill
          </Btn>
        </div>
      }
    >
      <div className="text-xs" style={{ color: T.text3 }}>
        {on} of {skills.length} enabled
      </div>

      {creating && (
        <Card style={{ borderColor: T.cyanBorder }}>
          <div className="flex items-center gap-2 mb-3">
            <Zap size={14} style={{ color: T.cyan }} />
            <span className="text-sm font-medium">New skill</span>
          </div>
          <SkillEditor initial={EMPTY} onSave={(d) => void createNew(d)} onCancel={() => setCreating(false)} saving={saving} />
        </Card>
      )}

      <div className="grid grid-cols-2 gap-3">
        {skills.map((s) => (
          <Card key={s.id} className="va-fade">
            {editingId === s.id ? (
              <SkillEditor initial={{ name: s.name, trigger: s.trigger, procedure: s.procedure }} onSave={(d) => void saveEdited(s, d)} onCancel={() => setEditingId(null)} saving={saving} />
            ) : (
              <>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <Zap size={14} style={{ color: s.enabled ? T.violet : T.text3, flexShrink: 0 }} />
                    <span className="text-sm font-medium truncate" style={{ color: s.enabled ? T.text : T.text2 }}>
                      {s.name}
                    </span>
                    <span className="text-xs shrink-0" style={{ color: T.text3, fontFamily: T.mono }}>
                      {s.kind}
                    </span>
                  </div>
                  <Toggle on={s.enabled} onChange={(v) => toggle(s, v)} />
                </div>
                <div className="mt-3 flex flex-col gap-2">
                  <div className="flex flex-col gap-0.5">
                    <SectionTitle>Trigger</SectionTitle>
                    <span className="text-xs" style={{ color: T.text2, lineHeight: 1.5 }}>
                      {s.trigger}
                    </span>
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <SectionTitle>Procedure</SectionTitle>
                    <span className="text-xs" style={{ color: T.text2, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
                      {s.procedure}
                    </span>
                  </div>
                </div>
                <div className="flex gap-1 mt-3">
                  <Btn small icon={Pencil} onClick={() => setEditingId(s.id)}>
                    Edit
                  </Btn>
                  <Btn small icon={Copy} onClick={() => duplicate(s)}>
                    Duplicate
                  </Btn>
                  {s.kind === 'custom' && (
                    <Btn small danger icon={Trash2} onClick={() => void remove(s)}>
                      Delete
                    </Btn>
                  )}
                </div>
              </>
            )}
          </Card>
        ))}
        {skills.length === 0 && !creating && (
          <Card>
            <Empty>No skills yet. Create one, or let the agent draft one below.</Empty>
          </Card>
        )}
      </div>

      <Card style={{ borderColor: T.violetBorder }}>
        <div className="flex items-center gap-2 mb-2">
          <Wand2 size={14} style={{ color: T.violet }} />
          <span className="text-sm font-medium">Create a skill with AI</span>
        </div>
        <p className="text-xs mb-3" style={{ color: T.text2, lineHeight: 1.5, margin: 0 }}>
          Describe the situation and what you want done. The agent drafts a trigger and a procedure; you edit, then save.
        </p>
        <textarea
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          placeholder="e.g. When I mention a meeting, check the time zone difference before suggesting a slot and always say the time in both zones"
          rows={3}
          className="w-full rounded-lg p-3 text-sm resize-none"
          style={{ background: T.bg, color: T.text, border: `1px solid ${T.border}`, lineHeight: 1.5 }}
        />
        <div className="flex justify-end mt-2">
          <Btn primary icon={busy ? Clock : Sparkles} onClick={() => void generate()} disabled={busy || !brief.trim()}>
            {busy ? 'Drafting…' : 'Draft skill'}
          </Btn>
        </div>
        {draft && (
          <div className="mt-3 rounded-lg p-3 flex flex-col gap-2" style={{ background: T.bg, border: `1px solid ${T.border}` }}>
            <span className="text-xs" style={{ color: T.violet }}>
              Draft
            </span>
            <SkillEditor
              key={`${draft.name}-${draft.trigger}`}
              initial={draft}
              onSave={(d) => void createNew(d)}
              onCancel={() => setDraft(null)}
              saving={saving}
            />
            <div className="flex justify-end">
              <Btn small onClick={() => void generate()} icon={Sparkles} disabled={busy}>
                Regenerate
              </Btn>
            </div>
          </div>
        )}
      </Card>
    </Page>
  )
}
