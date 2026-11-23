/**
 * Minimal ZIP reader for local skill imports (stored + deflated entries).
 *
 * Like the tar path, extraction is bounded and refuses to write outside the
 * destination: zip-slip is the classic way a "skill pack" writes to C:\Windows.
 */
import { inflateRawSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { safeJoin } from './tar'

const MAX_ENTRIES = 4000
const MAX_TOTAL_BYTES = 48 * 1024 * 1024
const EOCD = 0x06054b50

export interface ZipResult {
  written: string[]
  skipped: string[]
  error: string | null
}

export function extractZip(archive: Buffer, destination: string, stripComponents = 0): ZipResult {
  const written: string[] = []
  const skipped: string[] = []
  let eocd = -1
  for (let offset = archive.length - 22; offset >= 0 && offset > archive.length - 65_557; offset--) {
    if (archive.readUInt32LE(offset) === EOCD) {
      eocd = offset
      break
    }
  }
  if (eocd < 0) return { written, skipped, error: 'Not a ZIP archive (no end-of-central-directory record).' }

  const count = archive.readUInt16LE(eocd + 10)
  let pointer = archive.readUInt32LE(eocd + 16)
  if (count > MAX_ENTRIES) return { written, skipped, error: `Archive has more than ${MAX_ENTRIES} entries.` }

  let total = 0
  for (let index = 0; index < count; index++) {
    if (pointer + 46 > archive.length) break
    if (archive.readUInt32LE(pointer) !== 0x02014b50) break
    const method = archive.readUInt16LE(pointer + 10)
    const compressedSize = archive.readUInt32LE(pointer + 20)
    const uncompressedSize = archive.readUInt32LE(pointer + 24)
    const nameLength = archive.readUInt16LE(pointer + 28)
    const extraLength = archive.readUInt16LE(pointer + 30)
    const commentLength = archive.readUInt16LE(pointer + 32)
    const localOffset = archive.readUInt32LE(pointer + 42)
    const rawName = archive.subarray(pointer + 46, pointer + 46 + nameLength).toString('utf8')
    pointer += 46 + nameLength + extraLength + commentLength

    if (!rawName || rawName.endsWith('/')) continue

    const segments = rawName.replace(/\\/g, '/').split('/')
    if (segments.length <= stripComponents) continue
    const relativeEntry = segments.slice(stripComponents).join('/')

    if (localOffset + 30 > archive.length) continue
    if (archive.readUInt32LE(localOffset) !== 0x04034b50) continue
    const localNameLength = archive.readUInt16LE(localOffset + 26)
    const localExtraLength = archive.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const data = archive.subarray(dataStart, dataStart + compressedSize)

    let content: Buffer
    try {
      content = method === 0 ? data : method === 8 ? inflateRawSync(data, { maxOutputLength: MAX_TOTAL_BYTES }) : Buffer.alloc(0)
    } catch {
      skipped.push(`${relativeEntry} (could not be decompressed)`)
      continue
    }
    if (method !== 0 && method !== 8) {
      skipped.push(`${relativeEntry} (unsupported compression method ${method})`)
      continue
    }
    if (content.length !== uncompressedSize && method === 0) {
      // Trust the decompressed bytes; the header size is only a hint.
    }
    total += content.length
    if (total > MAX_TOTAL_BYTES) return { written, skipped, error: 'Archive expands past 48 MB.' }

    const target = safeJoin(destination, relativeEntry)
    if (!target) {
      skipped.push(`${relativeEntry} (outside the install directory)`)
      continue
    }
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
    written.push(relativeEntry)
  }

  return { written, skipped, error: written.length === 0 ? 'Archive contained no extractable files.' : null }
}
