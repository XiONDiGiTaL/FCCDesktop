/**
 * GitHub as a skill source, without the `npx skills` dependency.
 *
 * A repository is downloaded once as a tarball, extracted into an FCC temp
 * directory with traversal protection, and then *parsed* — the listing shown to
 * the user comes from real SKILL.md files, never from a repository name.
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, cpSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { get as httpsGet } from 'node:https'
import { join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import type { SkillRepoEntry, SkillRepoListing } from '../../src/shared/skills'
import { isSkillDirectory, parseSkillDirectory } from './parse'
import { extractTarGz } from './tar'
import { log } from '../core/logger'

const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024
const CACHE_TTL_MS = 5 * 60 * 1000
const USER_AGENT = 'FCC-Desktop-Skills'
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'vendor'])

export interface RepoRef {
  repo: string
  ref: string | null
  path: string | null
}

let cachedToken: { value: string | null; at: number } | null = null

/** Token from the environment, or from the GitHub CLI when it is signed in. */
export function githubToken(): Promise<string | null> {
  if (cachedToken && Date.now() - cachedToken.at < 60_000) return Promise.resolve(cachedToken.value)
  const fromEnv = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ''
  if (fromEnv.trim()) {
    cachedToken = { value: fromEnv.trim(), at: Date.now() }
    return Promise.resolve(cachedToken.value)
  }
  return new Promise((resolvePromise) => {
    execFile('gh', ['auth', 'token'], { timeout: 4000, windowsHide: true }, (error, stdout) => {
      const value = error ? null : stdout.trim() || null
      cachedToken = { value, at: Date.now() }
      resolvePromise(value)
    })
  })
}

export function parseRepoRef(input: string): RepoRef | null {
  const raw = input.trim()
  if (!raw) return null
  const cleaned = raw.replace(/^git@github\.com:/i, '').replace(/\.git$/i, '').replace(/\/+$/, '')
  const url = /^(https?:\/\/)?(www\.)?github\.com\//i.test(cleaned)
    ? cleaned.replace(/^(https?:\/\/)?(www\.)?github\.com\//i, '').replace(/\.git$/i, '')
    : cleaned
  const parts = url.split('/').filter(Boolean)
  if (parts.length < 2) return null
  const repo = `${parts[0]}/${parts[1]}`
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return null
  let ref: string | null = null
  let path: string | null = null
  if (parts.length >= 4 && (parts[2] === 'tree' || parts[2] === 'blob')) {
    ref = parts[3] as string
    path = parts.slice(4).join('/') || null
    // A ref may itself contain slashes; the API resolves the full string when it
    // does not match a branch, so keep the whole remainder as the ref.
    if (path) ref = parts.slice(3, parts.length - 1).join('/')
  }
  return { repo, ref, path }
}

interface RawRequest {
  status: number
  headers: Record<string, string | string[] | undefined>
  buffer: Buffer
}

function httpGet(url: string, headers: Record<string, string>, redirects = 0): Promise<RawRequest> {
  return new Promise((resolvePromise, reject) => {
    const request = httpsGet(
      url,
      { headers: { 'user-agent': USER_AGENT, accept: 'application/vnd.github+json', ...headers } },
      (response) => {
        const status = response.statusCode ?? 0
        if (status >= 300 && status < 400 && response.headers.location && redirects < 4) {
          response.resume()
          const next = new URL(response.headers.location, url).toString()
          resolvePromise(httpGet(next, headers, redirects + 1))
          return
        }
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > MAX_DOWNLOAD_BYTES) {
            request.destroy(new Error('Download exceeded 64 MB'))
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => {
          resolvePromise({ status, headers: response.headers, buffer: Buffer.concat(chunks) })
        })
      },
    )
    request.setTimeout(30_000, () => request.destroy(new Error('GitHub request timed out')))
    request.on('error', reject)
  })
}

async function apiJson<T>(path: string): Promise<{ data: T | null; status: number; error: string | null }> {
  const token = await githubToken()
  try {
    const response = await httpGet(`https://api.github.com${path}`, token ? { authorization: `Bearer ${token}` } : {})
    const body = response.buffer.toString('utf8')
    if (response.status >= 400) {
      const message =
        response.status === 404
          ? 'Repository not found — check the owner/name, or sign in with `gh auth login` for a private repository.'
          : response.status === 403
            ? 'GitHub rate limit reached. Add a GITHUB_TOKEN or run `gh auth login` for a higher limit.'
            : `GitHub returned ${response.status}.`
      return { data: null, status: response.status, error: message }
    }
    return { data: body ? (JSON.parse(body) as T) : null, status: response.status, error: null }
  } catch (error) {
    return { data: null, status: 0, error: `Could not reach GitHub: ${String(error)}` }
  }
}

export interface RepoInfo {
  fullName: string
  defaultBranch: string
  stars: number
  pushedAt: string | null
  description: string | null
  private: boolean
  htmlUrl: string
}

export async function repoInfo(repo: string): Promise<{ info: RepoInfo | null; error: string | null }> {
  const result = await apiJson<{
    full_name: string
    default_branch: string
    stargazers_count: number
    pushed_at: string
    description: string | null
    private: boolean
    html_url: string
  }>(`/repos/${repo}`)
  if (!result.data) return { info: null, error: result.error }
  return {
    info: {
      fullName: result.data.full_name,
      defaultBranch: result.data.default_branch,
      stars: result.data.stargazers_count ?? 0,
      pushedAt: result.data.pushed_at ?? null,
      description: result.data.description ?? null,
      private: Boolean(result.data.private),
      htmlUrl: result.data.html_url,
    },
    error: null,
  }
}

export async function searchRepos(query: string, limit = 20): Promise<{ items: RepoInfo[]; error: string | null }> {
  const result = await apiJson<{ items: Array<Record<string, unknown>> }>(
    `/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=${Math.min(50, limit)}`,
  )
  if (!result.data) return { items: [], error: result.error }
  const items = (result.data.items ?? []).map((item) => ({
    fullName: String(item.full_name ?? ''),
    defaultBranch: String(item.default_branch ?? 'main'),
    stars: Number(item.stargazers_count ?? 0),
    pushedAt: item.pushed_at ? String(item.pushed_at) : null,
    description: item.description ? String(item.description) : null,
    private: Boolean(item.private),
    htmlUrl: String(item.html_url ?? ''),
  }))
  return { items: items.filter((item) => item.fullName), error: null }
}

interface Extraction {
  root: string
  key: string
  at: number
}

let extraction: Extraction | null = null

/** Force the next prepareRepo() to download again (used by skill updates). */
export function resetRepoCache(): void {
  if (extraction) rmSync(extraction.root, { recursive: true, force: true })
  extraction = null
}

/** Download + extract once, then reuse for listing and installation. */
export async function prepareRepo(repo: string, ref: string | null): Promise<{ root: string; error: string | null; ref: string }> {
  const token = await githubToken()
  let resolvedRef = ref
  if (!resolvedRef) {
    const info = await repoInfo(repo)
    if (!info.info) return { root: '', error: info.error, ref: '' }
    resolvedRef = info.info.defaultBranch
  }
  const key = `${repo}@${resolvedRef}`
  if (extraction && extraction.key === key && Date.now() - extraction.at < CACHE_TTL_MS && existsSync(extraction.root)) {
    return { root: extraction.root, error: null, ref: resolvedRef }
  }

  const response = await httpGet(
    `https://api.github.com/repos/${repo}/tarball/${encodeURIComponent(resolvedRef)}`,
    token ? { authorization: `Bearer ${token}` } : {},
  )
  if (response.status >= 400) {
    return {
      root: '',
      error:
        response.status === 404
          ? `No repository or ref "${resolvedRef}" at ${repo}. Private repositories need an authenticated GitHub CLI or GITHUB_TOKEN.`
          : `GitHub returned ${response.status} for ${repo}.`,
      ref: resolvedRef,
    }
  }

  const dir = join(tmpdir(), `fcc-skill-${createHash('sha1').update(key).digest('hex').slice(0, 12)}`)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const extracted = extractTarGz(response.buffer, dir, 1)
  if (extracted.error) return { root: '', error: extracted.error, ref: resolvedRef }
  extraction = { root: dir, key, at: Date.now() }
  log.info('skills', `Extracted ${repo}@${resolvedRef} to ${dir} (${extracted.written.length} files)`)
  return { root: dir, error: null, ref: resolvedRef }
}

/** Directories inside the extracted repo that contain a SKILL.md. */
export function findSkillDirs(root: string): string[] {
  const found: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 4 || found.length >= 200) return
    if (isSkillDirectory(dir)) {
      found.push(dir)
      return
    }
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue
      const full = join(dir, entry)
      try {
        if (!statSync(full).isDirectory()) continue
      } catch {
        continue
      }
      walk(full, depth + 1)
    }
  }
  walk(root, 0)
  return found
}

export async function listRepoSkills(input: string): Promise<SkillRepoListing> {
  const parsed = parseRepoRef(input)
  if (!parsed) {
    return { repo: '', ref: '', url: '', entries: [], error: 'Enter a GitHub repository as owner/name or a github.com URL.' }
  }
  const prepared = await prepareRepo(parsed.repo, parsed.ref)
  if (prepared.error) {
    return { repo: parsed.repo, ref: prepared.ref, url: `https://github.com/${parsed.repo}`, entries: [], error: prepared.error }
  }

  const entries: SkillRepoEntry[] = []
  for (const dir of findSkillDirs(prepared.root)) {
    const rel = relative(prepared.root, dir).split(sep).join('/')
    if (parsed.path && !(rel === parsed.path || rel.endsWith(`/${parsed.path}`) || parsed.path.includes(rel))) continue
    const parsedSkill = parseSkillDirectory(dir)
    if (!parsedSkill.skill) {
      entries.push({
        name: rel.split('/').pop() ?? rel,
        path: rel,
        description: null,
        valid: false,
        issues: parsedSkill.issues,
        hasScripts: false,
        fileCount: 0,
      })
      continue
    }
    entries.push({
      name: parsedSkill.skill.name,
      path: rel,
      description: parsedSkill.skill.description,
      valid: true,
      issues: parsedSkill.issues,
      hasScripts: parsedSkill.skill.hasScripts,
      fileCount: parsedSkill.skill.files.length,
    })
  }

  return {
    repo: parsed.repo,
    ref: prepared.ref,
    url: `https://github.com/${parsed.repo}${parsed.path ? `/tree/${prepared.ref}/${parsed.path}` : ''}`,
    entries: entries.sort((a, b) => a.path.localeCompare(b.path)),
    error: entries.length === 0 ? 'No SKILL.md was found in that repository at the selected path.' : null,
  }
}

/** Copy one extracted skill directory into a destination skills directory. */
export function copySkillDir(source: string, destinationRoot: string, name: string): string {
  const target = resolve(destinationRoot, name)
  const root = resolve(destinationRoot)
  if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error('Refusing to write outside the skills directory.')
  cpSync(source, target, {
    recursive: true,
    dereference: false,
    filter: (entry) => {
      const base = entry.split(/[\\/]/).pop() ?? ''
      return base !== '.git' && base !== 'node_modules'
    },
  })
  return target
}
