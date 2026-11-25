/**
 * Collapse duplicate catalog entries that represent one logical model.
 *
 * FCC exposes a standard gateway alias and a `claude-3-freecc-no-thinking`
 * alias for many of the same models. The library shows one row per logical
 * model and lets the user pick the no-thinking variant explicitly.
 */

import type { ModelInfo } from './types'

export interface ModelVariantGroup {
  key: string
  baseName: string
  standard: ModelInfo | null
  noThinking: ModelInfo | null
  primary: ModelInfo
  /** Every catalog entry folded into this row, used for search. */
  models: ModelInfo[]
}

export function baseModelName(model: Pick<ModelInfo, 'displayName' | 'id'>): string {
  const name = (model.displayName || model.id).replace(/\s*\(no thinking\)\s*$/i, '').trim()
  return name || model.id
}

export function groupModelVariants(models: ModelInfo[]): ModelVariantGroup[] {
  const groups = new Map<string, ModelVariantGroup>()

  for (const model of models) {
    const baseName = baseModelName(model)
    const key = `${model.group}::${baseName.toLowerCase()}`
    let group = groups.get(key)
    if (!group) {
      group = {
        key,
        baseName,
        standard: null,
        noThinking: null,
        primary: model,
        models: [],
      }
      groups.set(key, group)
    }
    group.models.push(model)

    if (model.noThinking) {
      if (!group.noThinking) group.noThinking = model
    } else if (!group.standard) {
      group.standard = model
    }
    group.primary = group.standard ?? group.noThinking ?? model
  }

  return Array.from(groups.values()).sort(
    (a, b) =>
      a.primary.group.localeCompare(b.primary.group) || a.baseName.localeCompare(b.baseName),
  )
}
