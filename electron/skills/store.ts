/**
 * The skills filesystem layer.
 *
 * Claude Code already reads `~/.claude/skills` and `<project>/.claude/skills`.
 * FCC stores nothing outside those trees except a small state file, so a skill
 * installed here is installed for Claude Code too. Disabling never deletes: the
 * folder moves into `.fcc-disabled/`, a hidden directory the CLI does not scan
 * (verified against claude 2.1.330), and enabling moves it back.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type {
  SkillDetail,
  SkillOrigin,
  SkillScope,
  SkillSource,
  SkillSummary,
} from '../../src/shared/skills'
import { isSkillDirectory, parseSkillDirectory, skillIdFor } from './parse'

export const DISABLED_DIR = '.fcc-disabled'

export interface SkillLocation {
  scope: SkillScope
  root: string
  projectPath: string | null
}

export interface SkillStateEntry {
  enabled?: boolean
  autoInvoke?: boolean
  category?: string | null
  installedAt?: number
  source?: SkillSource
  version?: string | null
  origin?: SkillOrigin
  instructionsHash?: string
}

export interface SkillsStateFile {
  version: 1
  revision: number
  entries: Record<string, SkillStateEntry>
}

export const EMPTY_STATE: SkillsStateFile = { version: 1, revision: 0, entries: {} }

export interface SkillRecord {
  id: string
  root: string
  dir: string
  name: string
  enabled: boolean
  scope: SkillScope
  projectPath: string | null
}

export interface ScanResult {
  skills: SkillSummary[]
  records: Map<string, SkillRecord>
}

/**
 * Identity is scope + project + name, not the path: the path changes when a
 * skill is disabled, and state (category, auto-invoke, install date) must survive.
 */
export function skillIdentity(scope: SkillScope, projectPath: string | null, name: string): string {
  return createHash('sha1')
    .update(`${scope}|${(projectPath ?? '').toLowerCase()}|${name.toLowerCase()}`)
    .digest('hex')
    .slice(0, 16)
}

export function instructionsHash(instructions: string): string {
  return createHash('sha256').update(instructions).digest('hex').slice(0, 32)
}

function directoriesIn(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

export function scanSkills(locations: SkillLocation[], state: SkillsStateFile): ScanResult {
  const skills: SkillSummary[] = []
  const records = new Map<string, SkillRecord>()
  const nameCounts = new Map<string, number>()

  for (const location of locations) {
    const variants: Array<{ dir: string; enabled: boolean }> = [
      { dir: location.root, enabled: true },
      { dir: join(location.root, DISABLED_DIR), enabled: false },
    ]
    for (const variant of variants) {
      for (const entry of directoriesIn(variant.dir)) {
        const full = join(variant.dir, entry)
        if (!isSkillDirectory(full)) continue
        const parsed = parseSkillDirectory(full)
        if (!parsed.skill) continue
        const parsedSkill = parsed.skill
        const id = skillIdentity(location.scope, location.projectPath, parsedSkill.name)
        const stored = state.entries[id]
        const repeats = nameCounts.get(parsedSkill.name.toLowerCase()) ?? 0
        nameCounts.set(parsedSkill.name.toLowerCase(), repeats + 1)

        const warnings = [...parsedSkill.warnings]
        if (repeats > 0) {
          warnings.push(`Another installed skill is also named "${parsedSkill.name}" — the model may confuse them.`)
        }
        if (parsedSkill.findings.some((finding) => finding.severity === 'danger')) {
          warnings.push('Treat this skill as untrusted: it contains instructions that look like a safety override.')
        }

        const summary: SkillSummary = {
          id,
          name: parsedSkill.name,
          description: parsedSkill.description,
          scope: location.scope,
          origin: stored?.origin === 'fcc' ? 'fcc' : 'external',
          path: full,
          projectPath: location.projectPath,
          enabled: variant.enabled,
          autoInvoke: stored?.autoInvoke ?? true,
          category: stored?.category ?? null,
          version: stored?.version ?? parsedSkill.version ?? null,
          license: parsedSkill.license || null,
          compatibility: parsedSkill.compatibility || null,
          allowedTools: parsedSkill.allowedTools,
          installedAt: stored?.installedAt ?? null,
          updatedAt: parsedSkill.updatedAt,
          source: stored?.source ?? null,
          fileCount: parsedSkill.files.length,
          bytes: parsedSkill.bytes,
          hasScripts: parsedSkill.hasScripts,
          warnings,
          nativeVisible: variant.enabled,
          invocation: parsedSkill.name,
        }
        skills.push(summary)
        records.set(id, {
          id,
          root: location.root,
          dir: full,
          name: parsedSkill.name,
          enabled: variant.enabled,
          scope: location.scope,
          projectPath: location.projectPath,
        })
      }
    }
  }

  skills.sort((a, b) => {
    if (a.scope !== b.scope) return a.scope === 'project' ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  return { skills, records }
}

export function readDetail(record: SkillRecord, summary: SkillSummary): SkillDetail | null {
  const parsed = parseSkillDirectory(record.dir)
  if (!parsed.skill) return null
  return {
    ...summary,
    instructions: parsed.skill.instructions,
    body: parsed.skill.body,
    frontmatter: parsed.skill.frontmatter,
    metadata: parsed.skill.metadata,
    files: parsed.skill.files,
    findings: parsed.skill.findings,
  }
}

/** Move a skill between the visible tree and the CLI-invisible stash. */
export function setSkillDirectory(record: SkillRecord, enabled: boolean): string {
  const visible = resolve(record.root, record.name)
  const stashed = resolve(record.root, DISABLED_DIR, record.name)
  const from = enabled ? stashed : visible
  const to = enabled ? visible : stashed

  if (existsSync(to)) {
    throw new Error(`Cannot ${enabled ? 'enable' : 'disable'} ${record.name}: ${to} already exists.`)
  }
  if (!existsSync(from)) {
    throw new Error(`${record.name} is no longer at ${from}. Refresh the list.`)
  }
  mkdirSync(enabled ? record.root : join(record.root, DISABLED_DIR), { recursive: true })
  renameSync(from, to)
  return to
}

export function removeSkillDirectory(record: SkillRecord): void {
  rmSync(record.dir, { recursive: true, force: true })
}

export function skillsDirExists(dir: string): boolean {
  try {
    return statSync(dir).isDirectory()
  } catch {
    return false
  }
}

export function uniqueSkillDirName(root: string, preferred: string): string {
  let name = preferred
  let attempt = 1
  while (existsSync(join(root, name)) || existsSync(join(root, DISABLED_DIR, name))) {
    attempt += 1
    name = `${preferred}-${attempt}`
    if (attempt > 50) {
      name = `${preferred}-${skillIdFor(join(root, preferred + String(Date.now())))}`
      break
    }
  }
  return name
}
