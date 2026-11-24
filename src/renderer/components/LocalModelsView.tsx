import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BackendChoice, DownloadTask, LocalConfig, LocalModel, LocalState } from '../../shared/local'
import { fitFor, fitScore } from '../../shared/local-fit'
import { formatBytes, relativeTime } from '../lib/format'
import { Badge, Button, InlineNotice, Segmented, Select, Spinner, StatusDot, TextInput, Toggle } from './ui'
import {
  AlertIcon,
  ChipIcon,
  CopyIcon,
  FolderIcon,
  PlayIcon,
  RefreshIcon,
  SearchIcon,
  StopIcon,
  TrashIcon,
} from './Icons'

type Tab = 'recommended' | 'installed'

interface LocalModelsViewProps {
  onBack: () => void
  onToast: (kind: 'error' | 'info', text: string) => void
}

const compact = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })

const FIT_TONE: Record<string, 'green' | 'blue' | 'amber' | 'red' | 'neutral'> = {
  gpu: 'green',
  hybrid: 'blue',
  cpu: 'amber',
  'too-large': 'red',
}

function taskFor(downloads: DownloadTask[], repo: string, filename: string): DownloadTask | null {
  return downloads.find((task) => task.repo === repo && task.filename === filename && task.state === 'downloading') ?? null
}

function percentOf(task: DownloadTask): number {
  if (!task.sizeBytes) return 0
  return Math.min(100, Math.round((task.receivedBytes / task.sizeBytes) * 100))
}

export default function LocalModelsView({ onBack, onToast }: LocalModelsViewProps) {
  const [state, setState] = useState<LocalState | null>(null)
  const [tab, setTab] = useState<Tab>('recommended')
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [picked, setPicked] = useState<Record<string, string>>({})
  const pendingConfig = useRef<Partial<LocalConfig>>({})
  const configTimer = useRef<number | null>(null)
  const [notice, setNotice] = useState<{ tone: 'info' | 'error' | 'success'; text: string } | null>(null)
  const indexRequested = useRef(false)

  const refresh = useCallback(async () => {
    try {
      const next = await window.fcc.local.state()
      setState(next)
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
    const offChanged = window.fcc.local.onChanged(() => void refresh())
    const offDownloads = window.fcc.local.onDownloads((tasks) =>
      setState((current) => (current ? { ...current, downloads: tasks } : current)),
    )
    return () => {
      offChanged()
      offDownloads()
      if (configTimer.current !== null) window.clearTimeout(configTimer.current)
    }
  }, [refresh])

  // Fill an empty index on first visit; the service caches it for six hours.
  useEffect(() => {
    if (!state || indexRequested.current || state.index.models.length > 0) return
    indexRequested.current = true
    void window.fcc.local
      .catalog({})
      .then((index) => setState((current) => (current ? { ...current, index } : current)))
      .catch(() => {
        indexRequested.current = false
      })
  }, [state])

  const hardware = state?.hardware ?? null
  const models = state?.index.models ?? []
  const downloads = state?.downloads ?? []
  const installed = state?.installed ?? []
  const server = state?.server
  const runtime = state?.runtime

  const fileFor = (model: LocalModel) =>
    model.files.find((file) => file.filename === picked[model.repo]) ?? model.files[0] ?? null

  const sorted = useMemo(() => {
    if (!hardware) return models
    return [...models].sort((a, b) => {
      const fileA = a.files[0]
      const fileB = b.files[0]
      const scoreA = fileA ? fitScore(fitFor(fileA.sizeBytes, hardware), a.downloads) : 0
      const scoreB = fileB ? fitScore(fitFor(fileB.sizeBytes, hardware), b.downloads) : 0
      return scoreB - scoreA
    })
  }, [models, hardware])

  const download = (model: LocalModel) => {
    const file = fileFor(model)
    if (!file) return
    setBusy(`dl:${model.repo}`)
    window.fcc.local
      .download({ repo: model.repo, filename: file.filename, quant: file.quant })
      .then(() => setNotice({ tone: 'info', text: `Downloading ${file.filename} to ${state?.storage.dir ?? 'the model folder'}.` }))
      .catch((error) => onToast('error', error instanceof Error ? error.message : String(error)))
      .finally(() => setBusy(null))
  }

  const search = async () => {
    const text = query.trim()
    if (!text) return
    setSearching(true)
    try {
      const index = await window.fcc.local.catalog({ query: text, refresh: true })
      setState((current) => (current ? { ...current, index } : current))
      if (index.error) setNotice({ tone: 'error', text: index.error })
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setSearching(false)
    }
  }

  const reloadIndex = async () => {
    setBusy('index')
    try {
      const index = await window.fcc.local.catalog({ refresh: true })
      setState((current) => (current ? { ...current, index } : current))
      if (index.error) setNotice({ tone: 'error', text: index.error })
      else setNotice({ tone: 'info', text: `Indexed ${index.models.length} GGUF repositories from Hugging Face.` })
    } finally {
      setBusy(null)
    }
  }

  const saveConfig = async (patch: Partial<LocalConfig>) => {
    try {
      const next = await window.fcc.local.configure(patch)
      setState(next)
    } catch (error) {
      onToast('error', error instanceof Error ? error.message : String(error))
    }
  }

  // Number inputs fire per keystroke; batch them into one settings write.
  const queueConfig = (patch: Partial<LocalConfig>) => {
    pendingConfig.current = { ...pendingConfig.current, ...patch }
    if (configTimer.current !== null) window.clearTimeout(configTimer.current)
    configTimer.current = window.setTimeout(() => {
      const next = pendingConfig.current
      pendingConfig.current = {}
      void saveConfig(next)
    }, 350)
  }

  const installRuntime = async () => {
    setBusy('runtime')
    setNotice(null)
    try {
      const next = await window.fcc.local.installRuntime()
      setState(next)
      setNotice({ tone: 'success', text: `llama.cpp ${next.runtime.version ?? ''} installed (${next.runtime.backend ?? 'cpu'}).` })
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(null)
    }
  }

  const run = async (path: string) => {
    setBusy('server')
    setNotice(null)
    try {
      const status = await window.fcc.local.startServer({ path })
      if (status.running) {
        setNotice({ tone: 'success', text: `Running ${status.modelId}. Point FCC at ${status.openAiBaseUrl}.` })
      } else {
        setNotice({ tone: 'error', text: status.message ?? 'The model server did not start.' })
      }
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      setBusy(null)
    }
  }

  const stop = async () => {
    setBusy('server')
    try {
      await window.fcc.local.stopServer()
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="skills lm">
      <header className="skills-head">
        <div className="skills-heading">
          <span className="skills-eyebrow">
            <ChipIcon size={14} /> Local models
          </span>
          <h1>Run GGUF models on this machine</h1>
          <p>
            {installed.length} installed · {models.length} indexed ·{' '}
            {hardware
              ? `${hardware.gpus[0]?.name ?? 'no GPU detected'} · ${hardware.threads} threads · ${formatBytes(hardware.ramBytes)} RAM`
              : 'detecting hardware'}
          </p>
        </div>
        <div className="skills-head-actions">
          <Button icon={<RefreshIcon size={15} />} onClick={() => void reloadIndex()} disabled={busy === 'index'}>
            {busy === 'index' ? 'Indexing…' : 'Refresh index'}
          </Button>
          <Button variant="ghost" onClick={() => void window.fcc.local.openFolder('')}>
            Open folder
          </Button>
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

      <div className="lm-hardware">
        <div className="lm-stat">
          <span className="lm-stat-label">CPU</span>
          <span className="lm-stat-value">{hardware?.cpu ?? 'detecting…'}</span>
          <span className="lm-stat-sub">{hardware ? `${hardware.threads} threads` : ''}</span>
        </div>
        <div className="lm-stat">
          <span className="lm-stat-label">GPU</span>
          <span className="lm-stat-value">{hardware?.gpus[0]?.name ?? 'None detected'}</span>
          <span className="lm-stat-sub">
            {hardware?.vramBytes ? `${formatBytes(hardware.vramBytes)} VRAM` : 'VRAM unknown'}
          </span>
        </div>
        <div className="lm-stat">
          <span className="lm-stat-label">Memory</span>
          <span className="lm-stat-value">{hardware ? formatBytes(hardware.ramBytes) : '…'}</span>
          <span className="lm-stat-sub">{hardware ? `${formatBytes(hardware.freeRamBytes)} free` : ''}</span>
        </div>
        <div className="lm-stat">
          <span className="lm-stat-label">Runtime</span>
          <span className="lm-stat-value">
            {runtime?.installed ? `llama.cpp ${runtime.version ?? ''}` : 'Not installed'}
          </span>
          <span className="lm-stat-sub">
            {runtime?.installed
              ? `${runtime.backend ?? 'cpu'} backend`
              : hardware
                ? `suggested: ${hardware.backend}`
                : ''}
          </span>
        </div>
      </div>

      <div className="lm-controls">
        <div className="lm-control">
          <span className="lm-control-label">Model folder</span>
          <div className="lm-control-row">
            <code className="lm-path" title={state?.storage.dir}>
              {state?.storage.dir ?? '…'}
            </code>
            <span className="lm-control-note">
              {state?.storage.freeBytes ? `${formatBytes(state.storage.freeBytes)} free` : ''}
              {state?.storage.writable === false ? ' · not writable' : ''}
            </span>
            <Button
              size="sm"
              onClick={async () => {
                const dir = await window.fcc.local.pickStorage()
                if (!dir) return
                try {
                  await window.fcc.local.setStorage(dir)
                  await refresh()
                } catch (error) {
                  onToast('error', error instanceof Error ? error.message : String(error))
                }
              }}
            >
              Change…
            </Button>
          </div>
        </div>
        <div className="lm-control">
          <span className="lm-control-label">llama.cpp runtime</span>
          <div className="lm-control-row">
            <span className="lm-control-note">
              {runtime?.installing
                ? `Downloading… ${runtime.progress !== null ? `${Math.round(runtime.progress * 100)}%` : ''}`
                : runtime?.installed
                  ? runtime.path
                  : 'Install once, then every downloaded model can run.'}
            </span>
            {runtime?.installed && state?.config.backend !== 'auto' && runtime.backend !== state?.config.backend ? (
              <Button size="sm" onClick={() => void installRuntime()} disabled={busy === 'runtime' || runtime.installing}>
                Reinstall as {state?.config.backend}
              </Button>
            ) : null}
            {runtime?.installed ? (
              <Button
                size="sm"
                variant="ghost"
                icon={<TrashIcon size={13} />}
                onClick={async () => {
                  setState(await window.fcc.local.removeRuntime())
                }}
              >
                Remove
              </Button>
            ) : (
              <Button
                size="sm"
                variant="primary"
                onClick={() => void installRuntime()}
                disabled={busy === 'runtime' || runtime?.installing}
              >
                {runtime?.installing || busy === 'runtime' ? 'Installing…' : 'Install runtime'}
              </Button>
            )}
          </div>
        </div>
      </div>

      {server?.running ? (
        <div className="lm-server is-live">
          <StatusDot tone="green" />
          <div className="lm-server-body">
            <span className="lm-server-title">{server.modelId}</span>
            <span className="lm-server-sub">
              {server.openAiBaseUrl} · {server.backend ?? 'runtime'} ·{' '}
              {server.modelPath ? server.modelPath.split(/[\\/]/).pop() : ''}
            </span>
          </div>
          <Button
            size="sm"
            variant="ghost"
            icon={<CopyIcon size={13} />}
            onClick={() => {
              void window.fcc.app.copyText(server.openAiBaseUrl)
              onToast('info', 'Endpoint copied.')
            }}
          >
            Copy endpoint
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={<CopyIcon size={13} />}
            onClick={() => {
              void window.fcc.app.copyText(server.modelId ?? '')
              onToast('info', 'Model id copied — paste it as llama.cpp’s model in FCC.')
            }}
          >
            Copy model id
          </Button>
          <Button size="sm" onClick={() => void stop()} disabled={busy === 'server'} icon={<StopIcon size={13} />}>
            Stop
          </Button>
        </div>
      ) : (
        <div className="lm-server">
          <StatusDot tone="neutral" />
          <div className="lm-server-body">
            <span className="lm-server-title">No local model running</span>
            <span className="lm-server-sub">
              Pick an installed model and press Run. FCC Desktop hands FCC a llama.cpp endpoint when it starts the
              server itself; otherwise set Providers → llama.cpp in the FCC Admin UI to the URL shown here.
            </span>
          </div>
        </div>
      )}

      <div className="lm-load">
        <div className="lm-load-head">
          <span className="lm-control-label">Load settings</span>
          <span className="lm-control-note">Applied the next time you press Run.</span>
        </div>
        <div className="lm-load-grid">
          <label className="lm-field">
            <span>Runtime</span>
            <Select
              value={state?.config.backend ?? 'auto'}
              onChange={(event) => void saveConfig({ backend: event.target.value as BackendChoice })}
            >
              <option value="auto">Auto{hardware ? ` (${hardware.backend})` : ''}</option>
              <option value="vulkan">Vulkan</option>
              <option value="rocm">ROCm</option>
              {state?.hardware?.platform === 'darwin' ? <option value="metal">Metal</option> : null}
              <option value="cpu">CPU</option>
            </Select>
          </label>
          <label className="lm-field">
            <span>Context</span>
            <TextInput
              type="number"
              min={2048}
              max={131072}
              step={1024}
              value={state?.config.contextSize ?? 8192}
              onChange={(event) => queueConfig({ contextSize: Number(event.target.value) || 8192 })}
            />
          </label>
          <label className="lm-field">
            <span>GPU layers</span>
            <TextInput
              type="number"
              min={0}
              max={999}
              value={state?.config.gpuLayers ?? 999}
              onChange={(event) => queueConfig({ gpuLayers: Number(event.target.value) || 0 })}
            />
          </label>
          <label className="lm-field">
            <span>Threads</span>
            <TextInput
              type="number"
              min={0}
              max={256}
              value={state?.config.threads ?? 0}
              onChange={(event) => queueConfig({ threads: Number(event.target.value) || 0 })}
            />
          </label>
          <label className="lm-field">
            <span>Batch</span>
            <TextInput
              type="number"
              min={0}
              max={8192}
              step={64}
              value={state?.config.batchSize ?? 0}
              onChange={(event) => queueConfig({ batchSize: Number(event.target.value) || 0 })}
            />
          </label>
        </div>
        <div className="lm-load-toggles">
          <Toggle
            label="Flash attention"
            description="Passes -fa on. Faster at long context on most GPUs."
            checked={state?.config.flashAttention ?? false}
            onChange={(value) => void saveConfig({ flashAttention: value })}
          />
          <Toggle
            label="Keep model in memory"
            description="Passes --no-mmap so weights stay resident between turns."
            checked={state?.config.keepModelInMemory ?? false}
            onChange={(value) => void saveConfig({ keepModelInMemory: value })}
          />
        </div>
      </div>

      <div className="lm-toolbar">
        <Segmented
          value={tab}
          options={[
            { value: 'recommended' as const, label: 'Recommended' },
            { value: 'installed' as const, label: `Installed (${installed.length})` },
          ]}
          onChange={setTab}
        />
        {tab === 'recommended' ? (
          <div className="lm-search">
            <SearchIcon size={14} />
            <TextInput
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void search()
              }}
              placeholder="Search Hugging Face GGUF repositories"
              spellCheck={false}
            />
            <Button size="sm" onClick={() => void search()} disabled={searching || !query.trim()}>
              {searching ? <Spinner size={13} /> : 'Search'}
            </Button>
            {state?.index.query ? (
              <Button size="sm" variant="ghost" onClick={() => void reloadIndex()}>
                Clear
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      {loading ? (
        <div className="lm-empty">
          <Spinner size={16} /> Reading hardware and the model index…
        </div>
      ) : tab === 'installed' ? (
        installed.length === 0 ? (
          <div className="lm-empty">Nothing downloaded yet. Pick a model below that fits your machine.</div>
        ) : (
          <div className="lm-list">
            {installed.map((model) => {
              const active = server?.running && server.modelPath === model.path
              return (
                <div key={model.path} className={`lm-row ${active ? 'is-active' : ''}`}>
                  <div className="lm-row-main">
                    <span className="lm-row-title">
                      {model.filename.replace(/\.gguf$/i, '')}
                      {model.quant ? <Badge tone="blue">{model.quant}</Badge> : null}
                      {active ? <Badge tone="green">running</Badge> : null}
                    </span>
                    <span className="lm-row-sub">
                      {formatBytes(model.sizeBytes)} · {model.repo || 'added manually'}
                      {model.installedAt ? ` · ${relativeTime(model.installedAt)}` : ''}
                    </span>
                  </div>
                  <div className="lm-row-actions">
                    {active ? (
                      <Button size="sm" icon={<StopIcon size={13} />} onClick={() => void stop()} disabled={busy === 'server'}>
                        Stop
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="primary"
                        icon={<PlayIcon size={13} />}
                        onClick={() => void run(model.path)}
                        disabled={busy === 'server' || !runtime?.installed}
                      >
                        Run
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" icon={<FolderIcon size={13} />} onClick={() => void window.fcc.local.openFolder(model.path)}>
                      Reveal
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<TrashIcon size={13} />}
                      onClick={async () => {
                        try {
                          await window.fcc.local.removeModel(model.path)
                          await refresh()
                        } catch (error) {
                          onToast('error', error instanceof Error ? error.message : String(error))
                        }
                      }}
                    >
                      Remove
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        )
      ) : state?.index.error && models.length === 0 ? (
        <div className="lm-empty">
          <AlertIcon size={14} /> {state.index.error}
        </div>
      ) : (
        <div className="lm-grid">
          {sorted.map((model) => {
            const file = fileFor(model)
            const fit = file ? fitFor(file.sizeBytes, hardware) : null
            const task = file ? taskFor(downloads, model.repo, file.filename) : null
            const isInstalled = file ? installed.some((entry) => entry.filename === file.filename) : false
            return (
              <article key={model.id} className="lm-card">
                <div className="lm-card-head">
                  <span className="lm-card-title">{model.name}</span>
                  {fit ? <Badge tone={FIT_TONE[fit.level]}>{fit.label}</Badge> : null}
                </div>
                <div className="lm-card-sub">
                  {model.repo} · {model.params ?? 'size unknown'} · {compact.format(model.downloads)} downloads
                </div>
                <div className="lm-card-quant">
                  <select
                    className="input select"
                    value={file?.filename ?? ''}
                    onChange={(event) =>
                      setPicked((current) => ({ ...current, [model.repo]: event.target.value }))
                    }
                  >
                    {model.files.map((entry) => (
                      <option key={entry.filename} value={entry.filename}>
                        {entry.quant} · {formatBytes(entry.sizeBytes)}
                      </option>
                    ))}
                  </select>
                  {fit ? <span className="lm-fit-note">{fit.detail}</span> : null}
                </div>
                {task ? (
                  <div className="lm-progress">
                    <div className="lm-progress-bar">
                      <span style={{ width: `${percentOf(task)}%` }} />
                    </div>
                    <div className="lm-progress-row">
                      <span>
                        {percentOf(task)}% · {formatBytes(task.receivedBytes)} / {formatBytes(task.sizeBytes)}
                        {task.bytesPerSecond ? ` · ${formatBytes(task.bytesPerSecond)}/s` : ''}
                      </span>
                      <button className="link-btn" onClick={() => void window.fcc.local.cancelDownload(task.id)}>
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="lm-card-foot">
                    <span className="lm-card-size">{file ? formatBytes(file.sizeBytes) : '—'}</span>
                    {isInstalled ? (
                      <Badge tone="green">downloaded</Badge>
                    ) : model.gated ? (
                      <Badge tone="amber">gated on Hugging Face</Badge>
                    ) : (
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() => download(model)}
                        disabled={busy === `dl:${model.repo}` || !file || state?.storage.writable === false}
                      >
                        Download
                      </Button>
                    )}
                  </div>
                )}
              </article>
            )
          })}
        </div>
      )}

      {state?.runtime.installing ? (
        <div className="lm-installing">
          <Spinner size={13} /> Downloading the llama.cpp runtime…{' '}
          {state.runtime.progress !== null ? `${Math.round(state.runtime.progress * 100)}%` : ''}
        </div>
      ) : null}
    </div>
  )
}
