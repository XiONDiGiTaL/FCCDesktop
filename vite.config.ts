import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  root: fileURLToPath(new URL('./src/renderer', import.meta.url)),
  base: './',
  plugins: [
    react(),
    {
      name: 'inject-production-csp',
      apply: 'build',
      transformIndexHtml(html) {
        const policy = [
          "default-src 'self'",
          "script-src 'self'",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob:",
          "font-src 'self' data:",
          "connect-src 'none'",
          "object-src 'none'",
          "base-uri 'none'",
          "form-action 'none'",
        ].join('; ')
        return html.replace(
          '<head>',
          `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`,
        )
      },
    },
  ],
  server: {
    port: 5273,
    strictPort: true,
  },
  build: {
    outDir: fileURLToPath(new URL('./dist/renderer', import.meta.url)),
    emptyOutDir: true,
    target: 'chrome130',
    sourcemap: false,
    assetsInlineLimit: 0,
  },
})
