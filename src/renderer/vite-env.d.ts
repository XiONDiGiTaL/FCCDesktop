/// <reference types="vite/client" />
import type { FccBridge } from '../shared/types'

declare global {
  interface Window {
    fcc: FccBridge
  }
}

export {}
