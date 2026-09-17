const BY_TOOL: Record<string, string[]> = {
  web_search: ['Let me check that.', 'One sec, looking that up.', 'Let me have a look.'],
  research: ['Give me a moment, I will dig into that.', 'Let me read up on that.'],
  read_page: ['Let me read that page.', 'One moment, opening that.'],
  recall: ['Let me think back.', 'One sec.'],
  search_history: ['Let me look through our earlier chats.'],
  remember: ['Got it, noting that down.'],
  default: ['Hold on.', 'One sec.', 'Let me check.']
}

let counter = 0

export function fillerFor(toolName: string): string {
  const key = toolName.startsWith('mcp__') ? 'default' : toolName
  const options = BY_TOOL[key] ?? BY_TOOL.default!
  return options[counter++ % options.length]!
}

export function toolLabel(toolName: string): string {
  if (toolName.startsWith('mcp__')) {
    const [, server, ...rest] = toolName.split('__')
    return `${rest.join('_')} via ${server}`
  }
  return (
    {
      web_search: 'Searching the web',
      research: 'Researching',
      read_page: 'Reading page',
      recall: 'Checking memory',
      search_history: 'Searching history',
      remember: 'Saving to memory',
      forget: 'Forgetting',
      current_time: 'Checking the time'
    }[toolName] ?? toolName
  )
}
