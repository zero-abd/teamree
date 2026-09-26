import { describe, expect, it } from 'vitest'
import type { CommandSpec } from '../command-spec.js'
import { COMMANDS } from '../command-table.js'
import { GUIDE_MAX_LINES, GUIDE_TOPICS } from '../guideTopics.js'
import { runCli } from '../run.js'
import { availableTopics, guideText } from './guide.js'

/** Every command any topic teaches; the stand-in `worktree create` is found before the real one. */
const EVERYTHING: CommandSpec[] = [
  {
    path: ['worktree', 'create'],
    summary: '',
    flags: [{ name: 'parent', kind: 'string', description: '' }],
    run: async () => ({ data: null, text: '' })
  },
  ...[['msg', 'done'], ['context'], ['note']].map((path) => ({
    path,
    summary: '',
    run: async () => ({ data: null, text: '' })
  })),
  ...COMMANDS
]

describe('teamree guide', () => {
  it(`keeps every topic, footer included, to ${GUIDE_MAX_LINES} lines`, () => {
    const topics = availableTopics(EVERYTHING)
    expect(topics.map((topic) => topic.name)).toEqual(GUIDE_TOPICS.map((topic) => topic.name))
    for (const topic of topics) {
      expect(guideText(topics, topic.name).split('\n').length, topic.name).toBeLessThanOrEqual(GUIDE_MAX_LINES)
    }
  })

  it('offers only the topics whose commands this build has', () => {
    const topics = availableTopics(COMMANDS)
    expect(topics.map((topic) => topic.name)).toContain('pane')
    for (const topic of topics.slice(1)) expect(guideText(topics, undefined)).toContain(`teamree guide ${topic.name}`)
    expect(() => guideText(availableTopics([]), 'msg')).toThrow(/No guide topic "msg"/)
  })

  it('answers with no app running', async () => {
    let out = ''
    const code = await runCli(['guide'], {
      streams: { out: (text) => (out += text), err: () => {} },
      env: { TEAMREE_USER_DATA_DIR: '/nonexistent/teamree-guide' },
      cwd: '/'
    })
    expect(code).toBe(0)
    expect(out).toContain('teamree whoami')
  })
})
