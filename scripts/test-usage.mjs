/**
 * Bundles the usage-monitor tests with esbuild and runs them through node:test.
 * Same pattern as the local-model suite: no test framework dependency.
 */
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outDir = join(root, 'dist', 'test')
const outFile = join(outDir, 'usage.test.cjs')

mkdirSync(outDir, { recursive: true })

/**
 * The monitor imports the app's settings/paths helpers, which read Electron's
 * `app.getPath('userData')`. The test runs under plain node, so resolve
 * `electron` to a tiny stub that points at a temporary directory.
 */
const electronStub = {
  name: 'electron-stub',
  setup(build) {
    build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'electron-stub' }))
    build.onLoad({ filter: /.*/, namespace: 'electron-stub' }, () => ({
      loader: 'js',
      contents: [
        "const { join } = require('node:path')",
        "export const app = { getPath: () => process.env.FCC_USAGE_TEST_ROOT || join(process.cwd(), '.usage-test'), getName: () => 'FCC Desktop' }",
        'export default { app }',
      ].join('\n'),
    }))
  },
}

await build({
  entryPoints: [join(root, 'tests', 'usage.test.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: outFile,
  logLevel: 'warning',
  plugins: [electronStub],
})

const result = spawnSync(process.execPath, ['--test', outFile], { stdio: 'inherit', cwd: root })
rmSync(outFile, { force: true })
if (result.error) {
  console.error(result.error)
  process.exit(1)
}
process.exit(result.status ?? 1)
