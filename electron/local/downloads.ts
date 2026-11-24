/**
 * GGUF download manager.
 *
 * Downloads are resumable (`.part` file + Range), cancelable, and never leave a
 * half file under the real name: a model either exists completely or it is a
 * partial that the next attempt continues.
 */
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { get as httpsGet } from 'node:https'
import type { ClientRequest } from 'node:http'
import type { DownloadTask } from '../../src/shared/local'
import { log } from '../core/logger'

const UA = 'FCC-Desktop/1.0 (+https://github.com/XiONDiGiTaL/FCCDesktop)'
const MAX_REDIRECTS = 6
const EMIT_INTERVAL = 350

export interface DownloadInput {
  repo: string
  filename: string
  quant: string
  destPath: string
  sizeBytes: number
}

interface Active {
  request: ClientRequest | null
  cancelled: boolean
}

export class DownloadManager {
  private tasks = new Map<string, DownloadTask>()
  private active = new Map<string, Active>()
  private onChange: () => void = () => {}
  private onComplete: (task: DownloadTask) => void = () => {}

  bind(onChange: () => void, onComplete: (task: DownloadTask) => void): void {
    this.onChange = onChange
    this.onComplete = onComplete
  }

  list(): DownloadTask[] {
    return Array.from(this.tasks.values()).sort((a, b) => b.startedAt - a.startedAt)
  }

  cancel(id: string): boolean {
    const task = this.tasks.get(id)
    const active = this.active.get(id)
    if (!task || !active) return false
    active.cancelled = true
    active.request?.destroy(new Error('cancelled'))
    task.state = 'cancelled'
    task.error = null
    task.updatedAt = Date.now()
    task.bytesPerSecond = 0
    this.active.delete(id)
    this.onChange()
    return true
  }

  clearFinished(): void {
    for (const [id, task] of this.tasks) {
      if (task.state !== 'downloading') this.tasks.delete(id)
    }
    this.onChange()
  }

  start(input: DownloadInput): DownloadTask {
    const existing = this.list().find(
      (task) => task.state === 'downloading' && task.repo === input.repo && task.filename === input.filename,
    )
    if (existing) return existing

    const task: DownloadTask = {
      id: `${input.repo}:${input.filename}`,
      repo: input.repo,
      filename: input.filename,
      quant: input.quant,
      destPath: input.destPath,
      sizeBytes: input.sizeBytes,
      receivedBytes: existsSync(`${input.destPath}.part`) ? statSync(`${input.destPath}.part`).size : 0,
      state: 'downloading',
      error: null,
      startedAt: Date.now(),
      updatedAt: Date.now(),
      bytesPerSecond: 0,
    }
    this.tasks.set(task.id, task)
    mkdirSync(dirname(task.destPath), { recursive: true })

    if (existsSync(task.destPath)) {
      task.receivedBytes = statSync(task.destPath).size || task.sizeBytes
      task.state = 'done'
      task.updatedAt = Date.now()
      this.onComplete(task)
      this.onChange()
      return task
    }

    void this.run(task, this.urlFor(task.repo, task.filename), 0)
    return task
  }

  private urlFor(repo: string, filename: string): string {
    return `https://huggingface.co/${repo}/resolve/main/${filename}?download=true`
  }

  private async run(task: DownloadTask, url: string, redirects: number): Promise<void> {
    const part = `${task.destPath}.part`
    const offset = existsSync(part) ? statSync(part).size : 0
    const state: Active = { request: null, cancelled: false }
    this.active.set(task.id, state)

    const headers: Record<string, string> = { 'user-agent': UA, accept: '*/*' }
    if (offset > 0) headers.range = `bytes=${offset}-`

    let lastEmit = 0
    let windowBytes = offset
    let windowStart = Date.now()

    try {
      await new Promise<void>((resolve, reject) => {
        const request = httpsGet(url, { headers, timeout: 30000 }, (response) => {
          const status = response.statusCode ?? 0
          if ([301, 302, 303, 307, 308].includes(status) && response.headers.location) {
            response.resume()
            if (redirects >= MAX_REDIRECTS) {
              reject(new Error('Hugging Face redirected too many times.'))
              return
            }
            const next = new URL(response.headers.location, url).toString()
            request.destroy()
            void this.run(task, next, redirects + 1).then(resolve, reject)
            return
          }
          if (status === 401 || status === 403) {
            response.resume()
            reject(
              new Error(
                'Hugging Face refused this download. The repository is gated or private, so it needs a token and cannot be fetched here.',
              ),
            )
            return
          }
          if (status === 416) {
            response.resume()
            resolve()
            return
          }
          if (status >= 400) {
            response.resume()
            reject(new Error(`Hugging Face returned HTTP ${status}.`))
            return
          }

          const isResume = status === 206
          const contentLength = Number(response.headers['content-length'] ?? 0)
          if (task.sizeBytes === 0) {
            task.sizeBytes = isResume ? offset + contentLength : contentLength
          }

          const stream = createWriteStream(part, { flags: isResume && offset > 0 ? 'a' : 'w' })
          if (!isResume) task.receivedBytes = 0

          response.on('data', (chunk: Buffer) => {
            task.receivedBytes += chunk.length
            task.updatedAt = Date.now()
            const now = Date.now()
            if (now - windowStart >= 1000) {
              task.bytesPerSecond = Math.round(((task.receivedBytes - windowBytes) * 1000) / (now - windowStart))
              windowBytes = task.receivedBytes
              windowStart = now
            }
            if (now - lastEmit >= EMIT_INTERVAL) {
              lastEmit = now
              this.onChange()
            }
          })
          response.on('error', reject)
          stream.on('error', reject)
          stream.on('finish', resolve)
          response.pipe(stream)
        })
        state.request = request
        request.on('timeout', () => request.destroy(new Error('The download timed out.')))
        request.on('error', reject)
      })

      if (state.cancelled) return
      if (!existsSync(part)) {
        // 416 means the part file already held the whole body.
        if (existsSync(task.destPath)) {
          task.state = 'done'
        } else {
          throw new Error('The download ended before any data arrived.')
        }
      } else {
        renameSync(part, task.destPath)
        task.state = 'done'
        task.receivedBytes = statSync(task.destPath).size
      }
      task.error = null
      task.bytesPerSecond = 0
      task.updatedAt = Date.now()
      this.onComplete(task)
    } catch (error) {
      if (state.cancelled) return
      const message = error instanceof Error ? error.message : String(error)
      task.state = 'error'
      task.error = message
      task.bytesPerSecond = 0
      task.updatedAt = Date.now()
      log.warn('local-models', `Download failed for ${task.repo}/${task.filename}: ${message}`)
    } finally {
      this.active.delete(task.id)
      this.onChange()
    }
  }
}

