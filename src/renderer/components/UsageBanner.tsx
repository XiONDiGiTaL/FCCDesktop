import { useEffect, useState } from 'react'
import type { UsageState } from '../../shared/usage'
import { EXHAUSTED_HOLD_MS } from '../../shared/usage'
import { elapsed, relativeTime } from '../lib/format'
import { AlertIcon, ArrowUpRightIcon } from './Icons'

/**
 * In-chat notice for an active provider limit. It appears from the monitor's
 * state, so it shows up even when the failing turn produced no visible error.
 */
export default function UsageBanner({
  state,
  onOpen,
}: {
  state: UsageState | null
  onOpen: () => void
}) {
  const [now, setNow] = useState(Date.now())
  const provider = state?.provider ?? null
  const limited = provider?.availability === 'throttled' || provider?.availability === 'exhausted'
  const resetAt = provider?.cooldownUntil ?? null

  useEffect(() => {
    if (!limited) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [limited, resetAt])

  if (!provider || !limited) return null

  const remaining = resetAt !== null ? resetAt - now : null
  const active = remaining !== null && remaining > 0
  const exhausted = provider.availability === 'exhausted'

  return (
    <div className={`usage-banner ${exhausted ? 'is-exhausted' : 'is-throttled'}`} role="status">
      <span className="usage-banner-icon">
        <AlertIcon size={16} />
      </span>
      <div className="usage-banner-body">
        <strong>{exhausted ? 'Usage limit reached' : 'Provider temporarily rate-limited'}</strong>
        <span>
          {exhausted
            ? 'The provider reported that the available quota is exhausted.'
            : 'Requests are currently being throttled.'}
          {active && remaining !== null ? (
            <>
              {' '}
              Retry available in <span className="usage-banner-count">{elapsed(remaining)}</span>.
            </>
          ) : resetAt !== null ? (
            ' The reported cooldown has elapsed; the next request will confirm whether it cleared.'
          ) : (
            ` No reset time was supplied. This report was seen ${relativeTime(provider.lastRateLimit?.at ?? Date.now())} and is only kept as current for ${Math.round(EXHAUSTED_HOLD_MS / 60000)} minutes, then shown as history.`
          )}
        </span>
      </div>
      <button className="usage-banner-action" onClick={onOpen}>
        View usage <ArrowUpRightIcon size={13} />
      </button>
    </div>
  )
}
