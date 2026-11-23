/**
 * Bundles the Agent Skills tests with esbuild and runs them through node:test.
 *
 * Kept as a script instead of adding a test framework: the suite only needs
 * TypeScript compilation and node's own runner.
 */
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outDir = join(root, 'dist', 'test')
const outFile = join(outDir, 'skills.test.cjs')

mkdirSync(outDir, { recursive: true })

await build({
  entryPoints: [join(root, 'tests', 'skills.test.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: outFile,
  // The skills service imports electron for app paths and safeStorage; the stub
  // keeps the service testable under plain node:test.
  alias: { electron: join(root, 'tests', 'electron-stub.cjs') },
  logLevel: 'warning',
})

const result = spawnSync(process.execPath, ['--test', outFile], { stdio: 'inherit', cwd: root })
rmSync(outFile, { force: true })
if (result.error) {
  console.error(result.error)
  process.exit(1)
}
process.exit(result.status ?? 1)
