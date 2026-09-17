import { describe, expect, it } from 'vitest'
import { SpeakableFilter, stripInlineMarkdown } from './speakable'

describe('stripInlineMarkdown', () => {
  it('removes headings, list markers and emphasis', () => {
    expect(stripInlineMarkdown('## Title\n- one\n2. two\n**bold** and *it*')).toBe('Title\none\ntwo\nbold and it')
  })

  it('keeps link labels and reduces bare URLs to their host', () => {
    expect(stripInlineMarkdown('see [the docs](https://example.com/x) or https://www.bbc.co.uk/news/123')).toBe('see the docs or bbc.co.uk')
  })

  it('drops table rows and inline code ticks', () => {
    expect(stripInlineMarkdown('| a | b |\nrun `npm test` now')).toBe('\nrun npm test now')
  })
})

describe('SpeakableFilter', () => {
  it('passes plain-format text through untouched', () => {
    const f = new SpeakableFilter('plain')
    expect(f.feed('**keep** `this` as is')).toBe('**keep** `this` as is')
  })

  it('replaces a fenced block with a spoken notice, once per block', () => {
    const f = new SpeakableFilter('markdown')
    const out = f.feed('Here you go:\n```ts\nconst a = 1\n```\nThat sets a.')
    expect(out).toContain('The code is in the conversation.')
    expect(out).not.toContain('const a')
    expect(out).toContain('That sets a.')
  })

  it('tracks fence state across streamed pieces', () => {
    const f = new SpeakableFilter('markdown')
    const a = f.feed('Look:\n``')
    const b = f.feed('`py\nprint(1)\n')
    const c = f.feed('```\nDone.')
    expect(a + b + c).not.toContain('print(1)')
    expect(a + b + c).toContain('Done.')
    expect((a + b + c).match(/The code is in the conversation/g)?.length).toBe(1)
  })

  it('announces again for a second block', () => {
    const f = new SpeakableFilter('markdown')
    const out = f.feed('```\na\n```\nmid\n```\nb\n```\nend')
    expect(out.match(/The code is in the conversation/g)?.length).toBe(2)
  })
})
