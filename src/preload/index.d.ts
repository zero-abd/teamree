import type { TeamreeApi } from './index'

declare global {
  interface Window {
    teamree: TeamreeApi
  }
}

export {}
