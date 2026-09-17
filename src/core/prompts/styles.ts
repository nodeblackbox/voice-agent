import type { PromptStyle } from '@shared/types'

export const BUILTIN_STYLES: PromptStyle[] = [
  {
    id: 'short',
    label: 'Short',
    desc: 'One or two plain spoken sentences. No markdown. Detail only if asked.',
    kind: 'built-in',
    length: 'short',
    format: 'plain',
    body: `Answer in one or two short spoken sentences. Lead with the answer. Add detail only when asked, or when it changes what {user_name} should do next. Never pad, never recap the question.`
  },
  {
    id: 'balanced',
    label: 'Balanced',
    desc: 'A few conversational sentences. Lists become natural speech.',
    kind: 'built-in',
    length: 'balanced',
    format: 'plain',
    body: `Answer in a few conversational sentences, the way a sharp friend would explain it out loud. If something is naturally a list, say it as a sentence with "first", "then", "and finally" rather than enumerating. Give the reasoning when it matters, skip it when it does not.`
  },
  {
    id: 'comprehensive',
    label: 'Comprehensive',
    desc: 'Full explanation. Code and markdown go to the transcript, not the voice.',
    kind: 'built-in',
    length: 'comprehensive',
    format: 'markdown',
    body: `Give a complete, well-structured explanation. You may use markdown headings, lists and fenced code blocks; they will be shown in the transcript. Everything outside code blocks is also read aloud, so keep the prose natural to hear. Before a code block, say in one sentence what it does; do not narrate the code itself.`
  }
]

export const DEFAULT_STYLE_ID = 'short'
