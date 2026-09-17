import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Check, ChevronDown, ChevronRight, Pencil, Play, Plug, Plus, RefreshCw, Trash2, X, type LucideIcon } from 'lucide-react'
import type { McpServerConfig, McpServerStatus } from '@shared/types'
import { T, serviceColor, serviceLabel } from '../../theme'
import { useStore } from '../../state/store'
import { Btn, Card, Dot, Row, Select, TextInput, Toggle } from '../../components/primitives'
import { envToLines, formatElapsed, parseArgs, parseEnvLines } from '../../lib/format'

function Section({ icon: Icon, title, children }: { icon: LucideIcon; title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2 mb-1">
        <Icon size={14} style={{ color: T.text2 }} />
        <span className="text-sm font-medium">{title}</span>
      </div>
      {children}
    </div>
  )
}

type Form = { name: string; transport: 'stdio' | 'http'; command: string; args: string; url: string; env: string; cwd: string; enabled: boolean }

const EMPTY_FORM: Form = { name: '', transport: 'stdio', command: '', args: '', url: '', env: '', cwd: '', enabled: true }

export function toForm(c: McpServerConfig): Form {
  return {
    name: c.name,
    transport: c.transport,
    command: c.command ?? '',
    args: (c.args ?? []).map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' '),
    url: c.url ?? '',
    env: envToLines(c.env),
    cwd: c.cwd ?? '',
    enabled: c.enabled
  }
}

export function fromForm(f: Form): McpServerConfig {
  const env = parseEnvLines(f.env)
  return {
    name: f.name.trim(),
    enabled: f.enabled,
    transport: f.transport,
    command: f.transport === 'stdio' ? f.command.trim() || undefined : undefined,
    args: f.transport === 'stdio' ? parseArgs(f.args) : [],
    url: f.transport === 'http' ? f.url.trim() || undefined : undefined,
    env: Object.keys(env).length ? env : undefined,
    cwd: f.cwd.trim() || undefined
  }
}

function ServerForm({ initial, onSave, onCancel, saving }: { initial: Form; onSave: (f: Form) => void; onCancel: () => void; saving: boolean }) {
  const [f, setF] = useState<Form>(initial)
  const valid = f.name.trim() && (f.transport === 'http' ? f.url.trim() : f.command.trim())
  const field = (label: string, node: ReactNode, hint?: string) => (
    <div className="flex items-center gap-3 text-xs">
      <span style={{ width: 90, color: T.text2, flexShrink: 0 }}>{label}</span>
      <span className="flex-1 min-w-0">{node}</span>
      {hint && (
        <span style={{ width: 200, color: T.text3, flexShrink: 0 }} className="truncate">
          {hint}
        </span>
      )}
    </div>
  )
  return (
    <div className="flex flex-col gap-2 py-2">
      {field('Name', <TextInput value={f.name} onChange={(v) => setF({ ...f, name: v })} placeholder="my-server" autoFocus />, 'used as the tool prefix')}
      {field(
        'Transport',
        <Select
          value={f.transport}
          onChange={(v) => setF({ ...f, transport: v as 'stdio' | 'http' })}
          options={[
            { id: 'stdio', label: 'stdio (spawn a process)' },
            { id: 'http', label: 'streamable HTTP (url)' }
          ]}
        />
      )}
      {f.transport === 'stdio' ? (
        <>
          {field('Command', <TextInput value={f.command} onChange={(v) => setF({ ...f, command: v })} mono placeholder="npx, uvx, python, ${NODE}" />, '${NODE} = the app runtime')}
          {field('Arguments', <TextInput value={f.args} onChange={(v) => setF({ ...f, args: v })} mono placeholder='-y @modelcontextprotocol/server-filesystem "${PROJECT_PATH}"' />, 'space separated, quote paths')}
          {field('Working dir', <TextInput value={f.cwd} onChange={(v) => setF({ ...f, cwd: v })} mono placeholder="optional" />)}
        </>
      ) : (
        field('URL', <TextInput value={f.url} onChange={(v) => setF({ ...f, url: v })} mono placeholder="http://127.0.0.1:3001/mcp" />)
      )}
      {field(
        'Environment',
        <textarea
          value={f.env}
          onChange={(e) => setF({ ...f, env: e.target.value })}
          rows={2}
          placeholder={'KEY=value\nANOTHER=value'}
          className="w-full rounded-lg px-2.5 py-1.5 text-xs resize-none"
          style={{ background: T.bg, color: T.text, border: `1px solid ${T.border}`, fontFamily: T.mono }}
        />,
        'one KEY=VALUE per line'
      )}
      {field('Enabled', <Toggle on={f.enabled} onChange={(v) => setF({ ...f, enabled: v })} />)}
      <div className="flex justify-end gap-1.5 mt-1">
        <Btn small icon={X} onClick={onCancel}>
          Cancel
        </Btn>
        <Btn small primary icon={Check} onClick={() => onSave(f)} disabled={!valid || saving}>
          {saving ? 'Saving…' : 'Save server'}
        </Btn>
      </div>
    </div>
  )
}

type SchemaProp = { type?: string | string[]; description?: string; enum?: unknown[]; default?: unknown }

export function schemaFields(schema: Record<string, unknown> | undefined): Array<{ name: string; prop: SchemaProp; required: boolean }> {
  const props = (schema?.properties ?? {}) as Record<string, SchemaProp>
  const required = new Set((schema?.required as string[] | undefined) ?? [])
  return Object.entries(props).map(([name, prop]) => ({ name, prop, required: required.has(name) }))
}

export function buildToolInput(fields: ReturnType<typeof schemaFields>, values: Record<string, string>): { input: Record<string, unknown>; missing: string[] } {
  const input: Record<string, unknown> = {}
  const missing: string[] = []
  for (const { name, prop, required } of fields) {
    const raw = values[name] ?? ''
    const type = Array.isArray(prop.type) ? prop.type[0] : prop.type
    if (raw === '') {
      if (required && prop.default === undefined) missing.push(name)
      continue
    }
    if (type === 'number' || type === 'integer') {
      const n = Number(raw)
      if (Number.isNaN(n)) missing.push(name)
      else input[name] = type === 'integer' ? Math.trunc(n) : n
    } else if (type === 'boolean') input[name] = raw === 'true'
    else if (type === 'object' || type === 'array') {
      try {
        input[name] = JSON.parse(raw)
      } catch {
        missing.push(name)
      }
    } else input[name] = raw
  }
  return { input, missing }
}

function McpToolTest({ server, tool, schema }: { server: string; tool: string; schema?: Record<string, unknown> }) {
  const [open, setOpen] = useState(false)
  const [values, setValues] = useState<Record<string, string>>({})
  const [raw, setRaw] = useState(false)
  const [json, setJson] = useState('{}')
  const [result, setResult] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [ms, setMs] = useState<number | null>(null)
  const fields = schemaFields(schema)

  const run = async () => {
    setResult(null)
    let input: unknown
    if (raw || fields.length === 0) {
      try {
        input = JSON.parse(json || '{}')
      } catch {
        setResult('error: the JSON is not valid')
        return
      }
    } else {
      const built = buildToolInput(fields, values)
      if (built.missing.length) {
        setResult(`error: fill in ${built.missing.join(', ')}`)
        return
      }
      input = built.input
    }
    setBusy(true)
    const t0 = performance.now()
    try {
      const r = await window.api.services.mcpTestTool(server, tool, input)
      const errored = r && typeof r === 'object' && 'error' in (r as Record<string, unknown>)
      setResult(errored ? `error: ${String((r as { error: unknown }).error)}` : typeof r === 'string' ? r : JSON.stringify(r, null, 2))
    } catch (err) {
      setResult(`error: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setMs(performance.now() - t0)
      setBusy(false)
    }
  }

  const fieldInput = (name: string, prop: SchemaProp) => {
    const type = Array.isArray(prop.type) ? prop.type[0] : prop.type
    const value = values[name] ?? (prop.default !== undefined ? String(prop.default) : '')
    if (prop.enum) {
      return <Select value={value} onChange={(v) => setValues({ ...values, [name]: v })} options={[{ id: '', label: '—' }, ...prop.enum.map((e) => ({ id: String(e), label: String(e) }))]} />
    }
    if (type === 'boolean') {
      return <Select value={value} onChange={(v) => setValues({ ...values, [name]: v })} options={[{ id: '', label: '—' }, { id: 'true', label: 'true' }, { id: 'false', label: 'false' }]} />
    }
    return (
      <TextInput
        value={value}
        onChange={(v) => setValues({ ...values, [name]: v })}
        mono={type !== 'string'}
        placeholder={type === 'object' || type === 'array' ? 'JSON' : type ?? 'text'}
        onKeyDown={(e) => e.key === 'Enter' && void run()}
      />
    )
  }

  return (
    <span className="inline-flex flex-col gap-1 items-end">
      <Btn small icon={Play} onClick={() => setOpen(!open)}>
        Test
      </Btn>
      {open && (
        <span className="flex flex-col gap-1.5 mt-1 va-fade" style={{ width: 400 }}>
          {!raw && fields.length > 0 ? (
            fields.map(({ name, prop, required }) => (
              <span key={name} className="flex flex-col gap-0.5">
                <span className="text-xs" style={{ color: T.text3 }}>
                  <span style={{ fontFamily: T.mono, color: T.text2 }}>{name}</span>
                  {required && <span style={{ color: T.amber }}> *</span>}
                  {prop.description && <span> — {prop.description}</span>}
                </span>
                {fieldInput(name, prop)}
              </span>
            ))
          ) : (
            <TextInput value={json} onChange={setJson} mono placeholder='{"expression": "17*23"}' onKeyDown={(e) => e.key === 'Enter' && void run()} />
          )}
          {fields.length > 0 && (
            <button onClick={() => setRaw(!raw)} className="text-xs self-start" style={{ background: 'none', border: 'none', color: T.text3, cursor: 'pointer', padding: 0 }}>
              {raw ? 'Use form' : 'Edit as JSON'}
            </button>
          )}
          <span className="flex justify-end items-center gap-2">
            {ms !== null && (
              <span className="text-xs" style={{ color: T.text3, fontFamily: T.mono }}>
                {formatElapsed(ms)}
              </span>
            )}
            <Btn small primary onClick={() => void run()} disabled={busy}>
              {busy ? 'Calling…' : 'Call'}
            </Btn>
          </span>
          {result && (
            <pre className="text-xs rounded-lg p-2 overflow-auto" style={{ background: T.bg, color: result.startsWith('error:') ? T.red : T.text2, maxHeight: 160, margin: 0, fontFamily: T.mono, whiteSpace: 'pre-wrap' }}>
              {result}
            </pre>
          )}
        </span>
      )}
    </span>
  )
}

function ServerCard({
  status,
  config,
  onToggle,
  onEdit,
  onRemove
}: {
  status: McpServerStatus | undefined
  config: McpServerConfig
  onToggle: (on: boolean) => void
  onEdit: () => void
  onRemove: () => void
}) {
  const [logOpen, setLogOpen] = useState(false)
  const state = status?.state ?? 'off'
  const tools = status?.tools ?? []
  const stderr = status?.stderrTail ?? []
  return (
    <div className="py-3 flex flex-col gap-2" style={{ borderBottom: `1px solid ${T.border}` }}>
      <div className="flex items-center gap-2">
        <Dot color={config.enabled ? serviceColor(state) : T.text3} pulse={state === 'starting'} />
        <span className="text-sm font-medium">{config.name}</span>
        <span className="text-xs rounded px-1.5 py-0.5" style={{ background: T.raised, color: T.text3, fontFamily: T.mono }}>
          {config.transport}
        </span>
        <span className="text-xs" style={{ color: config.enabled ? serviceColor(state) : T.text3 }}>
          {config.enabled ? serviceLabel(state) : 'disabled'}
        </span>
        {status?.connectedAt && state === 'ready' && (
          <span className="text-xs" style={{ color: T.text3 }} title={new Date(status.connectedAt).toLocaleString()}>
            · up {formatElapsed(Date.now() - status.connectedAt)}
          </span>
        )}
        {status && status.calls > 0 && (
          <span className="text-xs" style={{ color: T.text3 }}>
            · {status.calls} call{status.calls === 1 ? '' : 's'}
          </span>
        )}
        <span className="ml-auto inline-flex items-center gap-1">
          <Btn small icon={Pencil} onClick={onEdit}>
            Edit
          </Btn>
          <Btn small danger icon={Trash2} onClick={onRemove} />
          <Toggle on={config.enabled} onChange={onToggle} />
        </span>
      </div>
      <div className="text-xs truncate" style={{ color: T.text3, fontFamily: T.mono }} title={status?.command}>
        {status?.command ?? [config.command, ...(config.args ?? [])].join(' ')}
      </div>
      {status?.error && (
        <div className="text-xs rounded-lg px-2 py-1.5" style={{ background: T.redTint, color: T.red, fontFamily: T.mono }}>
          {status.error}
        </div>
      )}
      {tools.length > 0 && (
        <div className="flex flex-col gap-1 pl-4">
          {tools.map((t) => (
            <div key={t.name} className="flex items-start gap-3 text-xs">
              <span style={{ fontFamily: T.mono, color: T.text, minWidth: 120 }}>{t.name}</span>
              <span className="flex-1" style={{ color: T.text3, lineHeight: 1.4 }}>
                {t.description}
              </span>
              <McpToolTest server={config.name} tool={t.name} schema={t.inputSchema} />
            </div>
          ))}
        </div>
      )}
      {stderr.length > 0 && (
        <div className="flex flex-col gap-1">
          <button
            onClick={() => setLogOpen(!logOpen)}
            className="inline-flex items-center gap-1 text-xs self-start"
            style={{ color: T.text3, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
          >
            {logOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />} stderr ({stderr.length})
          </button>
          {logOpen && (
            <pre className="text-xs rounded-lg p-2 overflow-auto" style={{ background: T.bg, color: T.text3, maxHeight: 140, margin: 0, fontFamily: T.mono, whiteSpace: 'pre-wrap' }}>
              {stderr.join('\n')}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

export function McpSection() {
  const settings = useStore((s) => s.settings)
  const updateSettings = useStore((s) => s.updateSettings)
  const pushToast = useStore((s) => s.pushToast)
  const mcpVersion = useStore((s) => s.mcpVersion)
  const [statuses, setStatuses] = useState<McpServerStatus[]>([])
  const [configs, setConfigs] = useState<McpServerConfig[]>([])
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  const load = useCallback(async () => {
    try {
      const [st, cf] = await Promise.all([window.api.services.mcpStatus(), window.api.services.mcpConfig()])
      setStatuses(st)
      setConfigs(cf)
    } catch {
      setStatuses([])
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load, mcpVersion])

  const reload = async () => {
    setBusy(true)
    try {
      setStatuses(await window.api.services.mcpReload())
    } finally {
      setBusy(false)
    }
  }

  const persist = async (next: McpServerConfig[]) => {
    setSaving(true)
    try {
      setConfigs(next)
      setStatuses(await window.api.services.mcpSetConfig(next))
      setEditing(null)
      setAdding(false)
    } catch (err) {
      pushToast('error', `Could not save MCP servers: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSaving(false)
    }
  }

  if (!settings) return null
  const ready = statuses.filter((s) => s.state === 'ready').length
  const toolCount = statuses.reduce((n, s) => n + s.tools.length, 0)

  return (
    <Section icon={Plug} title="MCP servers">
      <Card pad={0}>
        <div className="px-4">
          <Row label="Enable MCP tools" sub={`${ready}/${configs.filter((c) => c.enabled).length} servers connected · ${toolCount} tools · ${'${ROOT}'}, ${'${PROJECT_PATH}'} and ${'${NODE}'} are substituted in commands`}>
            <span className="inline-flex items-center gap-2">
              <Btn small icon={Plus} onClick={() => setAdding(true)} disabled={adding}>
                Add server
              </Btn>
              <Btn small icon={RefreshCw} onClick={() => void reload()} disabled={busy}>
                {busy ? 'Reloading…' : 'Reload'}
              </Btn>
              <Toggle on={settings.mcp.enabled} onChange={(v) => void updateSettings({ mcp: { enabled: v } })} />
            </span>
          </Row>
          {adding && (
            <div style={{ borderBottom: `1px solid ${T.border}` }}>
              <ServerForm
                initial={EMPTY_FORM}
                saving={saving}
                onCancel={() => setAdding(false)}
                onSave={(f) => {
                  const cfg = fromForm(f)
                  if (configs.some((c) => c.name === cfg.name)) {
                    pushToast('warn', `A server named ${cfg.name} already exists`)
                    return
                  }
                  void persist([...configs, cfg])
                }}
              />
            </div>
          )}
          {configs.map((c) =>
            editing === c.name ? (
              <div key={c.name} style={{ borderBottom: `1px solid ${T.border}` }}>
                <ServerForm
                  initial={toForm(c)}
                  saving={saving}
                  onCancel={() => setEditing(null)}
                  onSave={(f) => void persist(configs.map((x) => (x.name === c.name ? fromForm(f) : x)))}
                />
              </div>
            ) : (
              <ServerCard
                key={c.name}
                config={c}
                status={statuses.find((s) => s.name === c.name)}
                onToggle={(on) => void persist(configs.map((x) => (x.name === c.name ? { ...x, enabled: on } : x)))}
                onEdit={() => setEditing(c.name)}
                onRemove={() => void persist(configs.filter((x) => x.name !== c.name))}
              />
            )
          )}
          {configs.length === 0 && !adding && (
            <div className="py-3 text-xs" style={{ color: T.text3 }}>
              No servers configured. Add one, or reload to pick up mcp/mcp.json.
            </div>
          )}
        </div>
      </Card>
    </Section>
  )
}
