// Where the deploy command is, from inside a packaged app and from a checkout.
//
// The panel used to print `/Applications/teamree.app/...` unconditionally,
// which is a path that does not exist on the machine of anybody running from a
// clone — including every one of this project's own contributors. So the answer
// is worked out rather than written down, and "there is none" is an answer.

import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { shippedRelayCandidates, shippedRelayCommand } from './relayCommand'

describe('finding the relay this build carries', () => {
  it('prefers the packaged copy, and falls back to the checkout', () => {
    expect(
      shippedRelayCandidates({ resourcesPath: '/Apps/teamree.app/Resources', cwd: '/src', platform: 'darwin' })
    ).toEqual(['/Apps/teamree.app/Resources/relay/teamree-relay', '/src/relay/teamree-relay'])
  })

  it('looks for the .cmd launcher on Windows, because a shell script is not a program there', () => {
    expect(shippedRelayCandidates({ cwd: 'C:\\src', platform: 'win32' })).toEqual([
      path.join('C:\\src', 'relay', 'teamree-relay.cmd')
    ])
  })

  it('answers with the command and the deploy subcommand, ready to run in a pane', () => {
    expect(
      shippedRelayCommand({
        cwd: '/src',
        platform: 'darwin',
        exists: (candidate) => candidate === '/src/relay/teamree-relay'
      })
    ).toEqual({ command: '/src/relay/teamree-relay deploy', reason: null })
  })

  // A pane is a login shell with a command in it, and `/Users/Ada Lovelace/…`
  // unquoted is two arguments and a command not found.
  it('quotes a path a shell would otherwise split', () => {
    const found = '/Users/Ada Lovelace/teamree/relay/teamree-relay'
    expect(shippedRelayCommand({ cwd: '/Users/Ada Lovelace/teamree', platform: 'darwin', exists: () => true })).toEqual(
      {
        command: `'${found}' deploy`,
        reason: null
      }
    )
  })

  // The button is disabled with this sentence beside it, rather than enabled
  // and running a path that is not there.
  it('says there is none rather than naming a path that does not exist', () => {
    const answer = shippedRelayCommand({ cwd: '/src', platform: 'darwin', exists: () => false })
    expect(answer.command).toBeNull()
    expect(answer.reason).toMatch(/does not carry the relay project/)
  })
})
