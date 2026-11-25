import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConnectionStatus } from '../src/shared/types'
import type { ConnectionManager } from '../electron/fcc/connection'
import { UsageMonitor } from '../electron/usage/service'
import type { LocalUsageEvent, RateLimitHit } from '../src/shared/usage'
import {
  analyzeProviderFailure,
  availabilityFrom,
  EXHAUSTED_HOLD_MS,
  parseRateLimitHeaders,
  parseResetAt,
  parseRetryAfter,
  quotaCapability,
  rateLimitActive,
  sanitizeUsageConfig,
  summarizeLocalUsage,
} from '../src/shared/usage'

const NOW = new Date(2026, 10, 24, 12, 0, 0).getTime()

const NIM_429 = `API Error: Request rejected (429) · Upstream provider NIM returned HTTP 429. Category: rate_limit Mapped message: Provider rate limit reached. Please retry shortly.
Upstream error: {"status":429,"title":"Too Many Requests"}
Request ID: req_d429bb51c0454ae883568f15ec727b52`

test('429: the FCC/NIM error is classified as temporary throttling', () => {
  const analysis = analyzeProviderFailure(NIM_429, NOW)
  assert.equal(analysis.statusCode, 429)
  assert.equal(analysis.rateLimited, true)
  assert.equal(analysis.quotaExhausted, false)
  assert.equal(analysis.kind, 'rate_limit')
  assert.equal(analysis.category, 'rate_limit')
  assert.equal(analysis.providerLabel, 'NVIDIA NIM')
  assert.equal(analysis.requestId, 'req_d429bb51c0454ae883568f15ec727b52')
  assert.match(analysis.summary, /temporarily rate-limiting/i)
  assert.equal(analysis.retryAfterSeconds, null, 'no retry time was supplied')
  assert.equal(analysis.resetAt, null, 'no reset time may be invented')
})

test('429: an exhausted quota is distinguished from throttling', () => {
  const analysis = analyzeProviderFailure(
    `HTTP 429. Category: exceeded_current_quota_error. Upstream error: {"message":"Your account is suspended due to insufficient balance","type":"exceeded_current_quota_error"}`,
    NOW,
  )
  assert.equal(analysis.rateLimited, true)
  assert.equal(analysis.quotaExhausted, true)
  assert.equal(analysis.kind, 'quota')
  assert.match(analysis.summary, /quota is exhausted/i)
})

test('429: Retry-After seconds become a real retry time', () => {
  const analysis = analyzeProviderFailure('HTTP 429 Too Many Requests\nRetry-After: 42', NOW)
  assert.equal(analysis.retryAfterSeconds, 42)
  assert.equal(analysis.cooldownUntil, NOW + 42000)
  assert.equal(analysis.resetAt, null, 'a retry delay is not a quota reset')
})

test('429: Retry-After accepts an HTTP date', () => {
  const date = new Date(NOW + 45000).toUTCString()
  const analysis = analyzeProviderFailure(`HTTP 429\nRetry-After: ${date}`, NOW)
  assert.equal(analysis.retryAfterSeconds, 45)
  assert.equal(parseRetryAfter(date, NOW), 45000)
})

test('429: "retry in N seconds" is understood without a header', () => {
  const analysis = analyzeProviderFailure('rate limit reached, please try again in 30 seconds', NOW)
  assert.equal(analysis.rateLimited, true)
  assert.equal(analysis.retryAfterSeconds, 30)
  assert.equal(analysis.cooldownUntil, NOW + 30000)
})

test('headers: remaining quota and reset are reported as a header window', () => {
  const snapshot = parseRateLimitHeaders(
    {
      'X-RateLimit-Limit-Requests': '100',
      'x-ratelimit-remaining-requests': '85',
      'x-ratelimit-reset-requests': '30s',
      'retry-after': '12',
    },
    NOW,
  )
  const window = snapshot.windows.find((entry) => entry.id === 'header-requests')
  assert.ok(window)
  assert.equal(window?.source, 'header')
  assert.equal(window?.used, 15)
  assert.equal(window?.limit, 100)
  assert.equal(window?.remaining, 85)
  assert.equal(window?.percent, 15)
  assert.equal(window?.resetAt, NOW + 30000)
  assert.equal(snapshot.retryAfterSeconds, 12)
  assert.equal(snapshot.cooldownUntil, NOW + 12000)
  assert.equal(snapshot.resetAt, NOW + 30000, 'the limit reset stays separate from Retry-After')
  assert.ok(snapshot.windows.some((entry) => entry.kind === 'cooldown'))
})

test('headers: Anthropic-style token limits parse a duration reset', () => {
  const snapshot = parseRateLimitHeaders(
    {
      'anthropic-ratelimit-tokens-limit': '200000',
      'anthropic-ratelimit-tokens-remaining': '50000',
      'anthropic-ratelimit-tokens-reset': '1m30s',
    },
    NOW,
  )
  const window = snapshot.windows.find((entry) => entry.id === 'header-tokens')
  assert.ok(window)
  assert.equal(window?.percent, 75)
  assert.equal(window?.resetAt, NOW + 90000)
})

test('headers: malformed or partial values never produce a percentage', () => {
  const snapshot = parseRateLimitHeaders(
    {
      'x-ratelimit-limit-requests': 'not-a-number',
      'x-ratelimit-remaining-requests': '-4',
      'x-ratelimit-reset-requests': 'soon',
    },
    NOW,
  )
  assert.equal(snapshot.windows.length, 0)

  const partial = parseRateLimitHeaders({ 'x-ratelimit-limit-requests': '100' }, NOW)
  const window = partial.windows[0]
  assert.equal(window?.limit, 100)
  assert.equal(window?.used, null)
  assert.equal(window?.percent, null)
  assert.match(window?.note ?? '', /did not send both/i)
})

test('reset parsing handles ISO dates, unix seconds and durations', () => {
  assert.equal(parseResetAt('2026-11-24T12:05:00Z', NOW), Date.UTC(2026, 10, 24, 12, 5, 0))
  assert.equal(parseResetAt(String(Math.floor(NOW / 1000) + 60), NOW), NOW + 60000)
  assert.equal(parseResetAt('2m', NOW), NOW + 120000)
  assert.equal(parseResetAt('shortly', NOW), null)
})

test('5xx and auth failures are separated from rate limits', () => {
  const retryWithHeaders = analyzeProviderFailure('HTTP 429', NOW, {
    'x-ratelimit-remaining-requests': '0',
    'x-ratelimit-limit-requests': '100',
    'x-ratelimit-reset-requests': '90s',
    'retry-after': '10',
  })
  assert.equal(retryWithHeaders.retryAfterSeconds, 10)
  assert.equal(retryWithHeaders.cooldownUntil, NOW + 10000, 'Retry-After drives the countdown')
  assert.equal(retryWithHeaders.resetAt, NOW + 90000, 'the quota reset remains distinct')

  const server = analyzeProviderFailure('API Error: 502 Bad Gateway', NOW)
  assert.equal(server.serverError, true)
  assert.equal(server.rateLimited, false)
  assert.equal(server.kind, 'server')

  const auth = analyzeProviderFailure('401 Unauthorized: invalid api key', NOW)
  assert.equal(auth.authFailed, true)
  assert.equal(auth.rateLimited, false)
  assert.equal(auth.kind, 'auth')
})

test('empty, missing and malformed error text degrades gracefully', () => {
  const empty = analyzeProviderFailure('', NOW)
  assert.equal(empty.kind, 'unknown')
  assert.equal(empty.statusCode, null)
  assert.equal(empty.summary, 'The provider request failed.')

  const malformed = analyzeProviderFailure('{"unexpected":', NOW)
  assert.equal(malformed.rateLimited, false)
  assert.equal(malformed.detail, '{"unexpected":')
})

test('credentials embedded in an error are redacted', () => {
  const analysis = analyzeProviderFailure('invalid api key: nvapi-abcdef1234567890', NOW)
  assert.doesNotMatch(analysis.detail ?? '', /nvapi-abcdef1234567890/)
  assert.match(analysis.detail ?? '', /\[redacted-key\]/)
})

test('local summary separates today, 7 days and retention totals', () => {
  const events: LocalUsageEvent[] = [
    { at: NOW - 30000, model: 'nvidia_nim/a', outcome: 'success', inputTokens: 100, outputTokens: 50, durationMs: 1200 },
    { at: NOW - 7200000, model: 'nvidia_nim/a', outcome: 'failed', inputTokens: null, outputTokens: null, durationMs: null },
    { at: NOW - 86400000, model: 'nvidia_nim/b', outcome: 'rate_limited', inputTokens: null, outputTokens: null, durationMs: null },
    { at: NOW - 9 * 86400000, model: 'nvidia_nim/b', outcome: 'success', inputTokens: 10, outputTokens: 5, durationMs: 800 },
  ]
  const summary = summarizeLocalUsage(events, NOW, 30)
  assert.equal(summary.totals.requests, 4)
  assert.equal(summary.totals.success, 2)
  assert.equal(summary.totals.failed, 2)
  assert.equal(summary.totals.rateLimited, 1)
  assert.equal(summary.totals.inputTokens, 110)
  assert.equal(summary.totals.outputTokens, 55)

  assert.equal(summary.today.requests, 2)
  assert.equal(summary.today.success, 1)
  assert.equal(summary.today.failed, 1)
  assert.equal(summary.last7Days.requests, 3)
  assert.equal(summary.lastMinute.requests, 1)
  assert.equal(summary.lastMinute.inputTokens, 100)
  assert.equal(summary.days.length, 7)
  assert.equal(summary.days[6]?.date, '2026-11-24')
  assert.equal(summary.days[6]?.requests, 2)
  assert.equal(summary.models.length, 2)
  assert.equal(summary.models[0]?.requests, 2)
  assert.equal(summary.recent.length, 4)
  assert.equal(summary.trackedSince, NOW - 9 * 86400000)
})

test('local summary never synthesizes limits or percentages', () => {
  const summary = summarizeLocalUsage(
    [{ at: NOW - 1000, model: 'm', outcome: 'success', inputTokens: 5, outputTokens: 2, durationMs: 10 }],
    NOW,
  )
  assert.equal(summary.today.requests, 1)
  // The summary type has no limit/percent field at all; the point is that a
  // consumer cannot read quota from a local count.
  assert.equal('percent' in summary.today, false)
  assert.equal('remaining' in summary.today, false)
})

test('availability: offline, throttled, exhausted and configured states', () => {
  const base = { connected: true, keyState: 'configured' as const, lastFailure: null, providerId: 'nvidia_nim' }
  const recent: RateLimitHit = {
    at: NOW - 10000,
    providerLabel: 'NVIDIA NIM',
    category: 'rate_limit',
    exhausted: false,
    retryAfterSeconds: null,
    cooldownUntil: null,
    resetAt: null,
    source: 'inferred',
    requestId: null,
  }
  assert.equal(availabilityFrom({ ...base, connected: false, rateLimit: null, now: NOW }).availability, 'offline')
  assert.equal(availabilityFrom({ ...base, rateLimit: recent, now: NOW }).availability, 'throttled')
  assert.equal(
    availabilityFrom({ ...base, rateLimit: { ...recent, at: NOW - 120000 }, now: NOW }).availability,
    'available',
  )
  assert.equal(
    availabilityFrom({ ...base, rateLimit: { ...recent, exhausted: true }, now: NOW }).availability,
    'exhausted',
  )
  // An old exhaustion report with no reset time is history, not a current state.
  assert.equal(
    availabilityFrom({ ...base, rateLimit: { ...recent, at: NOW - 3600000, exhausted: true }, now: NOW }).availability,
    'available',
  )
  assert.equal(
    availabilityFrom({
      ...base,
      keyState: 'unknown',
      rateLimit: { ...recent, at: NOW - 3600000, exhausted: true },
      now: NOW,
    }).availability,
    'unknown',
  )
  assert.equal(
    availabilityFrom({ ...base, keyState: 'missing', rateLimit: null, now: NOW }).availability,
    'degraded',
  )
  assert.equal(
    availabilityFrom({ ...base, keyState: 'unknown', rateLimit: null, now: NOW }).availability,
    'unknown',
  )
})

test('rate limit hold honors a reported reset and expires an inferred one', () => {
  const hit: RateLimitHit = {
    at: NOW - 5000,
    providerLabel: 'NVIDIA NIM',
    category: 'rate_limit',
    exhausted: false,
    retryAfterSeconds: 60,
    cooldownUntil: null,
    resetAt: null,
    source: 'inferred',
    requestId: null,
  }
  const window = parseRateLimitHeaders({ 'retry-after': '60' }, NOW)
  assert.equal(rateLimitActive({ ...hit, cooldownUntil: window.cooldownUntil }, NOW), true)
  assert.equal(rateLimitActive({ ...hit, cooldownUntil: NOW - 1 }, NOW), false)
  assert.equal(rateLimitActive({ ...hit, at: NOW - 120000 }, NOW), false)

  // A quota-exhaustion report with no reset time is held longer than a
  // throttle, but it still expires instead of sticking forever.
  assert.equal(rateLimitActive({ ...hit, exhausted: true, at: NOW - 60000 }, NOW), true)
  assert.equal(rateLimitActive({ ...hit, exhausted: true, at: NOW - EXHAUSTED_HOLD_MS - 1000 }, NOW), false)
  assert.equal(rateLimitActive({ ...hit, exhausted: true, at: NOW - 86400000 }, NOW), false)

  // A supplied reset time is authoritative: it keeps a report current into the
  // future, and a reset that has already passed ends it even when recent.
  assert.equal(
    rateLimitActive({ ...hit, exhausted: true, at: NOW - 3600000, resetAt: NOW + 60000 }, NOW),
    true,
  )
  assert.equal(
    rateLimitActive({ ...hit, exhausted: true, at: NOW - 60000, resetAt: NOW - 1000 }, NOW),
    false,
  )
})

test('capability reports NIM and local providers as having no quota API', () => {
  const nim = quotaCapability('nvidia_nim')
  assert.equal(nim.supported, false)
  assert.match(nim.detail, /no usage or remaining-quota API/i)
  assert.equal(nim.sourceUrl, 'https://build.nvidia.com')

  const llocal = quotaCapability('llamacpp')
  assert.equal(llocal.supported, false)
  assert.match(llocal.detail, /no account quota/i)

  const unknown = quotaCapability(null)
  assert.equal(unknown.supported, false)
  assert.match(unknown.detail, /No provider-published usage endpoint/i)
})

// ------------------------------------------------------------- startup sync

interface FakeConnection {
  current(): ConnectionStatus
  baseUrl(): string
  authHeaders(): Record<string, string>
  probe(): Promise<ConnectionStatus>
  watch(listener: (status: ConnectionStatus) => void): () => void
  publish(patch: Partial<ConnectionStatus>): void
  watcherCount(): number
}

function fakeConnection(baseUrl: string): FakeConnection {
  let status: ConnectionStatus = {
    state: 'disconnected',
    baseUrl,
    latencyMs: null,
    provider: null,
    serverModel: null,
    modelCount: null,
    message: null,
    ownedByApp: false,
    checkedAt: 0,
  }
  const watchers = new Set<(next: ConnectionStatus) => void>()
  return {
    current: () => ({ ...status }),
    baseUrl: () => baseUrl,
    authHeaders: () => ({}),
    probe: async () => ({ ...status }),
    watch: (listener) => {
      watchers.add(listener)
      return () => {
        watchers.delete(listener)
      }
    },
    publish: (patch) => {
      status = { ...status, ...patch, checkedAt: Date.now() }
      for (const watcher of [...watchers]) watcher({ ...status })
    },
    watcherCount: () => watchers.size,
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the usage monitor')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

test('startup: usage reads provider status when the first probe connects FCC', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'fcc-usage-'))
  process.env.FCC_USAGE_TEST_ROOT = root

  const requests: string[] = []
  const server = createServer((req, res) => {
    requests.push(req.url ?? '')
    if (req.url === '/admin/api/status') {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', provider: 'nvidia_nim', model: 'nvidia_nim/test-model' }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const baseUrl = `http://127.0.0.1:${(address as AddressInfo).port}`

  const connection = fakeConnection(baseUrl)
  const router = {
    snapshot: () => ({ cooldowns: {}, history: [], lastError: null }),
    providers: () => [],
  } as unknown as import('../electron/fcc/free-router').FreeRouter
  const monitor = new UsageMonitor(connection as unknown as ConnectionManager, router)
  t.after(async () => {
    monitor.stop()
    delete process.env.FCC_USAGE_TEST_ROOT
    await new Promise<void>((resolve) => server.close(() => resolve()))
    rmSync(root, { recursive: true, force: true })
  })

  monitor.start()
  // The monitor starts first; reading now would only prove FCC is unprobed.
  assert.equal(requests.length, 0)
  assert.equal(monitor.state().provider.availability, 'offline')
  assert.equal(connection.watcherCount(), 1)

  // The startup probe resolves: this is the moment provider data is readable.
  connection.publish({ state: 'connected' })
  await waitFor(() => monitor.state().provider.syncedAt !== null)
  const connected = monitor.state()
  assert.notEqual(connected.provider.availability, 'offline')
  assert.equal(connected.provider.providerId, 'nvidia_nim')
  assert.equal(connected.provider.model, 'nvidia_nim/test-model')
  assert.ok(requests.includes('/'), 'provider status was read after the probe')

  // The connection poll republishes 'connected' every 15 s; no extra reads.
  const reads = requests.length
  connection.publish({ state: 'connected' })
  await new Promise((resolve) => setTimeout(resolve, 75))
  assert.equal(requests.length, reads, 'a repeated connected status must not re-read')

  // A real outage and reconnect refreshes provider status again.
  connection.publish({ state: 'disconnected' })
  assert.equal(monitor.state().provider.availability, 'offline')
  const beforeReconnect = requests.length
  connection.publish({ state: 'connected' })
  await waitFor(() => requests.length > beforeReconnect)
  assert.notEqual(monitor.state().provider.availability, 'offline')

  monitor.stop()
  assert.equal(connection.watcherCount(), 0)
})

test('usage config is clamped to safe polling values', () => {
  assert.deepEqual(sanitizeUsageConfig({ enabled: true, pollSeconds: 1 }), { enabled: true, pollSeconds: 1 })
  assert.deepEqual(sanitizeUsageConfig({ enabled: false, pollSeconds: 999999 }), { enabled: false, pollSeconds: 3600 })
  assert.deepEqual(sanitizeUsageConfig({ pollSeconds: 'nope' }), { enabled: true, pollSeconds: 120 })
})
