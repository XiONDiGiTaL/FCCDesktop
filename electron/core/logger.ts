const MAX_LINES = 400
const lines: string[] = []

function stamp(): string {
  return new Date().toISOString().slice(11, 23)
}

function push(level: string, scope: string, message: string): void {
  const line = `${stamp()} ${level.padEnd(5)} ${scope}: ${message}`
  lines.push(line)
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES)
  if (level === 'ERROR') console.error(line)
  else if (level === 'WARN') console.warn(line)
  else console.log(line)
}

export const log = {
  info: (scope: string, message: string) => push('INFO', scope, message),
  warn: (scope: string, message: string) => push('WARN', scope, message),
  error: (scope: string, message: string) => push('ERROR', scope, message),
}

export function logTail(limit = 160): string[] {
  return lines.slice(-limit)
}

/** Strip anything that looks like a credential before it can reach a log or the UI. */
export function redact(text: string): string {
  return text
    .replace(/(sk-[A-Za-z0-9_-]{8,})/g, '[redacted-key]')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{8,}/gi, '$1[redacted]')
    .replace(/("?(?:api[_-]?key|token|auth[_-]?token|password)"?\s*[:=]\s*")[^"]{4,}(")/gi, '$1[redacted]$2')
}
