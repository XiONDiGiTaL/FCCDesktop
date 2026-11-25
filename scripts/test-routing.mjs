/**
 * Bundles the free-provider router tests and runs them through node:test.
 * The shared module has no Node or Electron imports, so no stub is needed.
 */
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outDir = join(root, 'dist', 'test')
const outFile = join(outDir, 'routing.test.cjs')

mkdirSync(outDir, { recursive: true })

await build({
  entryPoints: [join(root, 'tests', 'routing.test.ts')],
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
