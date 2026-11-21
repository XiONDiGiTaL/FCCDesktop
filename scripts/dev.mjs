import { context } from 'esbuild'
import { createServer } from 'vite'
import { spawn } from 'node:child_process'
import electronPath from 'electron'

const shared = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: 'inline',
  external: ['electron'],
  logLevel: 'warning',
}

const contexts = await Promise.all([
  context({ ...shared, entryPoints: ['electron/main.ts'], outfile: 'dist/main/main.cjs' }),
  context({ ...shared, entryPoints: ['electron/preload.ts'], outfile: 'dist/main/preload.cjs' }),
])
await Promise.all(contexts.map((c) => c.rebuild()))
await Promise.all(contexts.map((c) => c.watch()))

const server = await createServer()
await server.listen()
server.printUrls()
const url = server.resolvedUrls?.local?.[0] ?? 'http://localhost:5273/'

const child = spawn(electronPath, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: url, NODE_ENV: 'development' },
})

const shutdown = async () => {
  await Promise.all(contexts.map((c) => c.dispose().catch(() => {})))
  await server.close().catch(() => {})
  process.exit(0)
}

child.on('close', shutdown)
process.on('SIGINT', () => {
  child.kill()
  shutdown()
})
