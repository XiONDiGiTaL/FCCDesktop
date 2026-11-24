/**
 * Local model contracts: hardware profile, Hugging Face index entries,
 * downloads, the llama.cpp runtime and its server.
 *
 * Nothing here may contain secrets — this module is bundled into the renderer.
 */

/** Model id prefix FCC's llama.cpp provider expects. */
export const LOCAL_MODEL_PREFIX = 'llamacpp/'

/** Filename-safe alias used as the llama.cpp model name and FCC model id. */
export function aliasForModelPath(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path
  return base
    .replace(/\.gguf$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

/** `llamacpp/<alias>` — the id a conversation sends to reach a local GGUF. */
export function localModelId(path: string): string {
  return `${LOCAL_MODEL_PREFIX}${aliasForModelPath(path)}`
}

export function isLocalModelId(modelId: string): boolean {
  return modelId.startsWith(LOCAL_MODEL_PREFIX)
}

export type GpuVendor = 'nvidia' | 'amd' | 'intel' | 'apple' | 'other' | 'none'
export type RuntimeBackend = 'vulkan' | 'rocm' | 'metal' | 'cpu'
/** `auto` follows the detected GPU; the rest force a specific runtime build. */
export type BackendChoice = 'auto' | RuntimeBackend

export interface GpuInfo {
  name: string
  /** Total VRAM when the platform exposes it. Windows reads it from the driver. */
  vramBytes: number | null
  vendor: GpuVendor
}

export interface HardwareProfile {
  cpu: string
  threads: number
  ramBytes: number
  freeRamBytes: number
  platform: string
  arch: string
  os: string
  gpus: GpuInfo[]
  /** Best single GPU by VRAM; the fit calculation uses it. */
  vramBytes: number | null
  gpuVendor: GpuVendor
  backend: RuntimeBackend
  detectedAt: number
}

export interface ModelFile {
  filename: string
  quant: string
  sizeBytes: number
}

export interface LocalModel {
  /** `owner/name` — stable across index refreshes. */
  id: string
  repo: string
  name: string
  family: string
  familyLabel: string
  params: string | null
  downloads: number
  likes: number
  updatedAt: number | null
  /** Gated repositories need a Hugging Face token; the download says so plainly. */
  gated: boolean
  license: string | null
  files: ModelFile[]
  url: string
  description: string | null
}

export type FitLevel = 'gpu' | 'hybrid' | 'cpu' | 'too-large'

export interface ModelFit {
  level: FitLevel
  label: string
  detail: string
}

export interface DownloadTask {
  id: string
  repo: string
  filename: string
  quant: string
  destPath: string
  sizeBytes: number
  receivedBytes: number
  state: 'downloading' | 'done' | 'error' | 'cancelled'
  error: string | null
  startedAt: number
  updatedAt: number
  bytesPerSecond: number
}

export interface InstalledModel {
  id: string
  repo: string
  filename: string
  quant: string
  path: string
  sizeBytes: number
  installedAt: number
}

export interface RuntimeStatus {
  installed: boolean
  version: string | null
  path: string | null
  backend: string | null
  installedAt: number | null
  installing: boolean
  progress: number | null
}

export interface LocalServerStatus {
  running: boolean
  /** Runtime build actually serving, e.g. `vulkan`. */
  backend: string | null
  modelPath: string | null
  /** `llamacpp/<alias>` — the id FCC expects for its llama.cpp provider. */
  modelId: string | null
  alias: string | null
  port: number
  baseUrl: string
  openAiBaseUrl: string
  startedAt: number | null
  message: string | null
  log: string[]
}

export interface LocalIndex {
  models: LocalModel[]
  fetchedAt: number
  error: string | null
  family: string | null
  query: string
}

export interface LocalStorageInfo {
  dir: string
  writable: boolean
  freeBytes: number | null
  error: string | null
}

export interface LocalState {
  hardware: HardwareProfile | null
  hardwareError: string | null
  storage: LocalStorageInfo
  runtime: RuntimeStatus
  server: LocalServerStatus
  downloads: DownloadTask[]
  installed: InstalledModel[]
  index: LocalIndex
  /** Effective local settings, so the view edits what the service will use. */
  config: LocalConfig
}

export interface LocalCatalogInput {
  /** Rebuild from Hugging Face instead of the cached index. */
  refresh?: boolean
  /** Free-text Hugging Face search; empty shows the recommended families. */
  query?: string
  family?: string | null
}

export interface LocalDownloadInput {
  repo: string
  filename: string
  quant?: string
}

export interface LocalServerInput {
  path: string
  port?: number
  contextSize?: number
  gpuLayers?: number
  flashAttention?: boolean
  threads?: number
  batchSize?: number
  keepModelInMemory?: boolean
}

export interface LocalConfig {
  /** Absolute folder for GGUF files. Empty means the app's data folder. */
  storageDir: string
  /** llama-server port. FCC's llamacpp provider expects 8080 by default. */
  port: number
  contextSize: number
  gpuLayers: number
  /** Which llama.cpp build to install; `auto` follows the detected GPU. */
  backend: BackendChoice
  /** Pass `-fa on`. Off leaves llama.cpp's own auto decision in place. */
  flashAttention: boolean
  /** CPU threads for generation; 0 lets llama.cpp decide. */
  threads: number
  /** Logical batch size (`-b`); 0 keeps the llama.cpp default. */
  batchSize: number
  /** Disables mmap (`--no-mmap`) so weights stay resident after loading. */
  keepModelInMemory: boolean
}
