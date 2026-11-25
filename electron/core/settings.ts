import { log } from './logger'
import { settingsPath } from './paths'
import { readJson, writeJsonAtomic } from './atomic'
import type { AppSettings, DeepPartial, Density, PermissionMode, Workspace } from '../../src/shared/types'
import type { LocalConfig } from '../../src/shared/local'
import { DEFAULT_USAGE_CONFIG, sanitizeUsageConfig } from '../../src/shared/usage'

const PERMISSION_MODES: PermissionMode[] = ['bypassPermissions', 'acceptEdits', 'default', 'plan']

export const DEFAULT_SETTINGS: AppSettings = {
  version: 1,
  connection: {
    host: '127.0.0.1',
    port: 8082,
    baseUrl: '',
    serverExePath: '',
    claudeExePath: '',
    autoStartServer: false,
  },
  agent: {
    defaultModel: '',
    permissionMode: 'bypassPermissions',
    workingDirectory: '',
    additionalDirs: [],
    showThinking: true,
    freeFirst: true,
    autoFallback: true,
    allowBillableAccounts: false,
    allowLocalFallback: false,
  },
  skills: {
    enabled: true,
    autoInvoke: true,
    maxActive: 3,
    mode: 'native',
    manageExternal: false,
    showIndicator: true,
  },
  local: {
    storageDir: '',
    port: 8080,
    contextSize: 8192,
    gpuLayers: 999,
    backend: 'auto',
    flashAttention: false,
    threads: 0,
    batchSize: 0,
    keepModelInMemory: false,
  },
  // Provider usage monitoring is read-only metadata plus local request counts.
  usage: DEFAULT_USAGE_CONFIG,
  ui: {
    fontScale: 1,
    density: 'comfortable',
    reducedMotion: false,
    sidebarCollapsed: false,
    activityOpen: false,
  },
  workspaces: [],
}

let current: AppSettings | null = null

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function asNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, parsed))
}

function sanitizeWorkspaces(value: unknown): Workspace[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const result: Workspace[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const path = asString(record.path, '').trim()
    if (!path || seen.has(path.toLowerCase())) continue
    seen.add(path.toLowerCase())
    result.push({
      id: asString(record.id, '') || `ws_${Date.now()}_${result.length}`,
      name: asString(record.name, '').trim() || path.split(/[\\/]/).filter(Boolean).pop() || path,
      path,
      addedAt: asNumber(record.addedAt, Date.now(), 0, Number.MAX_SAFE_INTEGER),
    })
  }
  return result.slice(0, 60)
}

export function sanitizeSettings(input: unknown): AppSettings {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const connection = (raw.connection && typeof raw.connection === 'object' ? raw.connection : {}) as Record<string, unknown>
  const agent = (raw.agent && typeof raw.agent === 'object' ? raw.agent : {}) as Record<string, unknown>
  const skills = (raw.skills && typeof raw.skills === 'object' ? raw.skills : {}) as Record<string, unknown>
  const ui = (raw.ui && typeof raw.ui === 'object' ? raw.ui : {}) as Record<string, unknown>

  const baseUrlRaw = asString(connection.baseUrl, '').trim().replace(/\/+$/, '')
  const baseUrl = /^https?:\/\/[^\s]+$/i.test(baseUrlRaw) ? baseUrlRaw : ''
  const permissionMode = PERMISSION_MODES.includes(agent.permissionMode as PermissionMode)
    ? (agent.permissionMode as PermissionMode)
    : DEFAULT_SETTINGS.agent.permissionMode
  const density: Density = ui.density === 'compact' ? 'compact' : 'comfortable'
  const additionalDirs = Array.isArray(agent.additionalDirs)
    ? Array.from(new Set(agent.additionalDirs.filter((v): v is string => typeof v === 'string' && v.trim() !== '').map((v) => v.trim()))).slice(0, 20)
    : []

  return {
    version: 1,
    connection: {
      host: asString(connection.host, DEFAULT_SETTINGS.connection.host).trim() || DEFAULT_SETTINGS.connection.host,
      port: Math.round(asNumber(connection.port, DEFAULT_SETTINGS.connection.port, 1, 65535)),
      baseUrl,
      serverExePath: asString(connection.serverExePath, '').trim(),
      claudeExePath: asString(connection.claudeExePath, '').trim(),
      autoStartServer: asBoolean(connection.autoStartServer, false),
    },
    agent: {
      defaultModel: asString(agent.defaultModel, '').trim(),
      permissionMode,
      workingDirectory: asString(agent.workingDirectory, '').trim(),
      additionalDirs,
      showThinking: asBoolean(agent.showThinking, true),
      freeFirst: asBoolean(agent.freeFirst, true),
      autoFallback: asBoolean(agent.autoFallback, true),
      allowBillableAccounts: asBoolean(agent.allowBillableAccounts, false),
      allowLocalFallback: asBoolean(agent.allowLocalFallback, false),
    },
    local: {
      storageDir: asString((raw.local as Record<string, unknown> | undefined)?.storageDir, '').trim(),
      port: Math.round(
        asNumber(
          (raw.local as Record<string, unknown> | undefined)?.port,
          DEFAULT_SETTINGS.local.port,
          1024,
          65535,
        ),
      ),
      contextSize: Math.round(
        asNumber(
          (raw.local as Record<string, unknown> | undefined)?.contextSize,
          DEFAULT_SETTINGS.local.contextSize,
          2048,
          131072,
        ),
      ),
      gpuLayers: Math.round(
        asNumber(
          (raw.local as Record<string, unknown> | undefined)?.gpuLayers,
          DEFAULT_SETTINGS.local.gpuLayers,
          0,
          999,
        ),
      ),
      backend: (() => {
        const value = (raw.local as Record<string, unknown> | undefined)?.backend
        return value === 'vulkan' || value === 'rocm' || value === 'metal' || value === 'cpu' ? value : 'auto'
      })(),
      flashAttention: asBoolean(
        (raw.local as Record<string, unknown> | undefined)?.flashAttention,
        DEFAULT_SETTINGS.local.flashAttention,
      ),
      threads: Math.round(
        asNumber((raw.local as Record<string, unknown> | undefined)?.threads, DEFAULT_SETTINGS.local.threads, 0, 256),
      ),
      batchSize: Math.round(
        asNumber(
          (raw.local as Record<string, unknown> | undefined)?.batchSize,
          DEFAULT_SETTINGS.local.batchSize,
          0,
          8192,
        ),
      ),
      keepModelInMemory: asBoolean(
        (raw.local as Record<string, unknown> | undefined)?.keepModelInMemory,
        DEFAULT_SETTINGS.local.keepModelInMemory,
      ),
    },
    skills: {
      enabled: asBoolean(skills.enabled, DEFAULT_SETTINGS.skills.enabled),
      autoInvoke: asBoolean(skills.autoInvoke, DEFAULT_SETTINGS.skills.autoInvoke),
      maxActive: Math.round(asNumber(skills.maxActive, DEFAULT_SETTINGS.skills.maxActive, 1, 5)),
      mode: skills.mode === 'inline' ? 'inline' : 'native',
      manageExternal: asBoolean(skills.manageExternal, DEFAULT_SETTINGS.skills.manageExternal),
      showIndicator: asBoolean(skills.showIndicator, DEFAULT_SETTINGS.skills.showIndicator),
    },
    usage: sanitizeUsageConfig(raw.usage),
    ui: {
      fontScale: asNumber(ui.fontScale, 1, 0.85, 1.3),
      density,
      reducedMotion: asBoolean(ui.reducedMotion, false),
      sidebarCollapsed: asBoolean(ui.sidebarCollapsed, false),
      activityOpen: asBoolean(ui.activityOpen, false),
    },
    workspaces: sanitizeWorkspaces(raw.workspaces),
  }
}

export function getSettings(): AppSettings {
  if (!current) {
    const stored = readJson<unknown>(settingsPath(), null)
    current = stored ? sanitizeSettings(stored) : structuredClone(DEFAULT_SETTINGS)
  }
  return current
}

export function persist(settings: AppSettings): AppSettings {
  current = sanitizeSettings(settings)
  try {
    writeJsonAtomic(settingsPath(), current)
  } catch (error) {
    log.error('settings', `Failed to persist settings: ${String(error)}`)
  }
  return current
}

export function updateSettings(patch: DeepPartial<AppSettings>): AppSettings {
  const base = structuredClone(getSettings())
  const next: AppSettings = {
    ...base,
    connection: { ...base.connection, ...(patch.connection ?? {}) },
    agent: { ...base.agent, ...(patch.agent ?? {}) },
    skills: { ...base.skills, ...(patch.skills ?? {}) },
    local: { ...base.local, ...((patch as { local?: Partial<LocalConfig> }).local ?? {}) },
    usage: { ...base.usage, ...(patch.usage ?? {}) },
    ui: { ...base.ui, ...(patch.ui ?? {}) },
    workspaces: patch.workspaces !== undefined ? (patch.workspaces as Workspace[]) : base.workspaces,
  }
  return persist(next)
}

export function resetSettings(): AppSettings {
  return persist(structuredClone(DEFAULT_SETTINGS))
}

/** Effective FCC base URL, honouring an explicit override when present. */
export function effectiveBaseUrl(settings = getSettings()): string {
  if (settings.connection.baseUrl) return settings.connection.baseUrl
  const host = settings.connection.host === '0.0.0.0' ? '127.0.0.1' : settings.connection.host
  return `http://${host}:${settings.connection.port}`
}
