import { describe, expect, it, vi } from 'vitest'
import { StateMachine } from './state-machine'

const make = () => {
  const onChange = vi.fn()
  const sm = new StateMachine(onChange)
  return { sm, onChange }
}

describe('StateMachine', () => {
  it('starts idle and goes listening when the mic turns on', () => {
    const { sm, onChange } = make()
    expect(sm.state).toBe('idle')
    sm.setMic(true)
    expect(sm.state).toBe('listening')
    expect(onChange).toHaveBeenCalledWith('listening', 'mic_on')
  })

  it('follows a normal voice turn: speaking user -> thinking -> speaking -> listening', () => {
    const { sm } = make()
    sm.setMic(true)
    expect(sm.speechStart()).toBe(true)
    sm.speechEnd()
    expect(sm.state).toBe('thinking')
    sm.firstAudio()
    expect(sm.state).toBe('speaking')
    sm.done()
    expect(sm.state).toBe('listening')
  })

  it('returns to idle after a turn when the mic is off', () => {
    const { sm } = make()
    sm.think()
    sm.done()
    expect(sm.state).toBe('idle')
  })

  it('only accepts barge-in while thinking, in a tool, or speaking', () => {
    const { sm } = make()
    expect(sm.bargeIn()).toBe(false)
    sm.think()
    expect(sm.bargeIn()).toBe(true)
    expect(sm.state).toBe('interrupted')
    sm.resumeUser()
    expect(sm.state).toBe('user_speaking')
  })

  it('tracks tool state inside thinking only', () => {
    const { sm } = make()
    sm.tool(true)
    expect(sm.state).toBe('idle')
    sm.think()
    sm.tool(true)
    expect(sm.state).toBe('tool')
    sm.firstAudio()
    expect(sm.state).toBe('speaking')
    sm.tool(false)
    expect(sm.state).toBe('speaking')
  })

  it('blip returns a too-short utterance to the rest state', () => {
    const { sm } = make()
    sm.setMic(true)
    sm.speechStart()
    sm.blip()
    expect(sm.state).toBe('listening')
  })

  it('muting the mic never cuts the agent reply', () => {
    const { sm } = make()
    sm.setMic(true)
    sm.think()
    sm.firstAudio()
    sm.setMic(false)
    expect(sm.state).toBe('speaking')
    sm.done()
    expect(sm.state).toBe('idle')
  })

  it('does not emit for no-op transitions and keeps a bounded log', () => {
    const { sm, onChange } = make()
    sm.done()
    expect(onChange).not.toHaveBeenCalled()
    for (let i = 0; i < 300; i++) {
      sm.think()
      sm.done()
    }
    expect(sm.log.length).toBeLessThanOrEqual(200)
    expect(sm.busy).toBe(false)
  })
})
