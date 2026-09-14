// Whether Electron needs a display put in front of it on this machine, and what
// to launch it with.
//
// Electron is a window. With no X server and no `$DISPLAY` it prints "Missing X
// server or $DISPLAY" and dies of SIGSEGV before the main script is evaluated,
// so the smoke test — the one gate that boots the app — cannot run in a
// container at all.
//
// That is worth adapting to rather than documenting, because of how this
// project is checked. There is no CI; `scripts/release.mjs` explains why every
// gate moved onto the machine cutting the release. So the only checks that
// exist are the ones a person or an agent runs locally, and a growing share of
// that runs in headless Linux containers. A gate that cannot start there is a
// gate those runs silently skip, and the next person to notice is whoever the
// release reaches.
//
// Same judgement as electron-sandbox.mjs, and deliberately the same narrow
// shape: a fact about the machine, acted on only by the machine that has it.
// macOS is the supported platform and always has a display, so nothing here
// ever fires on it. Wrapping only the Electron launch, rather than re-executing
// the whole launcher, keeps the bundling that runs before it in plain Node.
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

/**
 * How to launch `command`, given the machine it is being launched on.
 *
 * The machine is a parameter so this can be asked about machines other than
 * this one, which is the only way it is testable on either of them.
 */
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

  // `-a` picks a free display number rather than a fixed one, so two runs on
  // the same machine — a person's and an agent's, say — cannot collide.
  return {
    command: xvfbRun,
    args: ['-a', command, ...args],
    note: `no display on this machine; running Electron under ${xvfbRun}`
  }
}
