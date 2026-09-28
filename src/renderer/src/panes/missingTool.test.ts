import { describe, expect, it } from 'vitest'
import { missingTool } from './missingTool'

describe('missingTool', () => {
  it.each([
    ['zsh:1: command not found: pnpm', 'pnpm', 'npm i -g pnpm'],
    ['zsh: command not found: uv', 'uv', 'brew install uv'],
    ['bash: line 1: yarn: command not found', 'yarn', 'npm i -g yarn'],
    ['/bin/sh: cargo: command not found', 'cargo', 'brew install rust'],
    ['sh: 1: turbo: not found', 'turbo', undefined]
  ])('reads %j as %s missing', (line, tool, fix) => {
    expect(missingTool(['$ pnpm install', line])).toEqual(fix === undefined ? { tool } : { tool, fix })
  })

  it.each([['Error: not found'], ['npm ERR! 404 Not Found'], ['GET /api 404 not found']])(
    'reads nothing into %j',
    (line) => {
      expect(missingTool([line])).toBeNull()
    }
  )

  it('names the latest one', () => {
    expect(missingTool(['zsh: command not found: pnpm', 'zsh: command not found: bun'])?.tool).toBe('bun')
  })
})
