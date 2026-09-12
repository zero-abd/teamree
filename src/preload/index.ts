import { contextBridge } from 'electron'

const api = {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  }
} as const

export type TeamreeApi = typeof api

contextBridge.exposeInMainWorld('teamree', api)
