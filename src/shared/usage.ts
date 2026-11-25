/**
 * Provider usage monitoring contracts and pure helpers.
 *
 * This module is bundled into both processes, so it must stay free of Node and
 * Electron imports. It deliberately separates three kinds of information:
 *
 * - `provider` / `header`: reported by the provider or its gateway.
 * - `inferred`: derived from an observed HTTP 429, never presented as quota.
 * - `local`: counted by this app from its own requests, never presented as
 *   the account's remaining allowance.
 */

export type UsageSource = 'provider' | 'header' | 'inferred' | 'local'
export type UsageWindowKind = 'window' | 'minute' | 'day' | 'week' | 'month' | 'cooldown'
export type ProviderAvailability = 'available' | 'degraded' | 'throttled' | 'exhausted' | 'unknown' | 'offline'
export type UsageOutcome = 'success' | 'failed' | 'rate_limited' | 'cancelled'

export interface UsageConfig {
  /** Background synchronization of the provider status. */
  enabled: boolean
  /** Seconds between background reads. 0 is never; clamped by the service. */
  pollSeconds: number
}

export const DEFAULT_USAGE_CONFIG: UsageConfig = { enabled: true, pollSeconds: 120 }

/** Selectable polling intervals, mirrored by the dashboard's control. */
export const USAGE_POLL_OPTIONS: Array<{ value: number; label: string }> = [
  { value: 0, label: 'Manual only' },
  { value: 30, label: 'Every 30 seconds' },
  { value: 60, label: 'Every minute' },
  { value: 120, label: 'Every 2 minutes' },
  { value: 300, label: 'Every 5 minutes' },
  { value: 900, label: 'Every 15 minutes' },
]

export function sanitizeUsageConfig(input: unknown): UsageConfig {
  const record = input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
  const poll = Number(record.pollSeconds)
  return {
    enabled: typeof record.enabled === 'boolean' ? record.enabled : DEFAULT_USAGE_CONFIG.enabled,
    pollSeconds: Number.isFinite(poll) ? Math.min(3600, Math.max(0, Math.round(poll))) : DEFAULT_USAGE_CONFIG.pollSeconds,
  }
}

export interface UsageWindow {
  id: string
  label: string
  kind: UsageWindowKind
  source: UsageSource
  used: number | null
  limit: number | null
  remaining: number | null
  percent: number | null
  resetAt: number | null
  /** Why a value is unavailable; null when the window is complete. */
  note: string | null
}

export interface RateLimitHit {
  at: number
  providerLabel: string | null
  category: string | null
  /** The provider said the account quota is gone, not just "slow down". */
  exhausted: boolean
  retryAfterSeconds: number | null
  /** Retry-After or quota reset, whichever the provider supplied. */
  cooldownUntil: number | null
  resetAt: number | null
  source: 'header' | 'inferred'
  requestId: string | null
}

export interface ProviderFailure {
  at: number
  kind: 'auth' | 'server' | 'network' | 'unknown'
  message: string
}

export interface ProviderQuotaCapability {
  providerId: string | null
  providerLabel: string
  /** True only when a reachable endpoint reports this account's allowance. */
  supported: boolean
  detail: string
  sourceUrl: string | null
}

export interface ProviderKeyStatus {
  state: 'configured' | 'missing' | 'unknown'
  label: string
  detail: string | null
}

export interface ProviderUsage {
  providerId: string | null
  providerLabel: string
  model: string | null
  availability: ProviderAvailability
  summary: string
  windows: UsageWindow[]
  capability: ProviderQuotaCapability
  cooldownUntil: number | null
  lastRateLimit: RateLimitHit | null
  lastFailure: ProviderFailure | null
  keyStatus: ProviderKeyStatus
  endpoint: string
  speed: { latencyMs: number | null }
  /** When the provider metadata was last read successfully. */
  syncedAt: number | null
  /** True when the shown metadata came from disk after a failed refresh. */
  cached: boolean
  /** A monitor problem, never a model-request failure. */
  error: string | null
}

export interface UsageTotals {
  requests: number
  success: number
  failed: number
  cancelled: number
  rateLimited: number
  inputTokens: number
  outputTokens: number
}

export interface LocalUsageEvent {
  at: number
  model: string
  outcome: UsageOutcome
  inputTokens: number | null
  outputTokens: number | null
  durationMs: number | null
}

export interface UsageDay extends UsageTotals {
  date: string
  label: string
}

export interface UsageModel extends UsageTotals {
  model: string
  lastUsedAt: number
}

export interface LocalUsageSummary {
  totals: UsageTotals
  today: UsageTotals
  last7Days: UsageTotals
  lastMinute: UsageTotals
  days: UsageDay[]
  models: UsageModel[]
  recent: LocalUsageEvent[]
  trackedSince: number | null
  retentionDays: number
}

export interface UsageState {
  provider: ProviderUsage
  local: LocalUsageSummary
  config: UsageConfig
  /** Free-first registry, cooldowns and fallback history. */
  routing: import('./free-providers').RoutingView
  sampledAt: number
}

export function emptyTotals(): UsageTotals {
  return {
    requests: 0,
    success: 0,
    failed: 0,
    cancelled: 0,
    rateLimited: 0,
    inputTokens: 0,
    outputTokens: 0,
  }
}

function addEvent(totals: UsageTotals, event: LocalUsageEvent): void {
  totals.requests += 1
  if (event.outcome === 'success') totals.success += 1
  else if (event.outcome === 'cancelled') totals.cancelled += 1
  else totals.failed += 1
  if (event.outcome === 'rate_limited') totals.rateLimited += 1
  if (typeof event.inputTokens === 'number' && Number.isFinite(event.inputTokens)) {
    totals.inputTokens += Math.max(0, event.inputTokens)
  }
  if (typeof event.outputTokens === 'number' && Number.isFinite(event.outputTokens)) {
    totals.outputTokens += Math.max(0, event.outputTokens)
  }
}

export function startOfLocalDay(timestamp: number): number {
  const date = new Date(timestamp)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

export function localDayKey(timestamp: number): string {
  const date = new Date(timestamp)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function dayLabel(timestamp: number, now: number): string {
  if (startOfLocalDay(timestamp) === startOfLocalDay(now)) return 'Today'
  return new Date(timestamp).toLocaleDateString(undefined, { weekday: 'short' })
}

/**
 * Counts only what this app saw. There is no provider limit here on purpose:
 * `limit` and `percent` stay null so no caller can turn a local count into a
 * fabricated quota percentage.
 */
export function summarizeLocalUsage(
  events: LocalUsageEvent[],
  now: number,
  retentionDays = 30,
): LocalUsageSummary {
  const totals = emptyTotals()
  const today = emptyTotals()
  const week = emptyTotals()
  const minute = emptyTotals()
  const sorted = [...events]
    .filter((event) => Number.isFinite(event.at) && event.at > 0)
    .sort((a, b) => a.at - b.at)

  const todayStart = startOfLocalDay(now)
  const weekStart = startOfLocalDay(now - 86400000 * 6)
  const dayStarts: number[] = []
  for (let offset = 6; offset >= 0; offset -= 1) dayStarts.push(startOfLocalDay(now - offset * 86400000))
  const dayTotals = new Map<number, UsageTotals>()
  for (const start of dayStarts) dayTotals.set(start, emptyTotals())

  const models = new Map<string, UsageModel>()
  let trackedSince: number | null = null

  for (const event of sorted) {
    if (trackedSince === null || event.at < trackedSince) trackedSince = event.at
    addEvent(totals, event)
    if (event.at >= todayStart) addEvent(today, event)
    if (event.at >= weekStart) addEvent(week, event)
    if (event.at >= now - 60000) addEvent(minute, event)
    const bucket = dayTotals.get(startOfLocalDay(event.at))
    if (bucket) addEvent(bucket, event)

    const modelName = event.model.trim() || 'Server default'
    let entry = models.get(modelName)
    if (!entry) {
      entry = { model: modelName, lastUsedAt: event.at, ...emptyTotals() }
      models.set(modelName, entry)
    }
    addEvent(entry, event)
    if (event.at > entry.lastUsedAt) entry.lastUsedAt = event.at
  }

  const days: UsageDay[] = dayStarts.map((start) => ({
    date: localDayKey(start),
    label: dayLabel(start, now),
    ...(dayTotals.get(start) ?? emptyTotals()),
  }))

  const cutoff = now - Math.max(1, retentionDays) * 86400000
  const recent = sorted.filter((event) => event.at >= cutoff).slice(-25).reverse()

  return {
    totals,
    today,
    last7Days: week,
    lastMinute: minute,
    days,
    models: [...models.values()].sort((a, b) => b.requests - a.requests || b.lastUsedAt - a.lastUsedAt),
    recent,
    trackedSince,
    retentionDays,
  }
}

// ---------------------------------------------------------------- parsing

export function redactUsageText(text: string): string {
  return text
    .replace(/\b(nvapi-[A-Za-z0-9_-]{4,})/g, '[redacted-key]')
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})/g, '[redacted-key]')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]{8,}/gi, '$1[redacted]')
    .replace(/("?(?:api[_-]?key|token|auth[_-]?token|password)"?\s*[:=]\s*")[^"]{4,}(")/gi, '$1[redacted]$2')
}

/** Parses an ISO date, a Unix timestamp in seconds/milliseconds or a duration. */
export function parseResetAt(raw: string | null | undefined, now: number): number | null {
  if (!raw) return null
  const value = raw.trim().replace(/^["']|["']$/g, '')
  if (!value || /^(unknown|n\/a|none|shortly|later)$/i.test(value)) return null

  if (/^\d{10,13}$/.test(value)) {
    const numeric = Number(value)
    const at = value.length >= 13 ? numeric : numeric * 1000
    return Number.isFinite(at) ? at : null
  }
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const seconds = Number(value)
    return Number.isFinite(seconds) ? now + seconds * 1000 : null
  }
  const duration = parseDurationMs(value)
  if (duration !== null) return now + duration
  const parsed = Date.parse(value)
  if (Number.isFinite(parsed) && parsed > 0) return parsed
  return null
}

/** `1.5s`, `42`, `6m0s`, `1h2m3s`, `250ms` → milliseconds. */
export function parseDurationMs(raw: string | null | undefined): number | null {
  if (!raw) return null
  const value = raw.trim().toLowerCase()
  if (!value) return null
  if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value) * 1000

  const parts = value.match(/(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)/g)
  if (!parts || parts.length === 0) return null
  let total = 0
  for (const part of parts) {
    const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/.exec(part)
    if (!match) continue
    const amount = Number(match[1])
    const unit = match[2]
    const factor = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60000 : unit === 'h' ? 3600000 : 86400000
    total += amount * factor
  }
  return total > 0 ? total : null
}

/** `Retry-After` is either delta-seconds or an HTTP date. */
export function parseRetryAfter(raw: string | null | undefined, now: number): number | null {
  if (!raw) return null
  const value = raw.trim()
  if (!value) return null
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    const seconds = Number(value)
    return Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : null
  }
  const date = Date.parse(value)
  if (Number.isFinite(date) && date > 0) return Math.max(0, date - now)
  return parseDurationMs(value)
}

export interface HeaderSnapshot {
  windows: UsageWindow[]
  retryAfterSeconds: number | null
  cooldownUntil: number | null
  resetAt: number | null
}

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue
    if (Array.isArray(value)) return value[0] ?? null
    return value ?? null
  }
  return null
}

function numberHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): number | null {
  const raw = headerValue(headers, name)
  if (raw === null) return null
  const parsed = Number(raw.trim())
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

/**
 * Reads the limit headers a gateway may forward. FCC currently aggregates
 * provider responses and does not pass these through, so this is used only
 * when headers are actually present; it never guesses numbers.
 */
export function parseRateLimitHeaders(
  headers: Record<string, string | string[] | undefined>,
  now: number,
): HeaderSnapshot {
  const windows: UsageWindow[] = []
  const resetCandidates: number[] = []
  const pairs = [
    {
      id: 'requests',
      label: 'Provider requests',
      limit: 'x-ratelimit-limit-requests',
      remaining: 'x-ratelimit-remaining-requests',
      reset: 'x-ratelimit-reset-requests',
      altLimit: 'anthropic-ratelimit-requests-limit',
      altRemaining: 'anthropic-ratelimit-requests-remaining',
      altReset: 'anthropic-ratelimit-requests-reset',
    },
    {
      id: 'tokens',
      label: 'Provider tokens',
      limit: 'x-ratelimit-limit-tokens',
      remaining: 'x-ratelimit-remaining-tokens',
      reset: 'x-ratelimit-reset-tokens',
      altLimit: 'anthropic-ratelimit-tokens-limit',
      altRemaining: 'anthropic-ratelimit-tokens-remaining',
      altReset: 'anthropic-ratelimit-tokens-reset',
    },
  ]

  for (const pair of pairs) {
    const limit = numberHeader(headers, pair.limit) ?? numberHeader(headers, pair.altLimit)
    const remaining = numberHeader(headers, pair.remaining) ?? numberHeader(headers, pair.altRemaining)
    const resetRaw = headerValue(headers, pair.reset) ?? headerValue(headers, pair.altReset)
    const resetAt = parseResetAt(resetRaw, now)
    if (resetAt !== null) resetCandidates.push(resetAt)
    if (limit === null && remaining === null && resetAt === null) continue
    const used = limit !== null && remaining !== null ? Math.max(0, limit - remaining) : null
    const percent = used !== null && limit !== null && limit > 0
      ? Math.min(100, Math.max(0, (used / limit) * 100))
      : null
    windows.push({
      id: `header-${pair.id}`,
      label: pair.label,
      kind: 'window',
      source: 'header',
      used,
      limit,
      remaining,
      percent,
      resetAt,
      note: percent === null ? 'The gateway did not send both a limit and a remaining count.' : null,
    })
  }

  const retryRaw = headerValue(headers, 'retry-after')
  const retryMs = parseRetryAfter(retryRaw, now)
  const retryAfterSeconds = retryMs === null ? null : Math.max(1, Math.round(retryMs / 1000))
  const cooldownUntil = retryMs === null ? null : now + retryMs
  if (cooldownUntil !== null) {
    windows.push({
      id: 'header-retry-after',
      label: 'Retry after',
      kind: 'cooldown',
      source: 'header',
      used: null,
      limit: null,
      remaining: null,
      percent: null,
      resetAt: cooldownUntil,
      note: 'Reported by the gateway in a Retry-After header.',
    })
  }

  // A Retry-After delay is not a quota reset; keep the two apart.
  const resetAt = resetCandidates.sort((a, b) => a - b)[0] ?? null
  return { windows, retryAfterSeconds, cooldownUntil, resetAt }
}

export interface ProviderFailureAnalysis {
  kind: 'rate_limit' | 'quota' | 'auth' | 'server' | 'network' | 'unknown'
  statusCode: number | null
  rateLimited: boolean
  quotaExhausted: boolean
  authFailed: boolean
  serverError: boolean
  providerLabel: string | null
  category: string | null
  retryAfterSeconds: number | null
  resetAt: number | null
  cooldownUntil: number | null
  requestId: string | null
  summary: string
  detail: string | null
}

function normalizeProviderName(raw: string): string {
  const value = raw.trim().replace(/\s+/g, ' ')
  const known: Record<string, string> = {
    NIM: 'NVIDIA NIM',
    NVIDIA: 'NVIDIA NIM',
    KIMI: 'Kimi',
    OPENROUTER: 'OpenRouter',
    'OPEN ROUTER': 'OpenRouter',
  }
  return known[value.toUpperCase()] ?? value
}

/**
 * Classifies a failure string from the FCC agent or gateway. The agent embeds
 * the upstream error in its result text, which is the only place these details
 * reach the desktop app; nothing here invents a value that is not present.
 */
export function analyzeProviderFailure(
  text: string,
  now: number,
  headers: Record<string, string | string[] | undefined> = {},
): ProviderFailureAnalysis {
  const clean = redactUsageText(String(text ?? '')).trim()
  const headerSnapshot = parseRateLimitHeaders(headers, now)

  const statusMatch = /(?:HTTP\s*|status["']?\s*[:=]\s*)(\d{3})/i.exec(clean) ?? /\b(429|401|403|500|502|503|504)\b/.exec(clean)
  const statusCode = statusMatch ? Number(statusMatch[1]) : null
  const categoryMatch = /Category:\s*([A-Za-z0-9_]+)/i.exec(clean)
  const category = categoryMatch?.[1]?.toLowerCase() ?? null
  const requestMatch = /Request ID:\s*(req_[A-Za-z0-9]+)/i.exec(clean)
  const providerMatch = /Upstream provider\s+([A-Za-z0-9_. -]+?)\s+returned HTTP/i.exec(clean)
  const providerLabel = providerMatch?.[1] ? normalizeProviderName(providerMatch[1]) : null

  const quotaExhausted =
    /exceeded_current_quota|insufficient[ _-]?quota|quota[^.\n]{0,32}(?:exceeded|exhausted|reached)|insufficient balance|out of credits|billing (?:issue|required)/i.test(clean) ||
    category === 'exceeded_current_quota_error'
  const rateLimited =
    statusCode === 429 ||
    /rate[ _-]?limit|too many requests|throttl/i.test(clean) ||
    category === 'rate_limit' ||
    category === 'rate_limit_error'
  const authFailed =
    statusCode === 401 ||
    statusCode === 403 ||
    /unauthori[sz]ed|invalid[ _-]?api[ _-]?key|authentication (?:failed|required)|token[^.\n]{0,20}expired|missing[ _-]?key|no api key/i.test(clean)
  const serverError =
    (statusCode !== null && statusCode >= 500 && statusCode <= 599) ||
    /overloaded_error|bad gateway|service unavailable|internal server error|upstream (?:error|failure|timeout)/i.test(clean)
  const network = /econnrefused|enotfound|fetch failed|network error|timed out|timeout|connecterror/i.test(clean)

  let retryAfterSeconds = headerSnapshot.retryAfterSeconds
  if (retryAfterSeconds === null) {
    // Capture the whole line so an HTTP date keeps its weekday comma.
    const retryHeaderMatch = /Retry-After["']?\s*[:=]\s*"?([^\n]+)/i.exec(clean)
    const retryValue = retryHeaderMatch?.[1]?.trim().replace(/["',.;]+$/, '') ?? ''
    const retryMs = retryValue ? parseRetryAfter(retryValue, now) : null
    if (retryMs !== null) retryAfterSeconds = Math.max(1, Math.round(retryMs / 1000))
  }
  if (retryAfterSeconds === null) {
    const retryInMatch = /(?:retry|try) (?:again )?in\s+(\d+(?:\.\d+)?)\s*(milliseconds?|ms|seconds?|s|minutes?|m)/i.exec(clean)
    if (retryInMatch?.[1] && retryInMatch[2]) {
      const unit = retryInMatch[2].toLowerCase()
      const amount = Number(retryInMatch[1])
      const ms = unit.startsWith('ms') || unit === 'millisecond' || unit === 'milliseconds'
        ? amount
        : unit.startsWith('m')
          ? amount * 60000
          : amount * 1000
      retryAfterSeconds = Math.max(1, Math.round(ms / 1000))
    }
  }

  let resetAt = headerSnapshot.resetAt
  if (resetAt === null) {
    const resetMatch =
      /resets?[ _-]?(?:at|in)["']?\s*[:=]?\s*"?([^",\n}]+)/i.exec(clean) ??
      /reset_at["']?\s*[:=]\s*"?([^",\n}]+)/i.exec(clean)
    const candidate = resetMatch?.[1]
    if (candidate) resetAt = parseResetAt(candidate, now)
  }
  if (resetAt === null) {
    const isoMatch = /\b(20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z?)\b/.exec(clean)
    if (isoMatch?.[1]) resetAt = parseResetAt(isoMatch[1], now)
  }

  const retryFromReset = resetAt !== null && resetAt > now ? Math.max(1, Math.round((resetAt - now) / 1000)) : null
  const effectiveRetry = retryAfterSeconds ?? retryFromReset
  const cooldownUntil =
    retryAfterSeconds !== null
      ? now + retryAfterSeconds * 1000
      : resetAt ?? headerSnapshot.cooldownUntil

  const kind: ProviderFailureAnalysis['kind'] = quotaExhausted
    ? 'quota'
    : rateLimited
      ? 'rate_limit'
      : authFailed
        ? 'auth'
        : serverError
          ? 'server'
          : network
            ? 'network'
            : 'unknown'

  const summary =
    kind === 'quota'
      ? 'The provider reports that this account’s quota is exhausted.'
      : kind === 'rate_limit'
        ? 'The provider is temporarily rate-limiting requests.'
        : kind === 'auth'
          ? 'The provider rejected the request credentials.'
          : kind === 'server'
            ? 'The provider returned a server error.'
            : kind === 'network'
              ? 'The provider could not be reached.'
              : 'The provider request failed.'

  return {
    kind,
    statusCode,
    rateLimited,
    quotaExhausted,
    authFailed,
    serverError,
    providerLabel,
    category,
    retryAfterSeconds: effectiveRetry,
    resetAt,
    cooldownUntil,
    requestId: requestMatch?.[1] ?? null,
    summary,
    detail: clean ? clean.slice(0, 900) : null,
  }
}

// ------------------------------------------------------------- availability

/** How long an inferred throttling hold lasts when the provider sends no reset time. */
export const INFERRED_HOLD_MS = 90_000

/**
 * How long a quota-exhaustion report stays current without a reset time. A
 * quota report is stronger evidence than a single throttle, so it is held
 * longer, but it is still only a report from a moment in time: after this it
 * becomes history with its timestamp, never an indefinite "exhausted" state.
 */
export const EXHAUSTED_HOLD_MS = 15 * 60_000

/**
 * Whether a rate-limit report describes the provider's current state.
 *
 * A reported retry or reset time decides on its own: the report is current
 * until that time passes. Without one, only recency keeps it current. An old
 * 429 with no reset time is last-reported history, not a live state.
 */
export function rateLimitActive(hit: RateLimitHit | null, now: number): boolean {
  if (!hit) return false
  const reportedUntil = hit.cooldownUntil ?? hit.resetAt
  if (reportedUntil !== null) return reportedUntil > now
  return now - hit.at < (hit.exhausted ? EXHAUSTED_HOLD_MS : INFERRED_HOLD_MS)
}

export function availabilityFrom(input: {
  connected: boolean
  rateLimit: RateLimitHit | null
  keyState: 'configured' | 'missing' | 'unknown'
  lastFailure: ProviderFailure | null
  now: number
  providerId: string | null
  /** Local evidence that the provider is serving, when no status is exposed. */
  lastSuccessAt?: number | null
}): { availability: ProviderAvailability; summary: string } {
  const { connected, rateLimit, keyState, lastFailure, now, providerId, lastSuccessAt } = input
  if (!connected) {
    return {
      availability: 'offline',
      summary: 'FCC is not reachable, so provider status cannot be read.',
    }
  }
  if (rateLimit && rateLimitActive(rateLimit, now)) {
    if (rateLimit.exhausted) {
      return {
        availability: 'exhausted',
        summary: rateLimit.resetAt !== null
          ? 'The provider reported that the account quota is exhausted.'
          : `The provider reported that the account quota is exhausted and supplied no reset time. This is a recent report, shown for ${Math.round(EXHAUSTED_HOLD_MS / 60000)} minutes; it is not a live quota reading.`,
      }
    }
    return {
      availability: 'throttled',
      summary: rateLimit.resetAt !== null
        ? 'Requests are being throttled. A reset time was reported.'
        : 'Requests are being throttled. No reset time was reported.',
    }
  }
  if (keyState === 'missing') {
    const provider = providerId ? providerId.replace(/[_-]/g, ' ') : 'the selected provider'
    return {
      availability: 'degraded',
      summary: `FCC has no API key configured for ${provider}.`,
    }
  }
  if (lastFailure && lastFailure.kind === 'auth' && now - lastFailure.at < 300000) {
    return { availability: 'degraded', summary: 'The last request was rejected for authentication.' }
  }
  if (lastFailure && lastFailure.kind === 'server' && now - lastFailure.at < 120000) {
    return { availability: 'degraded', summary: 'The provider returned a server error recently.' }
  }
  if (keyState === 'unknown') {
    if (lastSuccessAt && now - lastSuccessAt < 600000) {
      return {
        availability: 'available',
        summary:
          'FCC is connected and the last request succeeded. This provider does not expose account status.',
      }
    }
    return {
      availability: 'unknown',
      summary: 'Connected to FCC, but the provider did not expose account status.',
    }
  }
  return {
    availability: 'available',
    summary: 'FCC is connected and no active rate limit was observed.',
  }
}

const PROVIDER_SOURCES: Record<string, string | null> = {
  nvidia_nim: 'https://build.nvidia.com',
  open_router: 'https://openrouter.ai/docs/api-reference/get-key',
  groq: 'https://console.groq.com/docs/rate-limits',
  anthropic: 'https://docs.anthropic.com/en/api/usage-cost-api',
  openai: 'https://platform.openai.com/docs/api-reference/usage',
}

/**
 * What can honestly be reported for a provider. `supported` is true only when
 * this app can actually reach a provider-published usage endpoint with the
 * credentials it legitimately holds — currently none of the key-based
 * providers qualify, because FCC stores their keys and does not expose them.
 */
export function quotaCapability(providerId: string | null): ProviderQuotaCapability {
  const id = (providerId ?? '').toLowerCase()
  const label = id ? id.replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : 'Provider'
  const sourceUrl = id ? PROVIDER_SOURCES[id] ?? null : null

  if (id === 'nvidia_nim') {
    return {
      providerId,
      providerLabel: 'NVIDIA NIM',
      supported: false,
      detail:
        'NVIDIA NIM publishes no usage or remaining-quota API. Trial limits are account-specific, are shown only on build.nvidia.com, and 429 responses usually carry no Retry-After or rate-limit headers.',
      sourceUrl,
    }
  }
  if (id === 'open_router') {
    return {
      providerId,
      providerLabel: 'OpenRouter',
      supported: false,
      detail:
        'OpenRouter exposes key usage at GET /api/v1/key, but the request needs the provider key. FCC holds that key; FCC Desktop never reads provider credentials.',
      sourceUrl,
    }
  }
  if (id === 'llamacpp' || id === 'lmstudio' || id === 'ollama') {
    return {
      providerId,
      providerLabel: label,
      supported: false,
      detail: 'Local inference has no account quota. Local request counts still apply.',
      sourceUrl,
    }
  }
  if (id === 'anthropic' || id === 'openai') {
    return {
      providerId,
      providerLabel: label,
      supported: false,
      detail: `${label} usage APIs require an organization admin key. FCC Desktop does not hold one and will not read provider credentials from FCC.`,
      sourceUrl,
    }
  }
  if (sourceUrl) {
    return {
      providerId,
      providerLabel: label,
      supported: false,
      detail: `${label} may report rate-limit headers on direct API responses, but FCC aggregates those responses and does not forward quota data. No provider usage endpoint is reachable from FCC Desktop.`,
      sourceUrl,
    }
  }
  return {
    providerId,
    providerLabel: label,
    supported: false,
    detail: 'No provider-published usage endpoint is known for this provider. Only local request tracking is available.',
    sourceUrl: null,
  }
}
