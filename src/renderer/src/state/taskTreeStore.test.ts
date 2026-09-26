import { describe, expect, it } from 'vitest'
import {
  readStoredBoardMode,
  readStoredCollapsedTasks,
  writeStoredBoardMode,
  writeStoredCollapsedTasks
} from './taskTreeStore'

function memory(): Storage {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, value),
    removeItem: (key) => void values.delete(key),
    clear: () => values.clear(),
    key: () => null,
    length: 0
  }
}

describe('remembering collapsed tasks', () => {
  it('keeps the collapsed ones across a write and a read', () => {
    const storage = memory()
    writeStoredCollapsedTasks(storage, { auth: true, gone: false })
    expect(readStoredCollapsedTasks(storage)).toEqual({ auth: true })
  })

  it('reads nothing from a broken or refusing store', () => {
    const storage = memory()
    storage.setItem('teamree.sidebar.collapsedTasks', '{"auth": "yes", "x": true')
    expect(readStoredCollapsedTasks(storage)).toEqual({})
    const refusing = {
      getItem: () => {
        throw new Error('blocked')
      }
    }
    expect(readStoredCollapsedTasks(refusing)).toEqual({})
    expect(readStoredCollapsedTasks(undefined)).toEqual({})
  })
})

describe('remembering the board’s view', () => {
  it('is Panes until Tasks is chosen', () => {
    const storage = memory()
    expect(readStoredBoardMode(storage)).toBe('panes')
    writeStoredBoardMode(storage, 'tasks')
    expect(readStoredBoardMode(storage)).toBe('tasks')
    storage.setItem('teamree.board.mode', 'kanban')
    expect(readStoredBoardMode(storage)).toBe('panes')
  })
})
