import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { dirname, isAbsolute, normalize } from 'node:path'
import { homedir } from 'node:os'
import type {
  AgentEvent,
  AgentRuntimeInfo,
  Attachment,
  SendPromptInput,
  SendPromptResult,
  SnapshotBlock,
} from '../../src/shared/types'
import { getSettings } from '../core/settings'
import { getProxyToken } from '../core/secrets'
import { log, redact } from '../core/logger'
import { analyzeProviderFailure, type ProviderFailureAnalysis } from '../../src/shared/usage'
import { resolveTool } from './discovery'
import { skillsService } from '../skills/service'
import type { ConnectionManager } from './connection'
import type { FreeRouter } from './free-router'
import type { ResearchService } from '../research/service'

const MAX_TOOL_OUTPUT = 24000
const MAX_DIRS = 12
/** Provider timeouts are retried in place once per turn, never more. */
const MAX_PROVIDER_RETRIES = 1
/** Provider switches allowed in one turn before giving the turn back to the user. */
const MAX_FREE_FALLBACKS = 2
/**
 * The CLI asks for 128k output tokens by default, which the gateway clamps to
 * ~82k. On a large slow model that is a long turn per call, so cap it: shorter
 * turns fail less and recover faster. Reasoning models count thinking against
 * this budget, so it must stay well clear of a normal long answer: 16k could
 * end a deep turn with stop_reason=max_tokens mid-response, 32k leaves room for
 * thinking plus a full write-up.
 */
const MAX_OUTPUT_TOKENS = '32000'
/**
 * The retry never replays the user's text: the CLI records every message it
 * receives, so resending the prompt would store and send it twice. A neutral
 * continuation keeps the transcript and the request payload clean.
 */
const RETRY_PROMPT = 'Continue.'

const PROVIDER_FAILURE_PATTERNS = [
  /provider api request failed/i,
  /provider exception/i,
  /\b429\b/,
  /rate[ _-]?limit|too many requests|throttl/i,
  /quota[^.\n]{0,32}(?:exceeded|exhausted|reached)|insufficient[ _-]?quota|out of credits/i,
  /request timed out/i,
  /\breadtimeout\b|\btimeouterror\b/i,
  /deadline exceeded/i,
  /api error:\s*5\d\d/i,
  /\bstatus(?:\s*code)?:?\s*5\d\d\b/i,
  /overloaded_error/i,
  /upstream (?:error|timeout|failure|request failed)/i,
]

/** True when the text describes a transient upstream failure, not a real answer. */
function looksLikeProviderFailure(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false
  return PROVIDER_FAILURE_PATTERNS.some((pattern) => pattern.test(trimmed))
}

interface ToolAccumulator {
  id: string
  name: string
  json: string
}

interface Session {
  conversationId: string
  proc: ChildProcess
  sessionId: string | null
  model: string
  cwd: string
  dirs: string[]
  turnId: string | null
  cancelled: boolean
  restarting: boolean
  busy: boolean
  startedAt: number
  toolCount: number
  stderr: string[]
  nonJson: string[]
  toolByMessage: Map<string, Map<number, ToolAccumulator>>
  endedTurns: Set<string>
  idleTimer: NodeJS.Timeout | null
  /** Number of automatic provider retries already spent on this turn. */
  turnAttempts: number
  turnHadOutput: boolean
  turnText: string
  /** Skills revision this process was started with; a change restarts it. */
  skillRevision: number
  /** Free-provider switches already spent on this turn. */
  fallbackCount: number
}

function isDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory()
  } catch {
    return false
  }
}

function safeDirectory(candidate: string | null | undefined): string | null {
  if (!candidate || !candidate.trim()) return null
  if (!isAbsolute(candidate)) return null
  const normalized = normalize(candidate)
  return isDirectory(normalized) ? normalized : null
}

function clamp(text: string): string {
  if (text.length <= MAX_TOOL_OUTPUT) return text
  return `${text.slice(0, MAX_TOOL_OUTPUT)}\n… truncated ${text.length - MAX_TOOL_OUTPUT} characters`
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return clamp(content)
  if (Array.isArray(content)) {
    return clamp(
      content
        .map((part) => {
          if (part && typeof part === 'object' && 'text' in part) return String((part as { text?: unknown }).text ?? '')
          return ''
        })
        .join('\n')
        .trim(),
    )
  }
  if (content === null || content === undefined) return ''
  return clamp(JSON.stringify(content))
}

function buildPrompt(text: string, attachments: Attachment[]): string {
  if (attachments.length === 0) return text
  const lines = attachments.map((attachment) => {
    const kind = attachment.isDirectory ? 'folder' : 'file'
    return `- ${attachment.path} (${kind}, ${attachment.name})`
  })
  return [
    text,
    '',
    'Files attached through FCC Desktop — they exist on disk, open them with your file tools when relevant:',
    ...lines,
  ].join('\n')
}

export class AgentManager {
  private sessions = new Map<string, Session>()

  constructor(
    private readonly connection: ConnectionManager,
    private readonly emit: (event: AgentEvent) => void,
    private readonly router: FreeRouter,
    private readonly research: ResearchService,
  ) {}

  runtime(conversationId: string): AgentRuntimeInfo | null {
    const session = this.sessions.get(conversationId)
    return {
      conversationId,
      sessionId: session?.sessionId ?? null,
      model: session?.model ?? null,
      workingDirectory: session?.cwd ?? null,
      additionalDirs: session?.dirs ?? [],
      busy: session?.busy ?? false,
      startedAt: session?.startedAt ?? null,
      toolCount: session?.toolCount ?? 0,
    }
  }

  async send(input: SendPromptInput): Promise<SendPromptResult> {
    const settings = getSettings()
    const conversationId = input.conversationId
    const existing = this.sessions.get(conversationId)
    if (existing?.busy) {
      throw new Error('The agent is still working on the previous message. Stop it before sending another.')
    }

    const status = await this.connection.probe()
    if (status.state !== 'connected') {
      throw new Error(status.message ?? `FCC is not reachable at ${this.connection.baseUrl()}.`)
    }

    const tool = resolveTool('claude')
    if (!tool.path) {
      throw new Error('fcc-claude.exe was not found. Set its path in Settings → Connection.')
    }

    const cwd =
      safeDirectory(input.workingDirectory) ??
      safeDirectory(settings.agent.workingDirectory) ??
      safeDirectory(homedir()) ??
      homedir()

    const attachments = input.attachments.filter((attachment) => {
      try {
        return existsSync(attachment.path)
      } catch {
        return false
      }
    })

    const requestedDirs = [
      ...input.additionalDirs,
      ...settings.agent.additionalDirs,
      ...attachments.map((attachment) => (attachment.isDirectory ? attachment.path : dirname(attachment.path))),
    ]
    const dirs: string[] = []
    for (const candidate of requestedDirs) {
      const dir = safeDirectory(candidate)
      if (!dir || dirs.includes(dir) || dir === cwd) continue
      dirs.push(dir)
      if (dirs.length >= MAX_DIRS) break
    }

    let model = input.model.trim()
    if (!model && getSettings().agent.freeFirst) {
      const routed = this.router.initialModel('', input.text, attachments.some((item) => item.kind === 'image'))
      if (!routed) {
        throw new Error(
          'No free model is eligible automatically. Add a free provider key in FCC Admin, enable billable free tiers in Settings, or pick a model explicitly in the picker.',
        )
      }
      model = routed.id
    }

    // Skills are resolved before the process is considered: enabling or
    // disabling one changes what the CLI's own registry can see, so the skill
    // revision is part of the process shape.
    const plan = skillsService.planTurn({
      text: input.text,
      projectPath: cwd,
      manual: input.skillNames ?? [],
    })
    const prompt = buildPrompt(plan.prompt?.prompt ?? input.text, attachments)
    const skillRevision = skillsService.revision()

    // Reuse the live process when the shape matches; otherwise restart it while
    // preserving the Claude session id so the conversation keeps its context.
    let session = existing
    const compatible =
      session &&
      session.model === model &&
      session.cwd === cwd &&
      session.skillRevision === skillRevision &&
      session.dirs.length === dirs.length &&
      session.dirs.every((dir, index) => dir === dirs[index])

    let resumeId = input.resumeSessionId ?? existing?.sessionId ?? null

    if (session && !compatible) {
      resumeId = session.sessionId ?? resumeId
      session.restarting = true
      this.killTree(session)
      this.sessions.delete(conversationId)
      session = undefined
    }

    if (!session) {
      session = this.spawnSession({ conversationId, toolPath: tool.path, model, cwd, dirs, resumeId })
      this.sessions.set(conversationId, session)
    }

    if (session.idleTimer) {
      clearTimeout(session.idleTimer)
      session.idleTimer = null
    }
    session.turnId = input.turnId
    session.busy = true
    session.cancelled = false

    this.emit({
      type: 'skills-active',
      conversationId,
      turnId: input.turnId,
      invocations: plan.invocations,
      delivery: plan.delivery,
      notes: plan.notes,
    })

    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: prompt }] },
    })

    try {
      session.proc.stdin?.write(`${line}\n`)
    } catch (error) {
      session.busy = false
      throw new Error(`Could not write to the agent process: ${String(error)}`)
    }

    session.turnAttempts = 0
    session.turnHadOutput = false
    session.turnText = ''

    return {
      turnId: input.turnId,
      sessionId: session.sessionId ?? resumeId,
      workingDirectory: cwd,
      addedDirs: dirs,
      prompt,
      model,
    }
  }

  cancel(conversationId: string): boolean {
    const session = this.sessions.get(conversationId)
    if (!session) return false
    session.cancelled = true
    this.killTree(session)
    return true
  }

  /**
   * Abandon the current turn through the CLI control channel. Unlike cancel(),
   * this keeps the process and its session alive, so a queued message can be
   * sent immediately without losing the conversation's context.
   */
  interrupt(conversationId: string): boolean {
    const session = this.sessions.get(conversationId)
    if (!session || !session.busy || !session.turnId || !session.proc.stdin) return false
    const line = JSON.stringify({
      type: 'control_request',
      request_id: `interrupt_${Date.now()}`,
      request: { subtype: 'interrupt' },
    })
    try {
      session.proc.stdin.write(`${line}\n`)
      // The CLI answers the turn with a result; mark it so the UI shows the
      // reply as interrupted rather than complete.
      session.cancelled = true
      log.info('agent', `Interrupt requested for ${conversationId}`)
      return true
    } catch (error) {
      log.warn('agent', `Failed to interrupt agent: ${String(error)}`)
      return false
    }
  }

  disposeAll(): void {
    for (const session of this.sessions.values()) {
      session.restarting = true
      this.killTree(session)
    }
    this.sessions.clear()
  }

  private spawnSession(args: {
    conversationId: string
    toolPath: string
    model: string
    cwd: string
    dirs: string[]
    resumeId: string | null
  }): Session {
    const settings = getSettings()
    const baseUrl = this.connection.baseUrl()
    let port = '8082'
    let host = settings.connection.host
    try {
      const parsed = new URL(baseUrl)
      port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80')
      host = parsed.hostname
    } catch {
      /* keep defaults */
    }
    const token = getProxyToken() || 'freecc'

    const cliArgs = [
      '--print',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
      '--permission-mode',
      settings.agent.permissionMode,
    ]
    // Non-interactive surfaces cannot answer permission prompts, so every mode
    // declares its tool allowlist explicitly and lets the rest be denied fast.
    const researchTools = 'mcp__fcc_research__web_search,mcp__fcc_research__fetch_url,mcp__fcc_research__github_repo'
    const allowedTools: Partial<Record<typeof settings.agent.permissionMode, string>> = {
      default: `Read,Glob,Grep,LS,NotebookRead,TodoWrite,${researchTools}`,
      acceptEdits: `Read,Glob,Grep,LS,NotebookRead,TodoWrite,Edit,Write,MultiEdit,NotebookEdit,${researchTools}`,
      plan: `Read,Glob,Grep,LS,NotebookRead,${researchTools}`,
    }
    const allowlist = allowedTools[settings.agent.permissionMode]
    if (allowlist) cliArgs.push('--allowedTools', allowlist)
    if (args.model) cliArgs.push('--model', args.model)
    const mcpConfig = this.research.configPath()
    if (mcpConfig) cliArgs.push('--mcp-config', mcpConfig)
    for (const dir of args.dirs) cliArgs.push('--add-dir', dir)
    if (args.resumeId) cliArgs.push('--resume', args.resumeId)

    log.info(
      'agent',
      `Spawning agent for ${args.conversationId} (model=${args.model || 'default'}, cwd=${args.cwd}, dirs=${args.dirs.length}, resume=${Boolean(args.resumeId)})`,
    )

    const proc = spawn(args.toolPath, cliArgs, {
      cwd: args.cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PORT: port,
        HOST: host,
        ANTHROPIC_BASE_URL: baseUrl,
        ANTHROPIC_AUTH_TOKEN: token,
        CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1',
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: MAX_OUTPUT_TOKENS,
        DISABLE_TELEMETRY: '1',
      },
    })

    const session: Session = {
      conversationId: args.conversationId,
      proc,
      sessionId: args.resumeId,
      model: args.model,
      cwd: args.cwd,
      dirs: args.dirs,
      turnId: null,
      cancelled: false,
      restarting: false,
      busy: false,
      startedAt: Date.now(),
      toolCount: 0,
      stderr: [],
      nonJson: [],
      toolByMessage: new Map(),
      endedTurns: new Set(),
      idleTimer: null,
      turnAttempts: 0,
      turnHadOutput: false,
      turnText: '',
      skillRevision: skillsService.revision(),
      fallbackCount: 0,
    }

    let buffer = ''
    proc.stdout?.setEncoding('utf8')
    proc.stdout?.on('data', (chunk: string) => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line) this.handleLine(session, line)
        newline = buffer.indexOf('\n')
      }
    })

    proc.stderr?.setEncoding('utf8')
    proc.stderr?.on('data', (chunk: string) => {
      const text = redact(chunk.toString()).trim()
      if (!text) return
      session.stderr.push(text)
      if (session.stderr.length > 40) session.stderr.shift()
      this.emit({ type: 'stderr', conversationId: session.conversationId, text: text.slice(0, 2000) })
    })

    proc.on('error', (error) => {
      log.error('agent', `Agent process error: ${error.message}`)
      this.emit({
        type: 'error',
        conversationId: session.conversationId,
        turnId: session.turnId,
        message: `Could not start the FCC agent: ${error.message}`,
      })
      this.finishTurn(session, true)
    })

    proc.on('close', (code) => {
      if (session.idleTimer) {
        clearTimeout(session.idleTimer)
        session.idleTimer = null
      }
      const wasCancelled = session.cancelled
      if (this.sessions.get(session.conversationId) === session) {
        this.sessions.delete(session.conversationId)
      }
      if (session.turnId && !session.endedTurns.has(session.turnId)) {
        if (!wasCancelled && !session.restarting && code !== 0) {
          const detail = session.stderr.slice(-4).join('\n')
          this.emit({
            type: 'error',
            conversationId: session.conversationId,
            turnId: session.turnId,
            message: `The agent process exited with code ${code ?? 'unknown'}.`,
            detail: detail || undefined,
          })
        }
        this.finishTurn(session, wasCancelled ? false : code !== 0)
      }
      this.emit({
        type: 'exit',
        conversationId: session.conversationId,
        code,
        cancelled: wasCancelled,
      })
      log.info('agent', `Agent exited for ${session.conversationId} (code=${code}, cancelled=${wasCancelled})`)
    })

    return session
  }

  private finishTurn(session: Session, isError: boolean): void {
    const turnId = session.turnId
    if (!turnId) return
    session.busy = false
    if (session.endedTurns.has(turnId)) return
    session.endedTurns.add(turnId)
    this.emit({
      type: 'turn-end',
      conversationId: session.conversationId,
      turnId,
      isError,
      cancelled: session.cancelled,
      resultText: null,
      costUsd: null,
      durationMs: null,
      numTurns: null,
      inputTokens: null,
      outputTokens: null,
      permissionDenials: 0,
    })
  }

  private handleLine(session: Session, line: string): void {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(line) as Record<string, unknown>
    } catch {
      session.nonJson.push(line.slice(0, 400))
      if (session.nonJson.length > 20) session.nonJson.shift()
      return
    }

    const type = String(parsed.type ?? '')
    const turnId = session.turnId

    if (type === 'system') {
      const subtype = String(parsed.subtype ?? '')
      if (subtype === 'init') {
        const sessionId = typeof parsed.session_id === 'string' ? parsed.session_id : null
        if (sessionId) session.sessionId = sessionId
        const tools = Array.isArray(parsed.tools) ? parsed.tools.length : 0
        session.toolCount = tools
        this.emit({
          type: 'session',
          conversationId: session.conversationId,
          sessionId: sessionId ?? '',
          model: typeof parsed.model === 'string' ? parsed.model : null,
          cwd: typeof parsed.cwd === 'string' ? parsed.cwd : null,
          permissionMode: typeof parsed.permissionMode === 'string' ? parsed.permissionMode : null,
          toolCount: tools,
        })
      } else if (subtype === 'status') {
        const statusText = typeof parsed.status === 'string' ? parsed.status : 'working'
        this.emit({
          type: 'status',
          conversationId: session.conversationId,
          turnId,
          phase: 'working',
          detail: statusText,
        })
      }
      return
    }

    if (type === 'stream_event') {
      const event = parsed.event as Record<string, unknown> | undefined
      if (!event) return
      const apiMessageId =
        (typeof (event.message as Record<string, unknown> | undefined)?.id === 'string'
          ? ((event.message as Record<string, unknown>).id as string)
          : null) ??
        (typeof parsed.api_message_id === 'string' ? parsed.api_message_id : null) ??
        session.turnId ??
        'stream'

      switch (event.type) {
        case 'message_start': {
          this.emit({
            type: 'message-start',
            conversationId: session.conversationId,
            turnId: turnId ?? '',
            apiMessageId,
          })
          this.emit({
            type: 'status',
            conversationId: session.conversationId,
            turnId,
            phase: 'thinking',
          })
          return
        }
        case 'content_block_start': {
          const index = Number(event.index ?? 0)
          const block = (event.content_block ?? {}) as Record<string, unknown>
          const blockType = String(block.type ?? 'text')
          if (blockType === 'tool_use') {
            session.turnHadOutput = true
            const toolId = String(block.id ?? '')
            const name = String(block.name ?? 'tool')
            const map = this.toolsFor(session, apiMessageId)
            map.set(index, { id: toolId, name, json: '' })
            this.emit({
              type: 'block-start',
              conversationId: session.conversationId,
              turnId: turnId ?? '',
              apiMessageId,
              index,
              block: { kind: 'tool', toolId, name },
            })
            this.emit({
              type: 'status',
              conversationId: session.conversationId,
              turnId,
              phase: 'working',
              detail: name,
            })
          } else {
            this.emit({
              type: 'block-start',
              conversationId: session.conversationId,
              turnId: turnId ?? '',
              apiMessageId,
              index,
              block: { kind: blockType === 'thinking' ? 'thinking' : 'text' },
            })
          }
          return
        }
        case 'content_block_delta': {
          const index = Number(event.index ?? 0)
          const delta = (event.delta ?? {}) as Record<string, unknown>
          if (typeof delta.text === 'string' && delta.text) {
            session.turnText += delta.text
            this.emit({
              type: 'text-delta',
              conversationId: session.conversationId,
              turnId: turnId ?? '',
              apiMessageId,
              index,
              text: delta.text,
            })
          } else if (typeof delta.thinking === 'string' && delta.thinking) {
            session.turnHadOutput = true
            this.emit({
              type: 'thinking-delta',
              conversationId: session.conversationId,
              turnId: turnId ?? '',
              apiMessageId,
              index,
              text: delta.thinking,
            })
          } else if (typeof delta.partial_json === 'string') {
            const entry = this.toolsFor(session, apiMessageId).get(index)
            if (entry) entry.json += delta.partial_json
          }
          return
        }
        case 'content_block_stop': {
          const index = Number(event.index ?? 0)
          const entry = this.toolsFor(session, apiMessageId).get(index)
          if (entry) {
            let input: unknown = {}
            try {
              input = entry.json ? JSON.parse(entry.json) : {}
            } catch {
              input = { raw: entry.json }
            }
            this.emit({
              type: 'tool-input',
              conversationId: session.conversationId,
              turnId: turnId ?? '',
              toolId: entry.id,
              input,
            })
          }
          return
        }
        default:
          return
      }
    }

    if (type === 'assistant') {
      const message = (parsed.message ?? {}) as Record<string, unknown>
      const apiMessageId = typeof message.id === 'string' ? message.id : 'assistant'
      const content = Array.isArray(message.content) ? message.content : []
      const blocks: SnapshotBlock[] = []
      for (const raw of content) {
        if (!raw || typeof raw !== 'object') continue
        const block = raw as Record<string, unknown>
        if (block.type === 'text' && typeof block.text === 'string') {
          blocks.push({ kind: 'text', text: block.text })
        } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
          blocks.push({ kind: 'thinking', text: block.thinking })
        } else if (block.type === 'tool_use') {
          session.turnHadOutput = true
          blocks.push({
            kind: 'tool',
            id: String(block.id ?? ''),
            name: String(block.name ?? 'tool'),
            input: block.input ?? {},
          })
        }
      }
      this.emit({
        type: 'message-snapshot',
        conversationId: session.conversationId,
        turnId: turnId ?? '',
        apiMessageId,
        blocks,
        thinkingDurationMs: typeof parsed.thinking_duration_ms === 'number' ? parsed.thinking_duration_ms : null,
      })
      return
    }

    if (type === 'user') {
      const message = (parsed.message ?? {}) as Record<string, unknown>
      const content = Array.isArray(message.content) ? message.content : []
      for (const raw of content) {
        if (!raw || typeof raw !== 'object') continue
        const block = raw as Record<string, unknown>
        if (block.type !== 'tool_result') continue
        const toolId = String(block.tool_use_id ?? '')
        this.emit({
          type: 'tool-result',
          conversationId: session.conversationId,
          turnId: turnId ?? '',
          toolId,
          output: toolResultText(block.content),
          isError: Boolean(block.is_error),
        })
      }
      return
    }

    if (type === 'result') {
      const usage = (parsed.usage ?? {}) as Record<string, unknown>
      const isError = Boolean(parsed.is_error) || String(parsed.subtype ?? '') !== 'success'
      const denials = Array.isArray(parsed.permission_denials) ? parsed.permission_denials.length : 0
      const resultText = typeof parsed.result === 'string' ? parsed.result : ''
      const analysis = isError
        ? analyzeProviderFailure(resultText || session.turnText, Date.now())
        : null
      if (analysis) this.router.noteFailure(session.model, analysis)

      // A rate limit, exhausted quota or rejected key will not recover by
      // replaying the same provider, so switch to another free one first.
      if (
        turnId &&
        analysis &&
        (analysis.rateLimited || analysis.quotaExhausted || analysis.authFailed) &&
        this.tryFreeFallback(session, turnId, resultText, analysis)
      ) {
        return
      }

      // A transient provider failure that produced nothing useful is replayed
      // once in the same turn, so the UI never shows a failed turn for it.
      if (turnId && this.shouldRetryProviderFailure(session, isError, resultText)) {
        const retryLine = JSON.stringify({
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: RETRY_PROMPT }] },
        })
        session.turnAttempts = MAX_PROVIDER_RETRIES
        session.turnText = ''
        session.turnHadOutput = false
        try {
          session.proc.stdin?.write(`${retryLine}\n`)
          log.warn('agent', `Provider failure on ${session.conversationId} — retrying the turn once`)
          this.emit({
            type: 'turn-retry',
            conversationId: session.conversationId,
            turnId,
            reason: 'provider',
            // Kept for the usage monitor: the retry itself carries no error text.
            detail: resultText.slice(0, 900),
          })
          this.emit({
            type: 'status',
            conversationId: session.conversationId,
            turnId,
            phase: 'thinking',
            detail: 'retrying after a provider timeout',
          })
          return
        } catch (error) {
          log.warn('agent', `Automatic retry could not be sent: ${String(error)}`)
          this.emit({
            type: 'error',
            conversationId: session.conversationId,
            turnId,
            message: 'The provider request failed and the automatic retry could not reach the agent.',
            detail: resultText.slice(0, 400) || undefined,
          })
        }
      }

      // Server errors and timeouts get one replay on the same provider, then a
      // free fallback if that replay also failed.
      if (turnId && isError && analysis && this.tryFreeFallback(session, turnId, resultText, analysis)) {
        return
      }

      if (turnId && !session.endedTurns.has(turnId)) {
        session.endedTurns.add(turnId)
        session.busy = false
        if (!isError && !session.cancelled) this.router.noteSuccess(session.model)
        this.emit({
          type: 'turn-end',
          conversationId: session.conversationId,
          turnId,
          isError,
          cancelled: session.cancelled,
          resultText: typeof parsed.result === 'string' ? parsed.result.slice(0, 4000) : null,
          costUsd: typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : null,
          durationMs: typeof parsed.duration_ms === 'number' ? parsed.duration_ms : null,
          numTurns: typeof parsed.num_turns === 'number' ? parsed.num_turns : null,
          inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : null,
          outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : null,
          permissionDenials: denials,
        })
      }
      session.turnId = null
      this.scheduleIdleShutdown(session)
      return
    }
  }

  /**
   * Retry only when the turn failed for a transient upstream reason and had
   * produced no real output yet: no tool calls, and no text except the error
   * message itself.
   */
  /**
   * Restart the agent on another free model while resuming the same Claude
   * session, so the task context survives the provider change. Returns false
   * when no free alternative exists, in which case the caller must not retry on
   * a paid endpoint.
   */
  private tryFreeFallback(
    session: Session,
    turnId: string,
    resultText: string,
    analysis: ProviderFailureAnalysis,
  ): boolean {
    if (session.cancelled || session.fallbackCount >= MAX_FREE_FALLBACKS) return false
    if (!session.sessionId) {
      log.warn('agent', 'Free fallback skipped: the session id is not available yet')
      return false
    }
    if (!this.router.isFree(session.model)) return false
    const next = this.router.fallbackFor(session.model, session.turnText || '', false)
    if (!next) {
      if (analysis.rateLimited || analysis.quotaExhausted) {
        this.router.noteUnavailable('Every eligible free provider is cooling down or unconfigured.')
        this.emit({
          type: 'free-unavailable',
          conversationId: session.conversationId,
          turnId,
          message:
            'No other free provider is ready. Add another free key in FCC Admin or wait for the cooldown. This turn was not sent to a paid endpoint.',
        })
      }
      return false
    }

    const tool = resolveTool('claude')
    if (!tool.path) return false

    const from = session.model
    const resumeId = session.sessionId
    const cwd = session.cwd
    const dirs = [...session.dirs]
    const fallbackCount = session.fallbackCount + 1

    // Detach the old process without ending the turn. Its close handler must
    // not emit a turn-end for a turn that is now running on the new model.
    session.turnId = null
    session.restarting = true
    session.busy = false
    this.killTree(session)
    this.sessions.delete(session.conversationId)

    const nextSession = this.spawnSession({
      conversationId: session.conversationId,
      toolPath: tool.path,
      model: next.id,
      cwd,
      dirs,
      resumeId,
    })
    nextSession.turnId = turnId
    nextSession.busy = true
    nextSession.cancelled = false
    nextSession.fallbackCount = fallbackCount
    nextSession.turnAttempts = 0
    nextSession.turnHadOutput = false
    nextSession.turnText = ''
    this.sessions.set(session.conversationId, nextSession)

    this.router.noteFallback(from, next.id, `${analysis.kind}: ${analysis.detail ?? resultText.slice(0, 180)}`)
    this.emit({
      type: 'turn-retry',
      conversationId: session.conversationId,
      turnId,
      reason: 'fallback',
      detail: resultText.slice(0, 900),
    })
    this.emit({
      type: 'model-fallback',
      conversationId: session.conversationId,
      turnId,
      from,
      to: next.id,
      fromProvider: this.router.providerOf(from),
      toProvider: next.providerId,
      reason: analysis.summary,
    })
    this.emit({
      type: 'status',
      conversationId: session.conversationId,
      turnId,
      phase: 'thinking',
      detail: `switched to ${next.providerLabel}`,
    })

    const retryLine = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: RETRY_PROMPT }] },
    })
    try {
      nextSession.proc.stdin?.write(`${retryLine}\n`)
      log.warn('agent', `Free fallback on ${session.conversationId}: ${from} -> ${next.id}`)
      return true
    } catch (error) {
      log.error('agent', `Free fallback could not start: ${String(error)}`)
      this.killTree(nextSession)
      this.sessions.delete(nextSession.conversationId)
      this.emit({
        type: 'error',
        conversationId: session.conversationId,
        turnId,
        message: 'The free fallback provider could not be started. The turn was not sent to a paid endpoint.',
      })
      this.finishTurn(nextSession, true)
      return true
    }
  }

  private shouldRetryProviderFailure(session: Session, isError: boolean, resultText: string): boolean {
    if (!isError || session.cancelled) return false
    if (session.turnAttempts >= MAX_PROVIDER_RETRIES) return false
    if (session.turnHadOutput) return false
    const text = session.turnText.trim()
    if (text && !looksLikeProviderFailure(text)) return false
    return looksLikeProviderFailure(resultText) || looksLikeProviderFailure(text)
  }

  /** Release the agent process after a long idle period; the session resumes from disk. */
  private scheduleIdleShutdown(session: Session): void {
    if (session.idleTimer) clearTimeout(session.idleTimer)
    session.idleTimer = setTimeout(() => {
      if (session.busy) return
      if (this.sessions.get(session.conversationId) !== session) return
      log.info('agent', 'Idle timeout reached — releasing the agent process')
      session.restarting = true
      this.sessions.delete(session.conversationId)
      this.killTree(session)
    }, 20 * 60 * 1000)
    session.idleTimer.unref?.()
  }

  private toolsFor(session: Session, apiMessageId: string): Map<number, ToolAccumulator> {
    let map = session.toolByMessage.get(apiMessageId)
    if (!map) {
      map = new Map()
      session.toolByMessage.set(apiMessageId, map)
    }
    return map
  }

  private killTree(session: Session): void {
    const pid = session.proc.pid
    if (!pid) return
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      } else {
        session.proc.kill('SIGTERM')
      }
    } catch (error) {
      log.warn('agent', `Failed to terminate agent ${pid}: ${String(error)}`)
    }
  }
}
