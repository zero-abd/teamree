import { describe, expect, it } from 'vitest'
import { clampContextBudget } from './memory'
import { MAX_MESSAGE_BYTES } from './messages'
import { Params } from './methods'

const accepts = (schema: { safeParse: (value: unknown) => { success: boolean } }, value: unknown) =>
  expect(schema.safeParse(value).success).toBe(true)
const rejects = (schema: { safeParse: (value: unknown) => { success: boolean } }, value: unknown) =>
  expect(schema.safeParse(value).success).toBe(false)

describe('worktree params gain optional task-tree fields', () => {
  it('still accepts the shapes callers send today', () => {
    accepts(Params.worktreeCreate, { projectId: 'p', name: 'n' })
    accepts(Params.worktreeRemove, { worktreeId: 'w', force: true })
  })

  it('accepts a parent, a calling pane and removing children', () => {
    accepts(Params.worktreeCreate, { projectId: 'p', name: 'n', parentId: 'w1', fromTerminalId: 'term_1' })
    accepts(Params.worktreeRemove, { worktreeId: 'w', children: true })
  })

  it('rejects malformed ones', () => {
    rejects(Params.worktreeCreate, { projectId: 'p', name: 'n', parentId: '' })
    rejects(Params.worktreeRemove, { worktreeId: 'w', children: 'yes' })
  })
})

describe('message.send', () => {
  const ask = {
    from: { terminalId: 't1', worktreeId: 'w1' },
    to: { relation: 'parent' },
    kind: 'ask',
    text: 'Which store?'
  }

  it('accepts an ask, a reply, a done and a note', () => {
    accepts(Params.messageSend, { ...ask, options: ['redis', 'postgres'] })
    accepts(Params.messageSend, { ...ask, kind: 'reply', replyTo: 7, to: { you: true } })
    accepts(Params.messageSend, { ...ask, kind: 'done', outcome: 'failed' })
    accepts(Params.messageSend, { ...ask, kind: 'note', to: { worktreeId: 'w2' } })
  })

  it('rejects a reply to nothing, an outcome off done, a party naming nobody and an oversize body', () => {
    rejects(Params.messageSend, { ...ask, kind: 'reply' })
    rejects(Params.messageSend, { ...ask, outcome: 'succeeded' })
    rejects(Params.messageSend, { ...ask, from: {} })
    rejects(Params.messageSend, { ...ask, to: { relation: 'cousins' } })
    rejects(Params.messageSend, { ...ask, text: 'é'.repeat(MAX_MESSAGE_BYTES / 2 + 1) })
    rejects(Params.messageSend, { ...ask, kind: 'dispatch' })
  })
})

describe('project memory params', () => {
  it('accepts project.context with and without options', () => {
    accepts(Params.projectContext, { worktreeId: 'w' })
    accepts(Params.projectContext, { worktreeId: 'w', budgetTokens: 9000, sections: ['self', 'files'], format: 'text' })
  })

  it('rejects a bad budget, section or format', () => {
    rejects(Params.projectContext, { worktreeId: 'w', budgetTokens: -1 })
    rejects(Params.projectContext, { worktreeId: 'w', budgetTokens: 1.5 })
    rejects(Params.projectContext, { worktreeId: 'w', sections: ['everything'] })
    rejects(Params.projectContext, { worktreeId: 'w', format: 'xml' })
    rejects(Params.projectContext, {})
  })

  it('clamps the budget into 200..4000 with 1500 by default', () => {
    expect(clampContextBudget(undefined)).toBe(1500)
    expect(clampContextBudget(50)).toBe(200)
    expect(clampContextBudget(9000)).toBe(4000)
    expect(clampContextBudget(2000)).toBe(2000)
  })

  it('bounds a note and its paths', () => {
    accepts(Params.memoryNote, { worktreeId: 'w', kind: 'decision', text: 'Use advisory locks', paths: ['src/a.ts'] })
    rejects(Params.memoryNote, { worktreeId: 'w', kind: 'decision', text: 'x'.repeat(501) })
    rejects(Params.memoryNote, { worktreeId: 'w', kind: 'decision', text: '   ' })
    rejects(Params.memoryNote, { worktreeId: 'w', kind: 'fact', text: 'x' })
    rejects(Params.memoryNote, { worktreeId: 'w', kind: 'question', text: 'x', scope: 'public' })
    rejects(Params.memoryNote, { worktreeId: 'w', kind: 'decision', text: 'x', paths: Array(21).fill('a.ts') })
    accepts(Params.memoryResolve, { noteId: 'n1', answer: 'postgres' })
    rejects(Params.memoryResolve, { noteId: '' })
  })
})

describe('handoff, template, settings and add-on params', () => {
  it('accepts well-formed calls', () => {
    accepts(Params.teamworkHandOff, { worktreeId: 'w', to: 'ana', note: 'finish the limiter' })
    accepts(Params.teamworkTake, { projectId: 'p', id: 'h1', agent: 'claude' })
    accepts(Params.projectSaveTemplate, {
      projectId: 'p',
      name: 'review',
      agents: { claude: 1, codex: 1 },
      prompt: 'Review {{input}}'
    })
    accepts(Params.settingsSet, {})
    accepts(Params.settingsSet, { shareTaskDetails: false, showCost: true, jacMemoryAddon: true })
    accepts(Params.addonsInstall, { id: 'jac-memory' })
  })

  it('rejects malformed ones', () => {
    rejects(Params.teamworkHandOff, { worktreeId: 'w', to: 'ana', note: 'x'.repeat(4097) })
    rejects(Params.projectSaveTemplate, { projectId: 'p', name: '../evil', agents: {}, prompt: 'x' })
    rejects(Params.projectSaveTemplate, { projectId: 'p', name: 'r', agents: { claude: 99 }, prompt: 'x' })
    rejects(Params.settingsSet, { showCost: 'on' })
    rejects(Params.addonsInstall, { id: 'python' })
  })
})
