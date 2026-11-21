import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { URL } from 'node:url'

export interface JsonResponse<T> {
  ok: boolean
  status: number
  data: T | null
  body: string
  latencyMs: number
  error: string | null
}

interface RequestOptions {
  method?: 'GET' | 'POST'
  body?: unknown
  headers?: Record<string, string>
  timeoutMs?: number
}

/**
 * Minimal JSON transport for the local FCC endpoint. Uses node:http instead of
 * fetch so that a dead endpoint fails fast without touching a proxy config.
 */
export function requestJson<T>(url: string, options: RequestOptions = {}): Promise<JsonResponse<T>> {
  const started = Date.now()
  const timeoutMs = options.timeoutMs ?? 8000
  return new Promise((resolve) => {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      resolve({
        ok: false,
        status: 0,
        data: null,
        body: '',
        latencyMs: 0,
        error: `Invalid URL: ${url}`,
      })
      return
    }

    const payload = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body), 'utf8')
    const client = parsed.protocol === 'https:' ? httpsRequest : httpRequest
    let settled = false

    const finish = (result: Omit<JsonResponse<T>, 'latencyMs'>): void => {
      if (settled) return
      settled = true
      resolve({ ...result, latencyMs: Date.now() - started })
    }

    const req = client(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || 80,
        path: `${parsed.pathname}${parsed.search}`,
        method: options.method ?? 'GET',
        headers: {
          accept: 'application/json',
          ...(payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {}),
          ...options.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > 8 * 1024 * 1024) {
            req.destroy(new Error('Response exceeded 8 MB'))
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8')
          let data: T | null = null
          try {
            data = body ? (JSON.parse(body) as T) : null
          } catch {
            data = null
          }
          finish({
            ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
            status: res.statusCode ?? 0,
            data,
            body,
            error: null,
          })
        })
      },
    )

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Timed out after ${timeoutMs} ms`))
    })
    req.on('error', (error: Error) => {
      finish({ ok: false, status: 0, data: null, body: '', error: error.message })
    })
    if (payload) req.write(payload)
    req.end()
  })
}
