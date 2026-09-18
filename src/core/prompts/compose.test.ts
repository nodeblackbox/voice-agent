import { describe, expect, it } from 'vitest'
import { composeSystemPrompt, type PromptContext } from './compose'
import { BUILTIN_STYLES } from './styles'
import { BUILTIN_SKILLS, mergeSkills, skillsBlock } from './skills'

const ctx: PromptContext = {
  agentName: 'Ava',
  userName: 'Sam',
  now: 'Wednesday 17 September 2026, 01:55',
  timezone: 'Europe/London',
  location: 'London',
  projectName: 'voice-agent',
  memoryBlock: '- Preferred gym: Elephant & Castle',
  skillsBlock: '',
  toolNames: ['web_search', 'remember'],
  fillerEnabled: true
}

const style = (id: string) => BUILTIN_STYLES.find((s) => s.id === id)!

describe('composeSystemPrompt', () => {
  it('fills names, context and memory into the prompt', () => {
    const p = composeSystemPrompt(style('short'), ctx)
    expect(p).toContain('You are Ava')
    expect(p).toContain('talking with Sam')
    expect(p).toContain('Now: Wednesday 17 September 2026, 01:55 (Europe/London)')
    expect(p).toContain('Location: London')
    expect(p).toContain('Active project: voice-agent')
    expect(p).toContain('Preferred gym: Elephant & Castle')
    expect(p).toContain('You have tools: web_search, remember')
  })

  it('uses plain speech rules for plain styles and markdown rules otherwise', () => {
    expect(composeSystemPrompt(style('short'), ctx)).toContain('No markdown, no bullet points')
    expect(composeSystemPrompt(style('comprehensive'), ctx)).toContain('code blocks and tables are shown on screen only')
  })

  it('tells the model about the app-spoken filler only when fillers are on', () => {
    expect(composeSystemPrompt(style('short'), ctx)).toContain('the app already says "let me check"')
    expect(composeSystemPrompt(style('short'), { ...ctx, fillerEnabled: false })).toContain('say in a few words what you are doing')
  })

  it('carries the conversational rules the voice agent depends on', () => {
    const p = composeSystemPrompt(style('balanced'), ctx)
    // answer-first applies to every style, not only Short
    expect(p).toContain('Answer first, in one or two short sentences')
    expect(p).toContain('say what you are about to do in one sentence, then do it')
    // interruption note semantics
    expect(p).toContain('the user heard only the text before the note')
    expect(p).toContain('continue from where you were cut, briefly')
    // search economy
    expect(p).toContain('one web_search plus at most one read_page usually answers')
    expect(p).toContain('do not re-search to double-check')
    expect(p).toContain('rather than trying the same page again')
    // memory hints are never spoken
    expect(p).toContain('never read this block out loud')
    expect(p).toContain('Never fake enthusiasm ("Great question!"')
  })

  it('adds the about-user line only when set', () => {
    expect(composeSystemPrompt(style('short'), ctx)).not.toContain('About Sam')
    expect(composeSystemPrompt(style('short'), { ...ctx, aboutUser: 'technical, likes direct answers' })).toContain('- About Sam: technical, likes direct answers')
  })

  it('omits tool, memory and skill sections when empty', () => {
    const p = composeSystemPrompt(style('balanced'), { ...ctx, toolNames: [], memoryBlock: '', skillsBlock: '' })
    expect(p).not.toContain('Tools')
    expect(p).not.toContain('What you remember')
    expect(p).not.toContain('Skills (')
  })

  it('includes enabled skills', () => {
    const p = composeSystemPrompt(style('balanced'), { ...ctx, skillsBlock: skillsBlock(BUILTIN_SKILLS) })
    expect(p).toContain('Skills (how to handle specific situations')
    expect(p).toContain('Web research — When asked to find')
    expect(p).not.toContain('Clarify before acting')
  })
})

describe('mergeSkills', () => {
  it('returns built-ins untouched when nothing is stored', () => {
    expect(mergeSkills([])).toEqual(BUILTIN_SKILLS)
  })

  it('applies stored toggles and edits to built-ins and appends customs', () => {
    const custom = { id: 'x', name: 'X', trigger: 'When x', procedure: 'Do x', enabled: true, kind: 'custom' as const }
    const edited = { ...BUILTIN_SKILLS[0]!, enabled: false, procedure: 'changed' }
    const merged = mergeSkills([edited, custom])
    expect(merged[0]).toMatchObject({ id: BUILTIN_SKILLS[0]!.id, enabled: false, procedure: 'changed', kind: 'built-in' })
    expect(merged.at(-1)).toEqual(custom)
    expect(merged).toHaveLength(BUILTIN_SKILLS.length + 1)
  })

  it('ignores a stored custom that shadows a built-in id', () => {
    const shadow = { ...BUILTIN_SKILLS[1]!, kind: 'custom' as const, name: 'Shadow' }
    const merged = mergeSkills([shadow])
    expect(merged.filter((s) => s.id === shadow.id)).toHaveLength(1)
  })
})
