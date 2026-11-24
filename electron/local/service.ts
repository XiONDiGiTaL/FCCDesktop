/**
 * Local model library: hardware-aware Hugging Face index, GGUF downloads into a
 * folder the user picks, and the llama.cpp server that makes them usable.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statfsSync, statSync, type Dirent } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { app } from 'electron'
import type {
  DownloadTask,
  HardwareProfile,
  InstalledModel,
  LocalCatalogInput,
  LocalConfig,
  LocalDownloadInput,
  LocalIndex,
  LocalModel,
  LocalServerInput,
  LocalServerStatus,
  LocalState,
  LocalStorageInfo,
} from '../../src/shared/local'
import { readJson, writeJsonAtomic } from '../core/atomic'
import { log } from '../core/logger'
import { dataRoot } from '../core/paths'
import { getSettings, updateSettings } from '../core/settings'
import { DownloadManager } from './downloads'
import { detectHardware } from './hardware'
import { featuredModels, searchModels } from './hub'
import { LlamaRuntime } from './runtime'
import { LOCAL_MODEL_PREFIX, aliasForModelPath } from '../../src/shared/local'

const HARDWARE_TTL = 15 * 60 * 1000
const INDEX_TTL = 6 * 60 * 60 * 1000

interface InstalledFile {
  version: 1
  models: InstalledModel[]
}

function installedPath(): string {
  return join(dataRoot(), 'local-models.json')
}

function indexPath(): string {
  return join(dataRoot(), 'local-index.json')
}

function humanSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`
}

export const aliasFor = aliasForModelPath

export class LocalModelsService {
  private hardware: HardwareProfile | null = null
  private hardwareError: string | null = null
  private hardwareAt = 0
  private index: LocalIndex = { models: [], fetchedAt: 0, error: null, family: null, query: '' }
  private listeners = new Set<() => void>()
  private downloadListeners = new Set<(tasks: DownloadTask[]) => void>()
  readonly downloads = new DownloadManager()
  readonly runtime = new LlamaRuntime()
  private starting = false

  constructor() {
    this.downloads.bind(
      () => this.publishDownloads(),
      (task) => this.registerInstalled(task),
    )
    const cached = readJson<{ fetchedAt?: number; models?: LocalModel[] }>(indexPath(), {})
    if (cached.models?.length && cached.fetchedAt) {
      this.index = { models: cached.models, fetchedAt: cached.fetchedAt, error: null, family: null, query: '' }
    }
  }

  storageDir(): string {
    const configured = getSettings().local.storageDir.trim()
    return configured || join(app.getPath('userData'), 'models')
  }

  private insideStorage(path: string): boolean {
    const root = resolve(this.storageDir())
    const target = resolve(path)
    return target === root || target.startsWith(`${root}${sep}`)
  }

  private storageCache: { at: number; info: LocalStorageInfo } | null = null

  storageInfo(): LocalStorageInfo {
    // State is read on every download tick; do not touch the disk that often.
    if (this.storageCache && Date.now() - this.storageCache.at < 1500) return this.storageCache.info
    const info = this.probeStorage()
    this.storageCache = { at: Date.now(), info }
    return info
  }

  private probeStorage(): LocalStorageInfo {
    const dir = this.storageDir()
    try {
      mkdirSync(dir, { recursive: true })
      const probe = join(dir, '.fcc-write-test')
      writeJsonAtomic(probe, { at: Date.now() })
      rmSync(probe, { force: true })
      let freeBytes: number | null = null
      try {
        const stats = statfsSync(dir)
        freeBytes = Number(stats.bavail) * Number(stats.bsize)
      } catch {
        freeBytes = null
      }
      return { dir, writable: true, freeBytes, error: null }
    } catch (error) {
      return { dir, writable: false, freeBytes: null, error: `Cannot write to ${dir}: ${String(error)}` }
    }
  }

  async detect(force = false): Promise<HardwareProfile | null> {
    if (!force && this.hardware && Date.now() - this.hardwareAt < HARDWARE_TTL) return this.hardware
    try {
      this.hardware = await detectHardware()
      this.hardwareAt = Date.now()
      this.hardwareError = null
    } catch (error) {
      this.hardwareError = String(error)
      log.warn('local-models', `Hardware detection failed: ${String(error)}`)
    }
    return this.hardware
  }

  hardwareProfile(): HardwareProfile | null {
    return this.hardware
  }

  installed(): InstalledModel[] {
    const stored = readJson<InstalledFile>(installedPath(), { version: 1, models: [] })
    const known = new Map<string, InstalledModel>()
    for (const model of stored.models ?? []) {
      if (typeof model?.path !== 'string') continue
      if (!existsSync(model.path)) continue
      known.set(resolve(model.path), model)
    }
    const dir = this.storageDir()
    const found: InstalledModel[] = []
    const scan = (folder: string, depth: number): void => {
      let entries: Dirent[] = []
      try {
        entries = readdirSync(folder, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        const full = join(folder, entry.name)
        if (entry.isDirectory() && depth < 2) {
          scan(full, depth + 1)
          continue
        }
        if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.gguf')) continue
        const key = resolve(full)
        const existing = known.get(key)
        if (existing) {
          found.push(existing)
          known.delete(key)
          continue
        }
        // A file dropped in by hand: still usable, just without source metadata.
        let size = 0
        try {
          size = statSync(full).size
        } catch {
          continue
        }
        found.push({
          id: key,
          repo: '',
          filename: entry.name,
          quant: '',
          path: key,
          sizeBytes: size,
          installedAt: 0,
        })
      }
    }
    scan(dir, 0)
    return found.sort((a, b) => b.installedAt - a.installedAt || a.filename.localeCompare(b.filename))
  }

  private persistInstalled(models: InstalledModel[]): void {
    try {
      writeJsonAtomic(installedPath(), { version: 1, models } satisfies InstalledFile)
    } catch (error) {
      log.warn('local-models', `Could not persist the model list: ${String(error)}`)
    }
  }

  private registerInstalled(task: DownloadTask): void {
    if (task.state !== 'done') return
    const models = this.installed().filter((model) => resolve(model.path) !== resolve(task.destPath))
    let size = task.sizeBytes
    try {
      size = statSync(task.destPath).size
    } catch {
      /* keep the advertised size */
    }
    models.push({
      id: resolve(task.destPath),
      repo: task.repo,
      filename: task.filename,
      quant: task.quant,
      path: resolve(task.destPath),
      sizeBytes: size,
      installedAt: Date.now(),
    })
    this.persistInstalled(models)
    this.emit()
  }

  async catalog(input: LocalCatalogInput = {}): Promise<LocalIndex> {
    const query = (input.query ?? '').trim()
    try {
      if (query) {
        const models = await searchModels(query, 12)
        this.index = {
          models,
          fetchedAt: Date.now(),
          error: models.length === 0 ? `No GGUF repository matched “${query}”.` : null,
          family: null,
          query,
        }
        return this.index
      }
      const fresh = Date.now() - this.index.fetchedAt < INDEX_TTL
      if (!input.refresh && fresh && this.index.models.length > 0 && !this.index.query) return this.index
      const models = await featuredModels()
      this.index = {
        models,
        fetchedAt: Date.now(),
        error: models.length === 0 ? 'Hugging Face returned no usable GGUF repositories.' : null,
        family: null,
        query: '',
      }
      writeJsonAtomic(indexPath(), { fetchedAt: this.index.fetchedAt, models })
      log.info('local-models', `Indexed ${models.length} GGUF repositories from Hugging Face`)
      return this.index
    } catch (error) {
      this.index = {
        ...this.index,
        error: `Could not reach Hugging Face: ${error instanceof Error ? error.message : String(error)}`,
      }
      return this.index
    }
  }

  cachedIndex(): LocalIndex {
    return this.index
  }

  download(input: LocalDownloadInput): DownloadTask {
    const model = this.index.models.find((entry) => entry.repo === input.repo)
    const file = model?.files.find((entry) => entry.filename === input.filename)
    if (!file) throw new Error('That file is not in the current index. Refresh the library and try again.')
    if (model?.gated) throw new Error('That repository is gated on Hugging Face and cannot be downloaded here.')
    const storage = this.storageInfo()
    if (!storage.writable) throw new Error(storage.error ?? 'The model folder is not writable.')
    if (storage.freeBytes !== null && storage.freeBytes < file.sizeBytes * 1.05) {
      throw new Error(
        `Not enough space in ${storage.dir}: ${humanSize(storage.freeBytes)} free, ${humanSize(file.sizeBytes)} needed.`,
      )
    }
    const task = this.downloads.start({
      repo: input.repo,
      filename: file.filename,
      quant: input.quant ?? file.quant,
      destPath: join(this.storageDir(), file.filename),
      sizeBytes: file.sizeBytes,
    })
    this.publishDownloads()
    return task
  }

  cancelDownload(id: string): boolean {
    return this.downloads.cancel(id)
  }

  clearDownloads(): void {
    this.downloads.clearFinished()
  }

  removeModel(path: string): boolean {
    if (!this.insideStorage(path)) throw new Error('That file is not inside the model folder.')
    const server = this.runtime.serverStatus()
    if (server.running && server.modelPath && resolve(server.modelPath) === resolve(path)) this.stopServer()
    rmSync(path, { force: true })
    rmSync(`${path}.part`, { force: true })
    this.persistInstalled(this.installed().filter((model) => resolve(model.path) !== resolve(path)))
    this.emit()
    return true
  }

  async installRuntime(): Promise<void> {
    const configured = getSettings().local.backend
    const hardware = await this.detect()
    const target = configured === 'auto' ? (hardware?.backend ?? 'cpu') : configured
    await this.runtime.install(target, () => this.emit())
  }

  /** Persist load settings; the sanitizer in core/settings clamps every field. */
  configure(patch: Partial<LocalConfig>): void {
    updateSettings({ local: patch })
    this.storageCache = null
    this.emit()
  }

  removeRuntime(): void {
    this.runtime.remove()
    this.emit()
  }

  async startServer(input: LocalServerInput): Promise<LocalServerStatus> {
    if (this.starting) throw new Error('The local server is already starting.')
    if (!this.insideStorage(input.path)) throw new Error('That model is not inside the model folder.')
    const settings = getSettings().local
    this.starting = true
    try {
      const status = await this.runtime.start({
        modelPath: resolve(input.path),
        port: Math.round(input.port ?? settings.port),
        contextSize: Math.round(input.contextSize ?? settings.contextSize),
        gpuLayers: Math.round(input.gpuLayers ?? settings.gpuLayers),
        alias: aliasFor(input.path),
        flashAttention: input.flashAttention ?? settings.flashAttention,
        threads: Math.round(input.threads ?? settings.threads),
        batchSize: Math.round(input.batchSize ?? settings.batchSize),
        keepModelInMemory: input.keepModelInMemory ?? settings.keepModelInMemory,
      })
      if (status.running) {
        updateSettings({ local: { port: status.port } })
      }
      return status
    } finally {
      this.starting = false
      this.emit()
    }
  }

  stopServer(): LocalServerStatus {
    this.runtime.stop()
    this.emit()
    return this.runtime.serverStatus()
  }

  setStorageDir(dir: string): LocalStorageInfo {
    const cleaned = dir.trim()
    if (!cleaned || !/^[A-Za-z]:[\\/]|^\//.test(cleaned)) throw new Error('Choose an absolute folder path.')
    mkdirSync(cleaned, { recursive: true })
    updateSettings({ local: { storageDir: resolvedPath(cleaned) } })
    this.storageCache = null
    this.emit()
    return this.storageInfo()
  }

  /**
   * Make `llamacpp/<alias>` usable for a turn: load that GGUF in llama-server,
   * reusing a server that already serves it.
   */
  async ensureModel(modelId: string): Promise<LocalServerStatus> {
    const alias = modelId.startsWith(LOCAL_MODEL_PREFIX) ? modelId.slice(LOCAL_MODEL_PREFIX.length) : modelId
    const current = this.runtime.serverStatus()
    if (current.running && current.alias === alias) return current
    const model = this.installed().find((entry) => aliasFor(entry.path) === alias)
    if (!model) {
      throw new Error(`“${alias}” is not in the local model folder. Download it from Local models.`)
    }
    return this.startServer({ path: model.path })
  }

  /** Env for an FCC process this app spawns, so its llama.cpp provider points here. */
  fccEnv(): Record<string, string> {
    const server = this.runtime.serverStatus()
    const port = server.running ? server.port : getSettings().local.port
    return { LLAMACPP_BASE_URL: `http://127.0.0.1:${port}/v1` }
  }

  async state(): Promise<LocalState> {
    await this.detect()
    return {
      hardware: this.hardware,
      hardwareError: this.hardwareError,
      storage: this.storageInfo(),
      runtime: this.runtime.status(),
      server: this.runtime.serverStatus(),
      downloads: this.downloads.list(),
      installed: this.installed(),
      index: this.index,
      config: getSettings().local,
    }
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  onDownloads(cb: (tasks: DownloadTask[]) => void): () => void {
    this.downloadListeners.add(cb)
    return () => this.downloadListeners.delete(cb)
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        /* a renderer listener must not break the service */
      }
    }
  }

  private publishDownloads(): void {
    const tasks = this.downloads.list()
    for (const listener of this.downloadListeners) {
      try {
        listener(tasks)
      } catch {
        /* ignore */
      }
    }
  }
}

function resolvedPath(path: string): string {
  try {
    return resolve(path)
  } catch {
    return path
  }
}

export const localModelsService = new LocalModelsService()
