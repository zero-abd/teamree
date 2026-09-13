// Which title strip we are drawing. Only macOS hides its title bar and keeps
// drawing window buttons over our content, so only macOS needs the inset that
// clears them.

import { isApplePlatform } from '../keyboard/platformModifier'

/** Class list for the strip, given the platform the bridge reported. */
export function titleBarClassName(platform: string | undefined): string {
  return isApplePlatform(platform) ? 'titlebar titlebar--mac' : 'titlebar'
}
