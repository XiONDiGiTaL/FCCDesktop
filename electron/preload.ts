import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type {
  AgentEvent,
  AppSettings,
  ConnectionStatus,
  DeepPartial,
  FccBridge,
} from '../src/shared/types'

const bridge: FccBridge = {
  app: {
    info: () => ipcRenderer.invoke('app:info'),
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
    onWindowState: (cb) => {
      const listener = (_event: Electron.IpcRendererEvent, state: { maximized: boolean; focused: boolean }) => cb(state)
      ipcRenderer.on('window:state', listener)
      return () => ipcRenderer.removeListener('window:state', listener)
    },
    openExternal: (url: string) => ipcRenderer.invoke('app:openExternal', url),
    openPath: (path: string) => ipcRenderer.invoke('app:openPath', path),
    copyText: (text: string) => ipcRenderer.invoke('app:copyText', text),
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (patch: DeepPartial<AppSettings>) => ipcRenderer.invoke('settings:update', patch),
    reset: () => ipcRenderer.invoke('settings:reset'),
  },
  secrets: {
    setProxyToken: (token: string) => ipcRenderer.invoke('secrets:setProxyToken', token),
    clearProxyToken: () => ipcRenderer.invoke('secrets:clearProxyToken'),
  },
  connection: {
    status: () => ipcRenderer.invoke('connection:status'),
    probe: () => ipcRenderer.invoke('connection:probe'),
    models: (force?: boolean) => ipcRenderer.invoke('connection:models', Boolean(force)),
    testModel: (modelId: string) => ipcRenderer.invoke('connection:testModel', modelId),
    startServer: () => ipcRenderer.invoke('connection:startServer'),
    stopServer: () => ipcRenderer.invoke('connection:stopServer'),
    detect: () => ipcRenderer.invoke('connection:detect'),
    onStatus: (cb) => {
      const listener = (_event: Electron.IpcRendererEvent, status: ConnectionStatus) => cb(status)
      ipcRenderer.on('connection:status', listener)
      return () => ipcRenderer.removeListener('connection:status', listener)
    },
  },
  dialogs: {
    pickFiles: () => ipcRenderer.invoke('dialog:pickFiles'),
    pickDirectory: () => ipcRenderer.invoke('dialog:pickDirectory'),
    pickExecutable: (kind) => ipcRenderer.invoke('dialog:pickExecutable', kind),
  },
  files: {
    describe: (paths: string[]) => ipcRenderer.invoke('files:describe', paths),
    thumbnail: (path: string) => ipcRenderer.invoke('files:thumbnail', path),
    reveal: (path: string) => ipcRenderer.invoke('files:reveal', path),
    pathForFile: (file: File) => {
      try {
        return webUtils.getPathForFile(file)
      } catch {
        return ''
      }
    },
  },
  skills: {
    catalog: (input) => ipcRenderer.invoke('skills:catalog', input ?? {}),
    detail: (id, projectPath) => ipcRenderer.invoke('skills:detail', id, projectPath ?? null),
    setEnabled: (id, enabled, projectPath, confirmExternal) =>
      ipcRenderer.invoke('skills:setEnabled', id, enabled, projectPath ?? null, Boolean(confirmExternal)),
    setAutoInvoke: (id, auto, projectPath) => ipcRenderer.invoke('skills:setAutoInvoke', id, auto, projectPath ?? null),
    setCategory: (id, category, projectPath) => ipcRenderer.invoke('skills:setCategory', id, category, projectPath ?? null),
    remove: (id, projectPath) => ipcRenderer.invoke('skills:remove', id, projectPath ?? null),
    update: (id, projectPath) => ipcRenderer.invoke('skills:update', id, projectPath ?? null),
    inspectRepo: (ref) => ipcRenderer.invoke('skills:inspectRepo', ref),
    installRepo: (input) => ipcRenderer.invoke('skills:installRepo', input),
    importLocal: (input) => ipcRenderer.invoke('skills:importLocal', input),
    importZip: (input) => ipcRenderer.invoke('skills:importZip', input),
    discover: (input) => ipcRenderer.invoke('skills:discover', input),
    categories: () => ipcRenderer.invoke('skills:categories'),
    pickImportFolder: () => ipcRenderer.invoke('skills:pickImportFolder'),
    pickImportArchive: () => ipcRenderer.invoke('skills:pickImportArchive'),
    onChanged: (cb) => {
      const listener = () => cb()
      ipcRenderer.on('skills:changed', listener)
      return () => ipcRenderer.removeListener('skills:changed', listener)
    },
  },
  conversations: {
    list: () => ipcRenderer.invoke('conversations:list'),
    get: (id: string) => ipcRenderer.invoke('conversations:get', id),
    create: (input) => ipcRenderer.invoke('conversations:create', input),
    update: (id: string, patch) => ipcRenderer.invoke('conversations:update', id, patch),
    remove: (id: string) => ipcRenderer.invoke('conversations:remove', id),
    clearAll: () => ipcRenderer.invoke('conversations:clearAll'),
    exportAll: () => ipcRenderer.invoke('conversations:exportAll'),
    onChanged: (cb) => {
      const listener = () => cb()
      ipcRenderer.on('conversations:changed', listener)
      return () => ipcRenderer.removeListener('conversations:changed', listener)
    },
  },
  agent: {
    send: (input) => ipcRenderer.invoke('agent:send', input),
    cancel: (conversationId: string) => ipcRenderer.invoke('agent:cancel', conversationId),
    interrupt: (conversationId: string) => ipcRenderer.invoke('agent:interrupt', conversationId),
    runtime: (conversationId: string) => ipcRenderer.invoke('agent:runtime', conversationId),
    onEvent: (cb: (event: AgentEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: AgentEvent) => cb(payload)
      ipcRenderer.on('agent:event', listener)
      return () => ipcRenderer.removeListener('agent:event', listener)
    },
  },
  diagnostics: {
    snapshot: () => ipcRenderer.invoke('diagnostics:snapshot'),
    copy: () => ipcRenderer.invoke('diagnostics:copy'),
  },
  storage: {
    openDataFolder: () => ipcRenderer.invoke('storage:openDataFolder'),
  },
}

contextBridge.exposeInMainWorld('fcc', bridge)
