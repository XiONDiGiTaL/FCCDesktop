import { BrowserWindow, clipboard, dialog, ipcMain, shell, app } from 'electron'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, extname, isAbsolute, normalize } from 'node:path'
import { writeFileSync } from 'node:fs'
import type {
  AppInfo,
  AppSettings,
  Attachment,
  AttachmentKind,
  ChatMessage,
  ConnectionStatus,
  Conversation,
  ConversationPatch,
  CreateConversationInput,
  DeepPartial,
  DiagnosticsSnapshot,
  ModelCatalog,
  SendPromptInput,
  SendPromptResult,
  ServerStartResult,
  SettingsEnvelope,
  ToolLocation,
} from '../src/shared/types'
import { getSettings, resetSettings, updateSettings } from './core/settings'
import { getProxyToken, clearProxyToken, secretStatus, setProxyToken } from './core/secrets'
import {
  clearConversations,
  createConversation,
  deleteConversation,
  exportConversations,
  getConversation,
  listConversations,
  loadConversations,
  updateConversation,
} from './core/conversations'
import { detectTools } from './fcc/discovery'
import type { ConnectionManager } from './fcc/connection'
import type { AgentManager } from './fcc/agent'
import { log, logTail } from './core/logger'
import { dataRoot } from './core/paths'

const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'css', 'scss', 'html', 'py', 'rs', 'go', 'java',
  'c', 'h', 'cpp', 'cs', 'rb', 'php', 'sh', 'ps1', 'bat', 'yml', 'yaml', 'toml', 'sql', 'xml', 'lua',
])
const TEXT_EXTENSIONS = new Set(['txt', 'md', 'markdown', 'log', 'csv', 'ini', 'cfg', 'env', 'rst'])
const DOC_EXTENSIONS = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'rtf', 'odt'])
const ARCHIVE_EXTENSIONS = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'])
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif'])

function kindOf(ext: string): AttachmentKind {
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (CODE_EXTENSIONS.has(ext)) return 'code'
  if (TEXT_EXTENSIONS.has(ext)) return 'text'
  if (DOC_EXTENSIONS.has(ext)) return 'document'
  if (ARCHIVE_EXTENSIONS.has(ext)) return 'archive'
  return 'other'
}

function describePath(raw: unknown): Attachment | null {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 1024) return null
  if (!isAbsolute(raw)) return null
  const path = normalize(raw)
  try {
    const stats = statSync(path)
    const ext = extname(path).slice(1).toLowerCase()
    return {
      path,
      name: basename(path),
      size: stats.isDirectory() ? 0 : stats.size,
      ext,
      kind: stats.isDirectory() ? 'other' : kindOf(ext),
      isDirectory: stats.isDirectory(),
    }
  } catch {
    return null
  }
}

function describeMany(paths: unknown): Attachment[] {
  if (!Array.isArray(paths)) return []
  return paths
    .slice(0, 40)
    .map(describePath)
    .filter((value): value is Attachment => value !== null)
}

function windowOf(event: Electron.IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender)
}

function openDialog(
  win: BrowserWindow | null,
  options: Electron.OpenDialogOptions,
): Promise<Electron.OpenDialogReturnValue> {
  return win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options)
}

function saveDialog(
  win: BrowserWindow | null,
  options: Electron.SaveDialogOptions,
): Promise<Electron.SaveDialogReturnValue> {
  return win ? dialog.showSaveDialog(win, options) : dialog.showSaveDialog(options)
}

function sanitizeSettingsPatch(patch: unknown): DeepPartial<AppSettings> {
  if (!patch || typeof patch !== 'object') return {}
  return patch as DeepPartial<AppSettings>
}

export interface IpcDeps {
  connection: ConnectionManager
  agent: AgentManager
  getWindow: () => BrowserWindow | null
  broadcastConversations: () => void
}

export function registerIpc({ connection, agent, getWindow, broadcastConversations }: IpcDeps): void {
  loadConversations()

  // ---------------------------------------------------------------- app shell
  ipcMain.handle('app:info', (): AppInfo => {
    const models = connection.current().modelCount ?? 0
    return {
      version: app.getVersion(),
      platform: process.platform,
      userData: app.getPath('userData'),
      models,
    }
  })

  ipcMain.on('window:minimize', () => getWindow()?.minimize())
  ipcMain.on('window:maximize', () => {
    const win = getWindow()
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.on('window:close', () => getWindow()?.close())

  ipcMain.handle('app:openExternal', async (_event, url: unknown) => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url) || url.length > 2048) return false
    await shell.openExternal(url)
    return true
  })

  ipcMain.handle('app:openPath', async (_event, path: unknown) => {
    if (typeof path !== 'string' || !isAbsolute(path) || !existsSync(path)) return false
    const error = await shell.openPath(path)
    return error === ''
  })

  ipcMain.handle('app:copyText', (_event, text: unknown) => {
    if (typeof text !== 'string' || text.length > 400000) return false
    clipboard.writeText(text)
    return true
  })

  ipcMain.handle('storage:openDataFolder', async () => {
    const path = dataRoot()
    const error = await shell.openPath(path)
    return error === ''
  })

  // ---------------------------------------------------------------- settings
  ipcMain.handle('settings:get', (): SettingsEnvelope => ({ settings: getSettings(), secrets: secretStatus() }))

  ipcMain.handle('settings:update', (_event, patch: unknown): SettingsEnvelope => {
    const settings = updateSettings(sanitizeSettingsPatch(patch))
    log.info('settings', 'Settings updated')
    return { settings, secrets: secretStatus() }
  })

  ipcMain.handle('settings:reset', (): SettingsEnvelope => ({
    settings: resetSettings(),
    secrets: secretStatus(),
  }))

  ipcMain.handle('secrets:setProxyToken', (_event, token: unknown) => {
    if (typeof token !== 'string' || token.length > 512) throw new Error('Invalid token payload.')
    return setProxyToken(token)
  })

  ipcMain.handle('secrets:clearProxyToken', () => clearProxyToken())

  // -------------------------------------------------------------- connection
  ipcMain.handle('connection:status', (): ConnectionStatus => connection.current())
  ipcMain.handle('connection:probe', async (): Promise<ConnectionStatus> => connection.probe())
  ipcMain.handle('connection:models', async (_event, force: unknown): Promise<ModelCatalog> =>
    connection.models(Boolean(force)),
  )
  ipcMain.handle('connection:testModel', async (_event, modelId: unknown) => {
    if (typeof modelId !== 'string' || !modelId.trim()) {
      return { ok: false, message: 'Select a model first.', latencyMs: null }
    }
    return connection.testModel(modelId)
  })
  ipcMain.handle('connection:startServer', (): Promise<ServerStartResult> => connection.startServer())
  ipcMain.handle('connection:stopServer', (): Promise<ServerStartResult> => connection.stopServer())
  ipcMain.handle('connection:detect', (): ToolLocation[] => detectTools())

  // ----------------------------------------------------------------- dialogs
  ipcMain.handle('dialog:pickFiles', async (event): Promise<Attachment[]> => {
    const win = windowOf(event) ?? getWindow()
    const result = await openDialog(win, {
      title: 'Attach files',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'All files', extensions: ['*'] },
        { name: 'Text and code', extensions: [...TEXT_EXTENSIONS, ...CODE_EXTENSIONS].slice(0, 60) },
        { name: 'Images', extensions: [...IMAGE_EXTENSIONS] },
      ],
    })
    if (result.canceled) return []
    return describeMany(result.filePaths)
  })

  ipcMain.handle('dialog:pickDirectory', async (event): Promise<string | null> => {
    const win = windowOf(event) ?? getWindow()
    const result = await openDialog(win, {
      title: 'Choose a folder',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || !result.filePaths[0]) return null
    return normalize(result.filePaths[0])
  })

  ipcMain.handle('dialog:pickExecutable', async (event, kind: unknown): Promise<string | null> => {
    const win = windowOf(event) ?? getWindow()
    const name = kind === 'server' ? 'fcc-server.exe' : 'fcc-claude.exe'
    const result = await openDialog(win, {
      title: `Locate ${name}`,
      properties: ['openFile'],
      filters: [{ name: 'Executable', extensions: ['exe'] }],
    })
    if (result.canceled || !result.filePaths[0]) return null
    return normalize(result.filePaths[0])
  })

  // ------------------------------------------------------------------- files
  ipcMain.handle('files:describe', (_event, paths: unknown) => describeMany(paths))

  ipcMain.handle('files:thumbnail', (_event, path: unknown): string | null => {
    const attachment = describePath(path)
    if (!attachment || attachment.isDirectory || attachment.kind !== 'image') return null
    if (attachment.size > 12 * 1024 * 1024) return null
    const mime: Record<string, string> = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
      bmp: 'image/bmp',
      svg: 'image/svg+xml',
      ico: 'image/x-icon',
      avif: 'image/avif',
    }
    const type = mime[attachment.ext]
    if (!type) return null
    try {
      const data = readFileSync(attachment.path).toString('base64')
      return `data:${type};base64,${data}`
    } catch {
      return null
    }
  })

  ipcMain.handle('files:reveal', (_event, path: unknown) => {
    const attachment = describePath(path)
    if (!attachment) return false
    shell.showItemInFolder(attachment.path)
    return true
  })

  // ----------------------------------------------------------- conversations
  ipcMain.handle('conversations:list', () => listConversations())

  ipcMain.handle('conversations:get', (_event, id: unknown): Conversation | null => {
    if (typeof id !== 'string') return null
    return getConversation(id)
  })

  ipcMain.handle('conversations:create', (_event, input: unknown): Conversation => {
    const safe = (input && typeof input === 'object' ? input : {}) as CreateConversationInput
    const conversation = createConversation({
      title: typeof safe.title === 'string' ? safe.title.slice(0, 200) : undefined,
      model: typeof safe.model === 'string' ? safe.model.slice(0, 200) : undefined,
      workspacePath: typeof safe.workspacePath === 'string' ? safe.workspacePath : null,
    })
    broadcastConversations()
    return conversation
  })

  ipcMain.handle('conversations:update', (_event, id: unknown, patch: unknown): Conversation | null => {
    if (typeof id !== 'string' || !patch || typeof patch !== 'object') return null
    const safe = patch as ConversationPatch
    const cleaned: ConversationPatch = {}
    if (typeof safe.title === 'string') cleaned.title = safe.title.slice(0, 200)
    if (typeof safe.pinned === 'boolean') cleaned.pinned = safe.pinned
    if (typeof safe.model === 'string') cleaned.model = safe.model.slice(0, 200)
    if (safe.workspacePath === null || typeof safe.workspacePath === 'string') cleaned.workspacePath = safe.workspacePath
    if (safe.sessionId === null || typeof safe.sessionId === 'string') cleaned.sessionId = safe.sessionId
    if (Array.isArray(safe.additionalDirs)) {
      cleaned.additionalDirs = safe.additionalDirs.filter((value): value is string => typeof value === 'string')
    }
    if (Array.isArray(safe.messages)) {
      cleaned.messages = (safe.messages as ChatMessage[]).slice(-4000)
    }
    const updated = updateConversation(id, cleaned)
    broadcastConversations()
    return updated
  })

  ipcMain.handle('conversations:remove', (_event, id: unknown) => {
    if (typeof id !== 'string') return false
    agent.cancel(id)
    const removed = deleteConversation(id)
    if (removed) broadcastConversations()
    return removed
  })

  ipcMain.handle('conversations:clearAll', () => {
    const all = listConversations()
    for (const conversation of all) agent.cancel(conversation.id)
    const result = clearConversations()
    broadcastConversations()
    return result
  })

  ipcMain.handle('conversations:exportAll', async (event) => {
    const win = windowOf(event) ?? getWindow()
    const result = await saveDialog(win, {
      title: 'Export conversations',
      defaultPath: `fcc-desktop-conversations-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (result.canceled || !result.filePath) return false
    try {
      writeFileSync(result.filePath, exportConversations(), 'utf8')
      return true
    } catch (error) {
      log.error('conversations', `Export failed: ${String(error)}`)
      return false
    }
  })

  // ------------------------------------------------------------------- agent
  ipcMain.handle('agent:send', async (_event, input: unknown): Promise<SendPromptResult> => {
    if (!input || typeof input !== 'object') throw new Error('Invalid prompt payload.')
    const payload = input as SendPromptInput
    if (typeof payload.conversationId !== 'string' || !payload.conversationId) throw new Error('Missing conversation id.')
    if (typeof payload.turnId !== 'string' || !/^[A-Za-z0-9_-]{6,64}$/.test(payload.turnId)) throw new Error('Invalid turn id.')
    if (typeof payload.text !== 'string' || !payload.text.trim()) throw new Error('Message is empty.')
    if (payload.text.length > 200000) throw new Error('Message is too long (200,000 character limit).')
    const sanitized: SendPromptInput = {
      conversationId: payload.conversationId,
      turnId: payload.turnId,
      text: payload.text,
      attachments: describeMany(Array.isArray(payload.attachments) ? payload.attachments.map((a) => a?.path) : []),
      model: typeof payload.model === 'string' ? payload.model.slice(0, 200) : '',
      workingDirectory: typeof payload.workingDirectory === 'string' ? payload.workingDirectory : '',
      additionalDirs: Array.isArray(payload.additionalDirs)
        ? payload.additionalDirs.filter((value): value is string => typeof value === 'string').slice(0, 20)
        : [],
      resumeSessionId: typeof payload.resumeSessionId === 'string' ? payload.resumeSessionId : null,
    }
    try {
      const result = await agent.send(sanitized)
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.warn('agent', `Send failed: ${message}`)
      throw new Error(message)
    }
  })

  ipcMain.handle('agent:cancel', (_event, conversationId: unknown) => {
    if (typeof conversationId !== 'string') return false
    return agent.cancel(conversationId)
  })

  ipcMain.handle('agent:runtime', (_event, conversationId: unknown) => {
    if (typeof conversationId !== 'string') return null
    return agent.runtime(conversationId)
  })

  // ------------------------------------------------------------- diagnostics
  ipcMain.handle('diagnostics:snapshot', (): DiagnosticsSnapshot => ({
    app: {
      version: app.getVersion(),
      electron: process.versions.electron ?? '',
      chrome: process.versions.chrome ?? '',
      node: process.versions.node ?? '',
      platform: process.platform,
      arch: process.arch,
      userData: app.getPath('userData'),
    },
    connection: connection.current(),
    tools: detectTools(),
    logs: [...logTail(), ...connection.serverDiagnostics().slice(-40)],
  }))

  ipcMain.handle('diagnostics:copy', () => {
    const snapshot: DiagnosticsSnapshot = {
      app: {
        version: app.getVersion(),
        electron: process.versions.electron ?? '',
        chrome: process.versions.chrome ?? '',
        node: process.versions.node ?? '',
        platform: process.platform,
        arch: process.arch,
        userData: app.getPath('userData'),
      },
      connection: connection.current(),
      tools: detectTools(),
      logs: logTail(),
    }
    clipboard.writeText(JSON.stringify(snapshot, null, 2))
    return true
  })

  log.info('ipc', `Registered IPC handlers (token configured: ${getProxyToken() ? 'yes' : 'no'})`)
}
