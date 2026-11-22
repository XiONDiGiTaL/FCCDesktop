import { useEffect, useState } from 'react'
import { elapsed } from '../lib/format'

export type ActivityPhase = 'idle' | 'thinking' | 'working' | 'waiting'

interface LiveActivityProps {
  phase: ActivityPhase
  /** When the current turn started, used for the live elapsed clock. */
  startedAt: number | null
  active: boolean
  /** Optional context, such as the tool that is running right now. */
  detail?: string | null
  compact?: boolean
}

function labelFor(phase: ActivityPhase): string {
  if (phase === 'thinking') return 'Thinking'
  if (phase === 'working') return 'Working'
  if (phase === 'waiting') return 'Waiting'
  return 'Running'
}

/**
 * Live "Thinking… 1:04" indicator. The timer lives in this component so the
 * once-per-second tick does not re-render the whole conversation.
 */
export default function LiveActivity({ phase, startedAt, active, detail, compact = false }: LiveActivityProps) {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [active])

  if (!active) return null

  const time = startedAt ? elapsed(Math.max(0, now - startedAt)) : ''

  return (
    <span className={`live-activity ${compact ? 'is-compact' : ''}`}>
      <span className={`thinking-orb phase-${phase}`} />
      <span className="live-activity-label">{labelFor(phase)}…</span>
      {detail ? <span className="live-activity-detail">{detail}</span> : null}
      {time ? (
        <span className="live-activity-time" title="Time on this turn">
          {time}
        </span>
      ) : null}
    </span>
  )
}
