import { join } from 'node:path'
import type { AgentEvent, ConnectionStatus } from '../../src/shared/types'
import type {
  LocalUsageEvent,
  ProviderFailure,
  ProviderUsage,
  RateLimitHit,
  UsageConfig,
  UsageOutcome,
  UsageState,
  UsageWindow,
} from '../../src/shared/usage'
import {
  analyzeProviderFailure,
  availabilityFrom,
  EXHAUSTED_HOLD_MS,
  INFERRED_HOLD_MS,
  quotaCapability,
  rateLimitActive,
  sanitizeUsageConfig,
  summarizeLocalUsage,
} from '../../src/shared/usage'
import type { ConnectionManager } from '../fcc/connection'
import type { FreeRouter } from '../fcc/free-router'
import { classifyModel, type ProviderAdminStatus } from '../../src/shared/free-providers'
import { requestJson } from '../fcc/http'
import { getSettings, updateSettings } from '../core/settings'
import { dataRoot } from '../core/paths'
import { readJson, writeJsonAtomic } from '../core/atomic'
import { log } from '../core/logger'

const STORE_VERSION = 1
const RETENTION_DAYS = 30
const MAX_EVENTS = 3000
const MIN_POLL_SECONDS = 30
const MIN_REFRESH_GAP = 10000

interface CachedProvider {
  providerId: string | null
  providerLabel: string | null
  model: string | null
  keyState: 'configured' | 'missing' | 'unknown'
  keyLabel: string
  keyDetail: string | null
  syncedAt: number
  windows: UsageWindow[]
  providers: ProviderAdminStatus[]
}

interface PersistedUsage {
  version: number
  events: LocalUsageEvent[]
  rateLimit: RateLimitHit | null
  lastFailure: ProviderFailure | null
  provider: CachedProvider | null
}

interface RootInfo {
  status?: unknown
  provider?: unknown
  model?: unknown
}

interface AdminProvider {
  provider_id?: unknown
  display_name?: unknown
  status?: unknown
  label?: unknown
}

interface AdminStatus {
  provider?: unknown
  model?: unknown
  provider_status?: unknown
}

const OUTCOMES: UsageOutcome[] = ['success', 'failed', 'rate_limited', 'cancelled']

function text(value: unknown, max = 200): string | null {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null
}

function sanitizeEvents(input: unknown): LocalUsageEvent[] {
  if (!Array.isArray(input)) return []
  const events: LocalUsageEvent[] = []
  for (const entry of input) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const at = count(record.at)
    const outcome = OUTCOMES.includes(record.outcome as UsageOutcome) ? (record.outcome as UsageOutcome) : null
    if (at === null || outcome === null) continue
    events.push({
      at,
      model: text(record.model, 200) ?? 'Server default',
      outcome,
      inputTokens: count(record.inputTokens),
      outputTokens: count(record.outputTokens),
      durationMs: count(record.durationMs),
    })
  }
  return events.slice(-MAX_EVENTS)
}

function sanitizeRateLimit(input: unknown): RateLimitHit | null {
  if (!input || typeof input !== 'object') return null
  const record = input as Record<string, unknown>
  const at = count(record.at)
  if (at === null) return null
  return {
    at,
    providerLabel: text(record.providerLabel, 80),
    category: text(record.category, 80),
    exhausted: Boolean(record.exhausted),
    retryAfterSeconds: count(record.retryAfterSeconds),
    cooldownUntil: count(record.cooldownUntil),
    resetAt: count(record.resetAt),
    source: record.source === 'header' ? 'header' : 'inferred',
    requestId: text(record.requestId, 120),
  }
}

function sanitizeFailure(input: unknown): ProviderFailure | null {
  if (!input || typeof input !== 'object') return null
  const record = input as Record<string, unknown>
  const at = count(record.at)
  const message = text(record.message, 400)
  if (at === null || !message) return null
  const kind = record.kind === 'auth' || record.kind === 'server' || record.kind === 'network' ? record.kind : 'unknown'
  return { at, kind, message }
}

function sanitizeCache(input: unknown): CachedProvider | null {
  if (!input || typeof input !== 'object') return null
  const record = input as Record<string, unknown>
  const syncedAt = count(record.syncedAt)
  if (syncedAt === null) return null
  const keyState =
    record.keyState === 'configured' || record.keyState === 'missing' ? record.keyState : 'unknown'
  return {
    providerId: text(record.providerId, 80),
    providerLabel: text(record.providerLabel, 120),
    model: text(record.model, 240),
    keyState,
    keyLabel: text(record.keyLabel, 60) ?? 'Unknown',
    keyDetail: text(record.keyDetail, 300),
    syncedAt,
    windows: [],
    providers: Array.isArray(record.providers)
      ? (record.providers as unknown[])
          .map((entry) => {
            if (!entry || typeof entry !== 'object') return null
            const item = entry as Record<string, unknown>
            const providerId = text(item.providerId, 80)
            const status = text(item.status, 40)
            if (!providerId || !status) return null
            return {
              providerId,
              displayName: text(item.displayName, 120) ?? providerId,
              status,
            } satisfies ProviderAdminStatus
          })
          .filter((entry): entry is ProviderAdminStatus => entry !== null)
      : [],
  }
}

function cooldownWindow(hit: RateLimitHit): UsageWindow {
  const resetAt = hit.cooldownUntil ?? hit.resetAt
  return {
    id: 'rate-limit-cooldown',
    label: 'Rate-limit cooldown',
    kind: 'cooldown',
    source: hit.source,
    used: null,
    limit: null,
    remaining: null,
    percent: null,
    resetAt,
    note:
      resetAt !== null
        ? 'The provider supplied this retry or reset time.'
        : 'The provider did not include a retry or reset time.',
  }
}

function keyStateFrom(raw: unknown): { state: 'configured' | 'missing' | 'unknown'; label: string; detail: string | null } {
  const status = typeof raw === 'string' ? raw.toLowerCase() : ''
  if (status === 'configured' || status === 'ready' || status === 'available') {
    return { state: 'configured', label: 'Configured', detail: null }
  }
  if (status === 'missing_key' || status === 'disconnected' || status === 'not_configured' || status === 'unavailable') {
    return {
      state: 'missing',
      label: 'Not configured',
      detail: 'FCC reports that this provider has no usable credentials.',
    }
  }
  return { state: 'unknown', label: 'Unknown', detail: null }
}

/**
 * Provider usage monitor.
 *
 * It reads FCC's own metadata (never provider keys), learns from the errors the
 * agent reports, and counts this app's requests. That combination is the most
 * that can be stated honestly for providers such as NVIDIA NIM, which publish
 * no usage endpoint.
 */
export class UsageMonitor {
  private events: LocalUsageEvent[] = []
  private rateLimit: RateLimitHit | null = null
  private lastFailure: ProviderFailure | null = null
  private cache: CachedProvider | null = null
  private pending = new Map<string, { model: string; at: number }>()
  private listeners = new Set<(state: UsageState) => void>()
  private timer: NodeJS.Timeout | null = null
  private retryTimer: NodeJS.Timeout | null = null
  private expiryTimer: NodeJS.Timeout | null = null
  private persistTimer: NodeJS.Timeout | null = null
  private inflight: Promise<UsageState> | null = null
  private lastRefreshAt = 0
  private stale = false
  private monitorError: string | null = null
  private started = false
  private unwatchConnection: (() => void) | null = null
  private lastConnectionState: ConnectionStatus['state'] | null = null

  constructor(
    private readonly connection: ConnectionManager,
    private readonly router: FreeRouter,
  ) {}

  // ------------------------------------------------------------------ lifecycle

  start(): void {
    if (this.started) return
    this.started = true
    this.load()
    this.arm()
    this.lastConnectionState = this.connection.current().state
    this.unwatchConnection = this.connection.watch((status) => {
      try {
        this.onConnectionStatus(status)
      } catch (error) {
        log.warn('usage', `Connection watch failed: ${String(error)}`)
      }
    })
    // FCC's first probe runs after this monitor starts. Reading provider
    // metadata now would only record "offline", so the first read happens when
    // the connection reports itself connected.
    if (this.lastConnectionState === 'connected') void this.refresh('startup')
  }

  /**
   * A successful probe (including a reconnect, or a server this app started)
   * makes provider metadata readable; anything cached before it described the
   * previous connection state.
   */
  private onConnectionStatus(status: ConnectionStatus): void {
    const previous = this.lastConnectionState
    this.lastConnectionState = status.state
    if (status.state === 'connected') {
      if (previous !== 'connected') void this.refresh('connect')
      return
    }
    // Show the disconnect at once instead of waiting for the next poll.
    if (previous === 'connected') {
      this.stale = this.cache !== null
      this.emit()
    }
  }

  stop(): void {
    this.unwatchConnection?.()
    this.unwatchConnection = null
    this.started = false
    if (this.timer) clearInterval(this.timer)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.clearRateLimitExpiry()
    this.timer = null
    this.retryTimer = null
    this.persistTimer = null
    this.flush()
  }

  onChange(listener: (state: UsageState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): UsageState {
    const state = this.state()
    for (const listener of this.listeners) {
      try {
        listener(state)
      } catch (error) {
        log.warn('usage', `Usage listener failed: ${String(error)}`)
      }
    }
    return state
  }

  // --------------------------------------------------------------------- state

  state(): UsageState {
    const now = Date.now()
    const current = this.connection.current()
    const providerId = this.cache?.providerId ?? current.provider ?? null
    const capability = quotaCapability(providerId)
    const keyState = this.cache?.keyState ?? 'unknown'
    const lastSuccessAt =
      [...this.events].reverse().find((event) => event.outcome === 'success')?.at ?? null
    const { availability, summary } = availabilityFrom({
      connected: current.state === 'connected',
      rateLimit: this.rateLimit,
      keyState,
      lastFailure: this.lastFailure,
      now,
      providerId,
      lastSuccessAt,
    })
    // Only a report that is still current contributes a window or a countdown;
    // an expired one stays in `lastRateLimit` as history with its timestamp.
    const rateLimitCurrent = this.rateLimit !== null && rateLimitActive(this.rateLimit, now)
    const windows: UsageWindow[] = [...(this.cache?.windows ?? [])]
    if (this.rateLimit && rateLimitCurrent) {
      windows.unshift(cooldownWindow(this.rateLimit))
    }
    const provider: ProviderUsage = {
      providerId,
      providerLabel: this.cache?.providerLabel ?? capability.providerLabel,
      model: this.cache?.model ?? current.serverModel ?? null,
      availability,
      summary,
      windows,
      capability,
      cooldownUntil: rateLimitCurrent
        ? this.rateLimit?.cooldownUntil ?? this.rateLimit?.resetAt ?? null
        : null,
      lastRateLimit: this.rateLimit,
      lastFailure: this.lastFailure,
      keyStatus: {
        state: keyState,
        label: this.cache?.keyLabel ?? 'Unknown',
        detail:
          this.cache?.keyDetail ??
          (keyState === 'unknown' && current.state === 'connected'
            ? 'FCC did not expose provider account status.'
            : null),
      },
      endpoint: current.baseUrl,
      speed: { latencyMs: current.latencyMs },
      syncedAt: this.cache?.syncedAt ?? null,
      cached: this.stale && this.cache !== null,
      error: this.monitorError,
    }
    const settings = getSettings()
    const activeModel = provider.model ?? ''
    const activeFree = activeModel ? classifyModel(activeModel).free : false
    const routing = {
      ...this.router.snapshot(),
      providers: this.router.providers(this.cache?.providers ?? []),
      activeModel,
      activeFree,
      activeProvider: activeModel ? classifyModel(activeModel).providerId : provider.providerId ?? '',
      autoFallback: settings.agent.autoFallback,
      freeFirst: settings.agent.freeFirst,
      allowBillable: settings.agent.allowBillableAccounts,
      allowLocal: settings.agent.allowLocalFallback,
    }
    return {
      provider,
      local: summarizeLocalUsage(this.events, now, RETENTION_DAYS),
      config: sanitizeUsageConfig(settings.usage),
      routing,
      sampledAt: now,
    }
  }

  // -------------------------------------------------------------------- config

  configure(patch: Partial<UsageConfig>): UsageState {
    const current = sanitizeUsageConfig(getSettings().usage)
    const next = sanitizeUsageConfig({ ...current, ...patch })
    updateSettings({ usage: next })
    this.arm()
    void this.refresh('config', true)
    return this.emit()
  }

  clearHistory(): UsageState {
    this.events = []
    this.rateLimit = null
    this.clearRateLimitExpiry()
    this.lastFailure = null
    this.monitorError = null
    this.persist()
    log.info('usage', 'Local usage history cleared')
    return this.emit()
  }

  private arm(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    const config = sanitizeUsageConfig(getSettings().usage)
    if (!config.enabled || config.pollSeconds <= 0) return
    const seconds = Math.max(MIN_POLL_SECONDS, config.pollSeconds)
    this.timer = setInterval(() => {
      void this.refresh('poll')
    }, seconds * 1000)
    this.timer.unref?.()
  }

  // ------------------------------------------------------------------ requests

  beginRequest(conversationId: string, model: string): void {
    this.pending.set(conversationId, {
      model: text(model, 200) ?? this.fallbackModel(),
      at: Date.now(),
    })
  }

  /** A send that never reached the agent still counts as an attempt. */
  failRequest(conversationId: string, message: string): void {
    const pending = this.pending.get(conversationId)
    if (!pending) return
    this.pending.delete(conversationId)
    const analysis = analyzeProviderFailure(message, Date.now())
    const outcome: UsageOutcome =
      analysis.rateLimited || analysis.quotaExhausted
        ? 'rate_limited'
        : analysis.authFailed || analysis.serverError || analysis.kind === 'network'
          ? 'failed'
          : 'failed'
    this.record(pending.model, outcome, null, null, null)
    if (analysis.rateLimited || analysis.quotaExhausted) this.noteRateLimit(analysis)
    else if (analysis.kind !== 'unknown') this.noteFailure(analysis)
    this.schedulePersist()
    this.emit()
  }

  observe(event: AgentEvent): void {
    if (event.type === 'model-fallback') {
      // The failed attempt belongs to the old model; the replayed turn belongs
      // to the new one. Turn-end will record the successful provider.
      const pending = this.pending.get(event.conversationId)
      if (pending) this.pending.set(event.conversationId, { ...pending, model: event.to })
      this.emit()
      return
    }
    if (event.type === 'free-unavailable') {
      this.emit()
      return
    }
    if (event.type === 'turn-retry') {
      const pending = this.pending.get(event.conversationId)
      const analysis = analyzeProviderFailure(event.detail ?? '', Date.now())
      this.record(
        pending?.model ?? this.fallbackModel(),
        analysis.rateLimited || analysis.quotaExhausted ? 'rate_limited' : 'failed',
        null,
        null,
        null,
      )
      if (analysis.rateLimited || analysis.quotaExhausted) this.noteRateLimit(analysis)
      this.emit()
      return
    }

    if (event.type === 'turn-end') {
      const pending = this.pending.get(event.conversationId)
      this.pending.delete(event.conversationId)
      const model = pending?.model ?? this.fallbackModel()
      const analysis = event.isError ? analyzeProviderFailure(event.resultText ?? '', Date.now()) : null
      const outcome: UsageOutcome = event.cancelled
        ? 'cancelled'
        : event.isError
          ? analysis && (analysis.rateLimited || analysis.quotaExhausted)
            ? 'rate_limited'
            : 'failed'
          : 'success'
      this.record(
        model,
        outcome,
        event.inputTokens,
        event.outputTokens,
        event.durationMs,
      )
      if (analysis && (analysis.rateLimited || analysis.quotaExhausted)) {
        this.noteRateLimit(analysis)
      } else if (analysis && analysis.kind !== 'unknown') {
        this.noteFailure(analysis)
      }
      // A real answer proves the provider is serving again, so an inferred
      // hold from an earlier 429 no longer applies.
      if (!event.isError && !event.cancelled) {
        this.rateLimit = null
        this.clearRateLimitExpiry()
      }
      this.emit()
      this.schedulePersist()
      this.scheduleRefresh(3000)
      return
    }

    if (event.type === 'error') {
      const textValue = `${event.message}\n${event.detail ?? ''}`
      if (!/429|rate|quota|throttl|unauthori|invalid api key|5\d\d/i.test(textValue)) return
      const analysis = analyzeProviderFailure(textValue, Date.now())
      if (analysis.rateLimited || analysis.quotaExhausted) this.noteRateLimit(analysis)
      else if (analysis.kind !== 'unknown') this.noteFailure(analysis)
      this.scheduleRefresh(6000)
      return
    }

    if (event.type === 'stderr') {
      if (!/429|rate limit|quota|too many requests/i.test(event.text)) return
      const analysis = analyzeProviderFailure(event.text, Date.now())
      if (analysis.rateLimited || analysis.quotaExhausted) this.noteRateLimit(analysis)
    }
  }

  private record(
    model: string,
    outcome: UsageOutcome,
    inputTokens: number | null,
    outputTokens: number | null,
    durationMs: number | null,
  ): void {
    this.events.push({
      at: Date.now(),
      model: model || 'Server default',
      outcome,
      inputTokens: count(inputTokens),
      outputTokens: count(outputTokens),
      durationMs: count(durationMs),
    })
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS)
    const cutoff = Date.now() - RETENTION_DAYS * 86400000
    this.events = this.events.filter((event) => event.at >= cutoff)
  }

  private noteRateLimit(analysis: ReturnType<typeof analyzeProviderFailure>): void {
    const now = Date.now()
    if (
      this.rateLimit &&
      now - this.rateLimit.at < 8000 &&
      this.rateLimit.exhausted === analysis.quotaExhausted &&
      this.rateLimit.category === analysis.category
    ) {
      return
    }
    this.rateLimit = {
      at: now,
      providerLabel: analysis.providerLabel ?? this.cache?.providerLabel ?? null,
      category: analysis.category,
      exhausted: analysis.quotaExhausted,
      retryAfterSeconds: analysis.retryAfterSeconds,
      cooldownUntil: analysis.cooldownUntil,
      resetAt: analysis.resetAt,
      source: 'inferred',
      requestId: analysis.requestId,
    }
    this.lastFailure = null
    this.monitorError = null
    this.armRateLimitExpiry()
    log.warn(
      'usage',
      `Rate limit observed${analysis.quotaExhausted ? ' (quota exhausted)' : ''}${analysis.resetAt ? `; reset at ${new Date(analysis.resetAt).toISOString()}` : '; no reset time supplied'}`,
    )
    this.emit()
    this.schedulePersist()
    this.scheduleRefresh(2000)
  }

  private noteFailure(analysis: ReturnType<typeof analyzeProviderFailure>): void {
    const kind = analysis.authFailed
      ? 'auth'
      : analysis.serverError
        ? 'server'
        : analysis.kind === 'network'
          ? 'network'
          : 'unknown'
    if (kind === 'unknown') return
    this.lastFailure = { at: Date.now(), kind, message: analysis.summary }
    this.emit()
    this.schedulePersist()
  }

  private fallbackModel(): string {
    return this.cache?.model ?? this.connection.current().serverModel ?? 'Server default'
  }

  // --------------------------------------------------------------------- sync

  refresh(reason: string, probe = false): Promise<UsageState> {
    if (this.inflight) return this.inflight
    const task = this.runRefresh(reason, probe).finally(() => {
      this.inflight = null
    })
    this.inflight = task
    return task
  }

  private async runRefresh(reason: string, probe: boolean): Promise<UsageState> {
    const now = Date.now()
    this.lastRefreshAt = now

    let connected = this.connection.current().state === 'connected'
    if (probe) {
      try {
        connected = (await this.connection.probe()).state === 'connected'
      } catch {
        connected = false
      }
    }

    if (!connected) {
      this.stale = this.cache !== null
      this.monitorError = 'FCC is not reachable; showing the last saved provider status.'
      return this.emit()
    }

    const base = this.connection.baseUrl().replace(/\/+$/, '')
    const auth = this.connection.authHeaders()
    const [root, admin] = await Promise.all([
      requestJson<RootInfo>(`${base}/`, { headers: auth, timeoutMs: 5000 }),
      requestJson<AdminStatus>(`${base}/admin/api/status`, { timeoutMs: 6000 }),
    ])

    if (!root.ok || !root.data) {
      this.stale = this.cache !== null
      this.monitorError =
        root.status === 0
          ? `No FCC server answered at ${base}.`
          : `FCC answered HTTP ${root.status} while reading provider status.`
      this.schedulePersist()
      return this.emit()
    }

    const providerId =
      text(root.data.provider, 80) ?? text(this.connection.current().provider, 80) ?? this.cache?.providerId ?? null
    const model = text(root.data.model, 240) ?? this.connection.current().serverModel ?? this.cache?.model ?? null

    let key = { state: 'unknown' as 'configured' | 'missing' | 'unknown', label: 'Unknown', detail: null as string | null }
    let providerLabel = this.cache?.providerLabel ?? quotaCapability(providerId).providerLabel

    let providerStatuses: ProviderAdminStatus[] = this.cache?.providers ?? []
    if (admin.ok && admin.data && Array.isArray(admin.data.provider_status)) {
      const entries = admin.data.provider_status as AdminProvider[]
      providerStatuses = entries
        .map((item) => {
          const id = text(item.provider_id, 80)
          const status = text(item.status, 40)
          if (!id || !status) return null
          return {
            providerId: id,
            displayName: text(item.display_name, 120) ?? id,
            status,
          } satisfies ProviderAdminStatus
        })
        .filter((item): item is ProviderAdminStatus => item !== null)
      const entry = entries.find((item) => text(item.provider_id, 80) === providerId)
      if (entry) {
        const name = text(entry.display_name, 120)
        if (name) providerLabel = name
        key = keyStateFrom(entry.status)
        if (key.state === 'unknown') {
          const label = text(entry.label, 80)
          if (label) key.detail = label
        }
      }
    } else if (admin.ok) {
      key = {
        state: 'unknown',
        label: 'Unknown',
        detail: 'FCC did not include provider account status in its response.',
      }
    } else if (admin.status === 404) {
      key = {
        state: 'unknown',
        label: 'Unknown',
        detail: 'This FCC version does not expose its Admin status endpoint.',
      }
    } else if (admin.status > 0) {
      key = {
        state: 'unknown',
        label: 'Unknown',
        detail: `FCC Admin status answered HTTP ${admin.status}.`,
      }
    }

    this.cache = {
      providerId,
      providerLabel,
      model,
      keyState: key.state,
      keyLabel: key.label,
      keyDetail: key.detail,
      syncedAt: Date.now(),
      windows: [],
      providers: providerStatuses,
    }
    this.stale = false
    this.monitorError = null
    this.schedulePersist()
    if (reason !== 'poll') {
      log.info('usage', `Provider usage metadata refreshed (${providerLabel ?? providerId ?? 'unknown'})`)
    }
    return this.emit()
  }

  /**
   * Availability is recomputed when the current report stops being current, so
   * an old 429 does not linger on screen until the next background poll.
   */
  private armRateLimitExpiry(): void {
    this.clearRateLimitExpiry()
    const hit = this.rateLimit
    if (!hit) return
    const fallback = hit.exhausted ? EXHAUSTED_HOLD_MS : INFERRED_HOLD_MS
    const end = hit.cooldownUntil ?? hit.resetAt ?? hit.at + fallback
    this.expiryTimer = setTimeout(() => {
      this.expiryTimer = null
      this.emit()
      this.schedulePersist()
    }, Math.max(250, end - Date.now()))
    this.expiryTimer.unref?.()
  }

  private clearRateLimitExpiry(): void {
    if (!this.expiryTimer) return
    clearTimeout(this.expiryTimer)
    this.expiryTimer = null
  }

  private scheduleRefresh(delayMs: number): void {
    if (this.retryTimer) return
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (Date.now() - this.lastRefreshAt < MIN_REFRESH_GAP) return
      void this.refresh('event')
    }, Math.max(1000, delayMs))
    this.retryTimer.unref?.()
  }

  // ---------------------------------------------------------------- persistence

  private storePath(): string {
    return join(dataRoot(), 'usage.json')
  }

  private load(): void {
    const raw = readJson<Partial<PersistedUsage>>(this.storePath(), {})
    this.events = sanitizeEvents(raw.events)
    this.rateLimit = sanitizeRateLimit(raw.rateLimit)
    this.lastFailure = sanitizeFailure(raw.lastFailure)
    this.cache = sanitizeCache(raw.provider)
    this.stale = this.cache !== null
    this.armRateLimitExpiry()
  }

  private schedulePersist(): void {
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      this.persist()
    }, 400)
    this.persistTimer.unref?.()
  }

  private flush(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer)
      this.persistTimer = null
    }
    this.persist()
  }

  private persist(): void {
    const payload: PersistedUsage = {
      version: STORE_VERSION,
      events: this.events,
      rateLimit: this.rateLimit,
      lastFailure: this.lastFailure,
      provider: this.cache,
    }
    try {
      writeJsonAtomic(this.storePath(), payload)
    } catch (error) {
      log.warn('usage', `Could not save usage history: ${String(error)}`)
    }
  }
}
