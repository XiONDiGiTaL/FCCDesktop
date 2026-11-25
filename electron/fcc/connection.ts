import { spawn, type ChildProcess } from 'node:child_process'
import { homedir } from 'node:os'
import { URL } from 'node:url'
import type {
  ConnectionStatus,
  ModelCatalog,
  ModelInfo,
  ServerInfo,
  ServerStartResult,
} from '../../src/shared/types'
import { effectiveBaseUrl, getSettings } from '../core/settings'
import { getProxyToken } from '../core/secrets'
import { log, redact } from '../core/logger'
import { resolveTool } from './discovery'
import { requestJson } from './http'
import { fetchModels } from './models'
import { localModelsService } from '../local/service'

const PROBE_TIMEOUT = 3500
const POLL_INTERVAL = 15000
const START_TIMEOUT = 50000

export class ConnectionManager {
  private status: ConnectionStatus
  private owned: ChildProcess | null = null
  private timer: NodeJS.Timeout | null = null
  private catalog: ModelCatalog | null = null
  private catalogBaseUrl = ''
  private serverLogs: string[] = []
  private onStatus: (status: ConnectionStatus) => void = () => {}
  private watchers = new Set<(status: ConnectionStatus) => void>()

  constructor() {
    this.status = {
      state: 'disconnected',
      baseUrl: effectiveBaseUrl(),
      latencyMs: null,
      provider: null,
      serverModel: null,
      modelCount: null,
      message: null,
      ownedByApp: false,
      checkedAt: 0,
    }
  }

  bind(onStatus: (status: ConnectionStatus) => void): void {
    this.onStatus = onStatus
  }

  /**
   * Observe every published status. The usage monitor starts before the first
   * probe, so it needs to learn when FCC actually becomes reachable.
   */
  watch(listener: (status: ConnectionStatus) => void): () => void {
    this.watchers.add(listener)
    return () => {
      this.watchers.delete(listener)
    }
  }

  baseUrl(): string {
    return effectiveBaseUrl()
  }

  current(): ConnectionStatus {
    return { ...this.status, ownedByApp: this.owned !== null }
  }

  authHeaders(): Record<string, string> {
    const token = getProxyToken()
    return token ? { 'x-api-key': token, authorization: `Bearer ${token}` } : {}
  }

  serverDiagnostics(): string[] {
    return [...this.serverLogs]
  }

  private publish(status: ConnectionStatus): ConnectionStatus {
    this.status = status
    this.onStatus(status)
    for (const watcher of [...this.watchers]) {
      try {
        watcher(this.current())
      } catch (error) {
        log.warn('fcc', `Connection watcher failed: ${String(error)}`)
      }
    }
    return status
  }

  /** Probe the endpoint and refresh the published status. Never throws. */
  async probe(): Promise<ConnectionStatus> {
    const baseUrl = this.baseUrl()
    if (baseUrl !== this.catalogBaseUrl) {
      this.catalog = null
      this.catalogBaseUrl = baseUrl
    }
    const response = await requestJson<ServerInfo>(`${baseUrl}/`, {
      headers: this.authHeaders(),
      timeoutMs: PROBE_TIMEOUT,
    })

    if (!response.ok) {
      const detail = response.error ?? `HTTP ${response.status}`
      return this.publish({
        state: response.status === 0 ? 'disconnected' : 'error',
        baseUrl,
        latencyMs: response.latencyMs,
        provider: null,
        serverModel: null,
        modelCount: null,
        message:
          response.status === 0
            ? `No FCC server answered at ${baseUrl}. Start it from Connection settings.`
            : `FCC answered with HTTP ${response.status}: ${detail}`,
        ownedByApp: this.owned !== null,
        checkedAt: Date.now(),
      })
    }

    if (!this.catalog) {
      const catalog = await fetchModels(baseUrl, getProxyToken())
      if (!catalog.error) this.catalog = catalog
    }

    return this.publish({
      state: 'connected',
      baseUrl,
      latencyMs: response.latencyMs,
      provider: response.data?.provider ?? null,
      serverModel: response.data?.model ?? null,
      modelCount: this.catalog?.models.length ?? null,
      message: null,
      ownedByApp: this.owned !== null,
      checkedAt: Date.now(),
    })
  }

  /** Last catalog read, without triggering another request. */
  cachedModels(): ModelInfo[] {
    return this.catalog?.models ?? []
  }

  async models(force = false): Promise<ModelCatalog> {
    const baseUrl = this.baseUrl()
    if (!force && this.catalog && this.catalogBaseUrl === baseUrl) {
      return this.catalog
    }
    const catalog = await fetchModels(baseUrl, getProxyToken())
    if (!catalog.error) {
      this.catalog = catalog
      this.catalogBaseUrl = baseUrl
      if (this.status.state === 'connected') {
        this.publish({ ...this.status, modelCount: catalog.models.length, checkedAt: Date.now() })
      }
    }
    return catalog
  }

  /** Real round-trip through the endpoint: proves model + credentials work. */
  async testModel(modelId: string): Promise<{ ok: boolean; message: string; latencyMs: number | null }> {
    const baseUrl = this.baseUrl().replace(/\/+$/, '')
    const response = await requestJson<{ content?: Array<{ text?: string }>; error?: { message?: string } }>(
      `${baseUrl}/v1/messages`,
      {
        method: 'POST',
        headers: {
          'anthropic-version': '2023-06-01',
          ...this.authHeaders(),
        },
        body: {
          model: modelId,
          max_tokens: 16,
          messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
        },
        timeoutMs: 60000,
      },
    )
    if (response.ok) {
      const text = response.data?.content?.map((part) => part.text ?? '').join('').trim()
      return {
        ok: true,
        message: text ? `Model responded: “${text.slice(0, 80)}”` : 'Model responded successfully.',
        latencyMs: response.latencyMs,
      }
    }
    const apiMessage = response.data?.error?.message
    return {
      ok: false,
      message: redact(apiMessage ?? response.error ?? `HTTP ${response.status}`),
      latencyMs: response.latencyMs,
    }
  }

  /** Start FCC only when nothing is already serving the configured endpoint. */
  async startServer(): Promise<ServerStartResult> {
    const settings = getSettings()
    if (this.owned) {
      const status = await this.probe()
      return { started: true, alreadyRunning: true, message: 'FCC is already running (started by this app).', status }
    }
    const probe = await this.probe()
    if (probe.state === 'connected') {
      return { started: true, alreadyRunning: true, message: 'An FCC server is already running; connected to it.', status: probe }
    }

    const tool = resolveTool('server')
    if (!tool.path) {
      const message =
        'fcc-server.exe was not found. Set its path in Connection settings, or install Free Claude Code.'
      return { started: false, alreadyRunning: false, message, status: probe }
    }

    const url = new URL(this.baseUrl())
    this.serverLogs = []
    log.info('fcc-server', `Starting ${tool.path} on ${url.hostname}:${url.port}`)

    let child: ChildProcess
    try {
      child = spawn(tool.path, [], {
        cwd: homedir(),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          // Point FCC's built-in llama.cpp provider at the local model server.
          ...localModelsService.fccEnv(),
          PORT: url.port || (url.protocol === 'https:' ? '443' : '80'),
          HOST: settings.connection.host,
          FCC_OPEN_BROWSER: '0',
          ...(getProxyToken() ? { ANTHROPIC_AUTH_TOKEN: getProxyToken() } : {}),
        },
      })
    } catch (error) {
      const message = `Could not launch fcc-server.exe: ${String(error)}`
      log.error('fcc-server', message)
      return { started: false, alreadyRunning: false, message, status: this.publish({ ...this.status, state: 'error', message }) }
    }

    this.owned = child
    let exited = false
    let exitCode: number | null = null

    const capture = (chunk: Buffer): void => {
      const text = redact(chunk.toString()).trim()
      if (!text) return
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue
        this.serverLogs.push(line.trim())
        if (this.serverLogs.length > 200) this.serverLogs.shift()
      }
    }
    child.stdout?.on('data', capture)
    child.stderr?.on('data', capture)
    child.on('error', (error) => {
      capture(Buffer.from(String(error)))
      exited = true
    })
    child.on('exit', (code) => {
      exited = true
      exitCode = code
      this.owned = null
      log.info('fcc-server', `FCC server process exited with code ${code}`)
      void this.probe()
    })

    this.publish({
      ...this.current(),
      state: 'starting',
      message: 'Starting the FCC server…',
      ownedByApp: true,
      checkedAt: Date.now(),
    })

    const deadline = Date.now() + START_TIMEOUT
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 600))
      const status = await this.probe()
      if (status.state === 'connected') {
        return { started: true, alreadyRunning: false, message: 'FCC server started and connected.', status }
      }
      if (exited) break
    }

    const lastLogs = this.serverLogs.slice(-6).join('\n')
    const message = exited
      ? `The FCC server process exited before it became reachable (code ${exitCode ?? 'unknown'}).${lastLogs ? `\n${lastLogs}` : ''}`
      : `The FCC server did not become reachable within ${Math.round(START_TIMEOUT / 1000)} seconds.${lastLogs ? `\n${lastLogs}` : ''}`
    if (this.owned) {
      this.killTree(this.owned)
      this.owned = null
    }
    log.error('fcc-server', message)
    const status = this.publish({ ...this.status, state: 'error', message, ownedByApp: false, checkedAt: Date.now() })
    return { started: false, alreadyRunning: false, message, status }
  }

  /** Stop only a server this application spawned. */
  async stopServer(): Promise<ServerStartResult> {
    if (!this.owned) {
      return {
        started: false,
        alreadyRunning: false,
        message: 'FCC was not started by this app, so it will not be stopped here.',
        status: this.current(),
      }
    }
    const child = this.owned
    this.killTree(child)
    this.owned = null
    await new Promise((resolve) => setTimeout(resolve, 700))
    const status = await this.probe()
    log.info('fcc-server', 'Stopped the FCC server started by this app')
    return { started: false, alreadyRunning: false, message: 'Stopped the FCC server started by this app.', status }
  }

  private killTree(child: ChildProcess): void {
    const pid = child.pid
    if (!pid) return
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      } else {
        child.kill('SIGTERM')
      }
    } catch (error) {
      log.warn('fcc-server', `Failed to terminate process ${pid}: ${String(error)}`)
    }
  }

  startPolling(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.probe()
    }, POLL_INTERVAL)
    this.timer.unref?.()
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.watchers.clear()
    if (this.owned) {
      this.killTree(this.owned)
      this.owned = null
    }
  }
}
