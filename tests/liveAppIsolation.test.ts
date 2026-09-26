// A suite started from a teamree pane inherits that pane's endpoint; no test may reach the app behind it.
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
// @ts-expect-error -- untyped .mjs, deliberately outside the TypeScript build.
import { PANE_ENV } from '../scripts/child-env.mjs'
import { defaultDiscoveryHost, findRuntime } from '../src/cli/discovery'

/** Set on the nested run, which is the one that looks. */
const PROBE = 'TEAMREE_ISOLATION_PROBE'

it('hands no test the pane the suite was started in, nor the app behind it', () => {
  if (process.env[PROBE] === '1') {
    for (const name of [...PANE_ENV, 'BASH_ENV']) expect(process.env).not.toHaveProperty(name)
    const found = findRuntime(defaultDiscoveryHost())
    expect(found).toMatchObject({ ok: false, reason: 'missing' })
    expect(found.ok || found.checked).toEqual([join(tmpdir(), 'teamree-tests-have-no-app', 'runtime.json')])
    return
  }
  const live = join(tmpdir(), 'teamree-live-app')
  const pane = Object.fromEntries(PANE_ENV.map((name: string) => [name, join(live, name)]))
  const child = spawnSync('npx', ['vitest', 'run', '--project', 'teamree', 'tests/liveAppIsolation.test.ts'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ...pane,
      TEAMREE_USER_BASH_ENV: '',
      BASH_ENV: join(live, 'env.bash'),
      TEAMREE_USER_DATA_DIR: live,
      [PROBE]: '1'
    }
  })
  expect(child.status, `${child.stdout}\n${child.stderr}`).toBe(0)
}, 60_000)
