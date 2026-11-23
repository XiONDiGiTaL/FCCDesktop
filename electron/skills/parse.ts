import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'
import type { SafetyFinding, SkillFileInfo, SkillFileKind } from '../../src/shared/skills'
import { parseFrontmatter, splitFrontmatter, stringField, stringList, stringMap } from './frontmatter'

export const SKILL_FILE = 'SKILL.md'
const MAX_FILES = 400
const MAX_DEPTH = 5
const MAX_INSTRUCTION_BYTES = 512 * 1024

export interface ParsedSkill {
  name: string
  description: string
  license: string
  compatibility: string
  version: string
  allowedTools: string[]
  argumentHint: string
  metadata: Record<string, string>
  frontmatter: Record<string, unknown>
  instructions: string
  body: string
  files: SkillFileInfo[]
  bytes: number
  hasScripts: boolean
  updatedAt: number
  warnings: string[]
  findings: SafetyFinding[]
}

export interface ParseOutcome {
  skill: ParsedSkill | null
  issues: string[]
}

/** Skills live on disk, so identity must come from the path, not the folder name. */
export function skillIdFor(path: string): string {
  return createHash('sha1').update(resolve(path).toLowerCase()).digest('hex').slice(0, 16)
}

function kindFor(relativePath: string): SkillFileKind {
  const parts = relativePath.split(/[\\/]/)
  if (parts.length === 1) return relativePath.toLowerCase() === SKILL_FILE.toLowerCase() ? 'instruction' : 'other'
  const top = (parts[0] ?? '').toLowerCase()
  if (top === 'scripts' || top === 'script') return 'script'
  if (top === 'references' || top === 'reference' || top === 'docs') return 'reference'
  if (top === 'assets' || top === 'templates' || top === 'examples') return 'asset'
  const ext = relativePath.split('.').pop()?.toLowerCase() ?? ''
  if (['sh', 'ps1', 'bat', 'cmd', 'py', 'js', 'mjs', 'ts', 'rb', 'exe', 'jar'].includes(ext)) return 'script'
  if (['md', 'txt', 'json', 'yaml', 'yml'].includes(ext)) return 'reference'
  return 'other'
}

/** Walk a skill folder without following symlinks out of it. */
export function listSkillFiles(root: string): SkillFileInfo[] {
  const out: SkillFileInfo[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= MAX_FILES) return
      if (entry === 'node_modules' || entry === '.git') continue
      const full = join(dir, entry)
      let stats
      try {
        stats = lstatSync(full)
      } catch {
        continue
      }
      // Never traverse a link: a downloaded skill must stay inside its folder.
      if (stats.isSymbolicLink()) continue
      if (stats.isDirectory()) {
        walk(full, depth + 1)
        continue
      }
      const rel = relative(root, full).split(sep).join('/')
      out.push({ path: rel, size: stats.size, kind: kindFor(rel) })
    }
  }
  walk(root, 0)
  return out.sort((a, b) => a.path.localeCompare(b.path))
}

const SUSPICIOUS: Array<{ code: string; severity: 'warning' | 'danger'; pattern: RegExp; message: string }> = [
  {
    code: 'pipe-to-shell',
    severity: 'danger',
    pattern: /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|k)?sh\b/i,
    message: 'Downloads and pipes a remote script into a shell.',
  },
  {
    code: 'delete-root',
    severity: 'danger',
    pattern: /\brm\s+-[a-z]*r[a-z]*f?\s+\/(\s|$)|format\s+[a-z]:/i,
    message: 'Contains a destructive filesystem command.',
  },
  {
    code: 'override-safety',
    severity: 'danger',
    pattern: /ignore (all|any|the) (previous|prior|above) (instructions|rules)|disregard (the )?(system|safety) (prompt|rules)|bypass (the )?(sandbox|permission)/i,
    message: 'Tries to override system or safety instructions — treated as untrusted content only.',
  },
  {
    code: 'credential-access',
    severity: 'warning',
    pattern: /\.ssh\/(id_|authorized_keys)|\.aws\/credentials|keychain|browser (cookies|passwords)/i,
    message: 'References credential stores. Review before use.',
  },
  {
    code: 'encoded-payload',
    severity: 'warning',
    pattern: /base64\s+(-d|--decode)\s*\|/i,
    message: 'Decodes an encoded payload into another command.',
  },
  {
    code: 'obfuscated-shell',
    severity: 'warning',
    pattern: /powershell(\.exe)?\s+.*-e(nc|ncodedcommand)?\s|<#\s*#>/i,
    message: 'Runs an encoded PowerShell command.',
  },
]

function scanInstructions(instructions: string): SafetyFinding[] {
  const findings: SafetyFinding[] = []
  for (const rule of SUSPICIOUS) {
    if (rule.pattern.test(instructions)) {
      findings.push({ severity: rule.severity, code: rule.code, message: rule.message, file: SKILL_FILE })
    }
  }
  return findings
}

/** Read and validate one skill directory. Never executes anything it finds. */
export function parseSkillDirectory(dir: string): ParseOutcome {
  const issues: string[] = []
  const filePath = join(dir, SKILL_FILE)
  if (!existsSync(filePath)) {
    // A few community skills use lowercase; accept it but normalise in memory.
    const alternate = readdirSync(dir).find((entry) => entry.toLowerCase() === 'skill.md')
    if (!alternate) return { skill: null, issues: [`${basename(dir)} has no ${SKILL_FILE}.`] }
    issues.push(`File is named ${alternate}; the Agent Skills format expects ${SKILL_FILE}.`)
  }
  const resolved = existsSync(filePath) ? filePath : join(dir, readdirSync(dir).find((entry) => entry.toLowerCase() === 'skill.md') ?? SKILL_FILE)
  const stats = statSync(resolved)
  if (stats.size > MAX_INSTRUCTION_BYTES) {
    return { skill: null, issues: [`${SKILL_FILE} is larger than 512 KB and was not loaded.`] }
  }
  const text = readFileSync(resolved, 'utf8')

  const split = splitFrontmatter(text)
  if (split.raw === null) {
    return { skill: null, issues: [...split.issues, 'A SKILL.md must start with --- frontmatter.'] }
  }
  const parsed = parseFrontmatter(text)
  issues.push(...parsed.issues)

  const name =
    stringField(parsed.data, 'name') ||
    stringField(stringMap(parsed.data, 'metadata'), 'name') ||
    basename(dir)
  if (!stringField(parsed.data, 'name')) issues.push('Frontmatter has no name; the folder name is used instead.')
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(name)) {
    issues.push(`Skill name "${name}" is not a simple slug; rename it to letters, digits and dashes.`)
  }
  const description = stringField(parsed.data, 'description')
  if (!description) issues.push('Frontmatter has no description; the model cannot tell when to use this skill.')
  if (description.length > 1200) issues.push('Description is longer than 1200 characters and will be truncated for the registry.')

  const files = listSkillFiles(dir)
  const hasScripts = files.some((file) => file.kind === 'script')
  const bytes = files.reduce((total, file) => total + file.size, 0)

  const allowedTools = stringList(parsed.data, 'allowed-tools')
  const warnings = [...issues]
  if (hasScripts && !allowedTools.includes('Bash')) {
    warnings.push('Bundles scripts. FCC never runs them; the model may only run them through the normal Bash permission flow.')
  }

  const findings = scanInstructions(text)
  for (const finding of findings) {
    warnings.push(`Security: ${finding.message}`)
  }

  let updatedAt = stats.mtimeMs
  try {
    updatedAt = Math.max(stats.mtimeMs, statSync(dir).mtimeMs)
  } catch {
    /* keep the file time */
  }

  return {
    skill: {
      name,
      description: description.slice(0, 4000),
      license: stringField(parsed.data, 'license'),
      compatibility: stringField(parsed.data, 'compatibility'),
      version:
        stringField(parsed.data, 'version') ||
        stringField(stringMap(parsed.data, 'metadata'), 'version'),
      allowedTools,
      argumentHint: stringField(parsed.data, 'argument-hint'),
      metadata: stringMap(parsed.data, 'metadata'),
      frontmatter: parsed.data,
      instructions: text,
      body: parsed.body.trim(),
      files,
      bytes,
      hasScripts,
      updatedAt,
      warnings,
      findings,
    },
    issues,
  }
}

/** True when the folder looks like a single skill rather than a collection. */
export function isSkillDirectory(dir: string): boolean {
  try {
    return readdirSync(dir).some((entry) => entry.toLowerCase() === 'skill.md')
  } catch {
    return false
  }
}

export function safeReadFile(root: string, relativePath: string): string | null {
  const target = resolve(root, relativePath)
  const rootResolved = resolve(root)
  if (target !== rootResolved && !target.startsWith(`${rootResolved}${sep}`)) return null
  try {
    const stats = statSync(target)
    if (!stats.isFile() || stats.size > MAX_INSTRUCTION_BYTES) return null
    return readFileSync(target, 'utf8')
  } catch {
    return null
  }
}
