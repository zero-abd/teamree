/** @vitest-environment jsdom */

// The Open in list: a project's own editor first, else the one Settings names for every project.

import { renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'

vi.mock('../runtimeClient/currentRuntimeClient', () => ({
  runtimeClient: { call: () => new Promise(() => {}) },
  RUNTIME_IS_SEEDED: false
}))

const { useWorkspaceStore } = await import('../state/workspaceStore')
const { useOpenIn } = await import('./openIn')

const INSTALLED = [
  { command: 'com.microsoft.VSCode', label: 'VS Code', kind: 'editor' as const },
  { command: 'dev.zed.Zed', label: 'Zed', kind: 'editor' as const }
]

it('puts the default editor first for a project that names none, and the project’s own first for one that does', () => {
  useWorkspaceStore.setState({ editors: INSTALLED, editorCommands: { '*': 'dev.zed.Zed', p1: 'com.microsoft.VSCode' } })
  const { result } = renderHook(() => useOpenIn())
  const labels = (projectId: string): string[] =>
    result.current(projectId, '/repos/x', 'the checkout', false).map((item) => item.label)
  expect(labels('p2')).toEqual(['Zed', 'VS Code'])
  expect(labels('p1')).toEqual(['VS Code', 'Zed'])
})
