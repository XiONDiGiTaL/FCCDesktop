import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { HardwareProfile } from '../src/shared/local'
import { fitFor, fitScore } from '../src/shared/local-fit'
import { displayNameOf, paramsOf, quantOf } from '../electron/local/hub'
import { buildServerArgs, pickAsset } from '../electron/local/runtime'
import { aliasFor } from '../electron/local/service'
import { isLocalModelId, localModelId } from '../src/shared/local'

const GB = 1024 ** 3

const desktop: HardwareProfile = {
  cpu: 'AMD Ryzen 7 5700X3D 8-Core Processor',
  threads: 16,
  ramBytes: 32 * GB,
  freeRamBytes: 12 * GB,
  platform: 'win32',
  arch: 'x64',
  os: '10.0.26100',
  gpus: [{ name: 'AMD Radeon RX 7900 XT', vramBytes: 20 * GB, vendor: 'amd' }],
  vramBytes: 20 * GB,
  gpuVendor: 'amd',
  backend: 'vulkan',
  detectedAt: 0,
}

test('fit: a model inside VRAM is a full-GPU fit', () => {
  const fit = fitFor(15 * GB, desktop)
  assert.equal(fit.level, 'gpu')
  assert.match(fit.detail, /20 GB VRAM/)
})

test('fit: a model larger than VRAM but within RAM offloads', () => {
  assert.equal(fitFor(19 * GB, desktop).level, 'hybrid')
})

test('fit: a model beyond VRAM + RAM is refused', () => {
  assert.equal(fitFor(60 * GB, desktop).level, 'too-large')
})

test('fit: without a GPU everything is CPU-only or too large', () => {
  const cpuOnly: HardwareProfile = {
    ...desktop,
    gpus: [],
    vramBytes: null,
    gpuVendor: 'none',
    backend: 'cpu',
  }
  assert.equal(fitFor(2 * GB, cpuOnly).level, 'cpu')
  assert.equal(fitFor(40 * GB, cpuOnly).level, 'too-large')
})

test('fit: ranking puts GPU fits ahead of popularity', () => {
  const gpu = fitScore(fitFor(2 * GB, desktop), 10)
  const big = fitScore(fitFor(60 * GB, desktop), 900_000_000)
  assert.ok(gpu > big)
})

test('hub: MoE parameter counts keep both numbers', () => {
  assert.equal(paramsOf('Qwen3-Coder-30B-A3B-Instruct'), '30B · 3B active')
  assert.equal(paramsOf('Llama-3.3-70B-Instruct'), '70B')
  assert.equal(paramsOf('GLM-4.7-Flash'), null)
})

test('hub: only real quantised files count', () => {
  assert.equal(quantOf('Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf'), 'Q4_K_M')
  assert.equal(quantOf('gpt-oss-20b-MXFP4.gguf'), 'MXFP4')
  assert.equal(quantOf('mmproj-model-f16.gguf'), null)
  assert.equal(quantOf('eagle3-gpt-oss-20b-Q8_0.gguf'), null, 'draft heads are not chat models')
  assert.equal(quantOf('Model-Q4_K_M-00001-of-00002.gguf'), null, 'split shards are not a single download')
})

test('hub: display names drop the GGUF suffix', () => {
  assert.equal(displayNameOf('unsloth/Qwen3.8-27B-GGUF'), 'Qwen3.8 27B')
})

test('runtime: asset choice follows platform and backend', () => {
  const win = ['llama-b12670-bin-win-vulkan-x64.zip', 'llama-b12670-bin-win-cpu-x64.zip']
  assert.equal(pickAsset(win, 'win32', 'vulkan')?.name, 'llama-b12670-bin-win-vulkan-x64.zip')
  assert.equal(pickAsset(win, 'win32', 'cpu')?.name, 'llama-b12670-bin-win-cpu-x64.zip')

  const linux = ['llama-b12670-bin-ubuntu-vulkan-x64.tar.gz', 'llama-b12670-bin-ubuntu-x64.tar.gz']
  assert.deepEqual(pickAsset(linux, 'linux', 'vulkan'), {
    name: 'llama-b12670-bin-ubuntu-vulkan-x64.tar.gz',
    kind: 'targz',
  })
  assert.equal(pickAsset(linux, 'linux', 'cpu')?.name, 'llama-b12670-bin-ubuntu-x64.tar.gz')
  assert.equal(pickAsset(['llama-b12670-bin-macos-arm64.tar.gz'], 'darwin', 'metal')?.kind, 'targz')
  assert.equal(pickAsset(['nothing-useful.zip'], 'win32', 'vulkan'), null)
})

test('runtime: ROCm is selectable but falls back to Vulkan', () => {
  const win = ['llama-b12670-bin-win-rocm-10.0-x64.zip', 'llama-b12670-bin-win-vulkan-x64.zip']
  assert.equal(pickAsset(win, 'win32', 'rocm')?.name, 'llama-b12670-bin-win-rocm-10.0-x64.zip')
  assert.equal(pickAsset(['llama-b12670-bin-win-vulkan-x64.zip'], 'win32', 'rocm')?.name, 'llama-b12670-bin-win-vulkan-x64.zip')
  const linux = ['llama-b12670-bin-ubuntu-rocm-10.0-x64.tar.gz']
  assert.equal(pickAsset(linux, 'linux', 'rocm')?.name, 'llama-b12670-bin-ubuntu-rocm-10.0-x64.tar.gz')
})

test('runtime: optional load settings become llama-server flags', () => {
  const base = buildServerArgs({
    modelPath: 'C:\models\m.gguf',
    port: 8080,
    contextSize: 8192,
    gpuLayers: 999,
    alias: 'm',
  })
  assert.deepEqual(base.slice(0, 2), ['-m', 'C:\models\m.gguf'])
  assert.ok(base.includes('--jinja'))
  assert.ok(!base.includes('-fa'), 'flash attention stays on llama.cpp auto by default')
  assert.ok(!base.includes('--no-mmap'))

  const tuned = buildServerArgs({
    modelPath: 'm.gguf',
    port: 8080,
    contextSize: 16384,
    gpuLayers: 40,
    alias: 'm',
    flashAttention: true,
    threads: 8,
    batchSize: 512,
    keepModelInMemory: true,
  })
  assert.equal(tuned[tuned.indexOf('-c') + 1], '16384')
  assert.equal(tuned[tuned.indexOf('-ngl') + 1], '40')
  assert.deepEqual(tuned.slice(tuned.indexOf('-fa'), tuned.indexOf('-fa') + 2), ['-fa', 'on'])
  assert.equal(tuned[tuned.indexOf('-t') + 1], '8')
  assert.equal(tuned[tuned.indexOf('-b') + 1], '512')
  assert.ok(tuned.includes('--no-mmap'))
})

test('service: model ids are FCC-friendly aliases', () => {
  assert.equal(aliasFor('C:\\models\\Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf'), 'qwen3-coder-30b-a3b-instruct-q4_k_m')
  assert.equal(aliasFor('/models/Gemma 3 1B.gguf'), 'gemma-3-1b')
})

test('service: local model ids are what a conversation sends', () => {
  assert.equal(localModelId('C:\\models\\Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf'), 'llamacpp/qwen3-coder-30b-a3b-instruct-q4_k_m')
  assert.equal(localModelId('/models/Gemma 3 1B.gguf'), 'llamacpp/gemma-3-1b')
  assert.equal(isLocalModelId('llamacpp/gemma-3-1b'), true)
  assert.equal(isLocalModelId('claude-sonnet-5-5'), false)
})
