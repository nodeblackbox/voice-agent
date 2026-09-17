import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

let dir = ''

export function initLog(userData: string): void {
  dir = join(userData, 'logs')
  mkdirSync(dir, { recursive: true })
}

export function log(scope: string, msg: string): void {
  const line = `${new Date().toISOString()} [${scope}] ${msg}`
  console.log(line)
  if (dir) {
    try {
      appendFileSync(join(dir, 'app.log'), line + '\n')
    } catch {
      // logging must never take the app down
    }
  }
}

export function logDir(): string {
  return dir
}
