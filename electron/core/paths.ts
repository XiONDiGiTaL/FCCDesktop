import { app } from 'electron'
import { join } from 'node:path'

export const dataRoot = (): string => join(app.getPath('userData'), 'data')
export const settingsPath = (): string => join(dataRoot(), 'settings.json')
export const secretsPath = (): string => join(dataRoot(), 'secrets.json')
export const conversationsDir = (): string => join(dataRoot(), 'conversations')
export const logsDir = (): string => join(app.getPath('userData'), 'logs')
