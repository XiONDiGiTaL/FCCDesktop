import { existsSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { homedir } from 'node:os'
import type { ToolLocation } from '../../src/shared/types'
import { getSettings } from '../core/settings'

type ToolKind = 'server' | 'claude'

const BINARY: Record<ToolKind, string> = {
  server: 'fcc-server.exe',
  claude: 'fcc-claude.exe',
}

function isFile(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile()
  } catch {
    return false
  }
}

function searchPath(name: string): string | null {
  const entries = (process.env.PATH ?? '').split(delimiter).filter(Boolean)
  for (const entry of entries) {
    const candidate = join(entry, name)
    if (isFile(candidate)) return candidate
  }
  return null
}

function defaultCandidates(kind: ToolKind): string[] {
  const home = homedir()
  const name = BINARY[kind]
  const appData = process.env.APPDATA ?? ''
  const localAppData = process.env.LOCALAPPDATA ?? ''
  return [
    join(home, '.local', 'bin', name),
    appData ? join(appData, 'uv', 'tools', 'free-claude-code', 'Scripts', name) : '',
    localAppData ? join(localAppData, 'Programs', 'Free Claude Code', name) : '',
    localAppData ? join(localAppData, 'Programs', 'fcc', name) : '',
  ].filter(Boolean)
}

export function resolveTool(kind: ToolKind): { path: string | null; source: ToolLocation['source'] } {
  const settings = getSettings()
  const configured = kind === 'server' ? settings.connection.serverExePath : settings.connection.claudeExePath
  if (configured) {
    return isFile(configured) ? { path: configured, source: 'settings' } : { path: null, source: 'settings' }
  }
  const fromPath = searchPath(BINARY[kind])
  if (fromPath) return { path: fromPath, source: 'path' }
  for (const candidate of defaultCandidates(kind)) {
    if (isFile(candidate)) return { path: candidate, source: 'default' }
  }
  return { path: null, source: 'missing' }
}

export function detectTools(): ToolLocation[] {
  return (['server', 'claude'] as ToolKind[]).map((kind) => {
    const resolved = resolveTool(kind)
    return {
      id: kind,
      label: kind === 'server' ? 'FCC server' : 'FCC agent',
      path: resolved.path,
      exists: resolved.path !== null,
      source: resolved.source,
    }
  })
}
