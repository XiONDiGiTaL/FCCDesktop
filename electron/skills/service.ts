import { cpSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import type {
  DiscoveryResult,
  InstalledSkillResult,
  SkillCatalog,
  SkillDetail,
  SkillImportInput,
  SkillInvocation,
  SkillsConfig,
  SkillsState,
  SkillSummary,
  SkillUpdateResult,
} from '../../src/shared/skills'
import { dataRoot } from '../core/paths'
import { readJson, writeJsonAtomic } from '../core/atomic'
import { getSettings, updateSettings } from '../core/settings'
import { log } from '../core/logger'
import { parseSkillDirectory } from './parse'
import {
  DISABLED_DIR,
  EMPTY_STATE,
  instructionsHash,
  readDetail,
  removeSkillDirectory,
  scanSkills,
  setSkillDirectory,
  skillIdentity,
  uniqueSkillDirName,
  type SkillLocation,
  type SkillRecord,
  type SkillStateEntry,
  type SkillsStateFile,
} from './store'
import { copySkillDir, findSkillDirs, listRepoSkills, parseRepoRef, prepareRepo, resetRepoCache } from './github'
import { discover, type DiscoverInput } from './discovery'
import { composePrompt, selectSkills, type ComposedPrompt } from './select'
import { extractZip } from './zip'
import { SKILL_CATEGORIES } from './catalog'

/** `FCC_CLAUDE_SKILLS_DIR` exists so tests (and relocated setups) never touch a real profile. */
export const globalSkillsDir = (): string =>
  process.env.FCC_CLAUDE_SKILLS_DIR?.trim() || join(homedir(), '.claude', 'skills')
export const projectSkillsDir = (project: string): string => join(project, '.claude', 'skills')
const statePath = (): string => join(dataRoot(), 'skills.json')

function skillConfig(): SkillsConfig {
  return getSettings().skills
}

function assertInside(root: string, target: string): void {
  const base = resolve(root)
  const full = resolve(target)
  if (full !== base && !full.startsWith(`${base}${sep}`)) throw new Error('Refusing to write outside the skills directory.')
}

export class SkillsService {
  private state: SkillsStateFile | null = null
  private records = new Map<string, SkillRecord>()
  private summaries: SkillSummary[] = []
  private scannedProject: string | null | undefined
  private scannedAt = 0
  private listeners = new Set<() => void>()
  private timer: NodeJS.Timeout | null = null

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch (error) {
        log.warn('skills', `Change listener failed: ${String(error)}`)
      }
    }
  }

  private loadState(): SkillsStateFile {
    if (this.state) return this.state
    const stored = readJson<SkillsStateFile | null>(statePath(), null)
    this.state =
      stored && typeof stored === 'object' && stored.entries && typeof stored.entries === 'object'
        ? {
            version: 1,
            revision: Number(stored.revision) || 0,
            entries: stored.entries,
            checks: stored.checks && typeof stored.checks === 'object' ? stored.checks : {},
          }
        : structuredClone(EMPTY_STATE)
    return this.state
  }

  private persist(): void {
    if (!this.state) return
    try {
      writeJsonAtomic(statePath(), this.state)
    } catch (error) {
      log.error('skills', `Could not save skills state: ${String(error)}`)
    }
  }

  private bump(): void {
    const state = this.loadState()
    state.revision += 1
    this.persist()
    this.notify()
  }

  revision(): number {
    return this.loadState().revision
  }

  private entryFor(id: string): SkillStateEntry {
    const state = this.loadState()
    const existing = state.entries[id]
    if (existing) return existing
    const created: SkillStateEntry = {}
    state.entries[id] = created
    return created
  }

  locations(projectPath: string | null): SkillLocation[] {
    const list: SkillLocation[] = [{ scope: 'global', root: globalSkillsDir(), projectPath: null }]
    if (projectPath && projectPath.trim()) {
      list.push({ scope: 'project', root: projectSkillsDir(projectPath.trim()), projectPath: projectPath.trim() })
    }
    return list
  }

  private scan(projectPath: string | null, refresh = false): void {
    if (!refresh && this.scannedProject === projectPath && Date.now() - this.scannedAt < 4000) return
    const result = scanSkills(this.locations(projectPath), this.loadState())
    this.summaries = result.skills
    this.records = result.records
    this.scannedProject = projectPath
    this.scannedAt = Date.now()
  }

  private refresh(): void {
    this.scannedAt = 0
  }

  catalog(projectPath: string | null, refresh = false): SkillCatalog {
    this.scan(projectPath, refresh)
    return {
      skills: this.summaries,
      directories: { global: globalSkillsDir(), project: projectPath ? projectSkillsDir(projectPath) : null },
      settings: skillConfig(),
      scannedAt: this.scannedAt,
      revision: this.revision(),
    }
  }

  detail(id: string, projectPath: string | null): SkillDetail | null {
    this.scan(projectPath, true)
    const summary = this.summaries.find((skill) => skill.id === id)
    const record = this.records.get(id)
    if (!summary || !record) return null
    return readDetail(record, summary)
  }

  categories() {
    return SKILL_CATEGORIES
  }

  private stateFor(projectPath: string | null): SkillsState {
    this.scan(projectPath)
    return { skills: this.summaries, settings: skillConfig(), revision: this.revision() }
  }

  /**
   * Disabling a skill FCC did not install moves a folder inside the user's own
   * Claude Code directory, so it needs an explicit opt-in or a confirmed action.
   */
  setEnabled(id: string, enabled: boolean, projectPath: string | null, confirmExternal = false): SkillsState {
    this.scan(projectPath, true)
    const record = this.records.get(id)
    const summary = this.summaries.find((skill) => skill.id === id)
    if (!record || !summary) throw new Error('That skill is no longer installed. Refresh the list.')
    if (record.enabled === enabled) return this.stateFor(projectPath)

    const config = skillConfig()
    if (summary.origin === 'external' && !config.manageExternal && !confirmExternal) {
      throw new Error(
        'This skill belongs to your Claude Code installation. Enable "Manage external skills" in Settings, or confirm the toggle, to move it in and out of the disabled stash.',
      )
    }

    const to = setSkillDirectory(record, enabled)
    const entry = this.entryFor(id)
    entry.enabled = enabled
    if (!entry.origin) entry.origin = summary.origin
    this.persist()
    log.info('skills', `${enabled ? 'Enabled' : 'Disabled'} ${summary.name} (${to})`)
    this.bump()
    this.refresh()
    return this.stateFor(projectPath)
  }

  setAutoInvoke(id: string, auto: boolean, projectPath: string | null): SkillsState {
    this.scan(projectPath, true)
    if (!this.records.has(id)) throw new Error('That skill is no longer installed.')
    this.entryFor(id).autoInvoke = auto
    this.persist()
    this.bump()
    this.refresh()
    return this.stateFor(projectPath)
  }

  setCategory(id: string, category: string | null, projectPath: string | null): SkillsState {
    this.scan(projectPath, true)
    if (!this.records.has(id)) throw new Error('That skill is no longer installed.')
    this.entryFor(id).category = category
    this.persist()
    this.bump()
    this.refresh()
    return this.stateFor(projectPath)
  }

  remove(id: string, projectPath: string | null): SkillsState {
    this.scan(projectPath, true)
    const record = this.records.get(id)
    const summary = this.summaries.find((skill) => skill.id === id)
    if (!record || !summary) throw new Error('That skill is no longer installed.')
    if (summary.origin !== 'fcc') {
      throw new Error(
        'This skill was installed outside FCC. Disable it instead — deleting it would edit your Claude Code installation.',
      )
    }
    removeSkillDirectory(record)
    const state = this.loadState()
    delete state.entries[id]
    this.persist()
    log.info('skills', `Removed ${summary.name} from ${record.root}`)
    this.bump()
    this.refresh()
    return this.stateFor(projectPath)
  }

  private targetRoot(scope: 'global' | 'project', projectPath: string | null): string {
    if (scope === 'project') {
      if (!projectPath || !projectPath.trim()) throw new Error('Choose a workspace before installing a project skill.')
      const root = projectSkillsDir(projectPath.trim())
      mkdirSync(root, { recursive: true })
      return root
    }
    mkdirSync(globalSkillsDir(), { recursive: true })
    return globalSkillsDir()
  }

  private registerInstalled(id: string, entry: SkillStateEntry): void {
    const stored = this.entryFor(id)
    Object.assign(stored, entry)
    if (!stored.origin) stored.origin = 'fcc'
    if (stored.enabled === undefined) stored.enabled = true
  }

  async inspectRepo(ref: string) {
    return listRepoSkills(ref)
  }

  async installFromRepo(input: {
    ref: string
    paths?: string[]
    scope: 'global' | 'project'
    projectPath?: string | null
    refOverride?: string | null
  }): Promise<InstalledSkillResult> {
    const parsed = parseRepoRef(input.ref)
    if (!parsed) return { ok: false, message: 'Enter a GitHub repository URL or owner/name.', installed: [], skipped: [] }
    const prepared = await prepareRepo(parsed.repo, input.refOverride ?? parsed.ref)
    if (prepared.error) return { ok: false, message: prepared.error, installed: [], skipped: [] }

    const root = this.targetRoot(input.scope, input.projectPath ?? null)
    const wanted = new Set((input.paths ?? []).map((entry) => entry.replace(/\\/g, '/').replace(/^\.\//, '')))
    const dirs = findSkillDirs(prepared.root).filter((dir) => {
      if (wanted.size === 0) return true
      const relative = dir.slice(prepared.root.length + 1).replace(/\\/g, '/')
      return wanted.has(relative)
    })
    if (dirs.length === 0) {
      return { ok: false, message: 'None of the selected folders contain a SKILL.md.', installed: [], skipped: [] }
    }

    const installed: SkillSummary[] = []
    const skipped: Array<{ name: string; reason: string }> = []
    for (const dir of dirs) {
      const relative = dir.slice(prepared.root.length + 1).replace(/\\/g, '/')
      const outcome = parseSkillDirectory(dir)
      if (!outcome.skill) {
        skipped.push({ name: relative, reason: outcome.issues.join(' ') || 'Invalid skill folder.' })
        continue
      }
      const skill = outcome.skill
      const folder = uniqueSkillDirName(root, skill.name)
      const target = join(root, folder)
      assertInside(root, target)
      try {
        copySkillDir(dir, root, folder)
      } catch (error) {
        skipped.push({ name: skill.name, reason: `Copy failed: ${String(error)}` })
        continue
      }
      const id = skillIdentity(input.scope, input.scope === 'project' ? input.projectPath ?? null : null, skill.name)
      this.registerInstalled(id, {
        enabled: true,
        autoInvoke: true,
        installedAt: Date.now(),
        origin: 'fcc',
        version: skill.version || null,
        instructionsHash: instructionsHash(skill.instructions),
        source: { kind: 'github', repo: parsed.repo, ref: prepared.ref, path: relative, url: `https://github.com/${parsed.repo}` },
      })
      installed.push({
        id,
        name: skill.name,
        description: skill.description,
        scope: input.scope,
        origin: 'fcc',
        path: target,
        projectPath: input.scope === 'project' ? input.projectPath ?? null : null,
        enabled: true,
        autoInvoke: true,
        category: null,
        version: skill.version || null,
        license: skill.license || null,
        compatibility: skill.compatibility || null,
        allowedTools: skill.allowedTools,
        installedAt: Date.now(),
        updatedAt: skill.updatedAt,
        source: { kind: 'github', repo: parsed.repo, ref: prepared.ref, path: relative },
        fileCount: skill.files.length,
        bytes: skill.bytes,
        hasScripts: skill.hasScripts,
        warnings: skill.warnings,
        nativeVisible: true,
        invocation: skill.name,
        updateAvailable: false,
        updateCheckedAt: null,
        updateError: null,
      })
    }

    this.persist()
    if (installed.length > 0) {
      this.bump()
      this.refresh()
    }
    return {
      ok: installed.length > 0,
      message:
        installed.length > 0
          ? `Installed ${installed.length} skill${installed.length === 1 ? '' : 's'} into ${
              input.scope === 'project' ? projectSkillsDir(input.projectPath ?? '') : globalSkillsDir()
            }. Bundled scripts were not executed.`
          : 'Nothing was installed.',
      installed,
      skipped,
    }
  }

  importLocal(input: SkillImportInput): InstalledSkillResult {
    const root = this.targetRoot(input.scope, input.projectPath ?? null)
    const installed: SkillSummary[] = []
    const skipped: Array<{ name: string; reason: string }> = []

    for (const candidate of input.paths.slice(0, 20)) {
      const source = resolve(candidate)
      let stats
      try {
        stats = statSync(source)
      } catch {
        skipped.push({ name: candidate, reason: 'Path does not exist.' })
        continue
      }
      const dirs = stats.isDirectory()
        ? findSkillDirs(source).length > 0
          ? findSkillDirs(source)
          : [source]
        : []
      for (const dir of dirs) {
        const outcome = parseSkillDirectory(dir)
        if (!outcome.skill) {
          skipped.push({ name: dir, reason: outcome.issues.join(' ') || 'No SKILL.md found.' })
          continue
        }
        const skill = outcome.skill
        const folder = uniqueSkillDirName(root, skill.name)
        try {
          assertInside(root, join(root, folder))
          cpSync(dir, join(root, folder), {
            recursive: true,
            dereference: false,
            filter: (entry) => !entry.endsWith(`${sep}.git`) && !entry.includes(`${sep}node_modules`),
          })
        } catch (error) {
          skipped.push({ name: skill.name, reason: `Copy failed: ${String(error)}` })
          continue
        }
        const id = skillIdentity(input.scope, input.scope === 'project' ? input.projectPath ?? null : null, skill.name)
        this.entryFor(id)
        Object.assign(this.entryFor(id), {
          enabled: true,
          autoInvoke: true,
          installedAt: Date.now(),
          origin: 'fcc',
          version: skill.version || null,
          instructionsHash: instructionsHash(skill.instructions),
          source: { kind: 'local', path: source },
        } satisfies SkillStateEntry)
        if (input.move && source !== dir) {
          rmSync(dir, { recursive: true, force: true })
        }
        installed.push({
          id,
          name: skill.name,
          description: skill.description,
          scope: input.scope,
          origin: 'fcc',
          path: join(root, folder),
          projectPath: input.scope === 'project' ? input.projectPath ?? null : null,
          enabled: true,
          autoInvoke: true,
          category: null,
          version: skill.version || null,
          license: skill.license || null,
          compatibility: skill.compatibility || null,
          allowedTools: skill.allowedTools,
          installedAt: Date.now(),
          updatedAt: skill.updatedAt,
          source: { kind: 'local', path: source },
          fileCount: skill.files.length,
          bytes: skill.bytes,
          hasScripts: skill.hasScripts,
          warnings: skill.warnings,
          nativeVisible: true,
          invocation: skill.name,
          updateAvailable: false,
          updateCheckedAt: null,
          updateError: null,
        })
      }
    }

    this.persist()
    if (installed.length > 0) {
      this.bump()
      this.refresh()
    }
    return {
      ok: installed.length > 0,
      message:
        installed.length > 0
          ? `Imported ${installed.length} skill${installed.length === 1 ? '' : 's'}. Nothing was executed.`
          : 'No valid skill folder was found in that selection.',
      installed,
      skipped,
    }
  }

  async importZip(input: { path: string; scope: 'global' | 'project'; projectPath?: string | null }): Promise<InstalledSkillResult> {
    const { readFileSync } = await import('node:fs')
    let archive: Buffer
    try {
      archive = readFileSync(input.path)
    } catch (error) {
      return { ok: false, message: `Could not read the archive: ${String(error)}`, installed: [], skipped: [] }
    }
    const staging = join(tmpdir(), `fcc-skill-zip-${Date.now()}`)
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(staging, { recursive: true })
    const extracted = extractZip(archive, staging, 0)
    if (extracted.error) return { ok: false, message: extracted.error, installed: [], skipped: [] }
    const dirs = findSkillDirs(staging)
    if (dirs.length === 0) {
      rmSync(staging, { recursive: true, force: true })
      return { ok: false, message: 'The archive has no SKILL.md folder.', installed: [], skipped: [] }
    }
    try {
      return this.importLocal({ paths: dirs, scope: input.scope, projectPath: input.projectPath ?? null })
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
  }

  /**
   * Compare installed GitHub skills with their source repositories.
   *
   * Grouped by repository, so ten skills from one repo cost one download. The
   * result is persisted per skill, which is what lets the view show "update
   * available" without asking GitHub again on every render.
   */
  async checkUpdates(projectPath: string | null, force = false): Promise<SkillsState> {
    const state = this.loadState()
    const scopeKey = projectPath ?? 'global'
    const last = state.checks?.[scopeKey] ?? 0
    if (!force && Date.now() - last < 10 * 60_000) return this.stateFor(projectPath)

    this.scan(projectPath, true)
    const groups = new Map<string, SkillSummary[]>()
    for (const skill of this.summaries) {
      const source = skill.source
      if (!source || source.kind !== 'github' || !source.repo || !source.path) continue
      const key = `${source.repo}@${source.ref ?? ''}`
      const list = groups.get(key) ?? []
      list.push(skill)
      groups.set(key, list)
    }

    state.checks = { ...(state.checks ?? {}), [scopeKey]: Date.now() }

    for (const list of groups.values()) {
      const source = list[0]?.source
      if (!source?.repo) continue
      const prepared = await prepareRepo(source.repo, source.ref ?? null)
      const checkedAt = Date.now()
      for (const skill of list) {
        const entry = this.entryFor(skill.id)
        if (prepared.error) {
          entry.upstream = { checkedAt, available: entry.upstream?.available ?? false, error: prepared.error }
          continue
        }
        const dir = join(prepared.root, skill.source?.path ?? '')
        if (!existsSync(dir)) {
          entry.upstream = {
            checkedAt,
            available: false,
            error: 'That skill folder no longer exists in the source repository.',
          }
          continue
        }
        const parsed = parseSkillDirectory(dir)
        if (!parsed.skill) {
          entry.upstream = { checkedAt, available: false, error: 'The upstream SKILL.md is no longer valid.' }
          continue
        }
        const hash = instructionsHash(parsed.skill.instructions)
        if (!entry.instructionsHash) entry.instructionsHash = hash
        entry.upstream = {
          checkedAt,
          available: entry.instructionsHash !== hash,
          version: parsed.skill.version || null,
          error: null,
        }
      }
    }

    this.persist()
    this.refresh()
    this.notify()
    log.info('skills', `Update check finished for ${scopeKey} (${groups.size} repositor${groups.size === 1 ? 'y' : 'ies'})`)
    return this.stateFor(projectPath)
  }

  /**
   * Global skills are checked shortly after launch and then at most every six
   * hours. Project scopes are checked on demand when the Skills view opens for
   * that workspace, because only the renderer knows which project is active.
   */
  startBackgroundChecks(): void {
    if (this.timer) return
    const sixHours = 6 * 60 * 60 * 1000
    const tick = () => {
      const last = this.loadState().checks?.global ?? 0
      if (Date.now() - last < sixHours) return
      void this.checkUpdates(null, true).catch((error) =>
        log.warn('skills', `Background update check failed: ${String(error)}`),
      )
    }
    const initial = setTimeout(tick, 30_000)
    initial.unref?.()
    this.timer = setInterval(tick, 60 * 60 * 1000)
    this.timer.unref?.()
  }

  stopBackgroundChecks(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async update(id: string, projectPath: string | null): Promise<SkillUpdateResult> {
    this.scan(projectPath, true)
    const summary = this.summaries.find((skill) => skill.id === id)
    const record = this.records.get(id)
    if (!summary || !record) return { id, ok: false, message: 'That skill is no longer installed.', skill: null }
    const source = summary.source
    if (!source || source.kind !== 'github' || !source.repo || !source.path) {
      return { id, ok: false, message: 'This skill has no GitHub source to update from.', skill: summary }
    }

    resetRepoCache()
    const prepared = await prepareRepo(source.repo, source.ref ?? null)
    if (prepared.error) return { id, ok: false, message: prepared.error, skill: summary }
    const dir = join(prepared.root, source.path)
    if (!existsSync(dir)) {
      return { id, ok: false, message: `The skill folder "${source.path}" is gone from ${source.repo}.`, skill: summary }
    }
    const outcome = parseSkillDirectory(dir)
    if (!outcome.skill) {
      return { id, ok: false, message: `Upstream SKILL.md is invalid: ${outcome.issues.join(' ')}`, skill: summary }
    }
    const nextHash = instructionsHash(outcome.skill.instructions)
    const entry = this.entryFor(id)
    if (entry.instructionsHash && entry.instructionsHash === nextHash) {
      return { id, ok: true, message: `${summary.name} is already up to date.`, skill: summary }
    }

    const staging = join(tmpdir(), `fcc-skill-update-${Date.now()}`)
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(staging, { recursive: true })
    try {
      copySkillDir(dir, staging, 'incoming')
      const target = record.dir
      const backup = `${target}.fcc-backup`
      rmSync(backup, { recursive: true, force: true })
      cpSync(target, backup, { recursive: true, dereference: false })
      rmSync(target, { recursive: true, force: true })
      cpSync(join(staging, 'incoming'), target, { recursive: true, dereference: false })
      rmSync(backup, { recursive: true, force: true })
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }

    entry.instructionsHash = nextHash
    entry.version = outcome.skill.version || null
    entry.source = { ...source, ref: prepared.ref }
    entry.upstream = { checkedAt: Date.now(), available: false, version: entry.version, error: null }
    this.persist()
    this.bump()
    this.refresh()
    this.scan(projectPath, true)
    return {
      id,
      ok: true,
      message: `Updated ${summary.name} from ${source.repo}.`,
      skill: this.summaries.find((skill) => skill.id === id) ?? null,
    }
  }

  discover(input: DiscoverInput): Promise<DiscoveryResult> {
    return discover(input)
  }

  /** Which skills should guide this turn, and how the instructions reach the model. */
  planTurn(input: { text: string; projectPath: string | null; manual?: string[] }): {
    invocations: SkillInvocation[]
    delivery: 'native' | 'inline' | 'none'
    notes: string[]
    prompt: ComposedPrompt | null
  } {
    const config = skillConfig()
    if (!config.enabled) return { invocations: [], delivery: 'none', notes: ['Skills are turned off in Settings.'], prompt: null }
    this.scan(input.projectPath)
    const invocations = selectSkills({
      prompt: input.text,
      skills: this.summaries,
      manual: input.manual ?? [],
      maxActive: config.maxActive,
      auto: config.autoInvoke,
    })
    if (invocations.length === 0) return { invocations, delivery: 'none', notes: [], prompt: null }

    const contents = new Map<string, { name: string; body: string; references: string[] }>()
    if (config.mode === 'inline') {
      for (const invocation of invocations) {
        const record = this.records.get(invocation.id)
        if (!record) continue
        const parsed = parseSkillDirectory(record.dir)
        if (!parsed.skill) continue
        contents.set(invocation.id, {
          name: parsed.skill.name,
          body: parsed.skill.body,
          references: parsed.skill.files.filter((file) => file.kind === 'reference').map((file) => file.path).slice(0, 20),
        })
      }
    }

    const prompt = composePrompt({
      text: input.text,
      invocations,
      contents,
      mode: config.mode,
      budgetChars: 24000,
    })
    return { invocations, delivery: prompt.delivery, notes: prompt.notes, prompt }
  }

  /** Used by Settings when "Manage external skills" is switched. */
  updateConfig(patch: Partial<SkillsConfig>): SkillsConfig {
    const next = updateSettings({ skills: patch }).skills
    this.refresh()
    this.notify()
    return next
  }
}

export const skillsService = new SkillsService()
export { DISABLED_DIR }
