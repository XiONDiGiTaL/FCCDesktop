import { mkdirSync, renameSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'

/** Write JSON atomically so a crash can never truncate persisted state. */
export function writeJsonAtomic(filePath: string, value: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true })
  const tmp = `${filePath}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  renameSync(tmp, filePath)
}

export function readJson<T>(filePath: string, fallback: T): T {
  try {
    if (!existsSync(filePath)) return fallback
    const raw = readFileSync(filePath, 'utf8').trim()
    if (!raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}
