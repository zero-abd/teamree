// How the smoke test gets launched, which is the part of it that has been wrong
// twice over.
//
// The smoke test is a release gate, and a gate is only as good as its ability to
// start. Both of these are about starting: what `run-smoke.mjs` tells the
// Electron process, and whether that process has a display to open a window on.
//
// The first is a regression test with a date attached. The peer bundle used to
// travel as a bare positional and be read as `process.argv[2]`, which held right
// up until `electronSandboxArgs()` began prepending `--no-sandbox` on a root
// Linux run: argv[2] became the smoke script, and the gate reported a peer
// library it could not import. So the command line is assembled here exactly as
// the launcher assembles it, switch and all, and read back.
import { describe, expect, it } from 'vitest'
// @ts-expect-error -- untyped .mjs, deliberately outside the TypeScript build.
import { PEER_BUNDLE_FLAG, USER_DATA_FLAG, namedArg, readNamedArg } from '../../scripts/smoke-args.mjs'
// @ts-expect-error -- see above.
import { SMOKE_SWITCHES, smokeEnv } from '../../scripts/smoke-args.mjs'
// @ts-expect-error -- see above.
import { displayPlan } from '../../scripts/virtual-display.mjs'

const BUNDLE = '/tmp/teamree-peer-Xf3k1z'
const USER_DATA = '/tmp/teamree-smoke-Qa9w2e'
const ELECTRON = '/repo/node_modules/electron/dist/electron'

/** The command line `run-smoke.mjs` builds, with the switches the machine asked for. */
function smokeArgs(switches: string[]) {
  return [...switches, 'scripts/smoke.mjs', namedArg(PEER_BUNDLE_FLAG, BUNDLE), namedArg(USER_DATA_FLAG, USER_DATA)]
}

describe('what the launcher tells the Electron process', () => {
  it('is read back the same however many switches precede it', () => {
    for (const switches of [[], ['--no-sandbox'], ['--no-sandbox', '--disable-gpu']]) {
      const args = smokeArgs(switches)
      expect(readNamedArg(PEER_BUNDLE_FLAG, args)).toBe(BUNDLE)
      expect(readNamedArg(USER_DATA_FLAG, args)).toBe(USER_DATA)
    }
  })

  it('is absent rather than wrong when nothing was passed', () => {
    // Both readers refuse on undefined, which is the only safe answer: one would
    // otherwise check no peer library, and the other would run the app against
    // the user data directory of whoever ran it.
    expect(readNamedArg(PEER_BUNDLE_FLAG, ['--no-sandbox', 'scripts/smoke.mjs'])).toBeUndefined()
    expect(readNamedArg(USER_DATA_FLAG, ['--no-sandbox', 'scripts/smoke.mjs'])).toBeUndefined()
  })

  it('survives a value with an = in it, because paths may carry one', () => {
    const odd = '/tmp/build=2/peer'
    expect(readNamedArg(PEER_BUNDLE_FLAG, [namedArg(PEER_BUNDLE_FLAG, odd)])).toBe(odd)
  })

  it('does not confuse one flag for another that starts the same way', () => {
    const args = [namedArg('--peer-bundle-dir', '/not/this/one'), namedArg(PEER_BUNDLE_FLAG, BUNDLE)]
    expect(readNamedArg(PEER_BUNDLE_FLAG, args)).toBe(BUNDLE)
  })
})

describe('what the launcher leaves the keychain', () => {
  it("keeps Chromium's cookie key out of the login keychain", () => {
    expect(SMOKE_SWITCHES).toContain('--use-mock-keychain')
  })

  it('hands Electron no NODE_USE_SYSTEM_CA', () => {
    const env = smokeEnv({ PATH: '/usr/bin', NODE_USE_SYSTEM_CA: '1' }, '/tmp/smoke/worktrees')
    expect(env).not.toHaveProperty('NODE_USE_SYSTEM_CA')
    expect(env).toMatchObject({ PATH: '/usr/bin', TEAMREE_WORKTREES_ROOT: '/tmp/smoke/worktrees' })
  })

  it('reaches no test or child the suite spawns', () => {
    expect(process.env).not.toHaveProperty('NODE_USE_SYSTEM_CA')
  })

  it('points the smoke app and the suite at claude and codex configs that are not the owner’s', () => {
    const env = smokeEnv({ PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/Users/me' }, '/tmp/smoke/worktrees')
    expect(env).toMatchObject({ CLAUDE_CONFIG_DIR: '/tmp/smoke/claude', CODEX_HOME: '/tmp/smoke/codex' })
    expect(process.env.CLAUDE_CONFIG_DIR).toContain('teamree-tests-have-no-agent-config')
    expect(process.env.CODEX_HOME).toContain('teamree-tests-have-no-agent-config')
  })
})

describe('whether Electron is given a display first', () => {
  const args = smokeArgs(['--no-sandbox'])
  const xvfb = (name: string) => (name === 'xvfb-run' ? '/usr/bin/xvfb-run' : undefined)
  const nothing = () => undefined

  it('leaves the supported platform alone', () => {
    // macOS has a display whether or not $DISPLAY is set, and nothing here is
    // allowed to reach the machine this project actually ships for.
    const plan = displayPlan(ELECTRON, args, { platform: 'darwin', env: {}, lookup: xvfb })
    expect(plan.command).toBe(ELECTRON)
    expect(plan.args).toEqual(args)
    expect(plan.note).toBeUndefined()
  })

  it('leaves a Linux machine that has a display alone', () => {
    for (const env of [{ DISPLAY: ':0' }, { WAYLAND_DISPLAY: 'wayland-0' }]) {
      const plan = displayPlan(ELECTRON, args, { platform: 'linux', env, lookup: xvfb })
      expect(plan.command).toBe(ELECTRON)
      expect(plan.args).toEqual(args)
    }
  })

  it('makes one for a headless Linux machine that can', () => {
    const plan = displayPlan(ELECTRON, args, { platform: 'linux', env: {}, lookup: xvfb })
    expect(plan.command).toBe('/usr/bin/xvfb-run')
    // `-a` rather than a fixed display number, and the Electron command line
    // handed through untouched behind it.
    expect(plan.args).toEqual(['-a', ELECTRON, ...args])
    expect(plan.note).toContain('xvfb-run')
  })

  it('says what is missing on a headless Linux machine that cannot', () => {
    const plan = displayPlan(ELECTRON, args, { platform: 'linux', env: {}, lookup: nothing })
    // Still launched: the failure belongs to Electron and says so in its own
    // words. What this adds is the sentence that names the remedy, because
    // "Electron was killed by SIGSEGV" does not.
    expect(plan.command).toBe(ELECTRON)
    expect(plan.args).toEqual(args)
    expect(plan.advice).toContain('xvfb-run')
  })
})
