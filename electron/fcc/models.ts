import type { ModelCatalog, ModelInfo } from '../../src/shared/types'
import { requestJson } from './http'

interface RawModel {
  id?: unknown
  display_name?: unknown
  owned_by?: unknown
  type?: unknown
}

interface RawList {
  data?: unknown
}

function providerOf(id: string): string {
  const parts = id.split('/')
  if (parts.length > 1) {
    const first = parts[0] ?? ''
    if (first === 'anthropic' || first.startsWith('claude-')) return parts[1] ?? 'anthropic'
    return first
  }
  return 'claude'
}

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  claude: 'Claude',
  nvidia_nim: 'NVIDIA NIM',
  openai: 'OpenAI',
  // FCC prefixes OpenRouter ids with `open_router/`, so both spellings matter.
  open_router: 'OpenRouter',
  openrouter: 'OpenRouter',
  groq: 'Groq',
  deepseek: 'DeepSeek',
  gemini: 'Gemini',
  mistral: 'Mistral',
}

export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider.replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export function normalizeModels(input: unknown): ModelInfo[] {
  const list = (input as RawList | null)?.data
  if (!Array.isArray(list)) return []
  const models: ModelInfo[] = []
  const seen = new Set<string>()
  for (const raw of list as RawModel[]) {
    if (!raw || typeof raw.id !== 'string' || !raw.id) continue
    if (seen.has(raw.id)) continue
    seen.add(raw.id)
    const displayName =
      typeof raw.display_name === 'string' && raw.display_name.trim() ? raw.display_name.trim() : raw.id
    const provider = providerOf(raw.id)
    models.push({
      id: raw.id,
      displayName,
      provider,
      group: providerLabel(provider),
      noThinking: raw.id.includes('no-thinking') || /\(no thinking\)/i.test(displayName),
    })
  }
  return models.sort((a, b) => a.group.localeCompare(b.group) || a.displayName.localeCompare(b.displayName))
}

export async function fetchModels(baseUrl: string, token: string): Promise<ModelCatalog> {
  const response = await requestJson<RawList>(`${baseUrl.replace(/\/+$/, '')}/v1/models`, {
    headers: token ? { 'x-api-key': token, authorization: `Bearer ${token}` } : {},
    timeoutMs: 8000,
  })
  if (!response.ok) {
    return {
      models: [],
      fetchedAt: Date.now(),
      error: response.error ?? `Model catalog request failed (HTTP ${response.status})`,
    }
  }
  const models = normalizeModels(response.data)
  return {
    models,
    fetchedAt: Date.now(),
    error: models.length === 0 ? 'The FCC endpoint returned an empty model catalog.' : null,
  }
}
