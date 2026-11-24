import type { HardwareProfile, ModelFit } from './local'

const GB = 1024 ** 3
/** Weights plus KV cache, compute buffers and the GPU context. */
const CONTEXT_OVERHEAD = 1.6 * GB

function gb(bytes: number): string {
  return `${(bytes / GB).toFixed(bytes / GB >= 10 ? 0 : 1)} GB`
}

/**
 * How a quantised GGUF is likely to behave on this machine.
 *
 * Deliberately conservative: a model that only just fits after the desktop
 * compositor, browser and Electron take their share runs badly, so "fits" is
 * judged against 94% of VRAM rather than all of it.
 */
export function fitFor(sizeBytes: number, hardware: HardwareProfile | null): ModelFit {
  if (!hardware || sizeBytes <= 0) {
    return {
      level: 'cpu',
      label: 'Unknown',
      detail: 'Hardware or file size was not detected; compare the size with your VRAM manually.',
    }
  }
  const need = sizeBytes + CONTEXT_OVERHEAD
  const vram = hardware.vramBytes ?? 0
  const ram = hardware.ramBytes

  if (vram > 0 && need <= vram * 0.94) {
    return {
      level: 'gpu',
      label: 'Runs on GPU',
      detail: `Needs about ${gb(need)} of the ${gb(vram)} VRAM on ${hardware.gpus[0]?.name ?? 'the GPU'}.`,
    }
  }
  if (vram > 0 && need <= vram + ram * 0.7) {
    return {
      level: 'hybrid',
      label: 'Partial offload',
      detail: `Needs about ${gb(need)} — more than ${gb(vram)} VRAM, so some layers run from system memory. Usable, slower.`,
    }
  }
  if (need <= ram * 0.8) {
    return {
      level: 'cpu',
      label: 'CPU only',
      detail: `Needs about ${gb(need)} of RAM and no VRAM. Expect a few tokens per second.`,
    }
  }
  return {
    level: 'too-large',
    label: 'Too large',
    detail: `Needs about ${gb(need)}; this machine has ${gb(ram)} RAM and ${vram > 0 ? gb(vram) : 'no detected'} VRAM.`,
  }
}

const FIT_WEIGHT: Record<ModelFit['level'], number> = { gpu: 3, hybrid: 2, cpu: 1, 'too-large': 0 }

/** Order the index by how well it runs here, then by popularity. */
export function fitScore(fit: ModelFit, downloads: number): number {
  return FIT_WEIGHT[fit.level] * 1e9 + Math.min(downloads, 9e8)
}
