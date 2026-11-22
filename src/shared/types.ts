/**
 * Shared contracts between the Electron main process and the renderer.
 * Nothing here may contain secrets: this module is bundled into the renderer.
 */

export const APP_NAME = 'FCC Desktop'
export const APP_ID = 'net.xiondigital.fccdesktop'

export type PermissionMode = 'bypassPermissions' | 'acceptEdits' | 'default' | 'plan'
export type ConnectionState = 'connected' | 'disconnected' | 'starting' | 'error'
export type Density = 'comfortable' | 'compact'

export interface Workspace {
  id: string
  name: string
  path: string
  addedAt: number
}

export interface ConnectionConfig {
  /** Hostname used to reach the FCC endpoint. */
  host: string
  /** Port used by the FCC proxy. */
  port: number
  /** Optional explicit base URL override; wins over host/port when set. */
  baseUrl: string
  /** Absolute path to fcc-server.exe. Empty means auto-detect. */
  serverExePath: string
  /** Absolute path to fcc-claude.exe. Empty means auto-detect. */
  claudeExePath: string
  /** Start FCC automatically when the app opens and no server answers. */
  autoStartServer: boolean
}

export interface AgentConfig {
  defaultModel: string
  permissionMode: PermissionMode
  /** Default working directory for new conversations. Empty means the user's home folder. */
  workingDirectory: string
  additionalDirs: string[]
  showThinking: boolean
}

export interface UiConfig {
  fontScale: number
  density: Density
  reducedMotion: boolean
  sidebarCollapsed: boolean
  activityOpen: boolean
}

export interface AppSettings {
  version: number
  connection: ConnectionConfig
  agent: AgentConfig
  ui: UiConfig
  workspaces: Workspace[]
}

export interface SecretStatus {
  hasProxyToken: boolean
  backend: 'dpapi' | 'unavailable'
}

export interface SettingsEnvelope {
  settings: AppSettings
  secrets: SecretStatus
}

export interface ServerInfo {
  status?: string
  provider?: string
  model?: string
}

export interface ConnectionStatus {
  state: ConnectionState
  baseUrl: string
  latencyMs: number | null
  provider: string | null
  serverModel: string | null
  modelCount: number | null
  message: string | null
  ownedByApp: boolean
  checkedAt: number
}

export interface ToolLocation {
  id: 'server' | 'claude'
  label: string
  path: string | null
  exists: boolean
  source: 'settings' | 'path' | 'default' | 'missing'
}

export interface DiagnosticsSnapshot {
  app: {
    version: string
    electron: string
    chrome: string
    node: string
    platform: string
    arch: string
    userData: string
  }
  connection: ConnectionStatus
  tools: ToolLocation[]
  logs: string[]
}

export interface ModelInfo {
  id: string
  displayName: string
  provider: string
  /** Model ids FCC exposes for a direct provider; grouped in the UI. */
  group: string
  noThinking: boolean
}

export interface ModelCatalog {
  models: ModelInfo[]
  fetchedAt: number
  error: string | null
}

export type AttachmentKind = 'image' | 'text' | 'code' | 'document' | 'archive' | 'binary' | 'other'

export interface Attachment {
  path: string
  name: string
  size: number
  ext: string
  kind: AttachmentKind
  isDirectory: boolean
}

export type MessageRole = 'user' | 'assistant' | 'system'
export type MessageStatus = 'complete' | 'streaming' | 'stopped' | 'error'

export interface ToolState {
  id: string
  name: string
  input: unknown
  inputComplete: boolean
  output: string | null
  status: 'running' | 'ok' | 'error'
}

export type MessageBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string; durationMs?: number }
  | { kind: 'tool'; tool: ToolState }

export interface MessageSegment {
  apiMessageId: string
  blocks: MessageBlock[]
}

export interface MessageMeta {
  model?: string
  costUsd?: number
  durationMs?: number
  numTurns?: number
  inputTokens?: number
  outputTokens?: number
  permissionDenials?: number
}

export interface ChatMessage {
  id: string
  role: MessageRole
  createdAt: number
  status: MessageStatus
  segments: MessageSegment[]
  attachments?: Attachment[]
  error?: string
  notice?: string
  meta?: MessageMeta
}

export interface QueuedMessage {
  id: string
  text: string
  attachments: Attachment[]
  createdAt: number
}

export interface ConversationSummary {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  pinned: boolean
  model: string
  workspacePath: string | null
  messageCount: number
  status: MessageStatus
}

export interface Conversation extends ConversationSummary {
  sessionId: string | null
  additionalDirs: string[]
  messages: ChatMessage[]
  /** Messages queued while a turn is running; persisted so a restart restores them. */
  queue: QueuedMessage[]
}

export interface CreateConversationInput {
  title?: string
  model?: string
  workspacePath?: string | null
}

export interface ConversationPatch {
  title?: string
  pinned?: boolean
  model?: string
  workspacePath?: string | null
  sessionId?: string | null
  additionalDirs?: string[]
  messages?: ChatMessage[]
  queue?: QueuedMessage[]
}

export interface SendPromptInput {
  conversationId: string
  /** Generated by the renderer so streaming events always match an existing message. */
  turnId: string
  text: string
  attachments: Attachment[]
  model: string
  workingDirectory: string
  additionalDirs: string[]
  resumeSessionId: string | null
}

export interface SendPromptResult {
  turnId: string
  sessionId: string | null
  workingDirectory: string
  addedDirs: string[]
  prompt: string
}

/** Snapshot of one assistant API message, used to replace streaming text with authoritative content. */
export type SnapshotBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; id: string; name: string; input: unknown }

export type AgentEvent =
  | {
      type: 'session'
      conversationId: string
      sessionId: string
      model: string | null
      cwd: string | null
      permissionMode: string | null
      toolCount: number
    }
  | { type: 'turn-start'; conversationId: string; turnId: string }
  | { type: 'message-start'; conversationId: string; turnId: string; apiMessageId: string }
  | {
      type: 'block-start'
      conversationId: string
      turnId: string
      apiMessageId: string
      index: number
      block: { kind: 'text' | 'thinking' | 'tool'; toolId?: string; name?: string }
    }
  | {
      type: 'text-delta' | 'thinking-delta'
      conversationId: string
      turnId: string
      apiMessageId: string
      index: number
      text: string
    }
  | {
      type: 'message-snapshot'
      conversationId: string
      turnId: string
      apiMessageId: string
      blocks: SnapshotBlock[]
      thinkingDurationMs: number | null
    }
  | { type: 'tool-input'; conversationId: string; turnId: string; toolId: string; input: unknown }
  | {
      type: 'tool-result'
      conversationId: string
      turnId: string
      toolId: string
      output: string
      isError: boolean
    }
  | {
      type: 'turn-end'
      conversationId: string
      turnId: string
      isError: boolean
      cancelled: boolean
      resultText: string | null
      costUsd: number | null
      durationMs: number | null
      numTurns: number | null
      inputTokens: number | null
      outputTokens: number | null
      permissionDenials: number
    }
  | {
      type: 'status'
      conversationId: string
      turnId: string | null
      phase: 'thinking' | 'working' | 'waiting'
      detail?: string
    }
  | { type: 'error'; conversationId: string; turnId: string | null; message: string; detail?: string }
  | { type: 'exit'; conversationId: string; code: number | null; cancelled: boolean }
  | { type: 'stderr'; conversationId: string; text: string }

export interface AgentRuntimeInfo {
  conversationId: string
  sessionId: string | null
  model: string | null
  workingDirectory: string | null
  additionalDirs: string[]
  busy: boolean
  startedAt: number | null
  toolCount: number
}

export interface ServerStartResult {
  started: boolean
  alreadyRunning: boolean
  message: string
  status: ConnectionStatus
}

export interface AppInfo {
  version: string
  platform: string
  userData: string
  models: number
}

/** The exact surface exposed on window.fcc by the preload script. */
export interface FccBridge {
  app: {
    info(): Promise<AppInfo>
    minimize(): void
    maximize(): void
    close(): void
    onWindowState(cb: (state: { maximized: boolean; focused: boolean }) => void): () => void
    openExternal(url: string): Promise<boolean>
    openPath(path: string): Promise<boolean>
    copyText(text: string): Promise<boolean>
  }
  settings: {
    get(): Promise<SettingsEnvelope>
    update(patch: DeepPartial<AppSettings>): Promise<SettingsEnvelope>
    reset(): Promise<SettingsEnvelope>
  }
  secrets: {
    setProxyToken(token: string): Promise<SecretStatus>
    clearProxyToken(): Promise<SecretStatus>
  }
  connection: {
    status(): Promise<ConnectionStatus>
    probe(): Promise<ConnectionStatus>
    models(force?: boolean): Promise<ModelCatalog>
    testModel(modelId: string): Promise<{ ok: boolean; message: string; latencyMs: number | null }>
    startServer(): Promise<ServerStartResult>
    stopServer(): Promise<ServerStartResult>
    detect(): Promise<ToolLocation[]>
    onStatus(cb: (status: ConnectionStatus) => void): () => void
  }
  dialogs: {
    pickFiles(): Promise<Attachment[]>
    pickDirectory(): Promise<string | null>
    pickExecutable(kind: 'server' | 'claude'): Promise<string | null>
  }
  files: {
    describe(paths: string[]): Promise<Attachment[]>
    thumbnail(path: string): Promise<string | null>
    reveal(path: string): Promise<boolean>
    pathForFile(file: File): string
  }
  conversations: {
    list(): Promise<ConversationSummary[]>
    get(id: string): Promise<Conversation | null>
    create(input: CreateConversationInput): Promise<Conversation>
    update(id: string, patch: ConversationPatch): Promise<Conversation | null>
    remove(id: string): Promise<boolean>
    clearAll(): Promise<boolean>
    exportAll(): Promise<boolean>
    onChanged(cb: () => void): () => void
  }
  agent: {
    send(input: SendPromptInput): Promise<SendPromptResult>
    cancel(conversationId: string): Promise<boolean>
    /** Stops the current turn but keeps the agent process and session alive. */
    interrupt(conversationId: string): Promise<boolean>
    runtime(conversationId: string): Promise<AgentRuntimeInfo | null>
    onEvent(cb: (event: AgentEvent) => void): () => void
  }
  diagnostics: {
    snapshot(): Promise<DiagnosticsSnapshot>
    copy(): Promise<boolean>
  }
  storage: {
    openDataFolder(): Promise<boolean>
  }
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K]
}
