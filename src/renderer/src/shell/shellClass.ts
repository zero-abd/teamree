// Which chrome the shell draws around itself. Only macOS hides its title bar
// and keeps drawing the window buttons over our content, so only macOS needs
// the inset that clears them — and where that inset goes depends on whether the
// sidebar is there to take it: its header while it is, the pane strip beside
// it once it is away. The stylesheet keys on both classes together.

import { isApplePlatform } from '../keyboard/platformModifier'

/** Class list for the shell, given the platform the bridge reported. */
export function shellClassName(platform: string | undefined, sidebarVisible: boolean): string {
  const classes = ['shell']
  if (isApplePlatform(platform)) classes.push('shell--mac')
  if (!sidebarVisible) classes.push('shell--collapsed')
  return classes.join(' ')
}
