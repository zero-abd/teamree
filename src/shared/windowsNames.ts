// The names Windows will not give a file, whatever the extension.
//
// Shared because two different naming rules have to obey it and one of them is
// now read by the window: a worktree's directory and its loose ref file, and a
// member key's filename. A name that works on one machine and not another
// splits the team, so the check lives in one place rather than being restated
// wherever a name is made.

/**
 * Windows refuses to create a file or directory whose name is a DOS device,
 * whatever the extension — `nul.pub` included.
 */
const WINDOWS_DEVICE_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  ...Array.from({ length: 10 }, (_, index) => `com${index}`),
  ...Array.from({ length: 10 }, (_, index) => `lpt${index}`)
])

export function isWindowsDeviceName(name: string): boolean {
  return WINDOWS_DEVICE_NAMES.has(name.toLowerCase())
}
