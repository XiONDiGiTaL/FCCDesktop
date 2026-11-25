/**
 * Free-first provider registry and model router.
 *
 * FCC owns provider credentials and does the actual proxying. This module only
 * decides which model ids may be chosen automatically. It is deliberately
 * conservative: a provider is auto-eligible only when its free access cannot
 * silently become a charge, unless the user explicitly opts in to accounts that
 * can bill.
 *
 * Provider facts are recorded with their source links. Free allowances change,
 * so the UI links to the provider console instead of presenting these numbers
 * as a live quota.
 */

export type FreeBasis = 'no-charge' | 'allowance' | 'local' | 'paid' | 'unknown'
export type ProviderKind = 'hosted' | 'local'

export interface FreeProvider {
  id: string
  label: string
  kind: ProviderKind
  /** How the free access works. */
  basis: FreeBasis
  /** True when a free-tier call can become billable on the same account. */
  canBill: boolean
  requiresKey: boolean
  website: string
  setupUrl: string
  keyEnv: string | null
  /** What the free access covers, in the provider's own terms. */
  freeNote: string
  /** Published limits. These are ceilings, not a live quota. */
  limits: string
  /** One-line caution shown next to the provider. */
  caution: string | null
  sourceUrl: string
}

/**
 * Providers that offer a standing free tier. "Paid" entries are documented so
 * the router can explain why a direct model is not selected automatically.
 */
export const FREE_PROVIDERS: FreeProvider[] = [
  {
    id: 'nvidia_nim',
    label: 'NVIDIA NIM',
    kind: 'hosted',
    basis: 'no-charge',
    canBill: false,
    requiresKey: true,
    website: 'https://build.nvidia.com/',
    setupUrl: 'https://build.nvidia.com/settings/api-keys',
    keyEnv: 'NVIDIA_NIM_API_KEY',
    freeNote: 'Free developer endpoints for prototyping with an NVIDIA Developer Program key.',
    limits: 'About 40 requests/minute and 10,000 requests/day per account. Published ceilings vary by model and traffic can throttle them.',
    caution: 'Phone verification is required in supported countries.',
    sourceUrl: 'https://build.nvidia.com/',
  },
  {
    id: 'groq',
    label: 'Groq',
    kind: 'hosted',
    basis: 'no-charge',
    canBill: false,
    requiresKey: true,
    website: 'https://groq.com/',
    setupUrl: 'https://console.groq.com/keys',
    keyEnv: 'GROQ_API_KEY',
    freeNote: 'Permanent Free plan. A card is only needed to move to the paid Developer plan.',
    limits: '30 requests/minute, 1,000 requests/day, 8,000 tokens/minute and 200,000 tokens/day on current free models such as gpt-oss-120b.',
    caution: 'Limits apply per organization, not per key.',
    sourceUrl: 'https://console.groq.com/docs/rate-limits',
  },
  {
    id: 'open_router',
    label: 'OpenRouter',
    kind: 'hosted',
    basis: 'no-charge',
    canBill: false,
    requiresKey: true,
    website: 'https://openrouter.ai/',
    setupUrl: 'https://openrouter.ai/settings/keys',
    keyEnv: 'OPENROUTER_API_KEY',
    freeNote: 'Only model variants ending in :free, plus the openrouter/free router, are selected automatically.',
    limits: 'Free variants: 20 requests/minute and 50 requests/day. A one-time purchase of 10 credits raises the daily cap to 1,000; this app does not make that purchase.',
    caution: 'A negative credit balance blocks free models too.',
    sourceUrl: 'https://openrouter.ai/docs/api-reference/limits',
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    kind: 'hosted',
    basis: 'allowance',
    canBill: true,
    requiresKey: true,
    website: 'https://ai.google.dev/',
    setupUrl: 'https://aistudio.google.com/apikey',
    keyEnv: 'GEMINI_API_KEY',
    freeNote: 'Free tier on many Flash, Flash-Lite, 2.5 Pro and Gemma models. Free-tier content is used to improve Google products.',
    limits: 'Per-project request, token and daily limits are shown in AI Studio and reset at midnight Pacific. Google does not guarantee them.',
    caution: 'A project with billing linked is a paid tier, so automatic routing needs explicit opt-in.',
    sourceUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
  },
  {
    id: 'sambanova',
    label: 'SambaNova',
    kind: 'hosted',
    basis: 'allowance',
    canBill: true,
    requiresKey: true,
    website: 'https://cloud.sambanova.ai/',
    setupUrl: 'https://cloud.sambanova.ai/apis',
    keyEnv: 'SAMBANOVA_API_KEY',
    freeNote: 'Free tier applies while no payment method is linked to the account.',
    limits: '20 requests/minute, 20 requests/day and 200,000 tokens/day per model on the free tier.',
    caution: 'Linking a card moves the account to the paid Developer tier.',
    sourceUrl: 'https://docs.sambanova.ai/cloud/docs/models/rate-limits',
  },
  {
    id: 'cloudflare',
    label: 'Cloudflare Workers AI',
    kind: 'hosted',
    basis: 'allowance',
    canBill: true,
    requiresKey: true,
    website: 'https://developers.cloudflare.com/workers-ai/',
    setupUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    keyEnv: 'CLOUDFLARE_API_KEY',
    freeNote: 'Workers Free includes 10,000 Neurons per day. Text generation is capped at 300 requests/minute.',
    limits: '10,000 Neurons/day at no charge, reset at 00:00 UTC. More requires the paid Workers plan.',
    caution: 'On a paid Workers plan, usage above the daily allocation is billed.',
    sourceUrl: 'https://developers.cloudflare.com/workers-ai/platform/pricing/',
  },
  {
    id: 'llamacpp',
    label: 'llama.cpp',
    kind: 'local',
    basis: 'local',
    canBill: false,
    requiresKey: false,
    website: 'https://github.com/ggml-org/llama.cpp',
    setupUrl: '',
    keyEnv: null,
    freeNote: 'Runs on this computer through the app library or an FCC llama.cpp provider.',
    limits: 'No account, provider quota or charge. Speed depends on local hardware.',
    caution: null,
    sourceUrl: 'https://github.com/ggml-org/llama.cpp',
  },
  {
    id: 'ollama',
    label: 'Ollama',
    kind: 'local',
    basis: 'local',
    canBill: false,
    requiresKey: false,
    website: 'https://ollama.com/',
    setupUrl: '',
    keyEnv: null,
    freeNote: 'Runs on this computer through an Ollama server configured in FCC.',
    limits: 'No account, provider quota or charge.',
    caution: null,
    sourceUrl: 'https://ollama.com/',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    kind: 'local',
    basis: 'local',
    canBill: false,
    requiresKey: false,
    website: 'https://lmstudio.ai/',
    setupUrl: '',
    keyEnv: null,
    freeNote: 'Runs on this computer through an LM Studio server configured in FCC.',
    limits: 'No account, provider quota or charge.',
    caution: null,
    sourceUrl: 'https://lmstudio.ai/',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    kind: 'hosted',
    basis: 'paid',
    canBill: true,
    requiresKey: true,
    website: 'https://www.deepseek.com/',
    setupUrl: 'https://platform.deepseek.com/api_keys',
    keyEnv: 'DEEPSEEK_API_KEY',
    freeNote: 'The direct DeepSeek API is paid. DeepSeek models are supported for free only through a free third-party endpoint such as an OpenRouter :free variant.',
    limits: 'Direct API usage is billed per token.',
    caution: 'Never selected automatically.',
    sourceUrl: 'https://api-docs.deepseek.com/quick_start/pricing',
  },
]

const PROVIDER_BY_ID = new Map(FREE_PROVIDERS.map((provider) => [provider.id, provider]))

const PROVIDER_ALIASES: Record<string, string> = {
  openrouter: 'open_router',
  open_router: 'open_router',
  google: 'gemini',
  google_gemini: 'gemini',
  nvidia: 'nvidia_nim',
  nvidia_nim: 'nvidia_nim',
  sambanova_cloud: 'sambanova',
  cloudflare_workers_ai: 'cloudflare',
  llama_cpp: 'llamacpp',
  llama: 'llamacpp',
  lm_studio: 'lmstudio',
  deep_seek: 'deepseek',
}

export function canonicalProviderId(raw: string): string {
  const id = raw.trim().toLowerCase()
  return PROVIDER_ALIASES[id] ?? id
}

export function freeProvider(providerId: string): FreeProvider | null {
  return PROVIDER_BY_ID.get(canonicalProviderId(providerId)) ?? null
}

/**
 * FCC gateway catalogs use `<alias>/<provider>/<model...>`, for example
 * `anthropic/nvidia_nim/nvidia/nemotron-3-ultra`. Direct provider ids use
 * `<provider>/<model...>`, and a bare id is one of FCC's Claude aliases.
 */
export function modelProviderId(modelId: string): string {
  const parts = modelId.trim().split('/').filter(Boolean)
  if (parts.length === 0) return 'unknown'
  const first = (parts[0] ?? '').toLowerCase()
  const isGatewayAlias = first === 'anthropic' || first.startsWith('claude-')
  if (isGatewayAlias && parts.length >= 3) return canonicalProviderId(parts[1] ?? 'anthropic')
  if (parts.length >= 2) return canonicalProviderId(first)
  return 'anthropic'
}

export interface ModelFreeInfo {
  providerId: string
  providerLabel: string
  basis: FreeBasis
  /** No charge under the intended free access. */
  free: boolean
  /** Automatic selection needs the user to allow billable accounts. */
  requiresOptIn: boolean
  local: boolean
  reason: string
}

function isFreeOpenRouterModel(modelId: string): boolean {
  const parts = modelId.toLowerCase().split('/').filter(Boolean)
  if (parts.includes('free')) return true
  return /:free(?:$|[/?#])/.test(modelId.toLowerCase()) || parts.some((part) => part === 'free:free')
}

export function classifyModel(modelId: string): ModelFreeInfo {
  const providerId = modelProviderId(modelId)
  const provider = freeProvider(providerId)
  if (!provider) {
    return {
      providerId,
      providerLabel: providerId.replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      basis: 'unknown',
      free: false,
      requiresOptIn: false,
      local: false,
      reason: 'This provider is not in the free registry, so it is treated as paid.',
    }
  }
  if (provider.basis === 'local') {
    return {
      providerId,
      providerLabel: provider.label,
      basis: 'local',
      free: true,
      requiresOptIn: false,
      local: true,
      reason: 'Local inference has no account or per-request charge.',
    }
  }
  if (provider.id === 'open_router') {
    const free = isFreeOpenRouterModel(modelId)
    return {
      providerId,
      providerLabel: provider.label,
      basis: free ? 'no-charge' : 'paid',
      free,
      requiresOptIn: false,
      local: false,
      reason: free
        ? 'OpenRouter :free variant: no per-request charge.'
        : 'Only OpenRouter model variants ending in :free are free.',
    }
  }
  if (provider.basis === 'paid') {
    return {
      providerId,
      providerLabel: provider.label,
      basis: 'paid',
      free: false,
      requiresOptIn: false,
      local: false,
      reason: provider.freeNote,
    }
  }
  return {
    providerId,
    providerLabel: provider.label,
    basis: provider.basis,
    free: true,
    requiresOptIn: provider.canBill,
    local: false,
    reason: provider.canBill
      ? 'Free allowance, but the account can bill above it or after billing is linked.'
      : 'Standing free tier with no per-request charge.',
  }
}

export interface ModelCapabilities {
  coding: boolean
  reasoning: boolean
  tools: boolean
  structured: boolean
  vision: boolean
  /** These are inferred from the model id and name, not provider metadata. */
  confidence: 'inferred'
}

export function inferCapabilities(modelId: string, displayName = ''): ModelCapabilities {
  const text = `${modelId} ${displayName}`.toLowerCase()
  const vision = /vision|multimodal|\bvl\b|-vl|gemini|pixtral|llava|omni|image/.test(text)
  const coding = /coder|code|codestral|devstral|deepseek|qwen|gpt-oss|nemotron|glm|kimi|swe/.test(text)
  const reasoning = /reason|thinking|\br1\b|deepseek-r1|qwen3|nemotron|o3|o4|glm|deepseek-v3\.[2-9]/.test(text)
  const nonChat =
    /embed|whisper|tts|guard|rerank|gliner|classif|calibration|moderation|content-safety|\bpii\b|image-generation|stable-diffusion/.test(
      text,
    )
  return {
    coding,
    reasoning,
    tools: !nonChat,
    structured: !nonChat,
    vision,
    confidence: 'inferred',
  }
}

export interface TaskProfile {
  coding: boolean
  reasoning: boolean
  vision: boolean
  longContext: boolean
  tools: boolean
}

export function inferTaskProfile(prompt: string, hasImages = false): TaskProfile {
  const text = prompt.toLowerCase()
  const coding =
    /\b(coding|coder|programming|code|bug|fix|refactor|implement|repository|repo|file|function|component|typescript|javascript|python|react|api|compile|build|test|types?|schema|migration)\b/.test(
      text,
    )
  const reasoning = /\b(why|explain|reason|design|architect|compare|analyse|analyze|trade-?off|plan|strategy|prove)\b/.test(
    text,
  )
  return {
    coding,
    reasoning,
    vision: hasImages,
    longContext: prompt.length > 12000,
    tools: true,
  }
}

export interface RoutableModel {
  id: string
  displayName?: string
}

export interface RouterCandidate {
  id: string
  displayName: string
  providerId: string
  providerLabel: string
  free: ModelFreeInfo
  capabilities: ModelCapabilities
  score: number
}

export interface RouteOptions {
  task: TaskProfile
  now?: number
  /** provider id -> epoch ms when its cooldown ends */
  cooldowns?: Record<string, number>
  excludeIds?: string[]
  excludeProviders?: string[]
  allowBillable?: boolean
  allowLocal?: boolean
}

const PROVIDER_PRIORITY: Record<string, number> = {
  nvidia_nim: 20,
  groq: 18,
  open_router: 16,
  gemini: 14,
  sambanova: 8,
  cloudflare: 6,
  llamacpp: 4,
  ollama: 3,
  lmstudio: 2,
}

function sizePenalty(modelId: string, task: TaskProfile): number {
  if (!task.coding) return 0
  const match = /(?:^|[/_.-])(\d+(?:\.\d+)?)b(?:$|[/_.-])/i.exec(modelId)
  if (!match) return 0
  const billions = Number(match[1])
  if (!Number.isFinite(billions)) return 0
  if (billions < 7) return -10
  if (billions < 14) return -3
  return 0
}

export function autoEligible(info: ModelFreeInfo, options: { allowBillable?: boolean; allowLocal?: boolean } = {}): boolean {
  if (!info.free) return false
  if (info.local && !options.allowLocal) return false
  if (info.requiresOptIn && !options.allowBillable) return false
  return true
}

/**
 * Rank every free model for the task. Paid endpoints are filtered before any
 * scoring, so a high-scoring paid model can never leak into an automatic route.
 */
export function rankFreeModels(models: RoutableModel[], options: RouteOptions): RouterCandidate[] {
  const now = options.now ?? Date.now()
  const excluded = new Set(options.excludeIds ?? [])
  const excludedProviders = new Set((options.excludeProviders ?? []).map(canonicalProviderId))
  const cooldowns = options.cooldowns ?? {}
  const candidates: RouterCandidate[] = []

  for (const model of models) {
    if (!model.id || excluded.has(model.id)) continue
    const free = classifyModel(model.id)
    if (!autoEligible(free, options)) continue
    if (excludedProviders.has(free.providerId)) continue
    const cooldown = cooldowns[free.providerId] ?? 0
    if (cooldown > now) continue
    const capabilities = inferCapabilities(model.id, model.displayName)
    if (options.task.tools && !capabilities.tools) continue
    if (options.task.vision && !capabilities.vision) continue

    let score = 50 + (PROVIDER_PRIORITY[free.providerId] ?? 0)
    if (capabilities.tools) score += 10
    if (capabilities.structured) score += 2
    if (options.task.coding && capabilities.coding) score += 12
    if (options.task.reasoning && capabilities.reasoning) score += 8
    if (options.task.vision && capabilities.vision) score += 20
    if (options.task.longContext && /128k|200k|1m|long/.test(`${model.id} ${model.displayName ?? ''}`.toLowerCase())) score += 4
    if (free.basis === 'local') score -= 6
    if (/nemotron|gpt-oss|qwen|deepseek|kimi|mistral|gemma|llama|minimax/.test(model.id.toLowerCase())) score += 4
    if (/:free\b/.test(model.id.toLowerCase())) score += 2
    if (/preview|experimental/.test(`${model.id} ${model.displayName ?? ''}`.toLowerCase())) score -= 1
    if (model.displayName && model.displayName !== model.id) score += 1
    score += sizePenalty(model.id, options.task)

    candidates.push({
      id: model.id,
      displayName: model.displayName ?? model.id,
      providerId: free.providerId,
      providerLabel: free.providerLabel,
      free,
      capabilities,
      score,
    })
  }

  return candidates.sort(
    (a, b) =>
      b.score - a.score ||
      (PROVIDER_PRIORITY[b.providerId] ?? 0) - (PROVIDER_PRIORITY[a.providerId] ?? 0) ||
      a.id.localeCompare(b.id),
  )
}

export function chooseFreeModel(models: RoutableModel[], options: RouteOptions): RouterCandidate | null {
  return rankFreeModels(models, options)[0] ?? null
}

// ------------------------------------------------------------------ provider view

export interface ProviderAdminStatus {
  providerId: string
  displayName: string
  status: string
}

export type FreeProviderState = 'ready' | 'missing-key' | 'cooldown' | 'no-models' | 'local'

export interface FreeProviderView {
  id: string
  label: string
  kind: ProviderKind
  basis: FreeBasis
  canBill: boolean
  requiresOptIn: boolean
  requiresKey: boolean
  freeNote: string
  limits: string
  caution: string | null
  setupUrl: string
  website: string
  sourceUrl: string
  configured: boolean
  state: FreeProviderState
  freeModelCount: number
  examples: string[]
  cooldownUntil: number | null
}

export function freeProviderViews(
  models: RoutableModel[],
  adminStatuses: ProviderAdminStatus[],
  cooldowns: Record<string, number>,
  now = Date.now(),
): FreeProviderView[] {
  const admin = new Map(adminStatuses.map((entry) => [canonicalProviderId(entry.providerId), entry]))
  const views: FreeProviderView[] = []
  for (const provider of FREE_PROVIDERS) {
    // Count only agent-capable endpoints. A PII classifier or embedding model is
    // free but is not a model the coding agent can use.
    const freeModels = models.filter((model) => {
      const info = classifyModel(model.id)
      return info.providerId === provider.id && info.free && inferCapabilities(model.id, model.displayName).tools
    })
    const entry = admin.get(provider.id)
    const status = entry?.status?.toLowerCase() ?? ''
    // FCC's own status wins: a provider with models listed but a missing key is
    // still not usable. Models are evidence only when FCC did not report it.
    const configured = status === 'configured' || status === 'ready' || status === 'available'
      ? true
      : entry
        ? false
        : freeModels.length > 0
    const cooldownUntil = cooldowns[provider.id] ?? null
    let state: FreeProviderState
    if (cooldownUntil !== null && cooldownUntil > now) state = 'cooldown'
    else if (provider.kind === 'local') state = configured ? 'local' : 'no-models'
    else if (!entry && freeModels.length === 0) state = 'no-models'
    else if (!configured) state = 'missing-key'
    else if (freeModels.length === 0) state = 'no-models'
    else state = 'ready'
    views.push({
      id: provider.id,
      label: provider.label,
      kind: provider.kind,
      basis: provider.basis,
      canBill: provider.canBill,
      requiresOptIn: provider.canBill,
      requiresKey: provider.requiresKey,
      freeNote: provider.freeNote,
      limits: provider.limits,
      caution: provider.caution,
      setupUrl: provider.setupUrl,
      website: provider.website,
      sourceUrl: provider.sourceUrl,
      configured,
      state,
      freeModelCount: freeModels.length,
      examples: freeModels.slice(0, 3).map((model) => model.id),
      cooldownUntil,
    })
  }
  return views
}

export interface FallbackRecord {
  at: number
  from: string
  to: string
  fromProvider: string
  toProvider: string
  reason: string
}

export interface RoutingSnapshot {
  cooldowns: Record<string, number>
  history: FallbackRecord[]
  lastError: string | null
}

export interface RoutingView extends RoutingSnapshot {
  providers: FreeProviderView[]
  activeModel: string
  activeFree: boolean
  activeProvider: string
  autoFallback: boolean
  freeFirst: boolean
  allowBillable: boolean
  allowLocal: boolean
}

export function routingSummary(view: RoutingView): string {
  const configured = view.providers.filter(
    (provider) => provider.basis !== 'paid' && (provider.state === 'ready' || provider.state === 'local'),
  )
  const eligible = configured.filter(
    (provider) =>
      (view.allowBillable || !provider.requiresOptIn) &&
      (provider.kind !== 'local' || view.allowLocal),
  )
  const cooldown = view.providers.filter((provider) => provider.state === 'cooldown').length
  if (configured.length === 0) return 'No free provider is ready. Add a free key in FCC Admin before sending.'
  if (eligible.length === 0) {
    return 'No free provider is eligible automatically. Enable billable free tiers or local fallback, or pick a model explicitly.'
  }
  if (view.activeFree) {
    const optIn = configured.length - eligible.length
    return `${eligible.length} free provider${eligible.length === 1 ? '' : 's'} eligible automatically${optIn > 0 ? `, ${optIn} waiting for opt-in or local fallback` : ''}${cooldown > 0 ? `, ${cooldown} cooling down` : ''}.`
  }
  return 'The selected model is not a free endpoint. Automatic fallback will only choose free providers.'
}
