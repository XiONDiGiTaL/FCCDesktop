import { execFile } from 'node:child_process'
import { cpus, freemem, release, totalmem } from 'node:os'
import type { GpuInfo, GpuVendor, HardwareProfile, RuntimeBackend } from '../../src/shared/local'

const PS_TIMEOUT = 9000

function run(command: string, args: string[], timeout = PS_TIMEOUT): Promise<string> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      resolve(error && !stdout ? '' : stdout)
    })
  })
}

export function vendorOf(name: string): GpuVendor {
  const text = name.toLowerCase()
  if (/nvidia|geforce|rtx|quadro|tesla/.test(text)) return 'nvidia'
  if (/amd|radeon|ryzen.*graphics|\brx\s?\d|firepro/.test(text)) return 'amd'
  if (/intel|arc\b|iris|uhd graphics/.test(text)) return 'intel'
  if (/apple\s?m\d/.test(text)) return 'apple'
  return 'other'
}

/** qwMemorySize arrives as a QWORD, often serialised as an 8-byte array. */
function asBytes(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.round(value)
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value)
  if (Array.isArray(value) && value.length === 8 && value.every((part) => typeof part === 'number')) {
    let total = 0n
    for (let index = 7; index >= 0; index--) total = (total << 8n) | BigInt(value[index] as number)
    return total > 0 ? Number(total) : null
  }
  return null
}

interface RawGpu {
  name?: unknown
  vram?: unknown
  driverDesc?: unknown
}

function parseJson(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return null
  }
}

async function windowsGpus(): Promise<GpuInfo[]> {
  // AdapterRAM is a uint32 and reports 4 GB for anything larger, so the driver's
  // qwMemorySize registry value is the only reliable VRAM source on Windows.
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "$class='HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}'",
    'Get-ChildItem $class | ForEach-Object {',
    '  $p = Get-ItemProperty $_.PSPath',
    '  if ($p.DriverDesc) { [pscustomobject]@{ name = $p.DriverDesc; vram = $p.\'HardwareInformation.qwMemorySize\'; driverDesc = $p.DriverDesc } }',
    '} | ConvertTo-Json -Compress',
  ].join('\n')
  const raw = parseJson(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]))
  const rows: RawGpu[] = Array.isArray(raw) ? (raw as RawGpu[]) : raw ? [raw as RawGpu] : []
  const gpus: GpuInfo[] = []
  for (const row of rows) {
    const name = typeof row.name === 'string' ? row.name.trim() : ''
    if (!name) continue
    if (/virtual|basic display|remote|microsoft/i.test(name)) continue
    if (gpus.some((entry) => entry.name === name)) continue
    gpus.push({ name, vramBytes: asBytes(row.vram), vendor: vendorOf(name) })
  }
  if (gpus.length === 0) {
    const fallback = parseJson(
      await run('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json -Compress',
      ]),
    )
    const list: RawGpu[] = Array.isArray(fallback) ? (fallback as RawGpu[]) : fallback ? [fallback as RawGpu] : []
    for (const row of list) {
      const name = typeof row.name === 'string' ? row.name.trim() : ''
      if (!name || gpus.some((entry) => entry.name === name)) continue
      gpus.push({ name, vramBytes: asBytes(row.vram), vendor: vendorOf(name) })
    }
  }
  return gpus
}

async function macGpus(): Promise<GpuInfo[]> {
  const raw = parseJson(await run('system_profiler', ['SPDisplaysDataType', '-json'], 15000))
  const devices = (raw as { SPDisplaysDataType?: Array<{ sppci_model?: string; spdisplays_vram?: string }> } | null)
    ?.SPDisplaysDataType
  if (!Array.isArray(devices)) return []
  return devices
    .map((device) => {
      const name = device.sppci_model?.trim() || 'Apple GPU'
      const vram = device.spdisplays_vram?.match(/(\d+)\s*GB/i)
      return {
        name,
        vramBytes: vram ? Number(vram[1]) * 1024 ** 3 : null,
        vendor: vendorOf(name),
      } satisfies GpuInfo
    })
    .slice(0, 4)
}

async function linuxGpus(): Promise<GpuInfo[]> {
  const text = await run('sh', ['-c', "lspci 2>/dev/null | grep -Ei 'vga|3d|display' | cut -d: -f3- | sed 's/^ *//'"])
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((name) => ({ name, vramBytes: null, vendor: vendorOf(name) }) satisfies GpuInfo)
    .slice(0, 4)
}

/**
 * Default runtime for a machine. Vulkan covers AMD, Intel and NVIDIA with one
 * archive and no driver toolkit, so it is the safest default; ROCm is available
 * as an explicit choice where the driver supports it.
 */
export function backendFor(platform: string, vendor: GpuVendor): RuntimeBackend {
  if (platform === 'darwin') return 'metal'
  if (vendor === 'none') return 'cpu'
  if (platform === 'win32' || platform === 'linux') return 'vulkan'
  return 'cpu'
}

export async function detectHardware(): Promise<HardwareProfile> {
  const list = cpus()
  const platform = process.platform
  let gpus: GpuInfo[] = []
  try {
    gpus =
      platform === 'win32' ? await windowsGpus() : platform === 'darwin' ? await macGpus() : await linuxGpus()
  } catch {
    gpus = []
  }
  const withVram = gpus.filter((gpu) => (gpu.vramBytes ?? 0) > 0)
  const best = withVram.sort((a, b) => (b.vramBytes ?? 0) - (a.vramBytes ?? 0))[0] ?? gpus[0]
  const gpuVendor: GpuVendor = best?.vendor ?? 'none'
  return {
    cpu: list[0]?.model?.trim() || 'Unknown CPU',
    threads: list.length,
    ramBytes: totalmem(),
    freeRamBytes: freemem(),
    platform,
    arch: process.arch,
    os: release(),
    gpus,
    vramBytes: best?.vramBytes ?? null,
    gpuVendor,
    backend: backendFor(platform, gpuVendor),
    detectedAt: Date.now(),
  }
}
