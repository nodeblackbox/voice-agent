import { useEffect, useState } from 'react'
import { Check, Clock, PenLine, Sparkles, Trash2, Volume2, Wand2 } from 'lucide-react'
import type { PromptStyle, StyleDraft, StyleFormat, StyleLength } from '@shared/types'
import { T } from '../theme'
import { useStore } from '../state/store'
import { Btn, Card, Page, Select, TextInput } from '../components/primitives'

const LENGTHS: Array<{ id: StyleLength; label: string }> = [
  { id: 'short', label: 'Short' },
  { id: 'balanced', label: 'Balanced' },
  { id: 'comprehensive', label: 'Comprehensive' }
]
const FORMATS: Array<{ id: StyleFormat; label: string }> = [
  { id: 'plain', label: 'Plain spoken' },
  { id: 'markdown', label: 'Markdown allowed' }
]

type Draft = StyleDraft

function RefineWithAI({ edit, onApply }: { edit: PromptStyle; onApply: (body: string) => void }) {
  const pushToast = useStore((s) => s.pushToast)
  const [instruction, setInstruction] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)

  const refine = async () => {
    if (!instruction.trim()) return
    setBusy(true)
    try {
      setDraft(await window.api.styles.generate(instruction.trim(), { label: edit.label, body: edit.body }))
    } catch (err) {
      pushToast('error', `Could not refine the prompt: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-3 rounded-lg p-3 flex flex-col gap-2" style={{ background: T.bg, border: `1px solid ${T.border}` }}>
      <div className="flex items-center gap-2">
        <PenLine size={13} style={{ color: T.violet }} />
        <span className="text-xs font-medium">Refine with AI</span>
        <span className="text-xs" style={{ color: T.text3 }}>
          tell it what to change about this prompt
        </span>
      </div>
      <textarea
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
        placeholder="e.g. stop apologising, never say 'great question', and always end with the one thing I should do next"
        rows={2}
        className="w-full rounded-lg p-2.5 text-sm resize-none"
        style={{ background: T.surface, color: T.text, border: `1px solid ${T.border}`, lineHeight: 1.5 }}
      />
      <div className="flex justify-end">
        <Btn small primary icon={busy ? Clock : Sparkles} onClick={() => void refine()} disabled={busy || !instruction.trim()}>
          {busy ? 'Rewriting…' : 'Rewrite prompt'}
        </Btn>
      </div>
      {draft && (
        <div className="flex flex-col gap-2 va-fade">
          <div className="grid gap-2" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <div className="flex flex-col gap-1">
              <span className="text-xs" style={{ color: T.text3 }}>
                Current
              </span>
              <pre className="text-xs rounded-lg p-2 overflow-auto" style={{ background: T.surface, color: T.text3, margin: 0, maxHeight: 220, whiteSpace: 'pre-wrap', fontFamily: T.mono, lineHeight: 1.5 }}>
                {edit.body}
              </pre>
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-xs" style={{ color: T.violet }}>
                Proposed
              </span>
              <textarea
                value={draft.body}
                onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                className="text-xs rounded-lg p-2 resize-none"
                rows={10}
                style={{ background: T.surface, color: T.text, border: `1px solid ${T.violetBorder}`, fontFamily: T.mono, lineHeight: 1.5 }}
              />
            </div>
          </div>
          <div className="flex gap-1.5 justify-end">
            <Btn small onClick={() => setDraft(null)}>
              Discard
            </Btn>
            <Btn small onClick={() => void refine()} icon={Sparkles} disabled={busy}>
              Regenerate
            </Btn>
            <Btn
              small
              primary
              icon={Check}
              onClick={() => {
                onApply(draft.body)
                setDraft(null)
                setInstruction('')
              }}
            >
              Apply to editor
            </Btn>
          </div>
        </div>
      )}
    </div>
  )
}

export function PromptsView() {
  const styles = useStore((s) => s.styles)
  const settings = useStore((s) => s.settings)
  const updateSettings = useStore((s) => s.updateSettings)
  const reloadStyles = useStore((s) => s.reloadStyles)
  const pushToast = useStore((s) => s.pushToast)

  const [selId, setSelId] = useState<string | null>(null)
  const [edit, setEdit] = useState<PromptStyle | null>(null)
  const [brief, setBrief] = useState('')
  const [generated, setGenerated] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)

  const sel = styles.find((s) => s.id === selId) ?? styles[0]
  useEffect(() => {
    if (sel && (!edit || edit.id !== sel.id)) setEdit({ ...sel })
  }, [sel, edit])

  const dirty = sel && edit ? JSON.stringify(sel) !== JSON.stringify(edit) : false

  const save = async () => {
    if (!edit) return
    const isBuiltIn = edit.kind === 'built-in'
    const toSave: PromptStyle = isBuiltIn
      ? { ...edit, id: `custom-${Date.now()}`, kind: 'custom', label: edit.label.endsWith(' (copy)') ? edit.label : `${edit.label} (copy)` }
      : edit
    await window.api.styles.save(toSave)
    await reloadStyles()
    setSelId(toSave.id)
    setEdit(null)
    pushToast('info', isBuiltIn ? `Saved as a custom copy: ${toSave.label}` : `Saved ${toSave.label}`)
  }

  const remove = async (id: string) => {
    await window.api.styles.delete(id)
    await reloadStyles()
    setSelId(null)
    setEdit(null)
  }

  const generate = async () => {
    if (!brief.trim()) return
    setBusy(true)
    try {
      setGenerated(await window.api.styles.generate(brief.trim()))
    } catch (err) {
      pushToast('error', `Could not draft a style: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const accept = async () => {
    if (!generated) return
    const style: PromptStyle = {
      id: `custom-${Date.now()}`,
      kind: 'custom',
      label: generated.label,
      desc: generated.desc,
      body: generated.body,
      length: 'balanced',
      format: 'plain'
    }
    await window.api.styles.save(style)
    await reloadStyles()
    setSelId(style.id)
    setEdit(null)
    setGenerated(null)
    setBrief('')
  }

  return (
    <Page title="Prompt styles" sub="Each style is a full system prompt for how the agent speaks. Pick one from the input bar, or make a new one here.">
      <div className="grid gap-4" style={{ gridTemplateColumns: '280px 1fr' }}>
        <div className="flex flex-col gap-2">
          {styles.map((p) => (
            <Card key={p.id} pad={12} active={sel?.id === p.id} onClick={() => setSelId(p.id)}>
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{p.label}</span>
                {settings?.styleId === p.id && (
                  <span className="text-xs" style={{ color: T.cyan }}>
                    active
                  </span>
                )}
              </div>
              <div className="text-xs mt-1" style={{ color: T.text3, lineHeight: 1.4 }}>
                {p.desc}
              </div>
              <div className="text-xs mt-2" style={{ color: T.text3, fontFamily: T.mono }}>
                {p.kind} · {p.length} · {p.format}
              </div>
            </Card>
          ))}
        </div>

        <div className="flex flex-col gap-4">
          {sel && edit && (
            <Card>
              <div className="flex items-center justify-between mb-3 gap-2">
                <TextInput value={edit.label} onChange={(v) => setEdit({ ...edit, label: v })} style={{ maxWidth: 260 }} />
                <div className="flex gap-1.5">
                  {settings?.styleId !== sel.id && (
                    <Btn small primary onClick={() => void updateSettings({ styleId: sel.id })} icon={Check}>
                      Use this style
                    </Btn>
                  )}
                  <Btn small icon={Volume2} onClick={() => void window.api.speak.preview(settings?.voice.voice ?? 'en-US-AvaNeural')}>
                    Preview voice
                  </Btn>
                  {sel.kind === 'custom' && <Btn small danger icon={Trash2} onClick={() => void remove(sel.id)} />}
                </div>
              </div>
              <div className="flex flex-col gap-2 mb-3">
                <TextInput value={edit.desc} onChange={(v) => setEdit({ ...edit, desc: v })} placeholder="One-line description shown in the picker" />
                <div className="flex gap-2 items-center">
                  <span className="text-xs" style={{ color: T.text3 }}>
                    Length
                  </span>
                  <Select value={edit.length} onChange={(v) => setEdit({ ...edit, length: v as StyleLength })} options={LENGTHS} />
                  <span className="text-xs ml-2" style={{ color: T.text3 }}>
                    Format
                  </span>
                  <Select value={edit.format} onChange={(v) => setEdit({ ...edit, format: v as StyleFormat })} options={FORMATS} />
                </div>
              </div>
              <textarea
                value={edit.body}
                onChange={(e) => setEdit({ ...edit, body: e.target.value })}
                rows={9}
                className="w-full rounded-lg p-3 text-sm resize-none"
                style={{ background: T.bg, color: T.text, border: `1px solid ${T.border}`, lineHeight: 1.6, fontFamily: T.mono }}
              />
              <div className="flex justify-between items-center mt-2">
                <span className="text-xs" style={{ color: T.text3 }}>
                  {sel.kind === 'built-in' ? 'Built-in styles save as a custom copy.' : ''}
                </span>
                <div className="flex gap-1.5">
                  {dirty && (
                    <Btn small onClick={() => setEdit({ ...sel })}>
                      Revert
                    </Btn>
                  )}
                  <Btn small primary disabled={!dirty} onClick={() => void save()} icon={Check}>
                    {sel.kind === 'built-in' ? 'Save as copy' : 'Save'}
                  </Btn>
                </div>
              </div>
              <RefineWithAI key={sel.id} edit={edit} onApply={(body) => setEdit({ ...edit, body })} />
            </Card>
          )}

          <Card style={{ borderColor: T.violetBorder }}>
            <div className="flex items-center gap-2 mb-2">
              <Wand2 size={14} style={{ color: T.violet }} />
              <span className="text-sm font-medium">Create a style with AI</span>
            </div>
            <p className="text-xs mb-3" style={{ color: T.text2, lineHeight: 1.5, margin: 0 }}>
              Describe the character or the rules. The agent drafts a full system prompt, you tweak it, then it appears in the style picker.
            </p>
            <textarea
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              placeholder="e.g. A calm interviewer who asks one question at a time and never gives the answer unless I say 'just tell me'"
              rows={3}
              className="w-full rounded-lg p-3 text-sm resize-none"
              style={{ background: T.bg, color: T.text, border: `1px solid ${T.border}`, lineHeight: 1.5 }}
            />
            <div className="flex justify-end mt-2">
              <Btn primary icon={busy ? Clock : Sparkles} onClick={() => void generate()} disabled={busy || !brief.trim()}>
                {busy ? 'Drafting…' : 'Generate prompt'}
              </Btn>
            </div>
            {generated && (
              <div className="mt-3 rounded-lg p-3 flex flex-col gap-2" style={{ background: T.bg, border: `1px solid ${T.border}` }}>
                <span className="text-xs" style={{ color: T.violet }}>
                  Draft · {generated.label}
                </span>
                <textarea
                  value={generated.body}
                  onChange={(e) => setGenerated({ ...generated, body: e.target.value })}
                  rows={7}
                  className="w-full rounded-lg p-2 text-sm resize-none"
                  style={{ background: T.surface, color: T.text2, border: `1px solid ${T.border}`, lineHeight: 1.6, fontFamily: T.mono }}
                />
                <div className="flex gap-1.5 justify-end">
                  <Btn small onClick={() => setGenerated(null)}>
                    Discard
                  </Btn>
                  <Btn small onClick={() => void generate()} icon={Sparkles} disabled={busy}>
                    Regenerate
                  </Btn>
                  <Btn small primary onClick={() => void accept()} icon={Check}>
                    Save as style
                  </Btn>
                </div>
              </div>
            )}
          </Card>
        </div>
      </div>
    </Page>
  )
}
