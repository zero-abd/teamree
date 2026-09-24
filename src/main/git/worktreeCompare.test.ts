import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { compareRuns } from '../../shared/runCompare'
import { createTempRepo, type TempRepo } from './testRepository'
import { readCompare } from './worktreeCompare'

const MATH = 'export function add(a: number, b: number): number {\n  return a + b\n}\n'

describe('comparing two runs of one task in a real repository', () => {
  const repos: TempRepo[] = []
  afterEach(async () => {
    await Promise.all(repos.splice(0).map((repo) => repo.cleanup()))
  })

  /** Two worktrees branched from one commit, and main moved on after them. */
  const twoRuns = async (): Promise<{ repo: TempRepo; start: string; claude: string; codex: string }> => {
    const repo = await createTempRepo()
    repos.push(repo)
    await repo.write('src/math.ts', MATH)
    await repo.commit('Add add')
    const start = await repo.git(['rev-parse', 'HEAD'])
    const claude = path.join(repo.worktreesRoot, 'claude')
    const codex = path.join(repo.worktreesRoot, 'codex')
    await repo.git(['worktree', 'add', '-q', '-b', 'task-claude', claude, 'main'])
    await repo.git(['worktree', 'add', '-q', '-b', 'task-codex', codex, 'main'])
    await repo.write('CHANGELOG.md', 'main moved on\n')
    await repo.commit('Unrelated work on main')
    return { repo, start, claude, codex }
  }

  const compare = (repo: TempRepo, left: string, right: string, maxBytes?: number): ReturnType<typeof readCompare> =>
    readCompare(repo.runner, {
      left: { worktreeId: 'wt-claude', worktreePath: left },
      right: { worktreeId: 'wt-codex', worktreePath: right },
      ...(maxBytes === undefined ? {} : { maxBytes }),
      now: () => 7
    })

  it('reads each run against the commit both started from: committed, uncommitted and untracked work alike', async () => {
    const { repo, start, claude, codex } = await twoRuns()
    // claude commits its change and a test; codex leaves the same change uncommitted and a note untracked.
    await repo.write(
      'src/math.ts',
      `${MATH}\nexport function sub(a: number, b: number): number {\n  return a - b\n}\n`,
      claude
    )
    await repo.write('src/math.test.ts', "import { sub } from './math'\n", claude)
    await repo.commit('Add sub', claude)
    await repo.write(
      'src/math.ts',
      `${MATH}\nexport function sub(a: number, b: number): number {\n  return a - b\n}\n`,
      codex
    )
    await repo.write('NOTES.md', 'sub added\n', codex)

    const result = await compare(repo, claude, codex)

    expect(result.base).toBe(start)
    expect(result.readAt).toBe(7)
    expect(result.left.worktreeId).toBe('wt-claude')
    expect(result.left.head).toBe(await repo.git(['rev-parse', 'HEAD'], claude))
    expect(result.right.head).toBe(start)
    expect([result.left.truncated, result.right.truncated]).toEqual([false, false])
    const files = compareRuns(result.left.patch, result.right.patch)
    expect(files.map((file) => [file.path, file.left !== null, file.right !== null, file.same])).toEqual([
      ['NOTES.md', false, true, false],
      ['src/math.test.ts', true, false, false],
      ['src/math.ts', true, true, true]
    ])
    // Main's own later commit is neither run's work.
    expect(result.left.patch + result.right.patch).not.toContain('CHANGELOG.md')
  })

  it('reads a run that has done nothing as an empty patch', async () => {
    const { repo, claude, codex } = await twoRuns()
    await repo.write('src/math.ts', `${MATH}// sub\n`, codex)
    const result = await compare(repo, claude, codex)
    expect(result.left.patch).toBe('')
    expect(result.right.patch).toContain('+// sub')
  })

  it('cuts a side past the ceiling and says so', async () => {
    const { repo, claude, codex } = await twoRuns()
    await repo.write('big.txt', 'a line of text\n'.repeat(2000), claude)
    const result = await compare(repo, claude, codex, 4096)
    expect(result.left.truncated).toBe(true)
    expect(Buffer.byteLength(result.left.patch, 'utf8')).toBeLessThanOrEqual(4096)
    expect(result.right.truncated).toBe(false)
  })

  it('refuses two checkouts that share no history', async () => {
    const { repo, claude } = await twoRuns()
    const other = await createTempRepo()
    repos.push(other)
    // Two fixtures made in the same second have the same root commit; this one starts elsewhere.
    await other.git(['checkout', '-q', '--orphan', 'elsewhere'])
    await other.commit('A root of its own')
    await expect(compare(repo, claude, other.repoPath)).rejects.toThrow(/no commit in common/)
  })
})
