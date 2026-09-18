import type { LogLevel } from '@shared/types'

/** Renderer-side log line; lands in the main process log files through the same flood guard. */
export function rlog(level: LogLevel, scope: string, msg: string): void {
  try {
    window.api.log?.write(level, scope, msg)
  } catch {
    // preload not available (tests)
  }
}
