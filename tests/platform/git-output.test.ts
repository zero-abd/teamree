// Everything teamree parses out of git, read back with both line endings.
//
// git itself terminates its porcelain output with \n on every platform, but the
// bytes can reach us through a layer that rewrites them — a Windows shell
// wrapper, a redirect through a file opened in text mode, or a user's own
// GIT_PAGER. A parser that only knows \n turns a trailing \r into part of a
// branch name or a path, so each parser is run against both spellings and the
// results are required to be identical.

import { describe, expect, it } from 'vitest'
import { parseGitVersion } from '../../src/main/git/gitVersion'
import { parseWorktreeList } from '../../src/main/git/worktreeInventory'
import { parsePorcelainV2 } from '../../src/main/git/worktreeStatus'
import { rejectBatchBinary } from '../../src/main/git/gitProcess'

const crlf = (text: string): string => text.replace(/\n/g, '\r\n')

const WORKTREE_LIST = `worktree /home/abd/repos/app
HEAD 1111111111111111111111111111111111111111
branch refs/heads/main

worktree /home/abd/.teamree/worktrees/app/fix-login
HEAD 2222222222222222222222222222222222222222
branch refs/heads/fix-login

worktree /home/abd/.teamree/worktrees/app/spike
HEAD 3333333333333333333333333333333333333333
detached
locked

`

const WINDOWS_WORKTREE_LIST = `worktree C:/Users/Abd/repos/app
HEAD 1111111111111111111111111111111111111111
branch refs/heads/main

worktree C:/Users/Abd/AppData/Roaming/teamree/worktrees/app/fix-login
HEAD 2222222222222222222222222222222222222222
branch refs/heads/fix-login

`

const STATUS = `# branch.oid 1111111111111111111111111111111111111111
# branch.head fix-login
# branch.upstream origin/fix-login
# branch.ab +3 -1
1 M. N... 100644 100644 100644 aaa bbb src/app.ts
1 .M N... 100644 100644 100644 ccc ddd src/main.ts
2 R. N... 100644 100644 100644 eee fff R100 new.ts\told.ts
u UU N... 100644 100644 100644 100644 ggg hhh iii conflict.ts
? untracked.ts
! ignored.ts
`

describe('worktree list --porcelain', () => {
  it('parses the same entries whichever line ending arrives', () => {
    const fromLf = parseWorktreeList(WORKTREE_LIST)
    expect(parseWorktreeList(crlf(WORKTREE_LIST))).toEqual(fromLf)
  })

  it('never leaves a carriage return inside a path or a branch name', () => {
    for (const entry of parseWorktreeList(crlf(WORKTREE_LIST))) {
      expect(entry.path).not.toMatch(/[\r\n]/)
      expect(entry.branch ?? '').not.toMatch(/[\r\n]/)
      expect(entry.head ?? '').not.toMatch(/[\r\n]/)
    }
  })

  it('reads the entries it was given', () => {
    const entries = parseWorktreeList(crlf(WORKTREE_LIST))
    expect(entries.map((entry) => entry.branch)).toEqual(['main', 'fix-login', undefined])
    expect(entries[2]).toMatchObject({ detached: true, locked: true })
  })

  it('keeps a Windows drive letter and its separators intact', () => {
    const entries = parseWorktreeList(crlf(WINDOWS_WORKTREE_LIST))
    expect(entries.map((entry) => entry.path)).toEqual([
      'C:/Users/Abd/repos/app',
      'C:/Users/Abd/AppData/Roaming/teamree/worktrees/app/fix-login'
    ])
  })

  it('unquotes a path git had to C-quote, on either line ending', () => {
    const raw = 'worktree "/home/abd/we\\"ird/pa\\ttern"\nbranch refs/heads/odd\n\n'
    expect(parseWorktreeList(crlf(raw))[0]?.path).toBe('/home/abd/we"ird/pa\ttern')
    expect(parseWorktreeList(crlf(raw))).toEqual(parseWorktreeList(raw))
  })
})

describe('status --porcelain=v2', () => {
  it('counts the same changes whichever line ending arrives', () => {
    expect(parsePorcelainV2(crlf(STATUS))).toEqual(parsePorcelainV2(STATUS))
  })

  it('does not let a carriage return leak into the branch or the upstream', () => {
    const parsed = parsePorcelainV2(crlf(STATUS))
    expect(parsed.branch).toBe('fix-login')
    expect(parsed.upstream).toBe('origin/fix-login')
    expect(parsed).toMatchObject({ ahead: 3, behind: 1, staged: 2, unstaged: 1, untracked: 1, conflicted: 1 })
  })

  it('reads a detached head the same way on both', () => {
    const raw = '# branch.head (detached)\n'
    expect(parsePorcelainV2(crlf(raw))).toMatchObject({ detached: true, branch: '' })
    expect(parsePorcelainV2(crlf(raw))).toEqual(parsePorcelainV2(raw))
  })

  it('survives output that is entirely empty or a single bare newline', () => {
    for (const raw of ['', '\n', '\r\n']) {
      expect(parsePorcelainV2(raw)).toMatchObject({ branch: '', staged: 0, unstaged: 0 })
    }
  })
})

describe('git --version', () => {
  it('reads a version through a carriage return', () => {
    expect(parseGitVersion('git version 2.39.3 (Apple Git-145)\r\n')).toMatchObject({ major: 2, minor: 39, patch: 3 })
    expect(parseGitVersion('git version 2.45.1.windows.1\r\n')).toMatchObject({ major: 2, minor: 45, patch: 1 })
    expect(parseGitVersion('git version 2.25\r\n')).toMatchObject({ major: 2, minor: 25, patch: 0 })
  })
})

describe('the git binary itself', () => {
  // The defect: Windows cannot execute a batch file directly. CreateProcess
  // hands it to cmd.exe, which re-parses the command line by its own rules, so a
  // branch name containing `&` would run as a second command — the injection
  // `shell: false` exists to prevent. Modern Node refuses outright, with an
  // error that says nothing about why.
  it('refuses a .cmd or .bat wrapper on Windows and says what to point at', () => {
    expect(rejectBatchBinary('C:\\tools\\git.cmd', 'win32')).toMatch(/batch file/)
    expect(rejectBatchBinary('C:\\tools\\git.BAT', 'win32')).toMatch(/TEAMREE_GIT_BINARY/)
    expect(rejectBatchBinary('C:\\Program Files\\Git\\cmd\\git.exe', 'win32')).toBeNull()
    expect(rejectBatchBinary('git', 'win32')).toBeNull()
  })

  it('says nothing about a file named .cmd on a platform that would just run it', () => {
    expect(rejectBatchBinary('/usr/local/bin/git.cmd', 'linux')).toBeNull()
    expect(rejectBatchBinary('/usr/local/bin/git.cmd', 'darwin')).toBeNull()
  })
})
