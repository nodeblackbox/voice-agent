import { tool, type Tool } from 'ai'
import { z } from 'zod'
import { timeContext } from '../context'

export const currentTimeTool: Tool = tool({
  description: 'The current local date and time. Only needed for arithmetic on dates; the current time is already in your context.',
  inputSchema: z.object({}),
  execute: async () => {
    const { now, timezone } = timeContext()
    return { now, timezone, iso: new Date().toISOString() }
  }
})
