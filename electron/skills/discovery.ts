/**
 * Discovery across independent sources. Nothing is trusted until it is listed:
 * skills.sh results are names + install counts, GitHub results are repositories
 * that must be inspected, and the curated set is verified against the GitHub API
 * before it is shown.
 */
import { get as httpsGet } from 'node:https'
import type { DiscoveryResult, SkillCandidate } from '../../src/shared/skills'
import { SKILL_CATEGORIES, keywordsForCategories } from './catalog'
import { repoInfo, searchRepos } from './github'

const USER_AGENT = 'FCC-Desktop-Skills'

/** Repositories worth starting from; each one is verified before display. */
export const CURATED_REPOS: Array<{ repo: string; label: string; note: string }> = [
  { repo: 'anthropics/skills', label: 'Anthropic skills', note: 'Reference Agent Skills from Anthropic.' },
  { repo: 'vercel-labs/agent-skills', label: 'Vercel agent skills', note: 'React, Next.js and web platform guidance.' },
  { repo: 'mattpocock/skills', label: 'Matt Pocock skills', note: 'Architecture, specs, grilling and codebase design.' },
  { repo: 'obra/superpowers', label: 'Superpowers', note: 'Multi-step development workflows.' },
  { repo: 'ComposioHQ/awesome-claude-skills', label: 'Awesome Claude Skills', note: 'Community index of skill collections.' },
]

function getJson<T>(url: string): Promise<{ data: T | null; status: number; error: string | null }> {
  return new Promise((resolvePromise) => {
    const request = httpsGet(url, { headers: { 'user-agent': USER_AGENT, accept: 'application/json' } }, (response) => {
      const status = response.statusCode ?? 0
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume()
        resolvePromise(getJson<T>(new URL(response.headers.location, url).toString()))
        return
      }
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        if (status >= 400) {
          resolvePromise({
            data: null,
            status,
            error:
              status === 429
                ? 'Skills registry is rate limiting — try again in a moment.'
                : `Skills registry returned ${status}.`,
          })
          return
        }
        try {
          resolvePromise({ data: JSON.parse(body) as T, status, error: null })
        } catch {
          resolvePromise({ data: null, status, error: 'Skills registry returned an unreadable response.' })
        }
      })
    })
    request.setTimeout(15_000, () => request.destroy(new Error('Discovery request timed out')))
    request.on('error', (error) => resolvePromise({ data: null, status: 0, error: `Network error: ${error.message}` }))
  })
}

interface SkillsShResponse {
  skills?: Array<{ id?: string; source?: string; skillId?: string; name?: string; installs?: number }>
}

export async function searchSkillsSh(query: string, limit = 40): Promise<DiscoveryResult> {
  const trimmed = query.trim()
  if (trimmed.length < 2) {
    return { provider: 'skills.sh', query: trimmed, candidates: [], error: 'Enter at least two characters.', at: Date.now() }
  }
  const response = await getJson<SkillsShResponse>(`https://skills.sh/api/search?q=${encodeURIComponent(trimmed)}`)
  if (!response.data) {
    return { provider: 'skills.sh', query: trimmed, candidates: [], error: response.error, at: Date.now() }
  }
  const candidates: SkillCandidate[] = (response.data.skills ?? [])
    .slice(0, limit)
    .map((entry) => {
      const source = entry.source ?? ''
      const skillId = entry.skillId ?? entry.name ?? ''
      const name = entry.name ?? skillId
      return {
        id: `skills.sh:${entry.id ?? `${source}/${skillId}`}`,
        name,
        repo: /^[\w.-]+\/[\w.-]+$/.test(source) ? source : null,
        path: null,
        description: null,
        installs: typeof entry.installs === 'number' ? entry.installs : null,
        url: `https://skills.sh/${source}/${skillId}`,
        provider: 'skills.sh' as const,
        category: null,
      }
    })
    .filter((candidate) => candidate.name)
  return { provider: 'skills.sh', query: trimmed, candidates, error: null, at: Date.now() }
}

export async function searchGithubSkills(query: string, limit = 24): Promise<DiscoveryResult> {
  const trimmed = query.trim()
  const search = trimmed ? `${trimmed} skill in:name,description,readme` : 'topic:agent-skills'
  const result = await searchRepos(search, limit)
  const candidates: SkillCandidate[] = result.items.map((item) => ({
    id: `github:${item.fullName}`,
    name: item.fullName,
    repo: item.fullName,
    path: null,
    description: [item.description, item.stars ? `${item.stars} stars` : null, item.pushedAt ? `updated ${item.pushedAt.slice(0, 10)}` : null]
      .filter(Boolean)
      .join(' · '),
    installs: null,
    url: item.htmlUrl || `https://github.com/${item.fullName}`,
    provider: 'github' as const,
    category: null,
  }))
  return { provider: 'github', query: trimmed, candidates, error: result.error, at: Date.now() }
}

export async function curatedSkills(): Promise<DiscoveryResult> {
  const results = await Promise.all(
    CURATED_REPOS.map(async (entry): Promise<SkillCandidate | null> => {
      const info = await repoInfo(entry.repo)
      if (!info.info) return null
      return {
        id: `curated:${entry.repo}`,
        name: entry.label,
        repo: entry.repo,
        path: null,
        description: [info.info.description, `${info.info.stars} stars`, entry.note].filter(Boolean).join(' · '),
        installs: null,
        url: info.info.htmlUrl,
        provider: 'curated',
        category: null,
      }
    }),
  )
  const candidates = results.filter((entry): entry is SkillCandidate => entry !== null)
  return {
    provider: 'curated',
    query: 'curated collections',
    candidates,
    error: candidates.length === 0 ? 'None of the curated repositories could be reached.' : null,
    at: Date.now(),
  }
}

export interface DiscoverInput {
  source: 'skills.sh' | 'github' | 'curated'
  query?: string
  category?: string | null
  limit?: number
}

/**
 * A category is a keyword bundle, so discovery stays open: picking "Landing page
 * generation" searches for the words a skill author would have used.
 */
export function queryForCategory(query: string, category: string | null): string {
  if (!category) return query
  const words = keywordsForCategories([category]).slice(0, 4)
  const label = SKILL_CATEGORIES.find((entry) => entry.id === category)?.label ?? ''
  return [query, label, ...words].filter(Boolean).join(' ').trim()
}

export async function discover({ source, query = '', category = null, limit }: DiscoverInput): Promise<DiscoveryResult> {
  const combined = queryForCategory(query, category)
  if (source === 'curated') return curatedSkills()
  if (source === 'github') return searchGithubSkills(combined || 'agent skills', limit)
  return searchSkillsSh(combined, limit)
}
