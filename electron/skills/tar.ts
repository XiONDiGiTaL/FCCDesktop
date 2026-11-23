/**
 * Dependency-free tar.gz extraction for GitHub skill downloads.
 *
 * Two things matter here and both are enforced rather than assumed: no entry may
 * escape the destination directory (path traversal, absolute paths, drive
 * letters, symlinks) and the archive may not expand past a hard budget.
 */
import { gunzipSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, resolve, sep } from 'node:path'

const MAX_ENTRIES = 4000
const MAX_TOTAL_BYTES = 48 * 1024 * 1024
const BLOCK = 512

export interface ExtractResult {
  written: string[]
  skipped: string[]
  error: string | null
}

function readString(block: Buffer, start: number, length: number): string {
  const slice = block.subarray(start, start + length)
  const end = slice.indexOf(0)
  return slice.subarray(0, end < 0 ? slice.length : end).toString('utf8').trim()
}

function readOctal(block: Buffer, start: number, length: number): number {
  const text = readString(block, start, length).replace(/[^0-7]/g, '')
  if (!text) return 0
  return parseInt(text, 8)
}

/** Safe destination inside root, or null when the entry tries to leave it. */
export function safeJoin(root: string, entry: string): string | null {
  const cleaned = entry.replace(/\\/g, '/').replace(/^\.\//, '')
  if (!cleaned || cleaned === '.' || cleaned === './') return null
  if (isAbsolute(cleaned) || /^[a-zA-Z]:/.test(cleaned)) return null
  const target = normalize(join(root, cleaned))
  const rootResolved = resolve(root)
  if (target !== rootResolved && !target.startsWith(`${rootResolved}${sep}`)) return null
  return target
}

export function extractTarGz(archive: Buffer, destination: string, stripComponents = 1): ExtractResult {
  const written: string[] = []
  const skipped: string[] = []
  let tar: Buffer
  try {
    tar = gunzipSync(archive, { maxOutputLength: MAX_TOTAL_BYTES * 2 })
  } catch (error) {
    return { written, skipped, error: `Archive could not be decompressed: ${String(error)}` }
  }

  mkdirSync(destination, { recursive: true })
  let offset = 0
  let total = 0
  let entries = 0
  const longNames: string[] = []

  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK)
    if (header.every((byte) => byte === 0)) break
    offset += BLOCK
    if (entries++ > MAX_ENTRIES) {
      return { written, skipped, error: `Archive has more than ${MAX_ENTRIES} entries.` }
    }

    const name = readString(header, 0, 100)
    const prefix = readString(header, 345, 155)
    const size = readOctal(header, 124, 12)
    const type = String.fromCharCode(header[156] ?? 48)
    const fullName = prefix ? `${prefix}/${name}` : name

    // GNU long name (type 'L') parks the real name in the next block.
    if (type === 'L') {
      const length = size
      const data = tar.subarray(offset, offset + length).toString('utf8').replace(/\0+$/, '')
      longNames.push(data)
      offset += Math.ceil(length / BLOCK) * BLOCK
      continue
    }

    const entryName = longNames.length > 0 ? (longNames.pop() ?? fullName) : fullName
    const dataStart = offset
    offset += Math.ceil(size / BLOCK) * BLOCK

    if (type === '5') continue
    if (type === '2' || type === '1') {
      skipped.push(`${entryName} (link entries are never followed)`)
      continue
    }
    if (type !== '0' && type !== '7' && type !== 'x' && type !== 'g') {
      skipped.push(`${entryName} (unsupported entry type)`)
      continue
    }

    const parts = entryName.replace(/\\/g, '/').split('/')
    if (parts.length <= stripComponents) continue
    const relativeEntry = parts.slice(stripComponents).join('/')
    const target = safeJoin(destination, relativeEntry)
    if (!target) {
      skipped.push(`${entryName} (outside the install directory)`)
      continue
    }
    total += size
    if (total > MAX_TOTAL_BYTES) {
      return { written, skipped, error: `Archive expands past ${Math.round(MAX_TOTAL_BYTES / 1024 / 1024)} MB.` }
    }
    mkdirSync(dirname(target), { recursive: true })
    const chunk = tar.subarray(dataStart, dataStart + size)
    writeFileSync(target, chunk)
    written.push(relativeEntry)
  }

  return { written, skipped, error: written.length === 0 ? 'Archive contained no extractable files.' : null }
}
