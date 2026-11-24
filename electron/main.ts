import { app, BrowserWindow, Menu, session, shell } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { APP_ID } from '../src/shared/types'
import { getSettings } from './core/settings'
import { loadConversations, recoverTempFiles } from './core/conversations'
import { log } from './core/logger'
import { ConnectionManager } from './fcc/connection'
import { AgentManager } from './fcc/agent'
import { UsageMonitor } from './usage/service'
import { registerIpc } from './ipc'

const DEV_URL = process.env.VITE_DEV_SERVER_URL ?? ''
const isDev = Boolean(DEV_URL)

let mainWindow: BrowserWindow | null = null

app.setName('FCC Desktop')
app.setAppUserModelId(APP_ID)

const connection = new ConnectionManager()
const usage = new UsageMonitor(connection)

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

const agent = new AgentManager(connection, (event) => {
  // The monitor only observes the stream; it never delays or alters a turn.
  try {
    usage.observe(event)
  } catch (error) {
    log.warn('usage', `Usage observation failed: ${String(error)}`)
  }
  broadcast('agent:event', event)
})

function installContentSecurityPolicy(): void {
  const devOrigins = 'http://localhost:5273 http://127.0.0.1:5273'
  const policy = isDev
    ? [
        `default-src 'self' ${devOrigins}`,
        `script-src 'self' 'unsafe-inline' ${devOrigins}`,
        `style-src 'self' 'unsafe-inline' ${devOrigins}`,
        `img-src 'self' data: blob: ${devOrigins}`,
        `font-src 'self' data: ${devOrigins}`,
        `connect-src 'self' ws://localhost:5273 ws://127.0.0.1:5273 ${devOrigins}`,
        `object-src 'none'`,
        `base-uri 'none'`,
        `form-action 'none'`,
      ].join('; ')
    : [
        `default-src 'self'`,
        `script-src 'self'`,
        `style-src 'self' 'unsafe-inline'`,
        `img-src 'self' data: blob:`,
        `font-src 'self' data:`,
        `connect-src 'none'`,
        `object-src 'none'`,
        `base-uri 'none'`,
        `form-action 'none'`,
      ].join('; ')

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [policy],
      },
    })
  })
}

function createWindow(): BrowserWindow {
  const settings = getSettings()
  const iconPath = join(__dirname, '../../build/icon.png')

  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 660,
    show: false,
    frame: false,
    backgroundColor: '#050607',
    title: 'FCC Desktop',
    autoHideMenuBar: true,
    ...(existsSync(iconPath) ? { icon: iconPath } : {}),
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: true,
      devTools: isDev,
    },
  })

  win.once('ready-to-show', () => {
    win.show()
    if (settings.ui.sidebarCollapsed) win.webContents.send('window:state', { maximized: false, focused: true })
  })

  const sendState = (): void => {
    if (!win.isDestroyed()) {
      win.webContents.send('window:state', { maximized: win.isMaximized(), focused: win.isFocused() })
    }
  }
  win.on('maximize', sendState)
  win.on('unmaximize', sendState)
  win.on('focus', sendState)
  win.on('blur', sendState)

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  win.webContents.on('will-navigate', (event, url) => {
    const allowed = isDev ? url.startsWith(DEV_URL) : url.startsWith('file://')
    if (!allowed) {
      event.preventDefault()
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    }
  })

  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    if (isDev && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) {
      win.webContents.toggleDevTools()
      event.preventDefault()
    }
    if (isDev && input.control && input.key.toLowerCase() === 'r') {
      win.webContents.reload()
      event.preventDefault()
    }
  })

  win.webContents.on('render-process-gone', (_event, details) => {
    log.error('main', `Renderer process gone: ${details.reason}`)
  })

  if (isDev) {
    void win.loadURL(DEV_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })

  return win
}

function bootstrap(): void {
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null)
    installContentSecurityPolicy()
    recoverTempFiles()
    loadConversations()

    connection.bind((status) => broadcast('connection:status', status))

    mainWindow = createWindow()

    registerIpc({
      connection,
      agent,
      usage,
      getWindow: () => mainWindow,
      broadcastConversations: () => broadcast('conversations:changed', null),
    })

    usage.start()

    connection.startPolling()
    const status = await connection.probe()
    log.info('main', `FCC endpoint ${status.baseUrl} is ${status.state}`)

    if (status.state !== 'connected' && getSettings().connection.autoStartServer) {
      log.info('main', 'Auto-starting FCC because no endpoint answered')
      const result = await connection.startServer()
      log.info('main', `Auto-start result: ${result.message}`)
      if (mainWindow) mainWindow.webContents.send('connection:status', result.status)
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createWindow()
      }
    })
  })

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  let cleanedUp = false
  app.on('before-quit', () => {
    if (cleanedUp) return
    cleanedUp = true
    agent.disposeAll()
    usage.stop()
    connection.dispose()
  })

  process.on('unhandledRejection', (reason) => {
    log.error('main', `Unhandled rejection: ${String(reason)}`)
  })
  process.on('uncaughtException', (error) => {
    log.error('main', `Uncaught exception: ${error.stack ?? error.message}`)
  })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  bootstrap()
}
