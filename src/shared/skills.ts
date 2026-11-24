/**
 * Agent Skills domain contracts shared by the main process and the renderer.
 *
 * Skills are discovered from the Claude Code directories FCC already runs
 * against, so nothing here decides whether a model can *see* a skill: the CLI
 * owns that. FCC owns installation, validation, toggles, selection and the
 * adapter that hands instructions to a model which cannot load them natively.
 */

export type SkillScope = 'global' | 'project'
export type SkillOrigin = 'fcc' | 'external'
/** native = the CLI loads SKILL.md itself; inline = FCC pastes instructions into the prompt. */
export type SkillMode = 'native' | 'inline'

export interface SkillSource {
  kind: 'github' | 'local' | 'zip' | 'registry' | 'unknown'
  repo?: string
  ref?: string
  path?: string
  url?: string
}

export interface SafetyFinding {
  severity: 'warning' | 'danger'
  code: string
  message: string
  file?: string
}

export type SkillFileKind = 'instruction' | 'script' | 'reference' | 'asset' | 'other'

export interface SkillFileInfo {
  path: string
  size: number
  kind: SkillFileKind
}

export interface SkillSummary {
  /** Stable across restarts: derived from the skill's absolute path. */
  id: string
  name: string
  description: string
  scope: SkillScope
  origin: SkillOrigin
  path: string
  projectPath: string | null
  enabled: boolean
  autoInvoke: boolean
  category: string | null
  version: string | null
  license: string | null
  compatibility: string | null
  allowedTools: string[]
  installedAt: number | null
  updatedAt: number
  source: SkillSource | null
  fileCount: number
  bytes: number
  hasScripts: boolean
  warnings: string[]
  /** The Claude Code CLI's own registry will pick this up (enabled skills only). */
  nativeVisible: boolean
  /** Name the model sees: bare for global, prefixed for project skills. */
  invocation: string
  /** True when the upstream SKILL.md differs from the installed copy. */
  updateAvailable: boolean
  /** When FCC last compared this skill with its source repository. */
  updateCheckedAt: number | null
  /** Why the last check could not complete (network, deleted folder, private repo). */
  updateError: string | null
}

export interface SkillDetail extends SkillSummary {
  instructions: string
  body: string
  frontmatter: Record<string, unknown>
  metadata: Record<string, string>
  files: SkillFileInfo[]
  findings: SafetyFinding[]
}

export interface SkillCandidate {
  id: string
  name: string
  repo: string | null
  path: string | null
  description: string | null
  installs: number | null
  url: string
  provider: 'skills.sh' | 'github' | 'curated'
  category: string | null
}

export interface SkillRepoEntry {
  name: string
  path: string
  description: string | null
  valid: boolean
  issues: string[]
  hasScripts: boolean
  fileCount: number
}

export interface SkillRepoListing {
  repo: string
  ref: string
  url: string
  entries: SkillRepoEntry[]
  error: string | null
}

export interface InstalledSkillResult {
  ok: boolean
  message: string
  installed: SkillSummary[]
  skipped: Array<{ name: string; reason: string }>
}

export interface SkillUpdateResult {
  id: string
  ok: boolean
  message: string
  skill: SkillSummary | null
}

export interface DiscoveryResult {
  provider: 'skills.sh' | 'github' | 'curated'
  query: string
  candidates: SkillCandidate[]
  error: string | null
  at: number
}

export interface SkillCategory {
  id: string
  label: string
  group: string
  /** Terms used by automatic selection; extend by editing the taxonomy file. */
  keywords: string[]
}

export interface SkillInvocation {
  id: string
  name: string
  scope: SkillScope
  reason: 'manual' | 'auto'
  score: number
  matched: string[]
}

export interface SkillsConfig {
  /** Master switch: when off, no skill is offered or injected. */
  enabled: boolean
  /** Let FCC pick skills from the prompt as well as the explicit selection. */
  autoInvoke: boolean
  /** Upper bound on skills active in one turn (1-5). */
  maxActive: number
  mode: SkillMode
  /** Allow toggling skills FCC did not install (moves them to the stash). */
  manageExternal: boolean
  /** Show the active-skills chip in the conversation header. */
  showIndicator: boolean
}

export interface SkillCatalog {
  skills: SkillSummary[]
  directories: { global: string; project: string | null }
  settings: SkillsConfig
  scannedAt: number
  revision: number
}

export interface SkillsState {
  skills: SkillSummary[]
  settings: SkillsConfig
  revision: number
}

export interface SkillListInput {
  projectPath?: string | null
  refresh?: boolean
}

export interface SkillUpdateCheckInput {
  projectPath?: string | null
  /** Bypass the throttle and hit GitHub now. */
  force?: boolean
}

export interface SkillInstallInput {
  scope: SkillScope
  projectPath?: string | null
  /** Directory paths for a local import; a repo listing path for GitHub. */
  paths?: string[]
  repo?: string
  ref?: string
}

export interface SkillImportInput {
  paths: string[]
  scope: SkillScope
  projectPath?: string | null
  /** Move the original folder out of the way after copying (local imports only). */
  move?: boolean
}
