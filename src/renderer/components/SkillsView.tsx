import { useCallback, useEffect, useMemo, useState } from 'react'
import type {
  SkillCandidate,
  SkillCategory,
  SkillDetail,
  SkillRepoListing,
  SkillSummary,
  SkillsConfig,
  SkillsState,
} from '../../shared/skills'
import type { SkillCatalog } from '../../shared/skills'
import { friendlyError } from '../lib/format'
import { Badge, Button, IconButton, InlineNotice, Segmented, Select, Spinner, TextInput, Toggle } from './ui'
import {
  AlertIcon,
  ArrowUpRightIcon,
  ChevronRightIcon,
  CloseIcon,
  FolderIcon,
  LinkIcon,
  PlayIcon,
  PowerIcon,
  RefreshIcon,
  SearchIcon,
  SparkIcon,
  TrashIcon,
} from './Icons'

interface SkillsViewProps {
  projectPath: string | null
  workspaceName: string | null
  onBack: () => void
  onToast: (kind: 'info' | 'error', text: string) => void
  onOpenExternal: (url: string) => void
  onSkillsChanged: () => void
}

type Tab = 'installed' | 'discover'
type Source = 'skills.sh' | 'github' | 'curated'

const SOURCES: Array<{ value: Source; label: string }> = [
  { value: 'skills.sh', label: 'skills.sh' },
  { value: 'github', label: 'GitHub' },
  { value: 'curated', label: 'Curated' },
]

function formatDate(value: number | null): string {
  if (!value) return '—'
  return new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function ScopeBadge({ scope }: { scope: 'global' | 'project' }) {
  return <Badge tone={scope === 'project' ? 'blue' : 'neutral'}>{scope === 'project' ? 'project' : 'global'}</Badge>
}

export default function SkillsView({
  projectPath,
  workspaceName,
  onBack,
  onToast,
  onOpenExternal,
  onSkillsChanged,
}: SkillsViewProps) {
  const api = window.fcc
  const [catalog, setCatalog] = useState<SkillCatalog | null>(null)
  const [categories, setCategories] = useState<SkillCategory[]>([])
  const [tab, setTab] = useState<Tab>('installed')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'enabled' | 'disabled' | 'updates'>('all')
  const [checking, setChecking] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<SkillDetail | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ tone: 'info' | 'error' | 'success'; text: string } | null>(null)

  // discovery state
  const [source, setSource] = useState<Source>('skills.sh')
  const [discoverQuery, setDiscoverQuery] = useState('')
  const [category, setCategory] = useState<string>('')
  const [candidates, setCandidates] = useState<SkillCandidate[]>([])
  const [discoverError, setDiscoverError] = useState<string | null>(null)
  const [discovering, setDiscovering] = useState(false)

  // repo inspection + install
  const [repoInput, setRepoInput] = useState('')
  const [listing, setListing] = useState<SkillRepoListing | null>(null)
  const [repoChoice, setRepoChoice] = useState<Set<string>>(new Set())
  const [installScope, setInstallScope] = useState<'global' | 'project'>(projectPath ? 'project' : 'global')
  const [inspecting, setInspecting] = useState(false)

  const refresh = useCallback(
    async (showSpinner = false) => {
      if (showSpinner) setBusy('refresh')
      try {
        const next = await api.skills.catalog({ projectPath, refresh: true })
        setCatalog(next)
      } catch (error) {
        setNotice({ tone: 'error', text: friendlyError(error) })
      } finally {
        if (showSpinner) setBusy(null)
      }
    },
    [api.skills, projectPath],
  )

  useEffect(() => {
    void refresh(true)
    void api.skills
      .categories()
      .then(setCategories)
      .catch(() => setCategories([]))
    setInstallScope(projectPath ? 'project' : 'global')
  }, [api.skills, projectPath, refresh])

  // Compare installed GitHub skills with their sources when the view opens. The
  // service throttles this, so revisiting the tab does not hammer GitHub.
  useEffect(() => {
    let cancelled = false
    setChecking(true)
    void api.skills
      .checkUpdates({ projectPath })
      .then((state) => {
        if (cancelled) return
        setCatalog((current) =>
          current ? { ...current, skills: state.skills, settings: state.settings } : current,
        )
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setChecking(false)
      })
    return () => {
      cancelled = true
    }
  }, [api.skills, projectPath])

  useEffect(() => {
    const off = api.skills.onChanged(() => {
      void refresh()
    })
    return off
  }, [api.skills, refresh])

  useEffect(() => {
    if (!selected) {
      setDetail(null)
      return
    }
    let cancelled = false
    void api.skills
      .detail(selected, projectPath)
      .then((next) => {
        if (!cancelled) setDetail(next)
      })
      .catch(() => {
        if (!cancelled) setDetail(null)
      })
    return () => {
      cancelled = true
    }
  }, [api.skills, projectPath, selected])

  const skills = catalog?.skills ?? []
  const config = catalog?.settings ?? null

  const filtered = useMemo(() => {
    const text = query.trim().toLowerCase()
    return skills.filter((skill) => {
      if (filter === 'enabled' && !skill.enabled) return false
      if (filter === 'disabled' && skill.enabled) return false
      if (filter === 'updates' && !skill.updateAvailable) return false
      if (!text) return true
      return [skill.name, skill.description, skill.category ?? '', skill.source?.repo ?? '', skill.version ?? '']
        .join(' ')
        .toLowerCase()
        .includes(text)
    })
  }, [skills, query, filter])

  const groupedCategories = useMemo(() => {
    const map = new Map<string, SkillCategory[]>()
    for (const entry of categories) {
      const list = map.get(entry.group) ?? []
      list.push(entry)
      map.set(entry.group, list)
    }
    return Array.from(map.entries())
  }, [categories])

  const applyState = (state: SkillsState) => {
    setCatalog((current) =>
      current
        ? { ...current, skills: state.skills, settings: state.settings, revision: state.revision }
        : {
            skills: state.skills,
            settings: state.settings,
            revision: state.revision,
            scannedAt: Date.now(),
            directories: { global: '', project: null },
          },
    )
    onSkillsChanged()
  }

  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key)
    setNotice(null)
    try {
      await action()
    } catch (error) {
      const text = friendlyError(error)
      setNotice({ tone: 'error', text })
      onToast('error', text)
    } finally {
      setBusy(null)
    }
  }

  const toggleSkill = (skill: SkillSummary, enabled: boolean) =>
    run(`toggle:${skill.id}`, async () => {
      const state = await api.skills.setEnabled(skill.id, enabled, projectPath, false)
      applyState(state)
      setDetail((current) => (current && current.id === skill.id ? { ...current, enabled } : current))
      setNotice({
        tone: 'success',
        text: enabled
          ? `${skill.name} is active. The next message restarts the agent with it available.`
          : `${skill.name} is disabled and removed from the agent's registry.`,
      })
    })

  const toggleAuto = (skill: SkillSummary, auto: boolean) =>
    run(`auto:${skill.id}`, async () => {
      const state = await api.skills.setAutoInvoke(skill.id, auto, projectPath)
      applyState(state)
    })

  const setCategoryFor = (skill: SkillSummary, value: string) =>
    run(`cat:${skill.id}`, async () => {
      const state = await api.skills.setCategory(skill.id, value || null, projectPath)
      applyState(state)
      setDetail((current) => (current && current.id === skill.id ? { ...current, category: value || null } : current))
    })

  const removeSkill = (skill: SkillSummary) =>
    run(`remove:${skill.id}`, async () => {
      const state = await api.skills.remove(skill.id, projectPath)
      applyState(state)
      if (selected === skill.id) setSelected(null)
      setNotice({ tone: 'success', text: `Removed ${skill.name} from disk.` })
    })

  const updateSkill = (skill: SkillSummary) =>
    run(`update:${skill.id}`, async () => {
      const result = await api.skills.update(skill.id, projectPath)
      setNotice({ tone: result.ok ? 'success' : 'error', text: result.message })
      await refresh()
    })

  const bulk = (enabled: boolean) =>
    run('bulk', async () => {
      let changed = 0
      let blocked = 0
      for (const skill of filtered) {
        if (skill.enabled === enabled) continue
        try {
          await api.skills.setEnabled(skill.id, enabled, projectPath, enabled ? false : false)
          changed += 1
        } catch {
          blocked += 1
        }
      }
      await refresh()
      setNotice({
        tone: blocked > 0 ? 'info' : 'success',
        text: `${enabled ? 'Enabled' : 'Disabled'} ${changed} skill${changed === 1 ? '' : 's'}${
          blocked > 0 ? `, ${blocked} blocked (external skills need confirmation in Settings)` : ''
        }.`,
      })
    })

  const updateConfig = (patch: Partial<SkillsConfig>) =>
    run('config', async () => {
      await api.settings.update({ skills: patch })
      await refresh()
    })

  const discover = () =>
    run('discover', async () => {
      setDiscovering(true)
      setDiscoverError(null)
      try {
        const result = await api.skills.discover({
          source,
          query: discoverQuery,
          category: category || null,
        })
        setCandidates(result.candidates)
        setDiscoverError(result.error)
      } finally {
        setDiscovering(false)
      }
    })

  const inspect = (ref: string) =>
    run('inspect', async () => {
      setInspecting(true)
      setListing(null)
      setRepoChoice(new Set())
      try {
        const result = await api.skills.inspectRepo(ref)
        setListing(result)
        setRepoInput(ref)
        if (result.error) setNotice({ tone: 'error', text: result.error })
        else {
          const first = result.entries.find((entry) => entry.valid)
          if (first) setRepoChoice(new Set([first.path]))
        }
      } finally {
        setInspecting(false)
      }
    })

  const installSelected = () =>
    run('install', async () => {
      if (!listing) return
      const result = await api.skills.installRepo({
        ref: listing.repo,
        paths: Array.from(repoChoice),
        scope: installScope,
        projectPath: installScope === 'project' ? projectPath : null,
      })
      setNotice({ tone: result.ok ? 'success' : 'error', text: result.message })
      if (result.skipped.length > 0) {
        setNotice({
          tone: 'info',
          text: `${result.message} Skipped: ${result.skipped.map((entry) => entry.name).join(', ')}`,
        })
      }
      if (result.ok) {
        setTab('installed')
        await refresh()
      }
    })

  const importFolder = () =>
    run('import-folder', async () => {
      const paths = await api.skills.pickImportFolder()
      if (paths.length === 0) return
      const result = await api.skills.importLocal({
        paths,
        scope: installScope,
        projectPath: installScope === 'project' ? projectPath : null,
      })
      setNotice({ tone: result.ok ? 'success' : 'error', text: result.message })
      if (result.ok) await refresh()
    })

  const importZip = () =>
    run('import-zip', async () => {
      const path = await api.skills.pickImportArchive()
      if (!path) return
      const result = await api.skills.importZip({
        path,
        scope: installScope,
        projectPath: installScope === 'project' ? projectPath : null,
      })
      setNotice({ tone: result.ok ? 'success' : 'error', text: result.message })
      if (result.ok) await refresh()
    })

  const updateAll = () =>
    run('update-all', async () => {
      const targets = skills.filter((skill) => skill.updateAvailable)
      let updated = 0
      const failures: string[] = []
      for (const skill of targets) {
        try {
          const result = await api.skills.update(skill.id, projectPath)
          if (result.ok) updated += 1
          else failures.push(skill.name)
        } catch {
          failures.push(skill.name)
        }
      }
      await refresh()
      setNotice({
        tone: failures.length > 0 ? 'info' : 'success',
        text: `Updated ${updated} skill${updated === 1 ? '' : 's'}${
          failures.length > 0 ? `. Could not update: ${failures.join(', ')}` : '.'
        }`,
      })
    })

  const checkNow = () =>
    run('check', async () => {
      setChecking(true)
      try {
        const state = await api.skills.checkUpdates({ projectPath, force: true })
        applyState(state)
        const available = state.skills.filter((skill) => skill.updateAvailable).length
        setNotice({
          tone: 'info',
          text:
            available > 0
              ? `${available} skill${available === 1 ? ' has' : 's have'} a newer version upstream.`
              : 'All GitHub-sourced skills are up to date.',
        })
      } finally {
        setChecking(false)
      }
    })

  const enabledCount = skills.filter((skill) => skill.enabled).length
  const updateCount = skills.filter((skill) => skill.updateAvailable).length
  const detailOpen = Boolean(selected && detail)

  return (
    <div className="skills">
      <header className="skills-head">
        <div className="skills-heading">
          <span className="skills-eyebrow">
            <SparkIcon size={14} /> Agent Skills
          </span>
          <h1>Capabilities your agent can load</h1>
          <p>
            {skills.length} installed · {enabledCount} enabled ·{' '}
            {projectPath ? `project scope: ${workspaceName ?? 'workspace'}` : 'global scope'} ·{' '}
            {config?.mode === 'inline' ? 'inline adapter' : 'native CLI loading'}
          </p>
        </div>
        <div className="skills-head-actions">
          {updateCount > 0 ? (
            <Button
              variant="primary"
              icon={<RefreshIcon size={15} />}
              onClick={() => void updateAll()}
              disabled={busy === 'update-all'}
            >
              {busy === 'update-all' ? 'Updating…' : `Update ${updateCount}`}
            </Button>
          ) : null}
          <Button variant="ghost" onClick={() => void checkNow()} disabled={checking || busy === 'check'}>
            {checking ? 'Checking…' : 'Check for updates'}
          </Button>
          <Button icon={<RefreshIcon size={15} />} onClick={() => void refresh(true)} disabled={busy === 'refresh'}>
            Refresh
          </Button>
          <Button variant="ghost" onClick={onBack}>
            Back to chat
          </Button>
        </div>
      </header>

      {notice ? (
        <InlineNotice tone={notice.tone === 'success' ? 'success' : notice.tone === 'error' ? 'error' : 'info'} onClose={() => setNotice(null)}>
          {notice.text}
        </InlineNotice>
      ) : null}

      <div className="skills-config">
        <Toggle
          label="Skills enabled"
          description="Master switch. Off means no skill is offered or injected."
          checked={config?.enabled ?? true}
          onChange={(value) => void updateConfig({ enabled: value })}
        />
        <Toggle
          label="Automatic invocation"
          description="Match the prompt against installed skills. Multiple matches run together."
          checked={config?.autoInvoke ?? true}
          onChange={(value) => void updateConfig({ autoInvoke: value })}
        />
        <Toggle
          label="Active-skills indicator"
          description="Show which skills guided each turn in the conversation header."
          checked={config?.showIndicator ?? true}
          onChange={(value) => void updateConfig({ showIndicator: value })}
        />
        <Toggle
          label="Manage external skills"
          description="Allow disabling skills FCC did not install. They move to a hidden stash, never deleted."
          checked={config?.manageExternal ?? false}
          onChange={(value) => void updateConfig({ manageExternal: value })}
        />
        <div className="skills-config-row">
          <label className="skills-field">
            <span>Delivery</span>
            <Select
              value={config?.mode ?? 'native'}
              onChange={(event) => void updateConfig({ mode: event.target.value as 'native' | 'inline' })}
            >
              <option value="native">Native — Claude Code loads SKILL.md</option>
              <option value="inline">Inline — FCC injects the instructions</option>
            </Select>
          </label>
          <label className="skills-field">
            <span>Max skills per turn</span>
            <Select
              value={String(config?.maxActive ?? 3)}
              onChange={(event) => void updateConfig({ maxActive: Number(event.target.value) })}
            >
              {[1, 2, 3, 4, 5].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </Select>
          </label>
        </div>
      </div>

      <div className="skills-tabs">
        <Segmented
          value={tab}
          options={[
            { value: 'installed' as Tab, label: `Installed (${skills.length})` },
            { value: 'discover' as Tab, label: 'Discover' },
          ]}
          onChange={setTab}
        />
        {tab === 'installed' ? (
          <div className="skills-filters">
            <div className="skills-search">
              <SearchIcon size={15} />
              <TextInput
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Filter by name, category, source…"
                spellCheck={false}
              />
            </div>
            <Segmented
              value={filter}
              options={[
                { value: 'all' as const, label: 'All' },
                { value: 'enabled' as const, label: 'Enabled' },
                { value: 'disabled' as const, label: 'Disabled' },
                { value: 'updates' as const, label: `Updates${updateCount ? ` (${updateCount})` : ''}` },
              ]}
              onChange={setFilter}
            />
            <Button size="sm" variant="ghost" onClick={() => void bulk(true)} disabled={busy === 'bulk'}>
              Enable shown
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void bulk(false)} disabled={busy === 'bulk'}>
              Disable shown
            </Button>
          </div>
        ) : null}
      </div>

      {tab === 'installed' ? (
        <div className={`skills-body ${detailOpen ? 'has-detail' : ''}`}>
          <div className="skills-list">
            {busy === 'refresh' && skills.length === 0 ? (
              <div className="skills-empty">
                <Spinner /> Reading skill folders…
              </div>
            ) : filtered.length === 0 ? (
              <div className="skills-empty">
                <strong>{skills.length === 0 ? 'No skills installed yet' : 'Nothing matches that filter'}</strong>
                <p>
                  {skills.length === 0
                    ? 'Install from GitHub, import a folder, or open Discover to browse skills.sh and curated collections.'
                    : 'Try a different term, or switch the filter back to All.'}
                </p>
                {skills.length === 0 ? (
                  <Button variant="primary" onClick={() => setTab('discover')}>
                    Browse skills
                  </Button>
                ) : null}
              </div>
            ) : (
              filtered.map((skill) => (
                <article
                  key={skill.id}
                  className={`skill-card ${selected === skill.id ? 'is-selected' : ''} ${skill.enabled ? '' : 'is-off'}`}
                >
                  <button className="skill-main" onClick={() => setSelected(skill.id)}>
                    <span className="skill-title-row">
                      <span className="skill-name">{skill.name}</span>
                      <ScopeBadge scope={skill.scope} />
                      {skill.origin === 'external' ? <Badge>Claude Code</Badge> : <Badge tone="green">FCC</Badge>}
                      {skill.version ? <Badge>{skill.version}</Badge> : null}
                      {!skill.enabled ? <Badge tone="amber">disabled</Badge> : null}
                      {skill.updateAvailable ? <Badge tone="blue">update available</Badge> : null}
                      {skill.updateError ? (
                        <span className="skill-flag warn" title={skill.updateError}>
                          <AlertIcon size={11} /> update check failed
                        </span>
                      ) : null}
                    </span>
                    <span className="skill-desc">{skill.description || 'No description in SKILL.md.'}</span>
                    <span className="skill-meta">
                      <span>{skill.source?.repo ?? skill.category ?? 'no category'}</span>
                      <span>{skill.fileCount} files</span>
                      <span>{formatBytes(skill.bytes)}</span>
                      {skill.hasScripts ? <span className="skill-flag">scripts</span> : null}
                      {skill.warnings.length > 0 ? (
                        <span className="skill-flag warn">
                          <AlertIcon size={11} /> {skill.warnings.length}
                        </span>
                      ) : null}
                      {skill.installedAt ? <span>installed {formatDate(skill.installedAt)}</span> : null}
                      {skill.updateCheckedAt ? <span>checked {formatDate(skill.updateCheckedAt)}</span> : null}
                    </span>
                  </button>
                  <div className="skill-actions">
                    <IconButton
                      label={skill.enabled ? 'Disable skill' : 'Enable skill'}
                      active={skill.enabled}
                      disabled={busy === `toggle:${skill.id}`}
                      onClick={() => void toggleSkill(skill, !skill.enabled)}
                    >
                      <PowerIcon size={15} />
                    </IconButton>
                    <IconButton
                      label={skill.autoInvoke ? 'Auto-invocation on' : 'Auto-invocation off'}
                      className={skill.autoInvoke ? 'is-on' : ''}
                      onClick={() => void toggleAuto(skill, !skill.autoInvoke)}
                    >
                      <PlayIcon size={14} />
                    </IconButton>
                    {skill.source?.repo ? (
                      <IconButton
                        label="Open source repository"
                        onClick={() => onOpenExternal(`https://github.com/${skill.source?.repo}`)}
                      >
                        <LinkIcon size={14} />
                      </IconButton>
                    ) : null}
                    <IconButton
                      label="Update from source"
                      disabled={!skill.source?.repo || busy === `update:${skill.id}`}
                      onClick={() => void updateSkill(skill)}
                    >
                      <RefreshIcon size={14} />
                    </IconButton>
                    <IconButton label="Open folder" onClick={() => void api.files.reveal(skill.path)}>
                      <FolderIcon size={14} />
                    </IconButton>
                    {skill.origin === 'fcc' ? (
                      <IconButton
                        label="Remove skill"
                        className="danger"
                        disabled={busy === `remove:${skill.id}`}
                        onClick={() => void removeSkill(skill)}
                      >
                        <TrashIcon size={14} />
                      </IconButton>
                    ) : null}
                  </div>
                </article>
              ))
            )}
          </div>

          {detailOpen && detail ? (
            <aside className="skill-detail">
              <div className="skill-detail-head">
                <div>
                  <h2>{detail.name}</h2>
                  <p>{detail.description || 'No description.'}</p>
                </div>
                <IconButton label="Close details" onClick={() => setSelected(null)}>
                  <CloseIcon size={15} />
                </IconButton>
              </div>

              <div className="skill-detail-tags">
                <ScopeBadge scope={detail.scope} />
                {detail.enabled ? <Badge tone="green">enabled</Badge> : <Badge tone="amber">disabled</Badge>}
                {detail.autoInvoke ? <Badge tone="blue">auto</Badge> : <Badge>manual</Badge>}
                {detail.origin === 'external' ? <Badge>Claude Code</Badge> : <Badge tone="green">FCC</Badge>}
                {detail.version ? <Badge>{detail.version}</Badge> : null}
                {detail.license ? <Badge>{detail.license}</Badge> : null}
              </div>

              {detail.findings.length > 0 ? (
                <div className="skill-findings">
                  {detail.findings.map((finding) => (
                    <div key={finding.code} className={`finding finding-${finding.severity}`}>
                      <AlertIcon size={13} />
                      <span>{finding.message}</span>
                    </div>
                  ))}
                </div>
              ) : null}

              <div className="skill-detail-section">
                <span className="skill-detail-label">Category</span>
                <Select value={detail.category ?? ''} onChange={(event) => void setCategoryFor(detail, event.target.value)}>
                  <option value="">Uncategorised</option>
                  {groupedCategories.map(([group, items]) => (
                    <optgroup key={group} label={group}>
                      {items.map((entry) => (
                        <option key={entry.id} value={entry.id}>
                          {entry.label}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </Select>
              </div>

              <dl className="skill-facts">
                <div>
                  <dt>Path</dt>
                  <dd>
                    <button className="link-btn" onClick={() => void api.files.reveal(detail.path)}>
                      {detail.path}
                    </button>
                  </dd>
                </div>
                <div>
                  <dt>Source</dt>
                  <dd>
                    {detail.source?.repo ? (
                      <button
                        className="link-btn"
                        onClick={() => onOpenExternal(`https://github.com/${detail.source?.repo}`)}
                      >
                        {detail.source.repo}
                        <ArrowUpRightIcon size={11} />
                      </button>
                    ) : (
                      (detail.source?.kind ?? 'local')
                    )}
                    {detail.source?.path ? <span className="skill-dim"> · {detail.source.path}</span> : null}
                  </dd>
                </div>
                <div>
                  <dt>Installed</dt>
                  <dd>{formatDate(detail.installedAt)}</dd>
                </div>
                <div>
                  <dt>Compatibility</dt>
                  <dd>{detail.compatibility || 'Standard Agent Skills — Claude Code native'}</dd>
                </div>
                <div>
                  <dt>Allowed tools</dt>
                  <dd>{detail.allowedTools.length ? detail.allowedTools.join(', ') : 'not declared'}</dd>
                </div>
                <div>
                  <dt>Auto-invocation</dt>
                  <dd>{detail.autoInvoke ? 'eligible' : 'manual only'}</dd>
                </div>
              </dl>

              {Object.keys(detail.metadata).length > 0 ? (
                <div className="skill-detail-section">
                  <span className="skill-detail-label">Metadata</span>
                  <div className="skill-meta-grid">
                    {Object.entries(detail.metadata).map(([key, value]) => (
                      <span key={key}>
                        <em>{key}</em> {value}
                      </span>
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="skill-detail-section">
                <span className="skill-detail-label">Bundled files ({detail.files.length})</span>
                <ul className="skill-files">
                  {detail.files.slice(0, 60).map((file) => (
                    <li key={file.path}>
                      <span className={`file-kind file-${file.kind}`}>{file.kind}</span>
                      <span className="skill-file-path">{file.path}</span>
                      <span className="skill-dim">{formatBytes(file.size)}</span>
                    </li>
                  ))}
                </ul>
                {detail.files.length > 60 ? <p className="skill-dim">{detail.files.length - 60} more files…</p> : null}
              </div>

              <div className="skill-detail-section">
                <span className="skill-detail-label">SKILL.md instructions</span>
                <pre className="skill-instructions">{detail.instructions}</pre>
              </div>

              <div className="skill-detail-actions">
                <Button
                  variant={detail.enabled ? 'secondary' : 'primary'}
                  onClick={() => void toggleSkill(detail, !detail.enabled)}
                >
                  {detail.enabled ? 'Disable' : 'Enable'}
                </Button>
                <Button variant="ghost" onClick={() => void api.files.reveal(`${detail.path}`)}>
                  Reveal in folder
                </Button>
              </div>
            </aside>
          ) : null}
        </div>
      ) : (
        <div className="skills-discover">
          <div className="discover-bar">
            <Segmented value={source} options={SOURCES} onChange={setSource} />
            <div className="skills-search grow">
              <SearchIcon size={15} />
              <TextInput
                value={discoverQuery}
                onChange={(event) => setDiscoverQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void discover()
                }}
                placeholder={
                  source === 'curated' ? 'Curated collections load directly' : 'Search skills: react, godot, sprite sheet…'
                }
                spellCheck={false}
              />
            </div>
            <Select value={category} onChange={(event) => setCategory(event.target.value)}>
              <option value="">All categories</option>
              {groupedCategories.map(([group, items]) => (
                <optgroup key={group} label={group}>
                  {items.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </Select>
            <Button variant="primary" onClick={() => void discover()} disabled={discovering}>
              {discovering ? <Spinner /> : 'Search'}
            </Button>
          </div>

          <div className="discover-grid">
            <section className="discover-results">
              {discoverError ? <InlineNotice tone="info">{discoverError}</InlineNotice> : null}
              {candidates.length === 0 && !discovering ? (
                <div className="skills-empty">
                  <strong>Search the open Agent Skills ecosystem</strong>
                  <p>
                    skills.sh indexes thousands of published skills. GitHub finds repositories by name and topic, and
                    curated collections are verified against the GitHub API before they appear here.
                  </p>
                  <p className="skill-dim">
                    Nothing is installed from a search result without inspecting its actual SKILL.md first.
                  </p>
                </div>
              ) : null}
              {candidates.map((candidate) => (
                <article key={candidate.id} className="candidate">
                  <div className="candidate-body">
                    <span className="skill-title-row">
                      <span className="skill-name">{candidate.name}</span>
                      <Badge>{candidate.provider}</Badge>
                      {candidate.installs ? <Badge tone="blue">{candidate.installs.toLocaleString()} installs</Badge> : null}
                    </span>
                    <span className="skill-desc">{candidate.description ?? 'Inspect to read its SKILL.md and files.'}</span>
                    <span className="skill-meta">
                      {candidate.repo ? <span>{candidate.repo}</span> : null}
                      {candidate.path ? <span>{candidate.path}</span> : null}
                    </span>
                  </div>
                  <div className="candidate-actions">
                    {candidate.repo ? (
                      <Button
                        size="sm"
                        onClick={() => void inspect(candidate.repo ?? '')}
                        icon={<ChevronRightIcon size={14} />}
                      >
                        Inspect
                      </Button>
                    ) : null}
                    <IconButton label="Open on the web" onClick={() => onOpenExternal(candidate.url)}>
                      <ArrowUpRightIcon size={14} />
                    </IconButton>
                  </div>
                </article>
              ))}
            </section>

            <aside className="discover-install">
              <section className="install-panel">
                <h3>Install from GitHub</h3>
                <p>Paste a repository URL, owner/name, or a skill folder URL. Private repos work when `gh` is signed in.</p>
                <div className="install-row">
                  <TextInput
                    value={repoInput}
                    onChange={(event) => setRepoInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && repoInput.trim()) void inspect(repoInput.trim())
                    }}
                    placeholder="https://github.com/owner/repo"
                    spellCheck={false}
                  />
                  <Button onClick={() => void inspect(repoInput)} disabled={!repoInput.trim() || inspecting}>
                    {inspecting ? <Spinner /> : 'Inspect'}
                  </Button>
                </div>

                {listing ? (
                  <div className="install-listing">
                    <div className="install-listing-head">
                      <span>
                        {listing.repo} <span className="skill-dim">@{listing.ref}</span>
                      </span>
                      <button className="link-btn" onClick={() => onOpenExternal(listing.url)}>
                        open <ArrowUpRightIcon size={11} />
                      </button>
                    </div>
                    {listing.entries.length === 0 ? (
                      <p className="skill-dim">{listing.error ?? 'No SKILL.md found.'}</p>
                    ) : (
                      <ul className="repo-entries">
                        {listing.entries.map((entry) => (
                          <li key={entry.path} className={entry.valid ? '' : 'is-invalid'}>
                            <label>
                              <input
                                type="checkbox"
                                checked={repoChoice.has(entry.path)}
                                disabled={!entry.valid}
                                onChange={(event) => {
                                  setRepoChoice((current) => {
                                    const next = new Set(current)
                                    if (event.target.checked) next.add(entry.path)
                                    else next.delete(entry.path)
                                    return next
                                  })
                                }}
                              />
                              <span className="repo-entry-copy">
                                <span className="repo-entry-name">
                                  {entry.name}
                                  {entry.hasScripts ? <span className="skill-flag"> scripts</span> : null}
                                </span>
                                <span className="repo-entry-path">{entry.path}</span>
                                <span className="skill-dim">
                                  {entry.valid
                                    ? entry.description || 'No description'
                                    : entry.issues[0] ?? 'Invalid skill folder'}
                                </span>
                              </span>
                            </label>
                          </li>
                        ))}
                      </ul>
                    )}

                    <div className="install-options">
                      <Segmented
                        value={installScope}
                        options={[
                          { value: 'global' as const, label: 'For all projects' },
                          { value: 'project' as const, label: 'This project' },
                        ]}
                        onChange={setInstallScope}
                      />
                      <Button
                        variant="primary"
                        disabled={repoChoice.size === 0 || busy === 'install' || (installScope === 'project' && !projectPath)}
                        onClick={() => void installSelected()}
                      >
                        {busy === 'install' ? <Spinner /> : `Install ${repoChoice.size || ''}`}
                      </Button>
                    </div>
                    <p className="skill-dim">
                      Installing copies files only. Bundled scripts are never executed, and every file is validated
                      against the Agent Skills structure first.
                    </p>
                  </div>
                ) : null}
              </section>

              <section className="install-panel">
                <h3>Local import</h3>
                <p>Bring in a skill you already have: a folder with SKILL.md, a folder of skills, or a .zip archive.</p>
                <div className="install-row">
                  <Button icon={<FolderIcon size={15} />} onClick={() => void importFolder()} disabled={busy === 'import-folder'}>
                    Import folder
                  </Button>
                  <Button onClick={() => void importZip()} disabled={busy === 'import-zip'}>
                    Import .zip
                  </Button>
                </div>
                <div className="install-options">
                  <Segmented
                    value={installScope}
                    options={[
                      { value: 'global' as const, label: 'For all projects' },
                      { value: 'project' as const, label: 'This project' },
                    ]}
                    onChange={setInstallScope}
                  />
                </div>
                {installScope === 'project' && !projectPath ? (
                  <p className="skill-dim">Choose a workspace in the composer to install project skills.</p>
                ) : null}
              </section>
            </aside>
          </div>
        </div>
      )}
    </div>
  )
}
