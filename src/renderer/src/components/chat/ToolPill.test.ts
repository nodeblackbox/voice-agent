import { describe, expect, it } from 'vitest'
import { wordDiff } from './ToolPill'

describe('wordDiff', () => {
  it('marks appended words as added and keeps the rest', () => {
    const d = wordDiff('Karate AI: Uses SAM 3D for poses', 'Karate AI: Uses SAM 3D for poses. Voice commands play segments')
    expect(d.map((p) => p.kind)).toEqual(['same', 'added'])
    expect(d[1]!.text).toContain('Voice commands')
  })

  it('marks a replaced phrase as removed then added', () => {
    const d = wordDiff('Uses SAM 3D for poses', 'Uses SAM 3 for poses')
    expect(d.filter((p) => p.kind === 'removed').map((p) => p.text.trim())).toEqual(['3D'])
    expect(d.filter((p) => p.kind === 'added').map((p) => p.text.trim())).toEqual(['3'])
  })
})
