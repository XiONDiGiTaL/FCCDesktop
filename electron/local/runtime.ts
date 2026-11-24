/**
 * llama.cpp runtime: install the official prebuilt server, launch it against a
 * downloaded GGUF, and expose it as the endpoint FCC's llama.cpp provider uses.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import type { LocalServerStatus, RuntimeStatus } from '../../src/shared/local'
import { dataRoot } from '../core/paths'
import { log } from '../core/logger'
import { extractZip } from '../skills/zip'
import { extractTarGz } from '../skills/tar'

// llama.cpp publishes a release per nightly build, newest first. `/latest`
// points at an empty marker release, so the list is what has the binaries.
const RELEASE_API = 'https://api.github.com/repos/ggml-org/llama.cpp/releases?per_page=15'
const UA = 'FCC-Desktop/1.0 (+https://github.com/XiONDiGiTaL/FCCDesktop)'
const MAX_ASSET_BYTES = 700 * 1024 * 1024
const HEALTH_TIMEOUT = 240000
const LOG_LINES = 80

interface RuntimeState {
  version: string
  binary: string
  backend: string
  installedAt: number
}

/**
 * llama-server arguments for a load configuration.
 *
 * Defaults are deliberately minimal (context, full offload, `--jinja` for tool
 * calling); the optional flags only appear when the user turns them on, so a
 * build that does not support a flag is never passed it by accident.
 */
export function buildServerArgs(options: StartOptions): string[] {
  const args = [
    '-m',
    options.modelPath,
    '--host',
    '127.0.0.1',
    '--port',
    String(options.port),
    '-c',
    String(options.contextSize),
    '-ngl',
    String(options.gpuLayers),
    '--alias',
    options.alias,
    '--jinja',
  ]
  if (options.flashAttention) args.push('-fa', 'on')
  if (options.threads && options.threads > 0) args.push('-t', String(options.threads))
  if (options.batchSize && options.batchSize > 0) args.push('-b', String(options.batchSize))
  if (options.keepModelInMemory) args.push('--no-mmap')
  return args
}

export interface StartOptions {
  modelPath: string
  port: number
  contextSize: number
  gpuLayers: number
  alias: string
  flashAttention?: boolean
  threads?: number
  batchSize?: number
  keepModelInMemory?: boolean
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(20000),
  })
  if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`)
  return (await response.json()) as unknown
}

async function downloadAsset(url: string, onProgress?: (received: number, total: number) => void): Promise<Buffer> {
  const response = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/octet-stream' },
    redirect: 'follow',
    signal: AbortSignal.timeout(600000),
  })
  if (!response.ok || !response.body) throw new Error(`Download failed with HTTP ${response.status}`)
  const total = Number(response.headers.get('content-length') ?? 0)
  if (total > MAX_ASSET_BYTES) throw new Error('That runtime archive is unexpectedly large; refusing to download it.')
  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      received += value.length
      if (received > MAX_ASSET_BYTES) throw new Error('That runtime archive is unexpectedly large; refusing it.')
      chunks.push(Buffer.from(value))
      onProgress?.(received, total)
    }
  }
  return Buffer.concat(chunks)
}

/**
 * Official builds ship as `llama-b<number>-bin-<platform>-<backend>-<arch>.zip`.
 *
 * Vulkan is preferred on every GPU: it covers AMD, Intel and NVIDIA with the
 * same archive, while the CUDA builds need a second cudart download.
 */
export function pickAsset(
  names: string[],
  platform: string,
  backend: string,
): { name: string; kind: 'zip' | 'targz' } | null {
  const gpu = backend !== 'cpu'
  const patterns: RegExp[] =
    platform === 'win32'
      ? backend === 'rocm'
        ? [/bin-win-rocm-[\d.]+-x64\.zip$/, /bin-win-vulkan-x64\.zip$/]
        : gpu
          ? [/bin-win-vulkan-x64\.zip$/, /bin-win-cpu-x64\.zip$/]
          : [/bin-win-cpu-x64\.zip$/]
      : platform === 'darwin'
        ? [/bin-macos-arm64\.tar\.gz$/, /bin-macos-x64\.tar\.gz$/]
        : backend === 'rocm'
          ? [/bin-ubuntu-rocm-[\d.]+-x64\.tar\.gz$/, /bin-ubuntu-vulkan-x64\.tar\.gz$/]
          : gpu
            ? [/bin-ubuntu-vulkan-x64\.tar\.gz$/, /bin-ubuntu-x64\.tar\.gz$/]
            : [/bin-ubuntu-x64\.tar\.gz$/, /bin-ubuntu-[\d.]+-x64\.tar\.gz$/]
  for (const pattern of patterns) {
    const match = names.find((name) => pattern.test(name))
    if (!match) continue
    return { name: match, kind: match.endsWith('.tar.gz') ? 'targz' : 'zip' }
  }
  return null
}

interface ReleaseAsset {
  name: string
  url: string
  size: number
}

interface ResolvedRelease {
  version: string
  asset: ReleaseAsset
  kind: 'zip' | 'targz'
}

/** Newest nightly release that actually ships a server for this platform. */
async function resolveRelease(backend: string): Promise<ResolvedRelease> {
  const releases = await fetchJson(RELEASE_API)
  if (!Array.isArray(releases)) throw new Error('GitHub returned an unexpected release list.')
  for (const entry of releases as Array<{ tag_name?: unknown; assets?: unknown }>) {
    const version = typeof entry?.tag_name === 'string' ? entry.tag_name : ''
    if (!version || !/^b\d+$/.test(version)) continue
    if (!Array.isArray(entry.assets)) continue
    const assets: ReleaseAsset[] = (entry.assets as Array<Record<string, unknown>>)
      .filter((asset) => typeof asset.name === 'string' && typeof asset.browser_download_url === 'string')
      .map((asset) => ({
        name: asset.name as string,
        url: asset.browser_download_url as string,
        size: Number(asset.size ?? 0),
      }))
    const picked = pickAsset(
      assets.map((asset) => asset.name),
      process.platform,
      backend,
    )
    if (!picked) continue
    const asset = assets.find((candidate) => candidate.name === picked.name)
    if (!asset) continue
    return { version, asset, kind: picked.kind }
  }
  throw new Error('No recent llama.cpp release ships a server for this platform.')
}

function runtimeRoot(): string {
  return join(app.getPath('userData'), 'runtime', 'llama')
}

function statePath(): string {
  return join(dataRoot(), 'local-runtime.json')
}

function findBinary(root: string, target: string, depth = 0): string | null {
  if (depth > 4) return null
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name)
    if (entry.isFile() && entry.name.toLowerCase() === target) return full
    if (entry.isDirectory()) {
      const nested = findBinary(full, target, depth + 1)
      if (nested) return nested
    }
  }
  return null
}

export class LlamaRuntime {
  private state: RuntimeState | null = null
  private installing = false
  private installProgress: number | null = null
  private child: ChildProcess | null = null
  private server: LocalServerStatus
  private logs: string[] = []

  constructor() {
    this.state = this.load()
    this.server = this.emptyServer()
  }

  private load(): RuntimeState | null {
    try {
      if (!existsSync(statePath())) return null
      const raw = JSON.parse(readFileSync(statePath(), 'utf8')) as RuntimeState
      if (!raw?.binary || !existsSync(raw.binary)) return null
      return raw
    } catch {
      return null
    }
  }

  private emptyServer(): LocalServerStatus {
    return {
      running: false,
      backend: null,
      modelPath: null,
      modelId: null,
      alias: null,
      port: 8080,
      baseUrl: 'http://127.0.0.1:8080',
      openAiBaseUrl: 'http://127.0.0.1:8080/v1',
      startedAt: null,
      message: null,
      log: [],
    }
  }

  status(): RuntimeStatus {
    return {
      installed: Boolean(this.state?.binary && existsSync(this.state.binary)),
      version: this.state?.version ?? null,
      path: this.state?.binary ?? null,
      backend: this.state?.backend ?? null,
      installedAt: this.state?.installedAt ?? null,
      installing: this.installing,
      progress: this.installProgress,
    }
  }

  serverStatus(): LocalServerStatus {
    return { ...this.server, log: [...this.logs] }
  }

  async install(backend: string, onChange: () => void): Promise<RuntimeStatus> {
    if (this.installing) return this.status()
    this.installing = true
    this.installProgress = 0
    onChange()
    try {
      const { version, asset, kind } = await resolveRelease(backend)
      let lastEmit = 0
      const archive = await downloadAsset(asset.url, (received, total) => {
        this.installProgress = total > 0 ? received / total : null
        const now = Date.now()
        if (now - lastEmit > 300) {
          lastEmit = now
          onChange()
        }
      })

      // Reinstall cleanly: a partially extracted older build must not linger.
      const target = join(runtimeRoot(), version.replace(/[^\w.-]/g, '_'))
      rmSync(target, { recursive: true, force: true })
      mkdirSync(target, { recursive: true })
      const result =
        kind === 'zip'
          ? extractZip(archive, target, 0, MAX_ASSET_BYTES)
          : extractTarGz(archive, target, 0, MAX_ASSET_BYTES)
      if (result.error) throw new Error(result.error)

      const binaryName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'
      const binary = findBinary(target, binaryName)
      if (!binary) throw new Error('The archive did not contain a llama-server binary.')

      this.state = { version, binary, backend, installedAt: Date.now() }
      mkdirSync(dirname(statePath()), { recursive: true })
      writeFileSync(statePath(), JSON.stringify(this.state, null, 2), 'utf8')
      log.info('local-runtime', `Installed llama.cpp ${version} (${asset.name}) at ${binary}`)
    } catch (error) {
      log.error('local-runtime', `Runtime install failed: ${String(error)}`)
      throw error
    } finally {
      this.installing = false
      this.installProgress = null
      onChange()
    }
    return this.status()
  }

  remove(): void {
    this.stop()
    rmSync(runtimeRoot(), { recursive: true, force: true })
    rmSync(statePath(), { force: true })
    this.state = null
  }

  private capture(chunk: Buffer): void {
    const text = chunk.toString()
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed) continue
      this.logs.push(trimmed)
      if (this.logs.length > LOG_LINES) this.logs.shift()
    }
  }

  async start(options: StartOptions): Promise<LocalServerStatus> {
    if (this.child) this.stop()
    const runtime = this.status()
    if (!runtime.installed || !runtime.path) throw new Error('Install the llama.cpp runtime first.')
    if (!existsSync(options.modelPath)) throw new Error('That model file is missing. Download it again.')

    const args = buildServerArgs(options)
    this.logs = []
    log.info('local-runtime', `Starting llama-server on 127.0.0.1:${options.port} (${options.alias})`)

    const child = spawn(runtime.path, args, {
      cwd: dirname(runtime.path),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, LLAMA_LOG_LEVEL: 'warn' },
    })
    if (process.platform !== 'win32') {
      try {
        chmodSync(runtime.path, 0o755)
      } catch {
        /* already executable */
      }
    }
    this.child = child
    child.stdout?.on('data', (chunk: Buffer) => this.capture(chunk))
    child.stderr?.on('data', (chunk: Buffer) => this.capture(chunk))

    let exited = false
    let code: number | null = null
    child.on('exit', (value) => {
      exited = true
      code = value
      if (this.child === child) this.child = null
    })

    this.server = {
      running: false,
      backend: this.state?.backend ?? null,
      modelPath: options.modelPath,
      modelId: `llamacpp/${options.alias}`,
      alias: options.alias,
      port: options.port,
      baseUrl: `http://127.0.0.1:${options.port}`,
      openAiBaseUrl: `http://127.0.0.1:${options.port}/v1`,
      startedAt: null,
      message: 'Loading the model…',
      log: [],
    }

    const deadline = Date.now() + HEALTH_TIMEOUT
    while (Date.now() < deadline) {
      if (exited) break
      try {
        const response = await fetch(`http://127.0.0.1:${options.port}/health`, {
          signal: AbortSignal.timeout(2500),
        })
        if (response.ok) {
          this.server = {
            ...this.server,
            running: true,
            backend: this.state?.backend ?? null,
            startedAt: Date.now(),
            message: null,
          }
          log.info('local-runtime', `llama-server ready on port ${options.port}`)
          return this.serverStatus()
        }
      } catch {
        /* still loading */
      }
      await new Promise((resolve) => setTimeout(resolve, 700))
    }

    const tail = this.logs.slice(-8).join('\n')
    this.stop()
    this.server = {
      ...this.emptyServer(),
      port: options.port,
      baseUrl: `http://127.0.0.1:${options.port}`,
      openAiBaseUrl: `http://127.0.0.1:${options.port}/v1`,
      modelPath: options.modelPath,
      alias: options.alias,
      modelId: `llamacpp/${options.alias}`,
      message: exited
        ? `llama-server exited with code ${code ?? 'unknown'}.${tail ? `\n${tail}` : ''}`
        : 'The model did not become ready within four minutes.',
    }
    return this.serverStatus()
  }

  stop(): void {
    const child = this.child
    if (!child?.pid) {
      this.child = null
      this.server = this.emptyServer()
      return
    }
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      } else {
        child.kill('SIGTERM')
      }
    } catch (error) {
      log.warn('local-runtime', `Could not stop llama-server: ${String(error)}`)
    }
    this.child = null
    this.server = this.emptyServer()
    log.info('local-runtime', 'Stopped llama-server')
  }
}

export function runtimeSize(): number {
  const root = runtimeRoot()
  if (!existsSync(root)) return 0
  let total = 0
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else {
        try {
          total += statSync(full).size
        } catch {
          /* ignore */
        }
      }
    }
  }
  walk(root)
  return total
}
