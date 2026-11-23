/**
 * A small, strict YAML subset parser for SKILL.md frontmatter.
 *
 * Skills are authored by third parties, so this never evaluates anything: it
 * reads flat `key: scalar`, two-level maps (`metadata:`) and `- item` lists,
 * which is what the Agent Skills format uses. Anything it cannot understand is
 * reported as a parse issue instead of being silently dropped.
 */

export interface FrontmatterResult {
  data: Record<string, unknown>
  body: string
  issues: string[]
}

const KEY = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) return value.slice(1, -1)
  }
  return value
}

function scalar(value: string): unknown {
  const trimmed = value.trim()
  if (!trimmed) return ''
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false
  if (trimmed === 'null' || trimmed === '~') return null
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed)
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed
      .slice(1, -1)
      .split(',')
      .map((entry) => stripQuotes(entry.trim()))
      .filter((entry) => entry !== '')
  }
  return stripQuotes(trimmed)
}

/** Split a document into its frontmatter block and the remaining body. */
export function splitFrontmatter(text: string): { raw: string | null; body: string; issues: string[] } {
  const normalised = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  if (!normalised.startsWith('---')) return { raw: null, body: normalised, issues: ['No YAML frontmatter found.'] }
  const end = normalised.indexOf('\n---', 3)
  if (end < 0) return { raw: null, body: normalised, issues: ['Frontmatter is not closed with a second --- line.'] }
  const raw = normalised.slice(3, end).replace(/^\n/, '')
  const after = normalised.slice(end + 4)
  return { raw, body: after.replace(/^\n/, ''), issues: [] }
}

export function parseFrontmatter(text: string): FrontmatterResult {
  const split = splitFrontmatter(text)
  const issues = [...split.issues]
  if (split.raw === null) return { data: {}, body: split.body, issues }

  const data: Record<string, unknown> = {}
  let blockKey: string | null = null
  let blockIndent = 0
  let blockLines: string[] = []
  let listKey: string | null = null

  const flushBlock = (): void => {
    if (!blockKey) return
    data[blockKey] = blockLines.join('\n').trim()
    blockKey = null
    blockLines = []
  }

  for (const rawLine of split.raw.split('\n')) {
    const line = rawLine.replace(/\t/g, '  ')
    if (!line.trim()) continue
    const indent = line.length - line.trimStart().length

    if (blockKey) {
      if (indent > blockIndent) {
        blockLines.push(line.trimStart())
        continue
      }
      flushBlock()
    }

    if (indent === 0 && /^-\s+/.test(line)) {
      issues.push(`List item at the top level is not attached to a key: ${line.trim()}`)
      continue
    }

    if (indent === 0) {
      const match = KEY.exec(line.trim())
      if (!match) {
        issues.push(`Unreadable frontmatter line: ${line.trim()}`)
        continue
      }
      const key = match[1] as string
      const rest = (match[2] ?? '').trim()
      listKey = null
      if (rest === '' ) {
        // Either a nested map, a block scalar or a list follows.
        blockKey = null
        data[key] = {}
        listKey = key
        continue
      }
      if (rest === '|' || rest === '>' || rest === '|-' || rest === '>-' || rest === '|+' || rest === '>+') {
        blockKey = key
        blockIndent = 0
        blockLines = []
        continue
      }
      data[key] = scalar(rest)
      continue
    }

    // Indented content belongs to the previous top-level key.
    const parent = listKey ?? null
    const value = line.trim()
    if (parent) {
      const existing = data[parent]
      if (Array.isArray(existing)) {
        if (value.startsWith('- ')) existing.push(scalar(value.slice(2)))
        else existing.push(scalar(value))
        continue
      }
      const map = (existing && typeof existing === 'object' ? existing : {}) as Record<string, unknown>
      if (value.startsWith('- ')) {
        const list = Array.isArray(map['']) ? (map[''] as unknown[]) : []
        list.push(scalar(value.slice(2)))
        map[''] = list
        data[parent] = map
        continue
      }
      const nested = KEY.exec(value)
      if (nested) {
        map[nested[1] as string] = scalar(nested[2] ?? '')
        data[parent] = map
        continue
      }
      if (Array.isArray(existing)) {
        existing.push(scalar(value))
        continue
      }
      data[parent] = value
      continue
    }
    issues.push(`Indented value without a parent key: ${value}`)
  }
  flushBlock()

  // `metadata:` with `- x` list items was stored under the '' key; normalise it.
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const record = value as Record<string, unknown>
      if (Array.isArray(record[''])) {
        data[key] = record['']
      } else if (Object.keys(record).length === 0) {
        data[key] = ''
      }
    }
  }

  return { data, body: split.body, issues }
}

export function stringField(data: Record<string, unknown>, key: string): string {
  const value = data[key]
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value)) return value.map(String).join(', ').trim()
  return ''
}

export function stringList(data: Record<string, unknown>, key: string): string[] {
  const value = data[key]
  if (Array.isArray(value)) return value.map(String).map((entry) => entry.trim()).filter(Boolean)
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
  }
  return []
}

export function stringMap(data: Record<string, unknown>, key: string): Record<string, string> {
  const value = data[key]
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: Record<string, string> = {}
  for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entryValue === 'string' || typeof entryValue === 'number' || typeof entryValue === 'boolean') {
      result[entryKey] = String(entryValue)
    }
  }
  return result
}
