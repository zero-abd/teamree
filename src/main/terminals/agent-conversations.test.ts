import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { claudeProjectSlug, claudeTranscriptPath, conversationOnDisk } from './agent-conversations'

const created: string[] = []

afterEach(async () => {
  await Promise.all(created.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

/** A stand-in home directory, with whichever stores a test wants inside it. */
async function home(stores: readonly string[] = []): Promise<string> {
  const base = await mkdtemp(path.join(os.tmpdir(), 'teamree-store-'))
  created.push(base)
  for (const store of stores) await mkdir(path.join(base, store), { recursive: true })
  return base
}

describe('claudeProjectSlug', () => {
  // Read off a real store: /Users/abd/.teamree/worktrees/x is kept under
  // -Users-abd--teamree-worktrees-x. The double dash is a separator and a dot meeting, not an escape.
  it('turns every separator and every dot into a dash', () => {
    expect(claudeProjectSlug('/Users/abd/repos/teamree')).toBe('-Users-abd-repos-teamree')
    expect(claudeProjectSlug('/Users/abd/.teamree/worktrees/a.b')).toBe('-Users-abd--teamree-worktrees-a-b')
  })
})

describe('conversationOnDisk', () => {
  it('finds the conversation Claude Code wrote for this directory under this id', async () => {
    const base = await home(['.claude/projects'])
    const cwd = path.join(base, 'checkout')
    await mkdir(cwd, { recursive: true })
    const transcript = claudeTranscriptPath(cwd, 'sess-1', base)
    await mkdir(path.dirname(transcript), { recursive: true })
    await writeFile(transcript, '{"type":"user"}\n', 'utf8')

    expect(conversationOnDisk({ agent: 'claude', cwd, agentSessionId: 'sess-1' }, base)).toBe('present')
    // The same directory, a different session.
    expect(conversationOnDisk({ agent: 'claude', cwd, agentSessionId: 'sess-2' }, base)).toBe('absent')
  })

  // An id was pinned, a key was pressed at the trust gate, nothing was written under it.
  it('says a pinned id with no file behind it is absent, not unknown', async () => {
    const base = await home(['.claude/projects'])
    expect(conversationOnDisk({ agent: 'claude', cwd: '/checkouts/wt_1', agentSessionId: 'sess-1' }, base)).toBe(
      'absent'
    )
  })

  // Without an id the resume asks for "the last conversation here".
  it('answers for a directory when there is no id to ask about', async () => {
    const base = await home(['.claude/projects'])
    const cwd = path.join(base, 'checkout')
    await mkdir(cwd, { recursive: true })
    expect(conversationOnDisk({ agent: 'claude', cwd }, base)).toBe('absent')

    const transcript = claudeTranscriptPath(cwd, 'whatever-id', base)
    await mkdir(path.dirname(transcript), { recursive: true })
    await writeFile(transcript, '{"type":"user"}\n', 'utf8')
    expect(conversationOnDisk({ agent: 'claude', cwd }, base)).toBe('present')
  })

  // A machine with no store has not proved anything about any pane on it.
  it('says unknown rather than absent when the store itself is not there', async () => {
    const base = await home()
    expect(conversationOnDisk({ agent: 'claude', cwd: '/checkouts/wt_1', agentSessionId: 'sess-1' }, base)).toBe(
      'unknown'
    )
    expect(conversationOnDisk({ agent: 'codex', cwd: '/checkouts/wt_1' }, base)).toBe('unknown')
  })

  // codex files one rollout per session under its day, with the cwd on the
  // first line; no id can be pinned, so the directory is the whole question.
  it('finds a codex session by the directory its rollout says it ran in', async () => {
    const base = await home()
    const day = path.join(base, '.codex', 'sessions', '2026', '09', '17')
    await mkdir(day, { recursive: true })
    const cwd = '/checkouts/wt_1'
    await writeFile(
      path.join(day, 'rollout-2026-09-17T06-59-58-01a0af3c-e37b-7a91-a438-7b9583c32e52.jsonl'),
      '{"timestamp":"2026-09-17T11:59:58.710Z","type":"session_meta","payload":{"session_id":"01a0af3c",' +
        `"cwd":${JSON.stringify(cwd)},"originator":"codex_cli"}}\n`,
      'utf8'
    )

    expect(conversationOnDisk({ agent: 'codex', cwd }, base)).toBe('present')
    expect(conversationOnDisk({ agent: 'codex', cwd: '/checkouts/wt_2' }, base)).toBe('absent')
  })

  // Deliberate: guessing a store wrong would read as "no conversation" for every pane.
  it('declines to answer for the agents whose stores this does not know', async () => {
    const base = await home(['.claude/projects', '.codex/sessions'])
    for (const agent of ['gemini', 'opencode', 'droid'] as const) {
      expect(conversationOnDisk({ agent, cwd: '/checkouts/wt_1', agentSessionId: 'sess-1' }, base), agent).toBe(
        'unknown'
      )
    }
  })

  // The id comes from an editable file and is about to become a filename.
  it('refuses to build a filename out of an id that is not one', async () => {
    const base = await home(['.claude/projects'])
    for (const agentSessionId of ['../../etc/passwd', 'a/b', '.', '']) {
      expect(conversationOnDisk({ agent: 'claude', cwd: '/checkouts/wt_1', agentSessionId }, base)).toBe('unknown')
    }
  })
})
