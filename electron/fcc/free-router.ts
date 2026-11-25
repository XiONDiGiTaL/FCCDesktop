import { join } from 'node:path'
import type { ModelInfo } from '../../src/shared/types'
import type { ProviderFailureAnalysis } from '../../src/shared/usage'
import {
  chooseFreeModel,
  classifyModel,
  freeProviderViews,
  inferTaskProfile,
  type FallbackRecord,
  type FreeProviderView,
  type RouterCandidate,
  type RoutingSnapshot,
} from '../../src/shared/free-providers'
import { getSettings } from '../core/settings'
import { dataRoot } from '../core/paths'
import { readJson, writeJsonAtomic } from '../core/atomic'
import { log } from '../core/logger'
import type { ConnectionManager } from './connection'

const STORE_VERSION = 1
const MAX_HISTORY = 25
const THROTTLE_HOLD_MS = 90_000
const QUOTA_HOLD_MS = 15 * 60_000

interface PersistedRouting {
  version: number
  cooldowns: Record<string, number>
  history: FallbackRecord[]
}

interface RoutingOptions {
  allowBillable: boolean
  allowLocal: boolean
}

/**
 * Chooses free models and remembers why a provider is cooling down.
 *
 * The router never starts a request. It only answers "which free model may be
 * used next" for the agent, which keeps the paid/ free decision auditable in
 * one small place.
 */
export class FreeRouter {
  private cooldowns = new Map<string, number>()
  private history: FallbackRecord[] = []
  private lastError: string | null = null

  constructor(private readonly connection: ConnectionManager) {
    this.load()
  }

  private options(): RoutingOptions {
    const agent = getSettings().agent
    return {
      allowBillable: agent.allowBillableAccounts,
      allowLocal: agent.allowLocalFallback,
    }
  }

  models(): ModelInfo[] {
    return this.connection.cachedModels()
  }

  isFree(model: string): boolean {
    return classifyModel(model).free
  }

  providerOf(model: string): string {
    return classifyModel(model).providerId
  }

  /**
   * Resolve an empty model choice to the best free model. A non-empty choice is
   * returned unchanged, because picking a model by hand is explicit consent to
   * use that endpoint.
   */
  initialModel(requested: string, prompt: string, hasImages: boolean): RouterCandidate | null {
    const value = requested.trim()
    if (value) {
      return {
        id: value,
        displayName: value,
        providerId: classifyModel(value).providerId,
        providerLabel: classifyModel(value).providerLabel,
        free: classifyModel(value),
        capabilities: {
          coding: false,
          reasoning: false,
          tools: true,
          structured: true,
          vision: false,
          confidence: 'inferred',
        },
        score: 0,
      }
    }
    const agent = getSettings().agent
    if (!agent.freeFirst) return null
    return chooseFreeModel(this.models(), {
      task: inferTaskProfile(prompt, hasImages),
      now: Date.now(),
      cooldowns: this.cooldownMap(),
      ...this.options(),
    })
  }

  /**
   * Pick a different free provider after a failure. The current provider is
   * excluded so a retry cannot bounce back to the endpoint that just failed.
   */
  fallbackFor(currentModel: string, prompt: string, hasImages: boolean): RouterCandidate | null {
    const agent = getSettings().agent
    if (!agent.autoFallback) return null
    const current = classifyModel(currentModel)
    if (!current.free) return null
    return chooseFreeModel(this.models(), {
      task: inferTaskProfile(prompt, hasImages),
      now: Date.now(),
      cooldowns: this.cooldownMap(),
      excludeIds: [currentModel],
      excludeProviders: current.providerId ? [current.providerId] : [],
      ...this.options(),
    })
  }

  noteFailure(model: string, analysis: ProviderFailureAnalysis): void {
    if (analysis.kind === 'unknown') return
    const providerId = classifyModel(model).providerId
    if (!providerId) return
    const now = Date.now()
    const until =
      analysis.cooldownUntil ?? analysis.resetAt ?? now + (analysis.quotaExhausted ? QUOTA_HOLD_MS : THROTTLE_HOLD_MS)
    if (until > now) {
      this.cooldowns.set(providerId, until)
      this.persist()
    }
  }

  noteSuccess(model: string): void {
    const providerId = classifyModel(model).providerId
    if (!providerId || !this.cooldowns.has(providerId)) return
    this.cooldowns.delete(providerId)
    this.persist()
  }

  noteFallback(from: string, to: string, reason: string): FallbackRecord {
    const record: FallbackRecord = {
      at: Date.now(),
      from,
      to,
      fromProvider: classifyModel(from).providerId,
      toProvider: classifyModel(to).providerId,
      reason: reason.slice(0, 240),
    }
    this.history.push(record)
    if (this.history.length > MAX_HISTORY) this.history.splice(0, this.history.length - MAX_HISTORY)
    this.lastError = null
    log.info('router', `Fell back from ${from} to ${to}: ${record.reason}`)
    this.persist()
    return record
  }

  /** Record that no free endpoint is currently eligible, for the usage view. */
  noteUnavailable(message: string): void {
    this.lastError = message.slice(0, 400)
    this.persist()
  }

  cooldownMap(): Record<string, number> {
    const now = Date.now()
    const result: Record<string, number> = {}
    for (const [providerId, until] of this.cooldowns) {
      if (until > now) result[providerId] = until
      else this.cooldowns.delete(providerId)
    }
    return result
  }

  snapshot(): RoutingSnapshot {
    return {
      cooldowns: this.cooldownMap(),
      history: [...this.history].slice(-10).reverse(),
      lastError: this.lastError,
    }
  }

  providers(adminStatuses: Array<{ providerId: string; displayName: string; status: string }>): FreeProviderView[] {
    return freeProviderViews(this.models(), adminStatuses, this.cooldownMap())
  }

  private load(): void {
    const raw = readJson<Partial<PersistedRouting>>(join(dataRoot(), 'routing.json'), {})
    const now = Date.now()
    if (raw.cooldowns && typeof raw.cooldowns === 'object') {
      for (const [providerId, until] of Object.entries(raw.cooldowns)) {
        if (typeof until === 'number' && until > now) this.cooldowns.set(providerId, until)
      }
    }
    if (Array.isArray(raw.history)) {
      this.history = raw.history
        .filter(
          (entry): entry is FallbackRecord =>
            Boolean(entry) &&
            typeof entry.at === 'number' &&
            typeof entry.from === 'string' &&
            typeof entry.to === 'string',
        )
        .slice(-MAX_HISTORY)
    }
  }

  private persist(): void {
    try {
      writeJsonAtomic(join(dataRoot(), 'routing.json'), {
        version: STORE_VERSION,
        cooldowns: this.cooldownMap(),
        history: this.history,
      } satisfies PersistedRouting)
    } catch (error) {
      log.warn('router', `Could not save routing state: ${String(error)}`)
    }
  }
}
