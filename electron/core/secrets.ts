import { safeStorage } from 'electron'
import { readJson, writeJsonAtomic } from './atomic'
import { secretsPath } from './paths'
import { log } from './logger'
import type { SecretStatus } from '../../src/shared/types'

interface SecretFile {
  proxyToken?: string
}

let cache: SecretFile | null = null
let plainToken: string | null = null

function available(): boolean {
  try {
    return safeStorage.isEncryptionAvailable()
  } catch {
    return false
  }
}

function load(): SecretFile {
  if (!cache) cache = readJson<SecretFile>(secretsPath(), {})
  return cache
}

function save(file: SecretFile): void {
  cache = file
  try {
    writeJsonAtomic(secretsPath(), file)
  } catch (error) {
    log.error('secrets', `Failed to persist credentials: ${String(error)}`)
  }
}

export function secretStatus(): SecretStatus {
  return {
    hasProxyToken: Boolean(getProxyToken()),
    backend: available() ? 'dpapi' : 'unavailable',
  }
}

/** Reads the FCC proxy token. On Windows the value is protected with DPAPI via safeStorage. */
export function getProxyToken(): string {
  if (plainToken !== null) return plainToken
  const stored = load().proxyToken
  if (!stored) return ''
  try {
    if (available()) {
      plainToken = safeStorage.decryptString(Buffer.from(stored, 'base64'))
    } else {
      // Encrypted blob exists but the OS key store is unavailable (different user/machine).
      log.warn('secrets', 'Stored credential cannot be decrypted on this machine.')
      plainToken = ''
    }
  } catch (error) {
    log.warn('secrets', `Could not decrypt stored credential: ${String(error)}`)
    plainToken = ''
  }
  return plainToken
}

export function setProxyToken(token: string): SecretStatus {
  const trimmed = token.trim()
  if (!trimmed) return clearProxyToken()
  if (!available()) {
    throw new Error('Windows credential protection is unavailable, so the token was not stored.')
  }
  const encrypted = safeStorage.encryptString(trimmed).toString('base64')
  save({ ...load(), proxyToken: encrypted })
  plainToken = trimmed
  return secretStatus()
}

export function clearProxyToken(): SecretStatus {
  save({ ...load(), proxyToken: undefined })
  plainToken = null
  return secretStatus()
}
