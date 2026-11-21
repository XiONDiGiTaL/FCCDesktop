import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { conversationsDir } from './paths'
import { writeJsonAtomic } from './atomic'
import { log } from './logger'
import type {
  ChatMessage,
  Conversation,
  ConversationPatch,
  ConversationSummary,
  CreateConversationInput,
  MessageSegment,
} from '../../src/shared/types'

const MAX_MESSAGES = 4000

const store = new Map<string, Conversation>()
let loaded = false

function fileFor(id: string): string {
  return join(conversationsDir(), `${id}.json`)
}

function isSafeId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{6,64}$/.test(id)
}

function sanitizeSegment(input: unknown): MessageSegment | null {
  if (!input || typeof input !== 'object') return null
  const record = input as Record<string, unknown>
  const apiMessageId = typeof record.apiMessageId === 'string' ? record.apiMessageId : 'unknown'
  const blocks = Array.isArray(record.blocks) ? record.blocks : []
  return { apiMessageId, blocks: blocks as MessageSegment['blocks'] }
}

function sanitizeMessage(input: unknown): ChatMessage | null {
  if (!input || typeof input !== 'object') return null
  const record = input as Record<string, unknown>
  if (typeof record.id !== 'string' || typeof record.role !== 'string') return null
  if (record.role !== 'user' && record.role !== 'assistant' && record.role !== 'system') return null
  const segments = Array.isArray(record.segments)
    ? record.segments.map(sanitizeSegment).filter((s): s is MessageSegment => s !== null)
    : []
  return {
    id: record.id,
    role: record.role,
    createdAt: typeof record.createdAt === 'number' ? record.createdAt : Date.now(),
    status: record.status === 'streaming' ? 'stopped' : (record.status as ChatMessage['status']) ?? 'complete',
    segments,
    attachments: Array.isArray(record.attachments) ? (record.attachments as ChatMessage['attachments']) : undefined,
    error: typeof record.error === 'string' ? record.error : undefined,
    notice: typeof record.notice === 'string' ? record.notice : undefined,
    meta: record.meta && typeof record.meta === 'object' ? (record.meta as ChatMessage['meta']) : undefined,
  }
}

export function loadConversations(): void {
  if (loaded) return
  loaded = true
  const dir = conversationsDir()
  mkdirSync(dir, { recursive: true })
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.json')) continue
    const id = entry.slice(0, -5)
    if (!isSafeId(id)) continue
    try {
      const parsed = JSON.parse(readFileSync(join(dir, entry), 'utf8')) as Conversation
      store.set(id, {
        id,
        title: typeof parsed.title === 'string' && parsed.title ? parsed.title : 'Untitled',
        createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : Date.now(),
        updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now(),
        pinned: Boolean(parsed.pinned),
        model: typeof parsed.model === 'string' ? parsed.model : '',
        workspacePath: typeof parsed.workspacePath === 'string' ? parsed.workspacePath : null,
        messageCount: Array.isArray(parsed.messages) ? parsed.messages.length : 0,
        status: 'complete',
        sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : null,
        additionalDirs: Array.isArray(parsed.additionalDirs)
          ? parsed.additionalDirs.filter((v): v is string => typeof v === 'string')
          : [],
        messages: Array.isArray(parsed.messages)
          ? parsed.messages.map(sanitizeMessage).filter((m): m is ChatMessage => m !== null)
          : [],
      })
    } catch (error) {
      log.warn('conversations', `Skipping unreadable conversation ${entry}: ${String(error)}`)
    }
  }
  log.info('conversations', `Loaded ${store.size} conversation(s)`)
}

function summary(conversation: Conversation): ConversationSummary {
  const { messages, sessionId: _sessionId, additionalDirs: _dirs, ...rest } = conversation
  void _sessionId
  void _dirs
  return { ...rest, messageCount: messages.length, status: 'complete' }
}

export function listConversations(): ConversationSummary[] {
  loadConversations()
  return Array.from(store.values())
    .map(summary)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
}

export function getConversation(id: string): Conversation | null {
  loadConversations()
  if (!isSafeId(id)) return null
  return store.get(id) ?? null
}

export function createConversation(input: CreateConversationInput): Conversation {
  loadConversations()
  const now = Date.now()
  const conversation: Conversation = {
    id: randomUUID(),
    title: (input.title ?? '').trim() || 'New conversation',
    createdAt: now,
    updatedAt: now,
    pinned: false,
    model: (input.model ?? '').trim(),
    workspacePath: input.workspacePath ?? null,
    messageCount: 0,
    status: 'complete',
    sessionId: null,
    additionalDirs: [],
    messages: [],
  }
  store.set(conversation.id, conversation)
  writeJsonAtomic(fileFor(conversation.id), conversation)
  return conversation
}

export function updateConversation(id: string, patch: ConversationPatch): Conversation | null {
  loadConversations()
  const existing = store.get(id)
  if (!existing) return null
  const next: Conversation = { ...existing }
  if (typeof patch.title === 'string') next.title = patch.title.trim().slice(0, 200) || 'Untitled'
  if (typeof patch.pinned === 'boolean') next.pinned = patch.pinned
  if (typeof patch.model === 'string') next.model = patch.model
  if (patch.workspacePath !== undefined) {
    next.workspacePath = typeof patch.workspacePath === 'string' && patch.workspacePath ? patch.workspacePath : null
  }
  if (patch.sessionId !== undefined) {
    next.sessionId = typeof patch.sessionId === 'string' && patch.sessionId ? patch.sessionId : null
  }
  if (Array.isArray(patch.additionalDirs)) {
    next.additionalDirs = Array.from(
      new Set(patch.additionalDirs.filter((v): v is string => typeof v === 'string' && v !== '')),
    ).slice(0, 20)
  }
  if (Array.isArray(patch.messages)) {
    next.messages = patch.messages.slice(-MAX_MESSAGES)
  }
  next.updatedAt = Date.now()
  store.set(id, next)
  try {
    writeJsonAtomic(fileFor(id), next)
  } catch (error) {
    log.error('conversations', `Failed to save conversation ${id}: ${String(error)}`)
  }
  return next
}

export function deleteConversation(id: string): boolean {
  loadConversations()
  if (!isSafeId(id) || !store.delete(id)) return false
  try {
    rmSync(fileFor(id), { force: true })
  } catch (error) {
    log.warn('conversations', `Failed to remove conversation file: ${String(error)}`)
  }
  return true
}

export function clearConversations(): boolean {
  loadConversations()
  const dir = conversationsDir()
  for (const id of Array.from(store.keys())) {
    try {
      rmSync(fileFor(id), { force: true })
    } catch {
      /* ignore individual failures */
    }
  }
  store.clear()
  // Remove any orphaned files left by interrupted writes.
  try {
    for (const entry of existsSync(dir) ? readdirSync(dir) : []) {
      if (entry.endsWith('.tmp')) rmSync(join(dir, entry), { force: true })
    }
  } catch {
    /* ignore */
  }
  return true
}

export function exportConversations(): string {
  loadConversations()
  return JSON.stringify(Array.from(store.values()), null, 2)
}

/** Used when a crash leaves a half-written temp file behind. */
export function recoverTempFiles(): void {
  const dir = conversationsDir()
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('.tmp')) continue
    try {
      renameSync(join(dir, entry), join(dir, entry.replace(/\.tmp$/, '')))
    } catch {
      /* ignore */
    }
  }
}
