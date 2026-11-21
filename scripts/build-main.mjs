import { build } from 'esbuild'
import { rm } from 'node:fs/promises'

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: false,
  minify: true,
  external: ['electron'],
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production') },
}

await rm('dist/main', { recursive: true, force: true })

await Promise.all([
  build({ ...shared, entryPoints: ['electron/main.ts'], outfile: 'dist/main/main.cjs' }),
  build({ ...shared, entryPoints: ['electron/preload.ts'], outfile: 'dist/main/preload.cjs' }),
])

console.log('main + preload bundled -> dist/main')
