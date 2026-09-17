import { useState } from 'react'
import { Check, ChevronRight, FolderKanban, Pencil, Plus, Trash2, X } from 'lucide-react'
import type { Project } from '@shared/types'
import { T } from '../theme'
import { useStore } from '../state/store'
import { Btn, Card, Empty, IconBtn, Page, Select, TextInput } from '../components/primitives'

interface Form {
  id?: string
  name: string
  path: string
  defaultStyleId: string
}

function ProjectForm({ initial, onSave, onCancel }: { initial: Form; onSave: (f: Form) => void; onCancel: () => void }) {
  const styles = useStore((s) => s.styles)
  const [f, setF] = useState(initial)
  const options = [{ id: '', label: 'Inherit global style' }, ...styles.map((s) => ({ id: s.id, label: s.label }))]
  return (
    <Card>
      <div className="flex flex-col gap-2">
        <TextInput value={f.name} onChange={(v) => setF({ ...f, name: v })} placeholder="Project name" autoFocus />
        <TextInput value={f.path} onChange={(v) => setF({ ...f, path: v })} placeholder="Folder path (optional)" mono />
        <div className="flex items-center gap-2">
          <span className="text-xs" style={{ color: T.text3 }}>
            Default style
          </span>
          <Select value={f.defaultStyleId} onChange={(v) => setF({ ...f, defaultStyleId: v })} options={options} width={220} />
          <div className="flex-1" />
          <Btn small onClick={onCancel} icon={X}>
            Cancel
          </Btn>
          <Btn small primary disabled={!f.name.trim()} onClick={() => onSave(f)} icon={Check}>
            Save
          </Btn>
        </div>
      </div>
    </Card>
  )
}

export function ProjectsView() {
  const projects = useStore((s) => s.projects)
  const styles = useStore((s) => s.styles)
  const settings = useStore((s) => s.settings)
  const updateSettings = useStore((s) => s.updateSettings)
  const reloadProjects = useStore((s) => s.reloadProjects)
  const [editing, setEditing] = useState<Form | null>(null)

  const save = async (f: Form) => {
    const existing = projects.find((p) => p.id === f.id)
    const project: Project = {
      id: f.id ?? crypto.randomUUID(),
      name: f.name.trim(),
      path: f.path.trim() || undefined,
      defaultStyleId: f.defaultStyleId || undefined,
      createdAt: existing?.createdAt ?? Date.now()
    }
    await window.api.projects.save(project)
    await reloadProjects()
    setEditing(null)
  }

  const remove = async (id: string) => {
    await window.api.projects.delete(id)
    await reloadProjects()
    if (settings?.projectId === id) await updateSettings({ projectId: '' })
  }

  const styleName = (id?: string) => styles.find((s) => s.id === id)?.label ?? 'inherit'

  return (
    <Page
      title="Projects"
      sub="A project is a folder plus its own memory notebook and default prompt style. The active project decides what context gets injected."
      actions={
        <Btn primary icon={Plus} onClick={() => setEditing({ name: '', path: '', defaultStyleId: '' })}>
          Add project
        </Btn>
      }
    >
      <div className="flex flex-col gap-2">
        {editing && editing.id === undefined && <ProjectForm initial={editing} onSave={(f) => void save(f)} onCancel={() => setEditing(null)} />}
        <Card active={!settings?.projectId} onClick={() => void updateSettings({ projectId: '' })}>
          <div className="flex items-center gap-4">
            <FolderKanban size={18} style={{ color: !settings?.projectId ? T.cyan : T.text3 }} />
            <div className="flex flex-col gap-0.5 flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">No project</span>
                {!settings?.projectId && (
                  <span className="text-xs" style={{ color: T.cyan }}>
                    active
                  </span>
                )}
              </div>
              <span className="text-xs" style={{ color: T.text3 }}>
                Global memory only
              </span>
            </div>
          </div>
        </Card>
        {projects.map((p) =>
          editing?.id === p.id ? (
            <ProjectForm
              key={p.id}
              initial={{ id: p.id, name: p.name, path: p.path ?? '', defaultStyleId: p.defaultStyleId ?? '' }}
              onSave={(f) => void save(f)}
              onCancel={() => setEditing(null)}
            />
          ) : (
            <Card key={p.id} active={settings?.projectId === p.id} onClick={() => void updateSettings({ projectId: p.id })}>
              <div className="flex items-center gap-4">
                <FolderKanban size={18} style={{ color: settings?.projectId === p.id ? T.cyan : T.text3 }} />
                <div className="flex flex-col gap-0.5 flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{p.name}</span>
                    {settings?.projectId === p.id && (
                      <span className="text-xs" style={{ color: T.cyan }}>
                        active
                      </span>
                    )}
                  </div>
                  <span className="text-xs truncate" style={{ color: T.text3, fontFamily: T.mono }}>
                    {p.path ?? 'no folder'}
                  </span>
                </div>
                <div className="flex gap-6 text-xs" style={{ color: T.text2 }}>
                  <span className="flex flex-col">
                    <span style={{ color: T.text3 }}>style</span>
                    <span>{styleName(p.defaultStyleId)}</span>
                  </span>
                </div>
                <div className="flex gap-0.5" onClick={(e) => e.stopPropagation()}>
                  <IconBtn
                    icon={Pencil}
                    label="Edit"
                    size={13}
                    w={26}
                    onClick={() => setEditing({ id: p.id, name: p.name, path: p.path ?? '', defaultStyleId: p.defaultStyleId ?? '' })}
                  />
                  <IconBtn icon={Trash2} label="Delete" size={13} w={26} onClick={() => void remove(p.id)} />
                </div>
                <ChevronRight size={14} style={{ color: T.text3 }} />
              </div>
            </Card>
          )
        )}
        {projects.length === 0 && !editing && <Empty>No projects yet. Add one to give it its own memory notebook.</Empty>}
      </div>
    </Page>
  )
}
