import { useEffect, useMemo, useRef, useState } from 'react'
import type { ConnectionStatus, ModelInfo } from '../../shared/types'
import { modelLabel, statusLabel } from '../lib/format'
import { Button, Spinner, StatusDot, TextInput } from './ui'
import { CheckIcon, ChevronDownIcon, ChipIcon, RefreshIcon } from './Icons'

interface ModelPickerProps {
  models: ModelInfo[]
  value: string
  onChange: (modelId: string) => void
  onRefresh: () => void
  error: string | null
  status: ConnectionStatus | null
}

export default function ModelPicker({ models, value, onChange, onRefresh, error, status }: ModelPickerProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const grouped = useMemo(() => {
    const search = query.trim().toLowerCase()
    const filtered = models.filter(
      (model) =>
        !search ||
        model.displayName.toLowerCase().includes(search) ||
        model.id.toLowerCase().includes(search) ||
        model.group.toLowerCase().includes(search),
    )
    const map = new Map<string, ModelInfo[]>()
    for (const model of filtered) {
      const list = map.get(model.group)
      if (list) list.push(model)
      else map.set(model.group, [model])
    }
    return Array.from(map.entries())
  }, [models, query])

  const refresh = () => {
    setRefreshing(true)
    onRefresh()
    window.setTimeout(() => setRefreshing(false), 900)
  }

  return (
    <div className="model-picker" ref={rootRef}>
      <button className={`model-trigger ${open ? 'is-open' : ''}`} onClick={() => setOpen((state) => !state)}>
        <ChipIcon size={15} />
        <span className="model-trigger-text">{modelLabel(value, models)}</span>
        <ChevronDownIcon size={14} className={open ? 'is-open' : ''} />
      </button>

      {open ? (
        <div className="model-pop">
          <div className="model-pop-head">
            <div className="model-pop-title">
              <span>Model</span>
              <span className="model-pop-count">{models.length} available</span>
            </div>
            <button className="icon-btn mini" onClick={refresh} title="Refresh from FCC">
              {refreshing ? <Spinner size={13} /> : <RefreshIcon size={14} />}
            </button>
          </div>

          <div className="model-search">
            <TextInput
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search models"
              spellCheck={false}
            />
          </div>

          <div className="model-list">
            {models.length === 0 ? (
              <div className="model-empty">
                {error ?? 'No models discovered yet. Check the FCC connection in Settings.'}
              </div>
            ) : grouped.length === 0 ? (
              <div className="model-empty">No model matches “{query}”.</div>
            ) : (
              grouped.map(([group, items]) => (
                <div key={group} className="model-group">
                  <div className="model-group-label">{group}</div>
                  {items.map((model) => (
                    <button
                      key={model.id}
                      className={`model-row ${model.id === value ? 'is-active' : ''}`}
                      onClick={() => {
                        onChange(model.id)
                        setOpen(false)
                      }}
                    >
                      <span className="model-row-main">
                        <span className="model-row-name">{model.displayName}</span>
                        <span className="model-row-id">{model.id}</span>
                      </span>
                      {model.noThinking ? <span className="model-tag">no thinking</span> : null}
                      {model.id === value ? <CheckIcon size={15} className="model-check" /> : null}
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>

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
