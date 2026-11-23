import { useEffect, useRef, useState } from 'react'
import type { SkillInvocation } from '../../shared/skills'
import { SparkIcon } from './Icons'

export interface ActiveSkillsState {
  turnId: string
  invocations: SkillInvocation[]
  delivery: 'native' | 'inline' | 'none'
  notes: string[]
}

/**
 * The conversation-header indicator. It reports what actually happened on the
 * last turn: which skills were chosen, whether the model selected them or the
 * user did, and how their instructions were delivered.
 */
export default function ActiveSkills({
  state,
  onOpenSkills,
}: {
  state: ActiveSkillsState | null
  onOpenSkills: () => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onClick = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  if (!state || state.invocations.length === 0) return null
  const names = state.invocations.map((invocation) => invocation.name)
  const label = names.length === 1 ? names[0] : `${names.length} skills`

  return (
    <div className="active-skills" ref={ref}>
      <button
        className={`active-skills-chip ${state.delivery === 'inline' ? 'is-inline' : ''}`}
        onClick={() => setOpen((current) => !current)}
        title={`Skills used this turn: ${names.join(', ')}`}
      >
        <SparkIcon size={12} />
        <span>{label}</span>
        {state.invocations.some((invocation) => invocation.reason === 'auto') ? (
          <span className="active-skills-auto">auto</span>
        ) : null}
      </button>

      {open ? (
        <div className="active-skills-pop" role="dialog" aria-label="Active skills">
          <div className="active-skills-head">
            <span>Applied to this turn</span>
            <button className="link-btn" onClick={onOpenSkills}>
              Manage
            </button>
          </div>
          <ul>
            {state.invocations.map((invocation) => (
              <li key={invocation.id}>
                <span className="active-skills-name">
                  {invocation.name}
                  <span className={`active-skills-reason is-${invocation.reason}`}>{invocation.reason}</span>
                </span>
                {invocation.matched.length > 0 && invocation.reason === 'auto' ? (
                  <span className="active-skills-why">matched: {invocation.matched.join(', ')}</span>
                ) : (
                  <span className="active-skills-why">selected by you</span>
                )}
              </li>
            ))}
          </ul>
          <p className="active-skills-foot">
            {state.delivery === 'inline'
              ? 'Instructions were injected into the prompt by FCC (inline adapter) and count against this turn’s context.'
              : 'The CLI loaded these through its native skill registry; only names entered the context up front.'}
          </p>
          {state.notes.length > 0 ? (
            <ul className="active-skills-notes">
              {state.notes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
