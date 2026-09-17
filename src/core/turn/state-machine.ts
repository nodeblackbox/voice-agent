import type { AgentState } from '@shared/types'

export type Transition = { from: AgentState; to: AgentState; event: string; at: number }

// Every transition is explicit so barge-in is never a race. `idle` = mic off / text only.
export class StateMachine {
  state: AgentState = 'idle'
  readonly log: Transition[] = []
  private micOn = false

  constructor(private readonly onChange: (state: AgentState, event: string) => void) {}

  private set(to: AgentState, event: string): void {
    if (to === this.state) return
    this.log.push({ from: this.state, to, event, at: performance.now() })
    if (this.log.length > 200) this.log.shift()
    this.state = to
    this.onChange(to, event)
  }

  private get restState(): AgentState {
    return this.micOn ? 'listening' : 'idle'
  }

  setMic(on: boolean): void {
    this.micOn = on
    if (on && this.state === 'idle') this.set('listening', 'mic_on')
    if (!on && (this.state === 'listening' || this.state === 'user_speaking')) this.set('idle', 'mic_off')
  }

  speechStart(): boolean {
    if (this.state === 'listening' || this.state === 'idle') {
      this.set('user_speaking', 'speech_start')
      return true
    }
    return false
  }

  speechEnd(): void {
    if (this.state === 'user_speaking') this.set('thinking', 'speech_end')
  }

  blip(): void {
    if (this.state === 'user_speaking') this.set(this.restState, 'blip')
  }

  think(): void {
    this.set('thinking', 'turn_start')
  }

  tool(on: boolean): void {
    if (on && this.state === 'thinking') this.set('tool', 'tool_start')
    if (!on && this.state === 'tool') this.set('thinking', 'tool_end')
  }

  firstAudio(): void {
    if (this.state === 'thinking' || this.state === 'tool') this.set('speaking', 'first_audio')
  }

  bargeIn(): boolean {
    if (this.state === 'thinking' || this.state === 'tool' || this.state === 'speaking') {
      this.set('interrupted', 'barge_in')
      return true
    }
    return false
  }

  resumeUser(): void {
    if (this.state === 'interrupted') this.set('user_speaking', 'user_continues')
  }

  done(): void {
    if (this.state === 'thinking' || this.state === 'tool' || this.state === 'speaking' || this.state === 'interrupted') {
      this.set(this.restState, 'turn_done')
    }
  }

  get busy(): boolean {
    return this.state === 'thinking' || this.state === 'tool' || this.state === 'speaking'
  }
}
