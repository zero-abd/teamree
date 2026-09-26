// Whether Electron needs a virtual display here (no X server kills it with SIGSEGV), and what to launch
// it with, for a smoke run in a headless Linux container; macOS never fires this.
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

/** The first `name` on PATH, or undefined. */
function onPath(name, pathValue) {
  for (const directory of (pathValue ?? '').split(delimiter)) {
    if (!directory) continue
    const candidate = join(directory, name)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/** How to launch `command` on the given machine, a parameter so it is testable anywhere. */
export function displayPlan(command, args, machine = {}) {
  const { platform = process.platform, env = process.env, lookup = onPath } = machine

  const headless = platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY
  if (!headless) return { command, args }

  const xvfbRun = lookup('xvfb-run', env.PATH)
  if (!xvfbRun) {
    return {
      command,
      args,
      advice:
        'this machine has no display and no xvfb-run to make one; ' +
        'Electron is about to fail for want of one. Install xvfb, or set $DISPLAY to a server that exists.'
    }
  }

  // `-a` picks a free display number so concurrent runs cannot collide.
  return {
    command: xvfbRun,
    args: ['-a', command, ...args],
    note: `no display on this machine; running Electron under ${xvfbRun}`
  }
}
