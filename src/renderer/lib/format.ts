import type { Attachment, ConnectionStatus, ModelInfo } from '../../shared/types'

export function formatBytes(bytes: number): string {
  if (!bytes) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

export function relativeTime(timestamp: number): string {
  const delta = Date.now() - timestamp
  const minute = 60000
  const hour = 3600000
  const day = 86400000
  if (delta < minute) return 'just now'
  if (delta < hour) return `${Math.floor(delta / minute)}m ago`
  if (delta < day) return `${Math.floor(delta / hour)}h ago`
  if (delta < day * 7) return `${Math.floor(delta / day)}d ago`
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

export function dayGroup(timestamp: number): string {
  const now = new Date()
  const date = new Date(timestamp)
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (timestamp >= startOfToday) return 'Today'
  if (timestamp >= startOfToday - 86400000) return 'Yesterday'
  if (timestamp >= startOfToday - 86400000 * 7) return 'Previous 7 days'
  if (date.getFullYear() === now.getFullYear()) return 'Earlier this year'
  return String(date.getFullYear())
}

export function clockTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
}

export function shortPath(path: string, max = 42): string {
  if (path.length <= max) return path
  const parts = path.split(/[\\/]/).filter(Boolean)
  const tail = parts.slice(-2).join('\\')
  return `…\\${tail.length > max ? tail.slice(-max) : tail}`
}

export function folderName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? path
}

export function statusLabel(status: ConnectionStatus | null): string {
  if (!status) return 'Checking…'
  if (status.state === 'connected') return 'Connected'
  if (status.state === 'starting') return 'Starting…'
  if (status.state === 'error') return 'Error'
  return 'Offline'
}

export function modelLabel(modelId: string, models: ModelInfo[]): string {
  if (!modelId) return 'Server default'
  const match = models.find((model) => model.id === modelId)
  return match?.displayName ?? modelId
}

export function friendlyError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw
    .replace(/^Error invoking remote method '[^']+': Error: /, '')
    .replace(/^Error invoking remote method '[^']+': /, '')
    .replace(/^Error: /, '')
}

export function attachmentIconKind(attachment: Attachment): string {
  return attachment.kind
}

export function toolSummary(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const record = input as Record<string, unknown>
  const pick = (...keys: string[]): string => {
    for (const key of keys) {
      const value = record[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
    return ''
  }
  switch (name) {
    case 'Read':
    case 'NotebookRead':
      return pick('file_path', 'path', 'notebook_path')
    case 'Write':
      return pick('file_path', 'path')
    case 'Edit':
    case 'NotebookEdit':
      return pick('file_path', 'notebook_path', 'path')
    case 'Bash':
      return pick('command', 'description')
    case 'PowerShell':
      return pick('command')
    case 'Glob':
      return pick('pattern', 'path')
    case 'Grep':
      return pick('pattern', 'path')
    case 'LS':
      return pick('path')
    case 'WebFetch':
      return pick('url')
    case 'WebSearch':
      return pick('query')
    case 'Task':
    case 'Agent':
      return pick('description', 'prompt')
    case 'TodoWrite':
      return 'task list updated'
    default:
      return pick('file_path', 'path', 'command', 'query', 'url', 'description', 'prompt')
  }
}

export function toolLabel(name: string): string {
  const labels: Record<string, string> = {
    Read: 'Read file',
    Write: 'Write file',
    Edit: 'Edit file',
    Bash: 'Run command',
    PowerShell: 'Run command',
    Glob: 'Find files',
    Grep: 'Search code',
    LS: 'List folder',
    WebFetch: 'Fetch page',
    WebSearch: 'Web search',
    Task: 'Delegate task',
    Agent: 'Sub-agent',
    TodoWrite: 'Update plan',
  }
  return labels[name] ?? name
}

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`
  const minutes = Math.floor(ms / 60000)
  const seconds = Math.round((ms % 60000) / 1000)
  return `${minutes}m ${seconds}s`
}

export function elapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60)
    return `${hours}:${String(minutes % 60).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

export function cost(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return `$${value.toFixed(value < 0.01 ? 4 : 3)}`
}
