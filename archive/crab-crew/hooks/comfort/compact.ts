export const shorten = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text

const base = (path: string): string => path.split(/[\\/]+/).filter(Boolean).pop() ?? path

const name = (tool: string): string =>
  tool.startsWith('mcp__') ? (tool.split('__').pop() ?? tool) : tool

/** One line per call: `Read register.tsx`, `Bash git status`. */
export const describe = (tool: string, input: unknown): string => {
  const data = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const text = (key: string): string | undefined =>
    typeof data[key] === 'string' ? (data[key] as string) : undefined
  const label = name(tool)

  switch (tool) {
    case 'Read':
    case 'Edit':
    case 'Write': {
      const path = text('file_path')
      return path === undefined ? label : `${label} ${base(path)}`
    }
    case 'NotebookEdit': {
      const path = text('notebook_path')
      return path === undefined ? label : `${label} ${base(path)}`
    }
    case 'Bash':
    case 'PowerShell': {
      const first = (text('command') ?? '').split('\n')[0] ?? ''
      return `${label} ${shorten(first.trim(), 60)}`.trim()
    }
    case 'Grep':
    case 'Glob':
      return `${label} ${shorten(text('pattern') ?? '', 40)}`.trim()
    case 'WebFetch':
      return `${label} ${shorten(text('url') ?? '', 50)}`.trim()
    case 'WebSearch':
      return `${label} ${shorten(text('query') ?? '', 50)}`.trim()
    case 'Agent':
      return `${label} ${shorten(text('description') ?? '', 50)}`.trim()
    default:
      return label
  }
}

/** Summary of a group of reads and searches: `Read ×3 · Grep ×2`. */
export const groupLine = (calls: readonly { tool: string }[]): string => {
  const order: string[] = []
  const count = new Map<string, number>()
  for (const call of calls) {
    const key = name(call.tool)
    if (!count.has(key)) {
      order.push(key)
    }
    count.set(key, (count.get(key) ?? 0) + 1)
  }
  return order.map(key => ((count.get(key) ?? 0) > 1 ? `${key} ×${count.get(key)}` : key)).join(' · ')
}

const host = (url: string): string => {
  const match = /^[a-z]+:\/\/([^/]+)/i.exec(url)
  return match?.[1] ?? url
}

/** What a tool call is doing, in plain words, for the spinner line: `reading register.tsx`, `running npm test`. */
export const activity = (tool: string, input: unknown): string => {
  const data = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>
  const text = (key: string): string => (typeof data[key] === 'string' ? (data[key] as string) : '')
  const file = base(text('file_path') || text('notebook_path'))
  const firstLine = (value: string) => shorten((value.split('\n')[0] ?? '').trim(), 44)
  switch (tool) {
    case 'Read':
      return file ? `reading ${file}` : 'reading'
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return file ? `editing ${file}` : 'editing'
    case 'Write':
      return file ? `writing ${file}` : 'writing'
    case 'Bash':
    case 'PowerShell':
      return text('description') ? shorten(text('description'), 50).replace(/^./, c => c.toLowerCase()) : `running ${firstLine(text('command'))}`
    case 'Grep':
      return `searching for ${shorten(text('pattern'), 36)}`
    case 'Glob':
      return `looking for ${shorten(text('pattern'), 36)}`
    case 'WebFetch':
      return `reading ${host(text('url'))}`
    case 'WebSearch':
      return `searching the web for ${shorten(text('query'), 36)}`
    case 'Agent':
    case 'Task':
      return `delegating: ${shorten(text('description'), 40)}`
    case 'Skill':
      return `using the ${text('skill') || text('name')} skill`
    default:
      return `using ${name(tool)}`
  }
}

/** The first useful line of what a failed call said: `Exit code 1`, `File not found`. */
export const errorDetail = (output: unknown): string => {
  const raw =
    typeof output === 'string'
      ? output
      : typeof output === 'object' && output !== null
        ? String((output as Record<string, unknown>).stderr ?? (output as Record<string, unknown>).error ?? '')
        : ''
  const line = raw
    .split('\n')
    .map(part => part.replace(/<\/?[a-z_]+>/gi, '').trim())
    .find(part => part !== '')
  return line === undefined ? '' : shorten(line, 70)
}
