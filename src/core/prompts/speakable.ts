import type { StyleFormat } from '@shared/types'

// Turns model text into what the voice should actually say. Runs on the *streamed* text, so it
// has to be robust to seeing half a fenced block: fence state is tracked across calls.
export class SpeakableFilter {
  private inFence = false
  private announcedFence = false
  private carry = ''

  constructor(private readonly format: StyleFormat) {}

  feed(piece: string): string {
    if (this.format === 'plain') return piece
    let out = ''
    let rest = this.carry + piece
    this.carry = ''
    // a fence can be split across tokens ("``" + "`ts"), so hold back a trailing partial fence
    const tail = /`{1,2}$/.exec(rest)
    if (tail && !rest.endsWith('```')) {
      this.carry = tail[0]
      rest = rest.slice(0, -tail[0].length)
    }
    while (rest.length) {
      const idx = rest.indexOf('```')
      if (idx < 0) {
        if (!this.inFence) out += rest
        break
      }
      if (!this.inFence) {
        out += rest.slice(0, idx)
        this.inFence = true
        if (!this.announcedFence) {
          out += ' The code is in the conversation. '
          this.announcedFence = true
        }
      } else {
        this.inFence = false
        this.announcedFence = false
      }
      rest = rest.slice(idx + 3)
      if (!this.inFence) rest = rest.replace(/^[^\n]*\n?/, '')
    }
    return this.inFence ? out : stripInlineMarkdown(out)
  }
}

export function stripInlineMarkdown(text: string): string {
  return text
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\((?:https?:\/\/)?([^)\s]+)\)/g, (_m, label: string) => label)
    .replace(/https?:\/\/([^\s/]+)[^\s]*/g, (_m, host: string) => host.replace(/^www\./, ''))
    .replace(/^\|.*\|\s*$/gm, '')
    .replace(/[ \t]+\n/g, '\n')
}
