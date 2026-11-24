import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  LocalUsageEvent,
  ProviderAvailability,
  UsageState,
  UsageWindow,
} from '../../shared/usage'
import { EXHAUSTED_HOLD_MS, USAGE_POLL_OPTIONS } from '../../shared/usage'
import { Badge, Button, InlineNotice, Select, Spinner, StatusDot } from './ui'
import { AlertIcon, ArrowUpRightIcon, GaugeIcon, InfoIcon, RefreshIcon, TrashIcon } from './Icons'
import { clockTime, elapsed, relativeTime } from '../lib/format'

interface UsageViewProps {
  state: UsageState | null
  activeModel: string
  onState: (state: UsageState) => void
  onBack: () => void
  onToast: (kind: 'error' | 'info', text: string) => void
}

const STATUS: Record<
  ProviderAvailability,
  { label: string; tone: 'green' | 'amber' | 'red' | 'neutral'; headline: string }
> = {
  available: { label: 'Available', tone: 'green', headline: 'Provider is serving requests' },
  degraded: { label: 'Needs attention', tone: 'amber', headline: 'Provider configuration needs attention' },
  throttled: { label: 'Temporarily rate-limited', tone: 'amber', headline: 'Provider temporarily rate-limited' },
  exhausted: { label: 'Quota exhausted', tone: 'red', headline: 'Usage limit reached' },
  unknown: { label: 'Usage unknown', tone: 'neutral', headline: 'Provider usage is not reported' },
  offline: { label: 'FCC offline', tone: 'red', headline: 'FCC is not reachable' },
}

const OUTCOME_LABEL: Record<LocalUsageEvent['outcome'], string> = {
  success: 'Success',
  failed: 'Failed',
  rate_limited: '429',
  cancelled: 'Stopped',
}

const number = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 })

function tokenTotal(input: number, output: number): string {
  const total = input + output
  return total > 0 ? number.format(total) : 'None reported'
}

function resetLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function sourceLabel(window: UsageWindow): string {
  if (window.source === 'header') return 'gateway headers'
  if (window.source === 'provider') return 'provider API'
  if (window.source === 'local') return 'locally counted'
  return 'inferred from a 429'
}

function UsageMeter({ window }: { window: UsageWindow }) {
  if (window.percent === null) {
    return (
      <div className="usage-window-unknown">
        {window.remaining !== null ? `${number.format(window.remaining)} remaining reported` : 'No percentage reported'}
      </div>
    )
  }
  const percent = Math.min(100, Math.max(0, window.percent))
  const tone = percent >= 95 ? 'is-danger' : percent >= 75 ? 'is-warn' : ''
  return (
    <div className="usage-window-meter">
      <div className="usage-meter">
        <span className={tone} style={{ width: `${percent}%` }} />
      </div>
      <div className="usage-window-numbers">
        <span>{number.format(percent)}% used</span>
        <span>
          {window.used !== null ? number.format(window.used) : '—'} / {window.limit !== null ? number.format(window.limit) : '—'}
        </span>
      </div>
    </div>
  )
}

export default function UsageView({ state, activeModel, onState, onBack, onToast }: UsageViewProps) {
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ tone: 'info' | 'error' | 'success'; text: string } | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [now, setNow] = useState(Date.now())

  const cooldown = state?.provider.cooldownUntil ?? null
  useEffect(() => {
    if (!cooldown) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [cooldown])

  useEffect(() => {
    if (!confirmClear) return
    const timer = window.setTimeout(() => setConfirmClear(false), 5000)
    return () => window.clearTimeout(timer)
  }, [confirmClear])

  const refresh = useCallback(async () => {
    setBusy('refresh')
    setNotice(null)
    try {
      onState(await window.fcc.usage.refresh())
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(null)
    }
  }, [onState])

  const configure = useCallback(
    async (pollSeconds: number) => {
      setBusy('configure')
      try {
        onState(await window.fcc.usage.configure({ enabled: pollSeconds > 0, pollSeconds }))
        setNotice({
          tone: 'success',
          text: pollSeconds > 0 ? 'Background sync interval saved.' : 'Background sync is off; refresh manually.',
        })
      } catch (error) {
        onToast('error', error instanceof Error ? error.message : String(error))
      } finally {
        setBusy(null)
      }
    },
    [onState, onToast],
  )

  const clear = useCallback(async () => {
    if (!confirmClear) {
      setConfirmClear(true)
      return
    }
    setConfirmClear(false)
    setBusy('clear')
    try {
      onState(await window.fcc.usage.clearHistory())
      setNotice({ tone: 'info', text: 'Local usage history cleared. Nothing was deleted at the provider.' })
    } catch (error) {
      onToast('error', error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(null)
    }
  }, [confirmClear, onState, onToast])

  const local = state?.local ?? null
  const provider = state?.provider ?? null
  const status = STATUS[provider?.availability ?? 'unknown']
  const remaining = cooldown ? cooldown - now : null
  const active = remaining !== null && remaining > 0
  const windows = provider?.windows ?? []
  const days = local?.days ?? []
  const maxDay = useMemo(() => Math.max(1, ...days.map((day) => day.requests)), [days])
  const pollValue = state ? (state.config.enabled ? state.config.pollSeconds : 0) : 120
  // The conversation's model is what the user is actually about to use; the
  // FCC server default is only a fallback.
  const model = activeModel || provider?.model || 'Server default'
  const todayTotal = local?.today.requests ?? 0
  const composition = local
    ? [
        { key: 'success', value: local.today.success },
        { key: 'failed', value: local.today.failed - local.today.rateLimited },
        { key: 'rate', value: local.today.rateLimited },
        { key: 'cancelled', value: local.today.cancelled },
      ]
    : []
  const lastRateLimit = local?.totals.rateLimited ?? 0
  const limitCurrent =
    provider?.availability === 'throttled' || provider?.availability === 'exhausted'

  return (
    <div className="skills usage">
      <header className="skills-head">
        <div className="skills-heading">
          <span className="skills-eyebrow">
            <GaugeIcon size={14} /> Provider usage
          </span>
          <h1>Know what is left before the wall</h1>
          <p>
            {provider?.providerLabel ?? 'Reading provider'} · {model}
            {provider?.syncedAt ? ` · synced ${relativeTime(provider.syncedAt)}` : ' · not synced yet'}
          </p>
        </div>
        <div className="skills-head-actions">
          <Button icon={<RefreshIcon size={15} />} onClick={() => void refresh()} disabled={busy === 'refresh'}>
            {busy === 'refresh' ? <Spinner size={13} /> : 'Refresh'}
          </Button>
          {provider ? (
            <Button
              variant="ghost"
              icon={<ArrowUpRightIcon size={14} />}
              onClick={() => void window.fcc.app.openExternal(`${provider.endpoint.replace(/\/+$/, '')}/admin`)}
            >
              FCC Admin
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onBack}>
            Back to chat
          </Button>
        </div>
      </header>

      {notice ? (
        <InlineNotice
          tone={notice.tone === 'success' ? 'success' : notice.tone === 'error' ? 'error' : 'info'}
          onClose={() => setNotice(null)}
        >
          {notice.text}
        </InlineNotice>
      ) : null}

      {!state || !provider || !local ? (
        <div className="usage-loading">
          <Spinner size={16} /> Reading provider status and local history…
        </div>
      ) : (
        <div className="usage-scroll">
          <section className={`usage-hero is-${provider.availability}`}>
            <div className="usage-hero-main">
              <span className={`usage-orb is-${provider.availability}`}>
                <GaugeIcon size={20} />
              </span>
              <div className="usage-hero-copy">
                <div className="usage-status-line">
                  <StatusDot tone={status.tone} />
                  <span className="usage-status-label">{status.label}</span>
                  {provider.cached ? <Badge tone="neutral">cached</Badge> : null}
                </div>
                <h2>{status.headline}</h2>
                <p>{provider.summary}</p>
              </div>
            </div>

            <div className="usage-hero-meta">
              <div>
                <span>Provider</span>
                <strong>{provider.providerLabel}</strong>
              </div>
              <div>
                <span>Active model</span>
                <strong title={model}>{model}</strong>
              </div>
              <div>
                <span>Last sync</span>
                <strong>{provider.syncedAt ? relativeTime(provider.syncedAt) : 'Never'}</strong>
              </div>
              <div>
                <span>Account key</span>
                <strong>{provider.keyStatus.label}</strong>
              </div>
            </div>

            {provider.availability === 'throttled' || provider.availability === 'exhausted' ? (
              <div className={`usage-countdown ${active ? 'is-live' : ''}`}>
                <span className="usage-countdown-label">
                  {provider.availability === 'exhausted' ? 'Quota reset' : 'Retry available in'}
                </span>
                <strong className="usage-countdown-value">
                  {active && remaining !== null
                    ? elapsed(remaining)
                    : cooldown
                      ? 'Waiting for refresh'
                      : provider.availability === 'exhausted'
                        ? 'No reset time'
                        : 'Unknown'}
                </strong>
                <span className="usage-countdown-sub">
                  {cooldown
                    ? `Provider-reported reset: ${resetLabel(cooldown)}`
                    : provider.availability === 'exhausted'
                      ? `No reset or Retry-After time was supplied. This report is shown as current for ${Math.round(EXHAUSTED_HOLD_MS / 60000)} minutes, then kept as history.`
                      : 'The provider did not include a reset or Retry-After time.'}
                </span>
              </div>
            ) : null}

            {provider.lastRateLimit ? (
              <div className={`usage-last-hit${limitCurrent ? '' : ' is-stale'}`}>
                <AlertIcon size={13} />
                {provider.lastRateLimit.exhausted ? 'Quota exhaustion' : 'Rate limit'} last reported{' '}
                {relativeTime(provider.lastRateLimit.at)}
                {limitCurrent ? null : <span className="usage-last-hit-note">no longer current</span>}
                {provider.lastRateLimit.category ? ` · ${provider.lastRateLimit.category}` : ''}
                {provider.lastRateLimit.requestId ? (
                  <code className="usage-request-id">{provider.lastRateLimit.requestId}</code>
                ) : null}
              </div>
            ) : null}
          </section>

          {provider.error ? (
            <InlineNotice tone="error">Monitor: {provider.error}</InlineNotice>
          ) : null}

          <div className="usage-metrics">
            <div className="usage-metric">
              <span className="usage-metric-label">Provider quota</span>
              <strong className={provider.capability.supported ? '' : 'is-muted'}>
                {provider.capability.supported ? 'Reported' : 'Not exposed'}
              </strong>
              <span className="usage-metric-sub">No provider API for remaining allowance</span>
            </div>
            <div className="usage-metric">
              <span className="usage-metric-label">Request attempts today</span>
              <strong>{number.format(todayTotal)}</strong>
              <span className="usage-metric-sub">
                {local.today.success} ok · {local.today.failed} failed · locally counted
              </span>
            </div>
            <div className="usage-metric">
              <span className="usage-metric-label">429s · 7 days</span>
              <strong>{number.format(local.last7Days.rateLimited)}</strong>
              <span className="usage-metric-sub">
                {lastRateLimit > 0 ? `${number.format(lastRateLimit)} in ${local.retentionDays} days` : 'None observed yet'}
              </span>
            </div>
            <div className="usage-metric">
              <span className="usage-metric-label">Tokens · 7 days</span>
              <strong>{tokenTotal(local.last7Days.inputTokens, local.last7Days.outputTokens)}</strong>
              <span className="usage-metric-sub">
                {number.format(local.last7Days.inputTokens)} in · {number.format(local.last7Days.outputTokens)} out
              </span>
            </div>
          </div>

          <section className="usage-card">
            <div className="usage-card-head">
              <span>Can this provider report remaining quota?</span>
              <Badge tone={provider.capability.supported ? 'green' : 'neutral'}>
                {provider.capability.supported ? 'Supported' : 'Not available'}
              </Badge>
            </div>
            <p className="usage-card-copy">{provider.capability.detail}</p>
            <div className="usage-card-foot">
              <span className="usage-key-state">
                <StatusDot tone={provider.keyStatus.state === 'configured' ? 'green' : provider.keyStatus.state === 'missing' ? 'red' : 'neutral'} />
                {provider.keyStatus.detail ?? `FCC key status: ${provider.keyStatus.label}`}
              </span>
              {provider.capability.sourceUrl ? (
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<ArrowUpRightIcon size={13} />}
                  onClick={() => void window.fcc.app.openExternal(provider.capability.sourceUrl ?? '')}
                >
                  Provider docs
                </Button>
              ) : null}
            </div>
          </section>

          <section className="usage-card">
            <div className="usage-card-head">
              <span>Usage windows</span>
              <span className="usage-card-note">Separate windows stay separate; nothing is combined into one percentage.</span>
            </div>
            {windows.length === 0 ? (
              <div className="usage-empty">
                <InfoIcon size={14} />
                <div>
                  <strong>No provider-reported windows.</strong>
                  <p>
                    This provider does not publish a daily, weekly or monthly request quota to FCC. A cooldown window
                    appears here only when a 429 supplies a retry or reset time.
                  </p>
                </div>
              </div>
            ) : (
              <div className="usage-window-list">
                {windows.map((window) => (
                  <article key={window.id} className={`usage-window is-${window.kind}`}>
                    <div className="usage-window-head">
                      <span className="usage-window-title">{window.label}</span>
                      <span className="usage-window-source">{sourceLabel(window)}</span>
                    </div>
                    <UsageMeter window={window} />
                    <div className="usage-window-foot">
                      <span>
                        {window.resetAt ? `Resets ${resetLabel(window.resetAt)} · ${clockTime(window.resetAt)}` : 'Reset time not provided'}
                      </span>
                      {window.note ? <span>{window.note}</span> : null}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className="usage-card">
            <div className="usage-card-head">
              <span>Local activity</span>
              <Badge tone="blue">Locally tracked</Badge>
            </div>
            <p className="usage-disclaimer">
              Counted by FCC Desktop from the requests this app made. These numbers are not the provider’s remaining
              free allowance and must not be read as account quota.
            </p>

            <div className="usage-today">
              <div className="usage-today-head">
                <span>Today by outcome</span>
                <strong>{number.format(todayTotal)} requests</strong>
              </div>
              <div className="usage-stack" role="img" aria-label="Today's request outcomes">
                {todayTotal === 0 ? (
                  <span className="usage-stack-empty" />
                ) : (
                  composition.map((part) =>
                    part.value > 0 ? (
                      <span
                        key={part.key}
                        className={`usage-stack-seg is-${part.key}`}
                        style={{ width: `${(part.value / todayTotal) * 100}%` }}
                      />
                    ) : null,
                  )
                )}
              </div>
              <div className="usage-legend">
                <span className="is-success">{local.today.success} succeeded</span>
                <span className="is-failed">{local.today.failed} failed</span>
                <span className="is-rate">{local.today.rateLimited} rate-limited</span>
                <span className="is-cancelled">{local.today.cancelled} stopped</span>
              </div>
            </div>

            <div className="usage-chart-wrap">
              <div className="usage-chart-head">
                <span>Last 7 days</span>
                <span>
                  {number.format(local.last7Days.requests)} requests · {number.format(local.last7Days.rateLimited)} 429s
                </span>
              </div>
              <div className="usage-chart">
                {days.map((day) => (
                  <div key={day.date} className="usage-chart-col" title={`${day.requests} requests · ${day.rateLimited} 429s`}>
                    <span className="usage-chart-value">{day.requests || ''}</span>
                    <span className="usage-chart-bar">
                      <span
                        className={day.rateLimited > 0 ? 'has-limits' : ''}
                        style={{ height: `${day.requests === 0 ? 2 : Math.max(8, (day.requests / maxDay) * 100)}%` }}
                      />
                    </span>
                    <span className="usage-chart-label">{day.label}</span>
                  </div>
                ))}
              </div>
            </div>

            {local.models.length > 0 ? (
              <div className="usage-table-wrap">
                <table className="usage-table">
                  <thead>
                    <tr>
                      <th>Model</th>
                      <th>Attempts</th>
                      <th>429s</th>
                      <th>Tokens</th>
                      <th>Last used</th>
                    </tr>
                  </thead>
                  <tbody>
                    {local.models.slice(0, 6).map((entry) => (
                      <tr key={entry.model}>
                        <td title={entry.model}>{entry.model}</td>
                        <td>{number.format(entry.requests)}</td>
                        <td>{entry.rateLimited > 0 ? <span className="usage-hot">{entry.rateLimited}</span> : '0'}</td>
                        <td>{number.format(entry.inputTokens + entry.outputTokens)}</td>
                        <td>{relativeTime(entry.lastUsedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="usage-empty">
                <InfoIcon size={14} />
                <div>
                  <strong>No requests recorded yet.</strong>
                  <p>Send a message and this timeline starts filling in. It never leaves this computer.</p>
                </div>
              </div>
            )}

            {local.recent.length > 0 ? (
              <div className="usage-recent">
                <div className="usage-recent-head">Recent requests</div>
                {local.recent.slice(0, 8).map((event, index) => (
                  <div key={`${event.at}-${index}`} className="usage-recent-row">
                    <span className={`usage-outcome is-${event.outcome}`}>{OUTCOME_LABEL[event.outcome]}</span>
                    <span className="usage-recent-model" title={event.model}>
                      {event.model}
                    </span>
                    <span className="usage-recent-tokens">
                      {event.inputTokens !== null || event.outputTokens !== null
                        ? `${number.format((event.inputTokens ?? 0) + (event.outputTokens ?? 0))} tok`
                        : 'tokens n/a'}
                    </span>
                    <span className="usage-recent-time">{relativeTime(event.at)}</span>
                  </div>
                ))}
              </div>
            ) : null}

            <div className="usage-card-foot usage-clear-row">
              <span>
                {local.trackedSince ? `Tracking since ${new Date(local.trackedSince).toLocaleDateString()} · ${local.retentionDays} day retention` : 'Nothing stored yet'}
              </span>
              <Button
                size="sm"
                variant="ghost"
                icon={<TrashIcon size={13} />}
                onClick={() => void clear()}
                disabled={busy === 'clear' || local.totals.requests === 0}
              >
                {confirmClear ? 'Confirm clear' : 'Clear local history'}
              </Button>
            </div>
          </section>

          <section className="usage-card usage-sync">
            <div className="usage-card-head">
              <span>Monitoring</span>
              <span className="usage-card-note">Reads FCC metadata only; never sends a model request.</span>
            </div>
            <div className="usage-sync-row">
              <label className="usage-sync-field">
                <span>Background sync</span>
                <Select value={pollValue} onChange={(event) => void configure(Number(event.target.value))} disabled={busy === 'configure'}>
                  {USAGE_POLL_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </label>
              <div className="usage-sync-facts">
                <span>Refreshes at start, after turns, after a 429, and on the interval above.</span>
                <span>
                  Last successful sync: {provider.syncedAt ? `${relativeTime(provider.syncedAt)} (${clockTime(provider.syncedAt)})` : 'never'}
                </span>
              </div>
            </div>
            <p className="usage-security">
              No API keys, tokens or session cookies are read for this view. FCC Desktop asks FCC for provider status,
              reads the agent’s own error text, and stores only counts on this computer.
            </p>
          </section>
        </div>
      )}
    </div>
  )
}
