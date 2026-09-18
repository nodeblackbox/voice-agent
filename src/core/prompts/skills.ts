import type { Skill } from '@shared/types'

export const BUILTIN_SKILLS: Skill[] = [
  {
    id: 'web-research',
    name: 'Web research',
    trigger: 'When asked to find, check, or look up something current',
    procedure:
      'Search with web_search first. If the snippets do not settle it, read the one or two most authoritative pages with read_page. Answer in the active style and name the source in words once ("according to the BBC"); do not list every hit.',
    enabled: true,
    kind: 'built-in'
  },
  {
    id: 'memory-curator',
    name: 'Memory curator',
    trigger: 'When the user states a preference, location, or fact about themselves',
    procedure:
      'Save it with remember (kind "profile" for things that should always be in context, otherwise "fact" or "decision"). Store what they meant, never your inference: fix obvious speech-recognition mangling of names and technical terms first, and ask if a mangled term is unguessable. Say back in a few words what you saved so they can correct it. To fix a wrong entry, save again with the same key.',
    enabled: true,
    kind: 'built-in'
  },
  {
    id: 'code-reader',
    name: 'Code reader',
    trigger: 'When a reply contains code and the voice is playing',
    procedure:
      'Speak the explanation, not the code. Put code in a fenced block (it goes to the transcript), say "the code is in the conversation", and continue with what it does and why.',
    enabled: true,
    kind: 'built-in'
  },
  {
    id: 'clarify-first',
    name: 'Clarify before acting',
    trigger: 'When a request is ambiguous and acting on the wrong reading would waste time',
    procedure: 'Ask one short clarifying question as the last sentence. If the ambiguity is minor, state your assumption in a few words and proceed.',
    enabled: false,
    kind: 'built-in'
  }
]

export function skillsBlock(skills: Skill[]): string {
  const on = skills.filter((s) => s.enabled)
  if (!on.length) return ''
  return on.map((s) => `- ${s.name} — ${s.trigger}: ${s.procedure}`).join('\n')
}

// Stored skills override built-ins by id (enabled flag and edits) and add custom ones.
export function mergeSkills(stored: Skill[]): Skill[] {
  const byId = new Map(stored.map((s) => [s.id, s]))
  const builtins = BUILTIN_SKILLS.map((b) => {
    const o = byId.get(b.id)
    return o ? { ...b, enabled: o.enabled, name: o.name, trigger: o.trigger, procedure: o.procedure } : b
  })
  const customs = stored.filter((s) => s.kind === 'custom' && !BUILTIN_SKILLS.some((b) => b.id === s.id))
  return [...builtins, ...customs]
}
