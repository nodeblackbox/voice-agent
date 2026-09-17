import { dynamicTool, jsonSchema, type Tool } from 'ai'

export interface McpToolDef {
  server: string
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

export interface McpBridge {
  tools(): McpToolDef[]
  call(server: string, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
}

const sanitize = (s: string): string => s.replace(/[^a-zA-Z0-9_]/g, '_')

export function mcpToolName(server: string, name: string): string {
  return `mcp__${sanitize(server)}__${sanitize(name)}`
}

export function mcpTools(bridge: McpBridge): Record<string, Tool> {
  const out: Record<string, Tool> = {}
  for (const def of bridge.tools()) {
    const schema = { type: 'object', properties: {}, ...def.inputSchema } as Record<string, unknown>
    out[mcpToolName(def.server, def.name)] = dynamicTool({
      description: def.description ? `${def.description} (via MCP server "${def.server}")` : `Tool "${def.name}" from MCP server "${def.server}"`,
      inputSchema: jsonSchema(schema as never),
      execute: (input, { abortSignal }) => bridge.call(def.server, def.name, (input ?? {}) as Record<string, unknown>, abortSignal)
    })
  }
  return out
}
