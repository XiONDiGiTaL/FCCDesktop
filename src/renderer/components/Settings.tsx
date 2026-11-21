import { useEffect, useState } from 'react'
import type {
  AgentRuntimeInfo,
  AppSettings,
  ConnectionStatus,
  DeepPartial,
  DiagnosticsSnapshot,
  ModelCatalog,
  SecretStatus,
  SettingsEnvelope,
  ToolLocation,
} from '../../shared/types'
import {
  duration,
  folderName,
  friendlyError,
  statusLabel,
} from '../lib/format'
import {
  Badge,
  Button,
  Field,
  InlineNotice,
  Modal,
  Segmented,
  Spinner,
  StatusDot,
  TextInput,
  Toggle,
} from './ui'
import SetupGuide from './SetupGuide'
import {
  CheckIcon,
  FolderIcon,
  LinkIcon,
  PlusIcon,
  PowerIcon,
  RefreshIcon,
  TrashIcon,
  XionMark,
  CloseIcon,
} from './Icons'

type Section = 'connection' | 'models' | 'agent' | 'appearance' | 'data' | 'diagnostics' | 'about'

const SECTIONS: Array<{ id: Section; label: string }> = [
  { id: 'connection', label: 'Connection' },
  { id: 'models', label: 'Models' },
  { id: 'agent', label: 'Agent' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'data', label: 'Data' },
  { id: 'diagnostics', label: 'Diagnostics' },
  { id: 'about', label: 'About' },
]

const PERMISSIONS: Array<{ id: AppSettings['agent']['permissionMode']; label: string; copy: string }> = [
  {
    id: 'bypassPermissions',
    label: 'Full access',
    copy: 'Read, write and run commands without prompts. Recommended for trusted workspaces.',
  },
  {
    id: 'acceptEdits',
    label: 'Accept edits',
    copy: 'File edits are approved automatically; shell commands are denied.',
  },
  {
    id: 'default',
    label: 'Read only',
    copy: 'Only read and search tools are allowed. The agent can inspect but not modify.',
  },
  {
    id: 'plan',
    label: 'Plan only',
    copy: 'Inspection only, tuned for producing a plan before you grant more access.',
  },
]

export default function SettingsPanel({
  open,
  onClose,
  envelope,
  status,
  catalog,
  runtime,
  onPatch,
  onStatus,
  onCatalog,
  onToast,
  onClearConversationsRequested,
}: {
  open: boolean
  onClose: () => void
  envelope: SettingsEnvelope
  status: ConnectionStatus | null
  catalog: ModelCatalog | null
  runtime: AgentRuntimeInfo | null
  onPatch: (patch: DeepPartial<AppSettings>) => Promise<SettingsEnvelope | null>
  onStatus: (status: ConnectionStatus) => void
  onCatalog: (catalog: ModelCatalog) => void
  onToast: (kind: 'error' | 'info', text: string) => void
  onClearConversationsRequested: () => void
}) {
  const [section, setSection] = useState<Section>('connection')
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [actionMessage, setActionMessage] = useState<{ tone: 'info' | 'error' | 'success'; text: string } | null>(null)
  const [tools, setTools] = useState<ToolLocation[]>([])
  const [modelQuery, setModelQuery] = useState('')
  const [customModel, setCustomModel] = useState('')
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string; latencyMs: number | null } | null>(null)
  const [diagnostics, setDiagnostics] = useState<DiagnosticsSnapshot | null>(null)
  const [token, setToken] = useState('')
  const [secrets, setSecrets] = useState<SecretStatus>(envelope.secrets)
  const [appInfo, setAppInfo] = useState<{ version: string; userData: string; models: number } | null>(null)

  const settings = envelope.settings

  const [host, setHost] = useState(settings.connection.host)
  const [port, setPort] = useState(String(settings.connection.port))
  const [baseUrl, setBaseUrl] = useState(settings.connection.baseUrl)
  const [serverPath, setServerPath] = useState(settings.connection.serverExePath)
  const [claudePath, setClaudePath] = useState(settings.connection.claudeExePath)
  const [workingDir, setWorkingDir] = useState(settings.agent.workingDirectory)

  useEffect(() => {
    setHost(settings.connection.host)
    setPort(String(settings.connection.port))
    setBaseUrl(settings.connection.baseUrl)
    setServerPath(settings.connection.serverExePath)
    setClaudePath(settings.connection.claudeExePath)
    setWorkingDir(settings.agent.workingDirectory)
  }, [settings, open])

  useEffect(() => {
    if (!open) return
    void window.fcc.connection.detect().then(setTools).catch(() => setTools([]))
    void window.fcc.app.info().then(setAppInfo).catch(() => setAppInfo(null))
  }, [open])

  useEffect(() => {
    if (!open || section !== 'diagnostics') return
    void window.fcc.diagnostics.snapshot().then(setDiagnostics).catch(() => setDiagnostics(null))
  }, [open, section])

  const saveConnection = async () => {
    const updated = await onPatch({
      connection: {
        host: host.trim() || '127.0.0.1',
        port: Math.min(65535, Math.max(1, Number(port) || 8082)),
        baseUrl: baseUrl.trim(),
        serverExePath: serverPath.trim(),
        claudeExePath: claudePath.trim(),
      },
    })
    if (updated) {
      setActionMessage({ tone: 'success', text: 'Connection settings saved.' })
      setBusyAction('probe')
      const probe = await window.fcc.connection.probe()
      onStatus(probe)
      setBusyAction(null)
    }
  }

  const runProbe = async () => {
    setBusyAction('probe')
    try {
      const next = await window.fcc.connection.probe()
      onStatus(next)
      setActionMessage(
        next.state === 'connected'
          ? { tone: 'success', text: `Connected in ${next.latencyMs ?? '—'} ms.` }
          : { tone: 'error', text: next.message ?? 'FCC is not reachable.' },
      )
      void window.fcc.connection.models(true).then(onCatalog).catch(() => {})
    } catch (error) {
      setActionMessage({ tone: 'error', text: friendlyError(error) })
    } finally {
      setBusyAction(null)
    }
  }

  const startServer = async () => {
    setBusyAction('start')
    setActionMessage({ tone: 'info', text: 'Starting FCC…' })
    try {
      const result = await window.fcc.connection.startServer()
      onStatus(result.status)
      setActionMessage({ tone: result.started ? 'success' : 'error', text: result.message })
    } catch (error) {
      setActionMessage({ tone: 'error', text: friendlyError(error) })
    } finally {
      setBusyAction(null)
    }
  }

  const stopServer = async () => {
    setBusyAction('stop')
    try {
      const result = await window.fcc.connection.stopServer()
      onStatus(result.status)
      setActionMessage({ tone: 'info', text: result.message })
    } catch (error) {
      setActionMessage({ tone: 'error', text: friendlyError(error) })
    } finally {
      setBusyAction(null)
    }
  }

  const detect = async () => {
    setBusyAction('detect')
    try {
      const found = await window.fcc.connection.detect()
      setTools(found)
      const server = found.find((tool) => tool.id === 'server')
      const claude = found.find((tool) => tool.id === 'claude')
      if (server?.path) setServerPath(server.path)
      if (claude?.path) setClaudePath(claude.path)
      if (!server?.path || !claude?.path) {
        setActionMessage({ tone: 'error', text: 'One or more FCC executables could not be located automatically.' })
      } else {
        setActionMessage({ tone: 'success', text: 'Found both FCC executables. Press Save to apply.' })
      }
    } catch (error) {
      setActionMessage({ tone: 'error', text: friendlyError(error) })
    } finally {
      setBusyAction(null)
    }
  }

  const browse = async (kind: 'server' | 'claude') => {
    const path = await window.fcc.dialogs.pickExecutable(kind)
    if (!path) return
    if (kind === 'server') setServerPath(path)
    else setClaudePath(path)
  }

  const browseWorkingDir = async () => {
    const path = await window.fcc.dialogs.pickDirectory()
    if (!path) return
    setWorkingDir(path)
    await onPatch({ agent: { workingDirectory: path } })
  }

  const addAdditionalDir = async () => {
    const path = await window.fcc.dialogs.pickDirectory()
    if (!path) return
    if (settings.agent.additionalDirs.some((dir) => dir.toLowerCase() === path.toLowerCase())) return
    await onPatch({ agent: { additionalDirs: [...settings.agent.additionalDirs, path] } })
  }

  const removeAdditionalDir = async (dir: string) => {
    await onPatch({ agent: { additionalDirs: settings.agent.additionalDirs.filter((item) => item !== dir) } })
  }

  const refreshModels = async () => {
    setBusyAction('models')
    try {
      const next = await window.fcc.connection.models(true)
      onCatalog(next)
      if (next.error) setActionMessage({ tone: 'error', text: next.error })
      else setActionMessage({ tone: 'success', text: `${next.models.length} models discovered from FCC.` })
    } catch (error) {
      setActionMessage({ tone: 'error', text: friendlyError(error) })
    } finally {
      setBusyAction(null)
    }
  }

  const testModel = async (modelId: string) => {
    setBusyAction('test')
    setTestResult(null)
    try {
      const result = await window.fcc.connection.testModel(modelId)
      setTestResult(result)
    } catch (error) {
      setTestResult({ ok: false, message: friendlyError(error), latencyMs: null })
    } finally {
      setBusyAction(null)
    }
  }

  const saveToken = async () => {
    try {
      const next = await window.fcc.secrets.setProxyToken(token)
      setSecrets(next)
      setToken('')
      setActionMessage({ tone: 'success', text: 'Proxy token encrypted with Windows DPAPI.' })
      await runProbe()
    } catch (error) {
      setActionMessage({ tone: 'error', text: friendlyError(error) })
    }
  }

  const clearToken = async () => {
    const next = await window.fcc.secrets.clearProxyToken()
    setSecrets(next)
    setActionMessage({ tone: 'info', text: 'Stored token removed.' })
  }

  const filteredModels = catalog?.models.filter((model) => {
    const query = modelQuery.trim().toLowerCase()
    if (!query) return true
    return (
      model.displayName.toLowerCase().includes(query) ||
      model.id.toLowerCase().includes(query) ||
      model.group.toLowerCase().includes(query)
    )
  }) ?? []

  const connected = status?.state === 'connected'

  return (
    <Modal open={open} onClose={onClose} className="settings-modal" labelledBy="settings-title">
      <nav className="settings-nav">
        <div className="settings-brand">
          <XionMark size={20} />
          <div>
            <div className="settings-brand-name">FCC Desktop</div>
            <div className="settings-brand-ver">v{appInfo?.version ?? '1.0.0'}</div>
          </div>
        </div>
        {SECTIONS.map((item) => (
          <button
            key={item.id}
            className={`settings-nav-item ${section === item.id ? 'is-active' : ''}`}
            onClick={() => {
              setSection(item.id)
              setActionMessage(null)
            }}
          >
            {item.label}
          </button>
        ))}
        <div className="settings-nav-foot">
          <span className={`nav-status ${connected ? 'is-on' : ''}`}>
            <StatusDot tone={connected ? 'green' : status?.state === 'error' ? 'red' : 'amber'} />
            {statusLabel(status)}
          </span>
        </div>
      </nav>

      <div className="settings-main">
        <header className="settings-head">
          <h1 id="settings-title">{SECTIONS.find((item) => item.id === section)?.label}</h1>
          <button className="icon-btn" onClick={onClose} aria-label="Close settings">
            <CloseIcon size={18} />
          </button>
        </header>

        <div className="settings-scroll">
          {actionMessage ? (
            <InlineNotice tone={actionMessage.tone} onClose={() => setActionMessage(null)}>
              {actionMessage.text}
            </InlineNotice>
          ) : null}

          {section === 'connection' ? (
            <>
              {status && !connected ? <SetupGuide status={status} variant="panel" /> : null}
              <section className="card">
                <div className="card-head">
                  <div>
                    <h3>FCC endpoint</h3>
                    <p>The local Free Claude Code proxy this desktop connects to.</p>
                  </div>
                  <span className={`state-chip ${connected ? 'is-on' : 'is-off'}`}>
                    <StatusDot tone={connected ? 'green' : status?.state === 'error' ? 'red' : 'amber'} />
                    {statusLabel(status)}
                  </span>
                </div>

                <div className="status-grid">
                  <div>
                    <span>Base URL</span>
                    <strong className="mono">{status?.baseUrl ?? '—'}</strong>
                  </div>
                  <div>
                    <span>Latency</span>
                    <strong>{status?.latencyMs !== null && status?.latencyMs !== undefined ? `${status.latencyMs} ms` : '—'}</strong>
                  </div>
                  <div>
                    <span>Provider</span>
                    <strong>{status?.provider ?? '—'}</strong>
                  </div>
                  <div>
                    <span>Models</span>
                    <strong>{status?.modelCount ?? catalog?.models.length ?? '—'}</strong>
                  </div>
                </div>

                <div className="row-actions">
                  <Button
                    variant="secondary"
                    onClick={() => void runProbe()}
                    disabled={busyAction !== null}
                    icon={busyAction === 'probe' ? <Spinner size={14} /> : <RefreshIcon size={15} />}
                  >
                    Test connection
                  </Button>
                  <Button
                    variant="primary"
                    onClick={() => void startServer()}
                    disabled={busyAction !== null}
                    icon={busyAction === 'start' ? <Spinner size={14} /> : <PowerIcon size={15} />}
                  >
                    Start FCC
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() => void stopServer()}
                    disabled={busyAction !== null || !status?.ownedByApp}
                    icon={<TrashIcon size={15} />}
                    title={status?.ownedByApp ? 'Stop the server this app started' : 'Only servers started by this app can be stopped here'}
                  >
                    Stop app-started server
                  </Button>
                  {status?.ownedByApp ? <Badge tone="blue">managed by this app</Badge> : null}
                </div>
                {status?.message ? <p className="card-note">{status.message}</p> : null}
              </section>

              <section className="card">
                <div className="card-head">
                  <div>
                    <h3>Host and port</h3>
                    <p>Use an explicit base URL to reach a remote or tunnelled endpoint.</p>
                  </div>
                </div>
                <div className="grid-2">
                  <Field label="Host" hint="127.0.0.1 for local">
                    <TextInput value={host} onChange={(event) => setHost(event.target.value)} spellCheck={false} />
                  </Field>
                  <Field label="Port" hint="FCC default is 8082">
                    <TextInput
                      value={port}
                      onChange={(event) => setPort(event.target.value.replace(/[^0-9]/g, ''))}
                      inputMode="numeric"
                      spellCheck={false}
                    />
                  </Field>
                </div>
                <Field label="Base URL override" hint="Optional — wins over host and port">
                  <TextInput
                    value={baseUrl}
                    onChange={(event) => setBaseUrl(event.target.value)}
                    placeholder="http://127.0.0.1:8082"
                    spellCheck={false}
                  />
                </Field>
                <Toggle
                  checked={settings.connection.autoStartServer}
                  onChange={(value) => void onPatch({ connection: { autoStartServer: value } })}
                  label="Start FCC automatically when the app opens"
                  description="Only starts when nothing is already answering on the endpoint."
                />
              </section>

              <section className="card">
                <div className="card-head">
                  <div>
                    <h3>Executables</h3>
                    <p>Auto-detected from PATH and the standard FCC install locations.</p>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => void detect()} disabled={busyAction !== null}>
                    {busyAction === 'detect' ? <Spinner size={13} /> : 'Auto-detect'}
                  </Button>
                </div>
                <Field
                  label="fcc-server.exe"
                  hint={tools.find((tool) => tool.id === 'server')?.exists ? 'found' : 'not found'}
                >
                  <div className="path-input">
                    <TextInput value={serverPath} onChange={(event) => setServerPath(event.target.value)} placeholder="Auto-detect" spellCheck={false} />
                    <Button size="sm" variant="ghost" onClick={() => void browse('server')}>
                      Browse
                    </Button>
                  </div>
                </Field>
                <Field
                  label="fcc-claude.exe"
                  hint={tools.find((tool) => tool.id === 'claude')?.exists ? 'found' : 'not found'}
                >
                  <div className="path-input">
                    <TextInput value={claudePath} onChange={(event) => setClaudePath(event.target.value)} placeholder="Auto-detect" spellCheck={false} />
                    <Button size="sm" variant="ghost" onClick={() => void browse('claude')}>
                      Browse
                    </Button>
                  </div>
                </Field>
                <div className="row-actions">
                  <Button variant="primary" onClick={() => void saveConnection()} disabled={busyAction !== null}>
                    Save connection
                  </Button>
                </div>
              </section>

              <section className="card">
                <div className="card-head">
                  <div>
                    <h3>Proxy credentials</h3>
                    <p>
                      FCC normally runs without auth. If you enabled PROXY_AUTH_ENABLED, store the token here — it is
                      encrypted with the Windows credential store and never sent to the interface.
                    </p>
                  </div>
                  <Badge tone={secrets.hasProxyToken ? 'green' : 'neutral'}>
                    {secrets.hasProxyToken ? 'token stored' : 'no token'}
                  </Badge>
                </div>
                <Field label="ANTHROPIC_AUTH_TOKEN" hint={secrets.backend === 'dpapi' ? 'DPAPI protected' : 'credential store unavailable'}>
                  <div className="path-input">
                    <TextInput
                      type="password"
                      value={token}
                      onChange={(event) => setToken(event.target.value)}
                      placeholder={secrets.hasProxyToken ? '•••••••• stored' : 'freecc'}
                      autoComplete="off"
                    />
                    <Button size="sm" variant="secondary" onClick={() => void saveToken()} disabled={!token.trim()}>
                      Save
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void clearToken()} disabled={!secrets.hasProxyToken}>
                      Clear
                    </Button>
                  </div>
                </Field>
              </section>
            </>
          ) : null}

          {section === 'models' ? (
            <>
              <section className="card">
                <div className="card-head">
                  <div>
                    <h3>Default model</h3>
                    <p>The catalog comes from the running FCC endpoint — nothing here is hardcoded.</p>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => void refreshModels()} disabled={busyAction !== null}>
                    {busyAction === 'models' ? <Spinner size={13} /> : 'Refresh'}
                  </Button>
                </div>

                <Field label="Custom model id" hint="For aliases your provider exposes but FCC does not list">
                  <div className="path-input">
                    <TextInput
                      value={customModel}
                      onChange={(event) => setCustomModel(event.target.value)}
                      placeholder="e.g. claude-opus-5-5"
                      spellCheck={false}
                    />
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={!customModel.trim()}
                      onClick={() => {
                        void onPatch({ agent: { defaultModel: customModel.trim() } })
                        setCustomModel('')
                      }}
                    >
                      Use as default
                    </Button>
                  </div>
                </Field>

                <div className="model-filter">
                  <TextInput
                    value={modelQuery}
                    onChange={(event) => setModelQuery(event.target.value)}
                    placeholder="Filter models"
                    spellCheck={false}
                  />
                  <span className="model-count">{filteredModels.length}</span>
                </div>

                {catalog?.error ? <InlineNotice tone="error">{catalog.error}</InlineNotice> : null}

                <div className="settings-model-list">
                  {filteredModels.length === 0 ? (
                    <div className="card-empty">No models available. Check the connection, then refresh.</div>
                  ) : (
                    filteredModels.map((model) => {
                      const isDefault = settings.agent.defaultModel === model.id
                      return (
                        <div key={model.id} className={`settings-model ${isDefault ? 'is-active' : ''}`}>
                          <button
                            className="settings-model-main"
                            onClick={() => void onPatch({ agent: { defaultModel: model.id } })}
                          >
                            <span className="settings-model-check">{isDefault ? <CheckIcon size={13} /> : null}</span>
                            <span className="settings-model-copy">
                              <span className="settings-model-name">{model.displayName}</span>
                              <span className="settings-model-id">{model.id}</span>
                            </span>
                            <span className="settings-model-group">{model.group}</span>
                          </button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => void testModel(model.id)}
                            disabled={busyAction === 'test'}
                          >
                            Test
                          </Button>
                        </div>
                      )
                    })
                  )}
                </div>

                {testResult ? (
                  <InlineNotice tone={testResult.ok ? 'success' : 'error'}>
                    {testResult.message}
                    {testResult.latencyMs !== null ? ` (${testResult.latencyMs} ms)` : ''}
                  </InlineNotice>
                ) : null}
              </section>

              <section className="card">
                <div className="card-head">
                  <div>
                    <h3>How providers are configured</h3>
                    <p>
                      FCC owns provider credentials: it maps each model id to the provider configured in its own
                      settings. Choose a model here and FCC routes it; provider keys stay with FCC, never in this app.
                    </p>
                  </div>
                </div>
                <div className="provider-hint">
                  <span className="provider-hint-label">Current server provider</span>
                  <strong>{status?.provider ?? 'unknown'}</strong>
                  <span className="provider-hint-model">{status?.serverModel ?? ''}</span>
                </div>
              </section>
            </>
          ) : null}

          {section === 'agent' ? (
            <>
              <section className="card">
                <div className="card-head">
                  <div>
                    <h3>Permissions</h3>
                    <p>
                      This surface runs headless, so tool permissions are declared up front. The mode is applied the
                      next time the agent starts.
                    </p>
                  </div>
                </div>
                <div className="permission-grid">
                  {PERMISSIONS.map((permission) => (
                    <button
                      key={permission.id}
                      className={`permission-card ${settings.agent.permissionMode === permission.id ? 'is-active' : ''}`}
                      onClick={() => void onPatch({ agent: { permissionMode: permission.id } })}
                    >
                      <span className="permission-radio">
                        {settings.agent.permissionMode === permission.id ? <span /> : null}
                      </span>
                      <span className="permission-copy">
                        <span className="permission-title">{permission.label}</span>
                        <span className="permission-desc">{permission.copy}</span>
                      </span>
                    </button>
                  ))}
                </div>
                {settings.agent.permissionMode !== 'bypassPermissions' ? (
                  <InlineNotice tone="info">
                    In this mode some tool calls are denied by design. Denials are reported back in the conversation.
                  </InlineNotice>
                ) : null}
              </section>

              <section className="card">
                <div className="card-head">
                  <div>
                    <h3>Workspaces</h3>
                    <p>The agent starts in this directory and inherits it as its working root.</p>
                  </div>
                </div>
                <Field label="Default working directory" hint={workingDir ? undefined : 'Empty means your home folder'}>
                  <div className="path-input">
                    <TextInput
                      value={workingDir}
                      onChange={(event) => setWorkingDir(event.target.value)}
                      onBlur={() => void onPatch({ agent: { workingDirectory: workingDir } })}
                      placeholder="C:\\Users\\you\\projects\\app"
                      spellCheck={false}
                    />
                    <Button size="sm" variant="ghost" onClick={() => void browseWorkingDir()}>
                      Browse
                    </Button>
                  </div>
                </Field>

                <div className="dir-manager">
                  <div className="dir-manager-head">
                    <span>Additional permitted directories</span>
                    <Button size="sm" variant="ghost" onClick={() => void addAdditionalDir()} icon={<PlusIcon size={14} />}>
                      Add
                    </Button>
                  </div>
                  {settings.agent.additionalDirs.length === 0 ? (
                    <div className="card-empty">No extra directories. Attachments grant access automatically per message.</div>
                  ) : (
                    settings.agent.additionalDirs.map((dir) => (
                      <div key={dir} className="dir-manager-row">
                        <FolderIcon size={14} />
                        <span className="dir-manager-name">{folderName(dir)}</span>
                        <span className="dir-manager-path">{dir}</span>
                        <button className="icon-btn mini danger" onClick={() => void removeAdditionalDir(dir)} aria-label="Remove directory">
                          <TrashIcon size={13} />
                        </button>
                      </div>
                    ))
                  )}
                </div>

                <Toggle
                  checked={settings.agent.showThinking}
                  onChange={(value) => void onPatch({ agent: { showThinking: value } })}
                  label="Show reasoning blocks"
                  description="Display the model's thinking summaries when FCC returns them."
                />
              </section>

              <section className="card">
                <div className="card-head">
                  <div>
                    <h3>Current session</h3>
                    <p>Runtime state for the open conversation.</p>
                  </div>
                </div>
                <div className="status-grid">
                  <div>
                    <span>Session id</span>
                    <strong className="mono">{runtime?.sessionId ? runtime.sessionId.slice(0, 8) : 'not started'}</strong>
                  </div>
                  <div>
                    <span>Model</span>
                    <strong>{runtime?.model || settings.agent.defaultModel || 'server default'}</strong>
                  </div>
                  <div>
                    <span>Working dir</span>
                    <strong className="mono">{runtime?.workingDirectory ?? '—'}</strong>
                  </div>
                  <div>
                    <span>Uptime</span>
                    <strong>{runtime?.startedAt ? duration(Date.now() - runtime.startedAt) : '—'}</strong>
                  </div>
                </div>
              </section>
            </>
          ) : null}

          {section === 'appearance' ? (
            <section className="card">
              <div className="card-head">
                <div>
                  <h3>Interface</h3>
                  <p>Obsidian is the only theme: the XiØN palette is tuned for long sessions.</p>
                </div>
              </div>
              <Field label="Text size">
                <Segmented
                  value={String(settings.ui.fontScale)}
                  options={[
                    { value: '0.92', label: 'Compact' },
                    { value: '1', label: 'Default' },
                    { value: '1.1', label: 'Large' },
                  ]}
                  onChange={(value) => void onPatch({ ui: { fontScale: Number(value) } })}
                />
              </Field>
              <Field label="Density">
                <Segmented
                  value={settings.ui.density}
                  options={[
                    { value: 'comfortable', label: 'Comfortable' },
                    { value: 'compact', label: 'Compact' },
                  ]}
                  onChange={(value) => void onPatch({ ui: { density: value as AppSettings['ui']['density'] } })}
                />
              </Field>
              <Toggle
                checked={settings.ui.reducedMotion}
                onChange={(value) => void onPatch({ ui: { reducedMotion: value } })}
                label="Reduce motion"
                description="Disables stream animations and transitions."
              />
              <Toggle
                checked={settings.ui.activityOpen}
                onChange={(value) => void onPatch({ ui: { activityOpen: value } })}
                label="Keep the activity panel open"
                description="Shows agent runtime, tool calls and usage beside the conversation."
              />
            </section>
          ) : null}

          {section === 'data' ? (
            <>
              <section className="card">
                <div className="card-head">
                  <div>
                    <h3>Storage</h3>
                    <p>Conversations and settings live on this computer in the app data folder.</p>
                  </div>
                </div>
                <div className="data-path">
                  <span className="mono">{appInfo?.userData ?? '—'}</span>
                  <Button size="sm" variant="ghost" onClick={() => void window.fcc.storage.openDataFolder()}>
                    Open folder
                  </Button>
                </div>
                <div className="row-actions">
                  <Button
                    variant="secondary"
                    onClick={() =>
                      void window.fcc.conversations.exportAll().then((ok) => {
                        if (ok) onToast('info', 'Conversations exported.')
                      })
                    }
                  >
                    Export conversations
                  </Button>
                  <Button variant="danger" onClick={onClearConversationsRequested}>
                    Delete all conversations
                  </Button>
                </div>
              </section>

              <section className="card">
                <div className="card-head">
                  <div>
                    <h3>Reset</h3>
                    <p>Restore every preference to its default. Stored credentials are not touched.</p>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  onClick={() =>
                    void window.fcc.settings.reset().then(() => {
                      onToast('info', 'Settings restored. Restart the app to apply everything.')
                    })
                  }
                >
                  Restore default settings
                </Button>
              </section>
            </>
          ) : null}

          {section === 'diagnostics' ? (
            <>
              <section className="card">
                <div className="card-head">
                  <div>
                    <h3>Environment</h3>
                    <p>Share this when reporting a problem — credentials are never included.</p>
                  </div>
                  <div className="row-actions">
                    <Button size="sm" variant="ghost" onClick={() => void window.fcc.diagnostics.snapshot().then(setDiagnostics)}>
                      Refresh
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => void window.fcc.diagnostics.copy()}>
                      Copy
                    </Button>
                  </div>
                </div>
                {diagnostics ? (
                  <>
                    <div className="status-grid">
                      <div>
                        <span>App</span>
                        <strong>v{diagnostics.app.version}</strong>
                      </div>
                      <div>
                        <span>Electron</span>
                        <strong>{diagnostics.app.electron}</strong>
                      </div>
                      <div>
                        <span>Chromium</span>
                        <strong>{diagnostics.app.chrome}</strong>
                      </div>
                      <div>
                        <span>Node</span>
                        <strong>{diagnostics.app.node}</strong>
                      </div>
                    </div>
                    <div className="tool-checks">
                      {diagnostics.tools.map((tool) => (
                        <div key={tool.id} className="tool-check">
                          <StatusDot tone={tool.exists ? 'green' : 'red'} />
                          <span className="tool-check-label">{tool.label}</span>
                          <span className="tool-check-path mono">{tool.path ?? `not found (${tool.source})`}</span>
                        </div>
                      ))}
                    </div>
                    <div className="log-block">
                      <div className="log-head">Recent app log</div>
                      <pre>{diagnostics.logs.slice(-60).join('\n') || 'No entries yet.'}</pre>
                    </div>
                  </>
                ) : (
                  <div className="card-empty">Collecting…</div>
                )}
              </section>
            </>
          ) : null}

          {section === 'about' ? (
            <section className="card about-card">
              <div className="about-mark">
                <XionMark size={34} />
              </div>
              <h3>FCC Desktop</h3>
              <p className="about-version">Version {appInfo?.version ?? '1.0.0'}</p>
              <p className="about-copy">
                A desktop environment for Free Claude Code. The agent runs locally through fcc-claude, talks to your
                FCC endpoint, and works inside the folders you grant. Built by XiØN.
              </p>
              <div className="about-links">
                <button className="link-row" onClick={() => void window.fcc.app.openExternal('https://xiondigital.net')}>
                  <LinkIcon size={14} />
                  xiondigital.net
                </button>
                <button className="link-row" onClick={() => void window.fcc.app.openExternal('https://github.com/XiONDiGiTaL/fccGUI')}>
                  <LinkIcon size={14} />
                  github.com/XiONDiGiTaL/fccGUI
                </button>
                <button className="link-row" onClick={() => void window.fcc.app.openExternal('https://github.com/Alishahryar1/free-claude-code')}>
                  <LinkIcon size={14} />
                  Free Claude Code
                </button>
              </div>
              <div className="about-license">Licensed under AGPL-3.0 · Copyright © 2026 XiØN</div>
            </section>
          ) : null}

          {section === 'diagnostics' && !diagnostics ? (
            <div className="settings-loading">
              <Spinner size={18} />
            </div>
          ) : null}
        </div>
      </div>
    </Modal>
  )
}
