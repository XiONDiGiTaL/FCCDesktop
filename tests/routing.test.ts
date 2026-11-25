import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  autoEligible,
  chooseFreeModel,
  classifyModel,
  freeProviderViews,
  inferCapabilities,
  inferTaskProfile,
  modelProviderId,
  rankFreeModels,
  routingSummary,
  type RoutingView,
} from '../src/shared/free-providers'
import { MODEL_TASKS, classifyModelTask, modelMatchesTask } from '../src/shared/model-tasks'

const now = Date.UTC(2026, 10, 24, 12)

test('gateway aliases resolve to the real provider', () => {
  assert.equal(modelProviderId('anthropic/gemini/models/gemini-2.5-flash'), 'gemini')
  assert.equal(modelProviderId('claude-3-freecc-no-thinking/gemini/models/gemini-2.5-pro'), 'gemini')
  assert.equal(modelProviderId('anthropic/nvidia_nim/nvidia/nemotron-3-ultra'), 'nvidia_nim')
  assert.equal(modelProviderId('claude-3-freecc-no-thinking/llamacpp/qwen3.8-27b'), 'llamacpp')
  assert.equal(modelProviderId('nvidia_nim/nvidia/nemotron'), 'nvidia_nim')
  assert.equal(modelProviderId('open_router/openai/gpt-oss-120b:free'), 'open_router')
  assert.equal(modelProviderId('claude-sonnet-5-5'), 'anthropic')
})

test('only standing free tiers are free without opt-in', () => {
  const nvidia = classifyModel('anthropic/nvidia_nim/nvidia/nemotron-3-ultra')
  assert.equal(nvidia.free, true)
  assert.equal(nvidia.requiresOptIn, false)

  const gemini = classifyModel('anthropic/gemini/models/gemini-2.5-flash')
  assert.equal(gemini.free, true)
  assert.equal(gemini.requiresOptIn, true, 'a billing-linked Gemini project can charge')

  const cloudflare = classifyModel('anthropic/cloudflare/@cf/openai/gpt-oss-120b')
  assert.equal(cloudflare.free, true)
  assert.equal(cloudflare.requiresOptIn, true)

  const groq = classifyModel('anthropic/groq/openai/gpt-oss-120b')
  assert.equal(groq.free, true)
  assert.equal(groq.requiresOptIn, false)
})

test('OpenRouter is free only for :free variants', () => {
  assert.equal(classifyModel('anthropic/open_router/openai/gpt-oss-120b:free').free, true)
  assert.equal(classifyModel('anthropic/open_router/openrouter/free').free, true)
  assert.equal(classifyModel('anthropic/open_router/deepseek/deepseek-r1:free').free, true)
  assert.equal(classifyModel('anthropic/open_router/openai/gpt-5').free, false)
})

test('direct DeepSeek and unknown providers are paid', () => {
  assert.equal(classifyModel('anthropic/deepseek/deepseek-chat').free, false)
  assert.equal(classifyModel('anthropic/openai/gpt-5').free, false)
  assert.equal(classifyModel('mystery_vendor/foo').free, false)
  assert.equal(autoEligible(classifyModel('mystery_vendor/foo')), false)
})

test('automatic routing never returns a paid endpoint', () => {
  const models = [
    { id: 'claude-opus-5-5', displayName: 'Claude Opus' },
    { id: 'anthropic/open_router/openai/gpt-5', displayName: 'GPT-5 paid' },
    { id: 'anthropic/deepseek/deepseek-chat', displayName: 'DeepSeek direct' },
    { id: 'anthropic/nvidia_nim/nvidia/nemotron-3-ultra', displayName: 'Nemotron' },
    { id: 'anthropic/gemini/models/gemini-2.5-pro', displayName: 'Gemini Pro' },
  ]
  const route = chooseFreeModel(models, {
    task: inferTaskProfile('fix this TypeScript bug'),
    now,
  })
  assert.equal(route?.providerId, 'nvidia_nim')
  const ranked = rankFreeModels(models, {
    task: inferTaskProfile('fix this TypeScript bug'),
    now,
    allowBillable: true,
  })
  for (const candidate of ranked) assert.equal(candidate.free.free, true)
  assert.ok(ranked.every((candidate) => candidate.providerId !== 'anthropic'))
  assert.ok(ranked.every((candidate) => candidate.providerId !== 'deepseek'))
})

test('billable free tiers stay out until explicitly enabled', () => {
  const models = [{ id: 'anthropic/gemini/models/gemini-2.5-flash', displayName: 'Gemini Flash' }]
  const task = inferTaskProfile('explain this function')
  assert.equal(chooseFreeModel(models, { task, now }), null)
  assert.equal(chooseFreeModel(models, { task, now, allowBillable: true })?.providerId, 'gemini')
})

test('cooldowns and exclusions move to the next free provider', () => {
  const models = [
    { id: 'anthropic/nvidia_nim/nvidia/nemotron-3-ultra', displayName: 'Nemotron' },
    { id: 'anthropic/groq/openai/gpt-oss-120b', displayName: 'gpt-oss 120b' },
    { id: 'anthropic/open_router/openai/gpt-oss-20b:free', displayName: 'gpt-oss 20b free' },
  ]
  const task = inferTaskProfile('refactor the parser')
  assert.equal(chooseFreeModel(models, { task, now })?.providerId, 'nvidia_nim')
  assert.equal(
    chooseFreeModel(models, { task, now, cooldowns: { nvidia_nim: now + 60_000 } })?.providerId,
    'groq',
  )
  assert.equal(
    chooseFreeModel(models, {
      task,
      now,
      cooldowns: { nvidia_nim: now + 60_000, groq: now + 60_000 },
    })?.providerId,
    'open_router',
  )
  assert.equal(
    chooseFreeModel(models, {
      task,
      now,
      cooldowns: { nvidia_nim: now + 60_000, groq: now + 60_000, open_router: now + 60_000 },
    }),
    null,
  )
  assert.equal(
    chooseFreeModel(models, { task, now, excludeIds: [models[0].id] })?.providerId,
    'groq',
  )
})

test('non-chat classifiers are never routed to an agent', () => {
  const models = [
    { id: 'anthropic/nvidia_nim/fastino/gliner2-pii', displayName: 'gliner2-pii' },
    { id: 'anthropic/nvidia_nim/nvidia/ising-calibration-1.5-31b', displayName: 'calibration' },
    { id: 'anthropic/nvidia_nim/nvidia/nemotron-3-ultra', displayName: 'Nemotron' },
  ]
  const route = chooseFreeModel(models, { task: inferTaskProfile('coding agent'), now })
  assert.match(route?.id ?? '', /nemotron/)
  const ranked = rankFreeModels(models, { task: inferTaskProfile('write code'), now })
  assert.equal(ranked.length, 1)
})

test('vision prompts require a vision-capable free model', () => {
  const models = [
    { id: 'anthropic/nvidia_nim/nvidia/nemotron-3-ultra', displayName: 'Nemotron text' },
    { id: 'anthropic/gemini/models/gemini-2.5-flash', displayName: 'Gemini Flash' },
  ]
  const route = chooseFreeModel(models, {
    task: inferTaskProfile('what is in this screenshot', true),
    now,
    allowBillable: true,
  })
  assert.equal(route?.providerId, 'gemini')
  assert.equal(route?.capabilities.vision, true)
})

test('local models are optional and last in priority', () => {
  const models = [
    { id: 'anthropic/llamacpp/qwen3.8-27b', displayName: 'Qwen local' },
    { id: 'anthropic/nvidia_nim/nvidia/nemotron-3-ultra', displayName: 'Nemotron' },
  ]
  const task = inferTaskProfile('write a function')
  assert.equal(chooseFreeModel(models, { task, now })?.providerId, 'nvidia_nim')
  assert.equal(chooseFreeModel(models, { task, now, excludeIds: [models[1].id] }), null)
  assert.equal(
    chooseFreeModel(models, { task, now, excludeIds: [models[1].id], allowLocal: true })?.providerId,
    'llamacpp',
  )
})

test('capability inference is explicit about being inferred', () => {
  const caps = inferCapabilities('anthropic/gemini/models/gemini-2.5-flash', 'Gemini Flash')
  assert.equal(caps.vision, true)
  assert.equal(caps.confidence, 'inferred')
  assert.equal(inferCapabilities('anthropic/nvidia_nim/nvidia/nemotron-3-ultra').reasoning, true)
  assert.equal(inferCapabilities('anthropic/groq/openai/whisper-large-v3').tools, false)
  assert.equal(inferCapabilities('anthropic/nvidia_nim/fastino/gliner2-pii').tools, false)
  assert.equal(inferTaskProfile('coding agent').coding, true)
})

test('provider views explain missing keys, cooldowns and local state', () => {
  const models = [
    { id: 'anthropic/nvidia_nim/nvidia/nemotron-3-ultra' },
    { id: 'anthropic/gemini/models/gemini-2.5-flash' },
    { id: 'anthropic/llamacpp/qwen3.8-27b' },
  ]
  const views = freeProviderViews(
    models,
    [
      { providerId: 'nvidia_nim', displayName: 'NVIDIA NIM', status: 'configured' },
      { providerId: 'gemini', displayName: 'Gemini', status: 'missing_key' },
      { providerId: 'llamacpp', displayName: 'LLaMA.cpp', status: 'configured' },
    ],
    { nvidia_nim: now + 30_000 },
    now,
  )
  const nvidia = views.find((view) => view.id === 'nvidia_nim')
  assert.equal(nvidia?.state, 'cooldown')
  assert.equal(nvidia?.freeModelCount, 1)
  const gemini = views.find((view) => view.id === 'gemini')
  assert.equal(gemini?.state, 'missing-key')
  const local = views.find((view) => view.id === 'llamacpp')
  assert.equal(local?.state, 'local')
})

test('the model library separates tasks without mislabeling Gemini chat', () => {
  assert.equal(classifyModelTask({ id: 'anthropic/gemini/models/gemini-3-pro-image' }), 'image')
  assert.equal(classifyModelTask({ id: 'anthropic/gemini/models/gemini-2.5-flash-preview-tts' }), 'other')
  assert.equal(classifyModelTask({ id: 'anthropic/nvidia_nim/nvidia/nemotron-3.5-embed-1b' }), 'other')
  assert.equal(classifyModelTask({ id: 'anthropic/nvidia_nim/nvidia/nemotron-3-ultra' }), 'reasoning')
  assert.equal(modelMatchesTask({ id: 'anthropic/nvidia_nim/nvidia/nemotron-3-ultra' }, 'coding'), true)
  assert.equal(modelMatchesTask({ id: 'anthropic/nvidia_nim/nvidia/nemotron-3-ultra' }, 'reasoning'), true)
  assert.equal(classifyModelTask({ id: 'anthropic/nvidia_nim/moonshotai/kimi-k3.1-pro' }), 'coding')
  assert.equal(classifyModelTask({ id: 'anthropic/gemini/models/gemini-2.5-pro' }), 'general')
  assert.equal(classifyModelTask({ id: 'anthropic/gemini/models/gemini-2.5-flash-thinking' }), 'reasoning')
  assert.equal(classifyModelTask({ id: 'anthropic/nvidia_nim/mistralai/pixtral-large' }), 'vision')
  assert.equal(MODEL_TASKS.length, 6)
})

test('the empty state says when no free provider is ready', () => {
  const providers = freeProviderViews([], [], {}, now)
  const view: RoutingView = {
    providers,
    cooldowns: {},
    history: [],
    lastError: null,
    activeModel: 'claude-opus-5-5',
    activeFree: false,
    activeProvider: 'anthropic',
    autoFallback: true,
    freeFirst: true,
    allowBillable: false,
    allowLocal: false,
  }
  assert.match(routingSummary(view), /No free provider is ready/)
})
