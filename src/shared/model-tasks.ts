/**
 * Task categories for the model library.
 *
 * FCC does not publish task metadata, so these buckets are inferred from the
 * model id and display name. They are meant for navigation, not routing: the
 * free router still decides which model may be used automatically.
 */

import { inferCapabilities } from './free-providers'

export type ModelTaskId = 'coding' | 'general' | 'reasoning' | 'vision' | 'image' | 'other'

export interface ModelTaskMeta {
  id: ModelTaskId
  label: string
  description: string
}

export const MODEL_TASKS: ModelTaskMeta[] = [
  {
    id: 'coding',
    label: 'Coding & agents',
    description: 'Repository work, tool calls, debugging and implementation.',
  },
  {
    id: 'general',
    label: 'General chat',
    description: 'Writing, questions and everyday assistant work.',
  },
  {
    id: 'reasoning',
    label: 'Reasoning',
    description: 'Analysis, planning and multi-step problems.',
  },
  {
    id: 'vision',
    label: 'Vision',
    description: 'Models that can read screenshots and images as input.',
  },
  {
    id: 'image',
    label: 'Image generation',
    description: 'Endpoints that create or edit images. Agent conversations still expect a text model.',
  },
  {
    id: 'other',
    label: 'Audio & specialty',
    description: 'Speech, video, embeddings, reranking and classifiers.',
  },
]

const TASK_BY_ID = new Map(MODEL_TASKS.map((task) => [task.id, task]))

const IMAGE = /\b(image|imagen|nano-?banana|diffusion|flux|sdxl|dall-?e|stable-diffusion|midjourney|seedream)\b/i
const AUDIO = /\b(tts|whisper|audio|speech|voice|music|veo|video|sora|suno|elevenlabs)\b|text-to-speech/i
const SPECIALTY =
  /\b(embed|embedding|rerank|gliner|classif|classifier|guard|moderation|calibration|safety|pii)\b/i
const VISION = /\bvision\b|multimodal|(^|[/_.-])vl([/_.-]|$)|pixtral|llava|\bomni\b/i
const CODING_BRAND = /\b(claude|sonnet|opus|haiku|gpt-4|gpt-5)\b/i

export function modelTaskMeta(id: ModelTaskId): ModelTaskMeta {
  return TASK_BY_ID.get(id) ?? { id: 'other', label: 'Other endpoints', description: 'Other endpoints.' }
}

export function classifyModelTask(model: { id: string; displayName?: string }): ModelTaskId {
  const text = `${model.id} ${model.displayName ?? ''}`.toLowerCase()
  if (IMAGE.test(text)) return 'image'
  if (AUDIO.test(text) || SPECIALTY.test(text)) return 'other'

  const capabilities = inferCapabilities(model.id, model.displayName)
  if (capabilities.reasoning) return 'reasoning'
  if (capabilities.coding || CODING_BRAND.test(text)) return 'coding'
  if (VISION.test(text)) return 'vision'
  return 'general'
}

/**
 * Tasks a model can be listed under. A reasoning model that also codes belongs
 * in both pages; the primary category above is used for company grouping so a
 * model is never repeated on a company page.
 */
export function modelTaskIds(model: { id: string; displayName?: string }): ModelTaskId[] {
  const text = `${model.id} ${model.displayName ?? ''}`.toLowerCase()
  const capabilities = inferCapabilities(model.id, model.displayName)
  const ids = new Set<ModelTaskId>([classifyModelTask(model)])
  if (capabilities.coding || CODING_BRAND.test(text)) ids.add('coding')
  if (capabilities.reasoning) ids.add('reasoning')
  if (VISION.test(text)) ids.add('vision')
  return MODEL_TASKS.map((task) => task.id).filter((id) => ids.has(id))
}

export function modelMatchesTask(
  model: { id: string; displayName?: string },
  task: ModelTaskId,
): boolean {
  return modelTaskIds(model).includes(task)
}
