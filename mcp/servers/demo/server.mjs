// First-party smoke-test MCP server. If its tools don't show up in Settings > MCP, MCP is broken.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const require = createRequire(resolve(dirname(fileURLToPath(import.meta.url)), '../../../package.json'))
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js')
const { z } = require('zod')

const server = new McpServer({ name: 'voice-agent-demo', version: '0.1.0' })

server.registerTool(
  'get_time',
  { description: 'Current time in a given IANA timezone (default: local).', inputSchema: { timezone: z.string().optional() } },
  async ({ timezone }) => {
    const text = new Intl.DateTimeFormat('en-GB', { dateStyle: 'full', timeStyle: 'medium', timeZone: timezone }).format(new Date())
    return { content: [{ type: 'text', text }] }
  }
)

server.registerTool(
  'calculate',
  { description: 'Evaluate an arithmetic expression (+ - * / ^ parentheses, sqrt, pow, pi).', inputSchema: { expression: z.string() } },
  async ({ expression }) => {
    const safe = /^[\d\s+\-*/().^,a-z]+$/i.test(expression) && !/[a-z]+/i.test(expression.replace(/sqrt|pow|pi|e/gi, ''))
    if (!safe) return { content: [{ type: 'text', text: 'Only arithmetic is allowed.' }], isError: true }
    const js = expression.replace(/\^/g, '**').replace(/sqrt/gi, 'Math.sqrt').replace(/pow/gi, 'Math.pow').replace(/\bpi\b/gi, 'Math.PI')
    try {
      const value = Function(`"use strict"; return (${js})`)()
      return { content: [{ type: 'text', text: String(value) }] }
    } catch (e) {
      return { content: [{ type: 'text', text: `Could not evaluate: ${e.message}` }], isError: true }
    }
  }
)

server.registerTool(
  'roll_dice',
  { description: 'Roll dice, e.g. sides=6 count=2.', inputSchema: { sides: z.number().int().min(2).default(6), count: z.number().int().min(1).max(20).default(1) } },
  async ({ sides, count }) => {
    const rolls = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * sides))
    return { content: [{ type: 'text', text: `${rolls.join(', ')} (total ${rolls.reduce((a, b) => a + b, 0)})` }] }
  }
)

await server.connect(new StdioServerTransport())
