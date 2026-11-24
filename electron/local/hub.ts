/**
 * Hugging Face index for GGUF chat models.
 *
 * Nothing is hardcoded: "recommended" is a set of family searches sorted by
 * downloads, and every size comes from the repository itself, so the library
 * reflects what people actually publish rather than a list baked in at release.
 */
import type { LocalModel, ModelFile } from '../../src/shared/local'
import { log } from '../core/logger'

const HUB = 'https://huggingface.co'
const TIMEOUT = 15000
const USER_AGENT = 'FCC-Desktop/1.0 (+https://github.com/XiONDiGiTaL/FCCDesktop)'

export interface Family {
  id: string
  label: string
  query: string
  blurb: string
  /** Repository names must contain this to belong to the family. */
  mustMatch?: RegExp
}

export const FAMILIES: Family[] = [
  { id: 'qwen-coder', label: 'Qwen Coder', query: 'Qwen3-Coder GGUF', blurb: 'Agentic coding, tool use', mustMatch: /coder/i },
  { id: 'qwen', label: 'Qwen', query: 'Qwen3 GGUF', blurb: 'General purpose, strong reasoning', mustMatch: /qwen3/i },
  { id: 'gpt-oss', label: 'gpt-oss', query: 'gpt-oss GGUF', blurb: 'Open-weight MoE with native tool calls', mustMatch: /gpt-oss/i },
  { id: 'deepseek', label: 'DeepSeek R1', query: 'DeepSeek-R1-Distill GGUF', blurb: 'Reasoning distillations', mustMatch: /deepseek-r1/i },
  { id: 'llama', label: 'Llama', query: 'Llama-3.3-Instruct GGUF', blurb: 'Meta instruct models', mustMatch: /llama-3/i },
  { id: 'gemma', label: 'Gemma', query: 'gemma-3 GGUF', blurb: 'Google open models', mustMatch: /gemma-3/i },
  { id: 'mistral', label: 'Mistral', query: 'Mistral-Small GGUF', blurb: 'Efficient European models', mustMatch: /mistral/i },
  { id: 'glm', label: 'GLM', query: 'GLM-4 GGUF', blurb: 'Strong bilingual models', mustMatch: /glm/i },
  { id: 'phi', label: 'Phi', query: 'Phi-4 GGUF', blurb: 'Small and quick', mustMatch: /phi-4/i },
  { id: 'devstral', label: 'Devstral', query: 'Devstral GGUF', blurb: 'Coding agents', mustMatch: /devstral/i },
]

/** Publishers whose GGUF conversions are consistently well-formed. */
const TRUSTED = [
  'ggml-org',
  'unsloth',
  'bartowski',
  'qwen',
  'meta-llama',
  'google',
  'mistralai',
  'openai',
  'zai-org',
  'nvidia',
  'microsoft',
  'lmstudio-community',
  'thebloke',
  'mradermacher',
]

/** Community merges and roleplay re-uploads that crowd the download ranking. */
const NOISE_RE = /uncensored|uncen\b|heretic|abliterated|nsfw|erotic|roleplay|lewd|cyber|jailbreak/i

/** Preference order when a repository ships many quants. */
const QUANT_ORDER = ['Q4_K_M', 'IQ4_XS', 'MXFP4', 'Q4_K_S', 'Q5_K_M', 'Q3_K_M', 'Q6_K', 'Q8_0', 'Q2_K']

const QUANT_RE =
  /(?:^|[-_.])((?:IQ\d(?:_[A-Z0-9]+)?)|(?:Q\d(?:_K)?(?:_[SML])?)|(?:Q\d_\d)|MXFP4|BF16|F16|F32)\.gguf$/i
/** Speculative-decoding draft heads and shards, not standalone chat models. */
const NOT_A_MODEL_RE = /mmproj|vocab|tokenizer|eagle|draft|mtp|-of-\d{5}\.|^mmproj/i

interface RawSibling {
  rfilename?: unknown
  size?: unknown
  lfs?: { size?: unknown }
}

interface RawModel {
  id?: unknown
  modelId?: unknown
  downloads?: unknown
  likes?: unknown
  lastModified?: unknown
  gated?: unknown
  tags?: unknown
  cardData?: { license?: unknown } | null
  siblings?: unknown
}

function asNumber(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT)
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/json' },
      signal: controller.signal,
      redirect: 'follow',
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    return (await response.json()) as unknown
  } finally {
    clearTimeout(timer)
  }
}

/** `Qwen3-Coder-30B-A3B-Instruct-GGUF` → `Qwen3 Coder 30B A3B Instruct`. */
export function displayNameOf(repo: string): string {
  const name = repo.split('/')[1] ?? repo
  return name
    .replace(/-GGUF$/i, '')
    .replace(/[-_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function paramsOf(name: string): string | null {
  const moe = name.match(/(\d+(?:\.\d+)?)B[-_]A(\d+(?:\.\d+)?)B/i)
  if (moe) return `${moe[1]}B · ${moe[2]}B active`
  const match = name.match(/(?:^|[^A-Za-z0-9.])(\d+(?:\.\d+)?)B(?![A-Za-z0-9])/i)
  return match ? `${match[1]}B` : null
}

export function quantOf(filename: string): string | null {
  if (NOT_A_MODEL_RE.test(filename) || /\.part$/i.test(filename)) return null
  const match = filename.match(QUANT_RE)
  return match?.[1] ? match[1].toUpperCase() : null
}

export function fileUrl(repo: string, filename: string): string {
  return `${HUB}/${repo}/resolve/main/${filename}?download=true`
}

function filesOf(raw: RawModel): ModelFile[] {
  if (!Array.isArray(raw.siblings)) return []
  const files: ModelFile[] = []
  const seen = new Set<string>()
  for (const entry of raw.siblings as RawSibling[]) {
    const filename = typeof entry?.rfilename === 'string' ? entry.rfilename : ''
    if (!filename.toLowerCase().endsWith('.gguf')) continue
    if (filename.includes('/')) continue
    const quant = quantOf(filename)
    if (!quant || seen.has(filename)) continue
    const size = asNumber(entry?.size ?? entry?.lfs?.size)
    if (size < 20 * 1024 * 1024) continue
    seen.add(filename)
    files.push({ filename, quant, sizeBytes: size })
  }
  const rank = (quant: string): number => {
    const index = QUANT_ORDER.indexOf(quant)
    return index < 0 ? QUANT_ORDER.length : index
  }
  return files.sort((a, b) => rank(a.quant) - rank(b.quant) || a.sizeBytes - b.sizeBytes)
}

function toModel(repo: string, raw: RawModel, family: Family): LocalModel | null {
  const files = filesOf(raw)
  if (files.length === 0) return null
  const name = displayNameOf(repo)
  return {
    id: repo,
    repo,
    name,
    family: family.id,
    familyLabel: family.label,
    params: paramsOf(name),
    downloads: asNumber(raw.downloads),
    likes: asNumber(raw.likes),
    updatedAt: typeof raw.lastModified === 'string' ? Date.parse(raw.lastModified) || null : null,
    gated: raw.gated === true || raw.gated === 'auto' || raw.gated === 'manual',
    license:
      typeof raw.cardData?.license === 'string'
        ? raw.cardData.license
        : Array.isArray(raw.tags)
          ? (raw.tags as unknown[]).find((tag): tag is string => typeof tag === 'string' && tag.startsWith('license:'))?.slice(8) ?? null
          : null,
    files: files.slice(0, 6),
    url: `${HUB}/${repo}`,
    description: null,
  }
}

interface Hit {
  id: string
  downloads: number
  trusted: number
}

async function search(query: string, limit: number): Promise<Hit[]> {
  const url = `${HUB}/api/models?search=${encodeURIComponent(query)}&filter=gguf&sort=downloads&direction=-1&limit=${limit}`
  const raw = await fetchJson(url)
  if (!Array.isArray(raw)) return []
  const hits: Hit[] = []
  for (const entry of raw as RawModel[]) {
    const id = typeof entry.id === 'string' ? entry.id : typeof entry.modelId === 'string' ? entry.modelId : ''
    if (!id || !id.includes('/')) continue
    if (/mmproj|embed|rerank|vl-|vision|eagle|draft/i.test(id)) continue
    // `GLM-4.6V-GGUF` and friends are vision checkpoints, not chat models.
    if (/V-GGUF$/.test(id)) continue
    if (NOISE_RE.test(id)) continue
    const owner = id.split('/')[0]?.toLowerCase() ?? ''
    const rank = TRUSTED.indexOf(owner)
    hits.push({ id, downloads: asNumber(entry.downloads), trusted: rank < 0 ? TRUSTED.length : rank })
  }
  // Curated publishers first, then whatever is actually popular.
  return hits.sort((a, b) => a.trusted - b.trusted || b.downloads - a.downloads)
}

async function modelInfo(repo: string): Promise<RawModel | null> {
  try {
    const raw = await fetchJson(`${HUB}/api/models/${repo}?blobs=true`)
    return raw && typeof raw === 'object' ? (raw as RawModel) : null
  } catch (error) {
    log.warn('local-hub', `Could not read ${repo}: ${String(error)}`)
    return null
  }
}

/** Best GGUF repository for a family: first hit that is really that family and ships quants. */
async function familyModel(family: Family): Promise<LocalModel | null> {
  let hits: Hit[] = []
  try {
    hits = await search(family.query, 20)
  } catch (error) {
    log.warn('local-hub', `Search failed for ${family.label}: ${String(error)}`)
    return null
  }
  const matching = hits.filter((hit) => !family.mustMatch || family.mustMatch.test(hit.id))
  for (const hit of matching.slice(0, 4)) {
    const info = await modelInfo(hit.id)
    if (!info) continue
    const model = toModel(hit.id, info, family)
    if (model) return model
  }
  return null
}

export async function featuredModels(): Promise<LocalModel[]> {
  const models: LocalModel[] = []
  // Four at a time: enough to feel quick without tripping the Hub's rate limits.
  for (let index = 0; index < FAMILIES.length; index += 4) {
    const batch = FAMILIES.slice(index, index + 4)
    const results = await Promise.all(batch.map((family) => familyModel(family)))
    for (const model of results) if (model) models.push(model)
  }
  return models
}

export async function searchModels(query: string, limit = 12): Promise<LocalModel[]> {
  const family: Family = { id: 'search', label: 'Search', query, blurb: '' }
  const hits = await search(query, Math.max(limit, 20))
  const models: LocalModel[] = []
  for (const hit of hits) {
    const info = await modelInfo(hit.id)
    if (!info) continue
    const model = toModel(hit.id, info, family)
    if (model) models.push(model)
    if (models.length >= limit) break
  }
  return models
}
