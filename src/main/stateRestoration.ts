import type { SystemPreferences } from 'electron'

/**
 * Turns off AppKit's window restoration; windowState.ts and the runtime bring back what teamree needs.
 * AppKit asks talagentd on the main thread before `ready`, and a talagentd stuck on the keychain held launch for hours.
 */
export function optOutOfStateRestoration(
  platform: NodeJS.Platform,
  preferences: Pick<SystemPreferences, 'registerDefaults'>
): void {
  if (platform === 'darwin') preferences.registerDefaults({ ApplePersistence: false })
}
