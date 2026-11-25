import { useEffect, useMemo, useRef, useState } from 'react'
import type { ConnectionStatus, ModelInfo } from '../../shared/types'
import {
  MODEL_TASKS,
  classifyModelTask,
  modelMatchesTask,
  modelTaskIds,
  modelTaskMeta,
  type ModelTaskId,
} from '../../shared/model-tasks'
import { modelLabel, statusLabel } from '../lib/format'
import { Button, Spinner, StatusDot, TextInput } from './ui'
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChipIcon,
  CodeIcon,
  EyeIcon,
  GaugeIcon,
  ImageIcon,
  RefreshIcon,
  SparkIcon,
} from './Icons'

interface ModelPickerProps {
  models: ModelInfo[]
  value: string
  onChange: (modelId: string) => void
  onRefresh: () => void
  error: string | null
  status: ConnectionStatus | null
}

type LibraryView =
  | { kind: 'home' }
  | { kind: 'task'; id: ModelTaskId }
  | { kind: 'brand'; label: string }
  | { kind: 'all' }

interface BrandGroup {
  label: string
  models: ModelInfo[]
  freeCount: number
  local: boolean
}

function taskGlyph(id: ModelTaskId) {
  if (id === 'coding') return <CodeIcon size={15} />
  if (id === 'reasoning') return <GaugeIcon size={15} />
  if (id === 'vision') return <EyeIcon size={15} />
  if (id === 'image') return <ImageIcon size={15} />
  if (id === 'other') return <ChipIcon size={15} />
  return <SparkIcon size={15} />
}

function brandInitials(label: string): string {
  const words = label
    .replace(/[^a-zA-Z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  if (words.length === 0) return '?'
  if (words.length === 1) return (words[0] ?? '').slice(0, 2).toUpperCase()
  return words
    .slice(0, 2)
    .map((word) => word.charAt(0))
    .join('')
    .toUpperCase()
}

function matchesQuery(model: ModelInfo, query: string): boolean {
  if (!query) return true
  const task = modelTaskMeta(classifyModelTask(model))
  return `${model.displayName} ${model.id} ${model.group} ${task.label}`.toLowerCase().includes(query)
}

function groupByBrand(models: ModelInfo[]): Array<[string, ModelInfo[]]> {
  const map = new Map<string, ModelInfo[]>()
  for (const model of models) {
    const list = map.get(model.group)
    if (list) list.push(model)
    else map.set(model.group, [model])
  }
  return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]))
}

export default function ModelPicker({ models, value, onChange, onRefresh, error, status }: ModelPickerProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [view, setView] = useState<LibraryView>({ kind: 'home' })
  const [refreshing, setRefreshing] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const taskByModel = useMemo(
    () => new Map(models.map((model) => [model.id, classifyModelTask(model)])),
    [models],
  )
  const taskIdsByModel = useMemo(
    () => new Map(models.map((model) => [model.id, modelTaskIds(model)])),
    [models],
  )

  const taskGroups = useMemo(
    () =>
      MODEL_TASKS.map((task) => ({
        ...task,
        models: models.filter((model) => taskIdsByModel.get(model.id)?.includes(task.id)),
      })).filter((task) => task.models.length > 0),
    [models, taskIdsByModel],
  )

  const brands = useMemo<BrandGroup[]>(() => {
    const map = new Map<string, ModelInfo[]>()
    for (const model of models) {
      const list = map.get(model.group)
      if (list) list.push(model)
      else map.set(model.group, [model])
    }
    return Array.from(map.entries())
      .map(([label, items]) => ({
        label,
        models: items,
        freeCount: items.filter((model) => model.free).length,
        local: items.some((model) => model.local),
      }))
      .sort(
        (a, b) =>
          b.freeCount - a.freeCount ||
          b.models.length - a.models.length ||
          a.label.localeCompare(b.label),
      )
  }, [models])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (view.kind !== 'home') {
        setView({ kind: 'home' })
        setQuery('')
      } else {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, view.kind])

  const toggle = () => {
    if (!open) {
      setView({ kind: 'home' })
      setQuery('')
    }
    setOpen((state) => !state)
  }

  const goHome = () => {
    setView({ kind: 'home' })
    setQuery('')
  }

  const openTask = (id: ModelTaskId) => {
    setView({ kind: 'task', id })
    setQuery('')
  }

  const openBrand = (label: string) => {
    setView({ kind: 'brand', label })
    setQuery('')
  }

  const refresh = () => {
    setRefreshing(true)
    onRefresh()
    window.setTimeout(() => setRefreshing(false), 900)
  }

  const search = query.trim().toLowerCase()
  const detailItems = useMemo(() => {
    if (view.kind === 'task') return models.filter((model) => modelMatchesTask(model, view.id))
    if (view.kind === 'brand') return models.filter((model) => model.group === view.label)
    if (view.kind === 'all') return models
    return []
  }, [models, view])

  const detailTask = view.kind === 'task' ? modelTaskMeta(view.id) : null
  const detailTitle =
    view.kind === 'task'
      ? detailTask?.label ?? 'Models'
      : view.kind === 'brand'
        ? view.label
        : 'All models'
  const detailDescription =
    view.kind === 'task'
      ? detailTask?.description ?? ''
      : view.kind === 'brand'
        ? `Every ${view.label} endpoint in the FCC catalog.`
        : 'Every model FCC currently exposes, with free and paid endpoints labeled.'
  const detailFree = detailItems.filter((model) => model.free).length
  const filtered = detailItems.filter((model) => matchesQuery(model, search))

  const detailGroups =
    view.kind === 'brand'
      ? MODEL_TASKS.map((task) => [
          task.label,
          filtered.filter((model) => taskByModel.get(model.id) === task.id),
        ] as [string, ModelInfo[]]).filter(([, items]) => items.length > 0)
      : groupByBrand(filtered)

  const homeMatches = search ? models.filter((model) => matchesQuery(model, search)) : []
  const homeGroups = groupByBrand(homeMatches)

  const select = (modelId: string) => {
    onChange(modelId)
    setOpen(false)
    setQuery('')
    setView({ kind: 'home' })
  }

  const renderRow = (model: ModelInfo) => (
    <button
      type="button"
      key={model.id}
      className={`model-row ${model.id === value ? 'is-active' : ''}`}
      onClick={() => select(model.id)}
    >
      <span className="model-row-main">
        <span className="model-row-name">{model.displayName}</span>
        <span className="model-row-id">{model.id}</span>
      </span>
      <span className="model-row-tags">
        {model.local ? (
          <span className="model-tag is-local">local</span>
        ) : model.free ? (
          <span className={`model-tag is-free ${model.requiresOptIn ? 'is-conditional' : ''}`}>
            {model.requiresOptIn ? 'free tier' : 'free'}
          </span>
        ) : (
          <span className="model-tag is-paid">paid</span>
        )}
        {model.noThinking ? <span className="model-tag">no thinking</span> : null}
      </span>
      {model.id === value ? <CheckIcon size={15} className="model-check" /> : null}
    </button>
  )

  const renderGroups = (groups: Array<[string, ModelInfo[]]>) =>
    groups.map(([label, items]) => (
      <div key={label} className="model-group">
        <div className="model-group-label">
          <span>{label}</span>
          <span>{items.length}</span>
        </div>
        {items.map(renderRow)}
      </div>
    ))

  return (
    <div className="model-picker" ref={rootRef}>
      <button
        type="button"
        className={`model-trigger ${open ? 'is-open' : ''}`}
        onClick={toggle}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Model: ${modelLabel(value, models)}`}
      >
        <ChipIcon size={15} />
        <span className="model-trigger-text">{modelLabel(value, models)}</span>
        <ChevronDownIcon size={14} className={open ? 'is-open' : ''} />
      </button>

      {open ? (
        <div className="model-pop model-library" role="dialog" aria-label="Model library">
          <div className="model-pop-head">
            {view.kind === 'home' ? (
              <div className="model-pop-title-group">
                <span className="model-pop-eyebrow">MODEL LIBRARY</span>
                <div className="model-pop-title">
                  <span>Choose a model</span>
                  <span className="model-pop-count">{models.length} total</span>
                </div>
              </div>
            ) : (
              <button type="button" className="model-back" onClick={goHome}>
                <ChevronLeftIcon size={13} />
                All categories
              </button>
            )}
            <button type="button" className="icon-btn mini" onClick={refresh} title="Refresh from FCC">
              {refreshing ? <Spinner size={13} /> : <RefreshIcon size={14} />}
            </button>
          </div>

          {view.kind === 'home' ? (
            <div className="model-page" key="home">
              <div className="model-search">
                <TextInput
                  autoFocus
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={`Search ${models.length} models`}
                  spellCheck={false}
                />
              </div>

              {models.length === 0 ? (
                <div className="model-empty">
                  {error ?? 'No models discovered yet. Check the FCC connection in Settings.'}
                </div>
              ) : search ? (
                <div className="model-list model-results">
                  <div className="model-results-head">
                    <span>{homeMatches.length} matches</span>
                    <span>“{query.trim()}”</span>
                  </div>
                  {homeMatches.length === 0 ? (
                    <div className="model-empty">No model matches “{query.trim()}”.</div>
                  ) : (
                    renderGroups(homeGroups)
                  )}
                </div>
              ) : (
                <div className="model-catalog">
                  <div className="model-section-head">
                    <span>Browse by task</span>
                    <span>{taskGroups.length} categories</span>
                  </div>
                  <div className="model-task-grid">
                    {taskGroups.map((task) => (
                      <button
                        type="button"
                        key={task.id}
                        className="model-tile model-task-tile"
                        data-task={task.id}
                        onClick={() => openTask(task.id)}
                      >
                        <span className="model-tile-icon">{taskGlyph(task.id)}</span>
                        <span className="model-tile-body">
                          <span className="model-tile-name">{task.label}</span>
                          <span className="model-tile-meta">
                            {task.models.length} models ·{' '}
                            {task.models.filter((model) => model.free).length} free
                          </span>
                        </span>
                        <ChevronRightIcon size={13} className="model-tile-arrow" />
                      </button>
                    ))}
                  </div>

                  <div className="model-section-head">
                    <span>Browse by company</span>
                    <span>{brands.length} providers</span>
                  </div>
                  <div className="model-brand-grid">
                    {brands.map((brand) => (
                      <button
                        type="button"
                        key={brand.label}
                        className="model-tile model-brand-tile"
                        onClick={() => openBrand(brand.label)}
                      >
                        <span className={`model-brand-mark ${brand.local ? 'is-local' : ''}`}>
                          {brandInitials(brand.label)}
                        </span>
                        <span className="model-tile-body">
                          <span className="model-tile-name">{brand.label}</span>
                          <span className="model-tile-meta">
                            {brand.models.length} models ·{' '}
                            {brand.local ? 'local' : brand.freeCount ? `${brand.freeCount} free` : 'paid'}
                          </span>
                        </span>
                        <ChevronRightIcon size={13} className="model-tile-arrow" />
                      </button>
                    ))}
                  </div>

                  <button type="button" className="model-all" onClick={() => { setView({ kind: 'all' }); setQuery('') }}>
                    <span className="model-tile-icon">
                      <ChipIcon size={15} />
                    </span>
                    <span className="model-tile-body">
                      <span className="model-tile-name">All models</span>
                      <span className="model-tile-meta">Search the full FCC catalog</span>
                    </span>
                    <ChevronRightIcon size={13} className="model-tile-arrow" />
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="model-page model-detail-page" key={`${view.kind}-${detailTitle}`}>
              <div className="model-detail-head">
                <div className="model-detail-title">{detailTitle}</div>
                <div className="model-detail-meta">
                  {detailItems.length} models · {detailFree} free
                </div>
                <p>{detailDescription}</p>
              </div>

              <div className="model-search">
                <TextInput
                  autoFocus
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={`Filter ${detailTitle}`}
                  spellCheck={false}
                />
              </div>

              <div className="model-list">
                {filtered.length === 0 ? (
                  <div className="model-empty">
                    {detailItems.length === 0
                      ? 'No models in this category.'
                      : `No model matches “${query.trim()}”.`}
                  </div>
                ) : (
                  renderGroups(detailGroups)
                )}
              </div>
            </div>
          )}

          <div className="model-pop-foot">
            <span className="model-foot-status">
              <StatusDot tone={status?.state === 'connected' ? 'green' : 'red'} />
              {statusLabel(status)}
              {status?.baseUrl ? <span className="model-foot-url">{status.baseUrl}</span> : null}
            </span>
            <Button size="sm" variant="ghost" onClick={refresh}>
              Reload
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}
