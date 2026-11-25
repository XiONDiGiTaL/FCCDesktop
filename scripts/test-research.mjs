/**
 * Bundles the research server tests and runs them through node:test.
 * The service has no Electron imports, so it runs directly under node.
 */
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outDir = join(root, 'dist', 'test')
const outFile = join(outDir, 'research.test.cjs')

mkdirSync(outDir, { recursive: true })

await build({
  entryPoints: [join(root, 'tests', 'research.test.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: outFile,
  logLevel: 'warning',
})

const result = spawnSync(process.execPath, ['--test', outFile], { stdio: 'inherit', cwd: root })
rmSync(outFile, { force: true })
if (result.error) {
  console.error(result.error)
  process.exit(1)
}
process.exit(result.status ?? 1)
