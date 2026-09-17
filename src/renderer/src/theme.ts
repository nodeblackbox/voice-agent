import type { AgentState, ServiceState, ToolStatus } from '@shared/types'

export const T = {
  bg: '#0B0D10',
  rail: '#0E1013',
  surface: '#14171B',
  raised: '#1B1F24',
  border: '#23272D',
  text: '#EDEEF0',
  text2: '#8B929B',
  text3: '#565C64',
  cyan: '#4FD1FF',
  violet: '#B98BFF',
  green: '#4ADE80',
  amber: '#FFB454',
  red: '#FF6B6B',
  mono: "ui-monospace, 'SF Mono', Menlo, monospace",
  cyanTint: 'rgba(79,209,255,.10)',
  cyanBorder: 'rgba(79,209,255,.35)',
  violetTint: 'rgba(185,139,255,.08)',
  violetBorder: 'rgba(185,139,255,.3)',
  amberTint: 'rgba(255,180,84,.10)',
  redTint: 'rgba(255,107,107,.10)'
} as const

export const serviceColor = (s: ServiceState | undefined): string => {
  switch (s) {
    case 'ready':
      return T.green
    case 'starting':
    case 'reconnecting':
      return T.amber
    case 'error':
      return T.red
    default:
      return T.text3
  }
}

export const serviceLabel = (s: ServiceState | undefined): string => {
  switch (s) {
    case 'ready':
      return 'ready'
    case 'starting':
      return 'starting'
    case 'reconnecting':
      return 'reconnecting'
    case 'error':
      return 'error'
    default:
      return 'off'
  }
}

export const agentStateColor = (s: AgentState): string => {
  switch (s) {
    case 'listening':
    case 'user_speaking':
    case 'speaking':
      return T.cyan
    case 'thinking':
    case 'tool':
      return T.violet
    case 'interrupted':
      return T.amber
    default:
      return T.text3
  }
}

export const toolStatusColor = (s: ToolStatus): string => {
  switch (s) {
    case 'running':
    case 'done':
      return T.violet
    case 'error':
      return T.amber
    default:
      return T.text3
  }
}
