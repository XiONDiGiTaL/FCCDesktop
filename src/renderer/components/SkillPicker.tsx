import { useMemo, useState } from 'react'
import type { SkillSummary } from '../../shared/skills'
import { Badge, Button, Modal, TextInput } from './ui'
import { CloseIcon, SearchIcon, SparkIcon } from './Icons'

/**
 * Explicit selection for the next message. Skills chosen here are invoked even
 * when automatic detection would not pick them.
 */
export default function SkillPicker({
  open,
  skills,
  selected,
  onClose,
  onToggle,
  onOpenLibrary,
}: {
  open: boolean
  skills: SkillSummary[]
  selected: string[]
  onClose: () => void
  onToggle: (name: string) => void
  onOpenLibrary: () => void
}) {
  const [query, setQuery] = useState('')
  const enabled = useMemo(() => {
    const text = query.trim().toLowerCase()
    return skills
      .filter((skill) => skill.enabled)
      .filter((skill) =>
        text
          ? [skill.name, skill.description, skill.category ?? '', skill.source?.repo ?? ''].join(' ').toLowerCase().includes(text)
          : true,
      )
      .sort((a, b) => (selected.includes(b.name) ? 1 : 0) - (selected.includes(a.name) ? 1 : 0))
  }, [skills, query, selected])

  return (
    <Modal open={open} onClose={onClose} className="modal-skills">
      <div className="skill-picker">
        <div className="skill-picker-head">
          <div>
            <h2>
              <SparkIcon size={16} /> Skills for this message
            </h2>
            <p>Pick skills explicitly. Enabled skills otherwise load automatically when the request matches.</p>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <CloseIcon size={16} />
          </button>
        </div>

        <div className="skills-search">
          <SearchIcon size={15} />
          <TextInput
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search enabled skills"
            spellCheck={false}
            autoFocus
          />
        </div>

        <div className="skill-picker-list">
          {enabled.length === 0 ? (
            <p className="skill-dim">
              {skills.length === 0
                ? 'No skills installed yet — open the library to browse skills.sh and GitHub.'
                : 'No enabled skill matches that search.'}
            </p>
          ) : (
            enabled.map((skill) => {
              const isOn = selected.includes(skill.name)
              return (
                <button
                  key={skill.id}
                  className={`skill-pick-row ${isOn ? 'is-on' : ''}`}
                  onClick={() => onToggle(skill.name)}
                >
                  <span className="skill-pick-check">{isOn ? '✓' : ''}</span>
                  <span className="skill-pick-copy">
                    <span className="skill-pick-name">
                      {skill.name}
                      {skill.scope === 'project' ? <Badge tone="blue">project</Badge> : null}
                      {!skill.autoInvoke ? <Badge>manual</Badge> : null}
                    </span>
                    <span className="skill-pick-desc">{skill.description || 'No description.'}</span>
                  </span>
                </button>
              )
            })
          )}
        </div>

        <div className="skill-picker-foot">
          <span className="skill-dim">{selected.length} selected · invoked with /name under the hood</span>
          <div className="skill-picker-actions">
            <Button variant="ghost" onClick={onOpenLibrary}>
              Open library
            </Button>
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
