// What the setup panel says at each point of setting teamwork up.
//
// The cases worth pinning are the ones where being wrong is expensive: a step
// that claims to be done when it is not, a step that says "blocked" without
// naming what to fix, and the push step, which must never show a tick because
// nothing in the window can see a commit.

import { describe, expect, it } from 'vitest'
import type { MemberList, PeerLink, RelaySetting, TeamworkStatus } from '@shared/entities'
import {
  checkRelayDraft,
  pushPlan,
  RELAY_OPTIONS,
  startTeamworkFlow,
  type StartTeamworkInput,
  type StepId
} from './startTeamwork'

const SELF_KEY = 'c2VsZmtleXNlbGZrZXlzZWxma2V5c2VsZmtleXNlbGZrZXk='

function list(overrides: Partial<MemberList> = {}): MemberList {
  return {
    projectId: 'p1',
    members: [],
    problems: [],
    self: { handle: 'ada', publicKey: SELF_KEY },
    selfFile: '.teamree/members/ada.pub',
    enrolled: false,
    watched: true,
    readAt: 0,
    ...overrides
  }
}

const enrolled = (): MemberList =>
  list({
    enrolled: true,
    members: [
      {
        handle: 'ada',
        publicKey: SELF_KEY,
        addedAt: '2026-03-01',
        file: '.teamree/members/ada.pub',
        isSelf: true
      }
    ]
  })

function relay(overrides: Partial<RelaySetting> = {}): RelaySetting {
  return {
    projectId: 'p1',
    file: '.teamree/relay',
    url: null,
    source: null,
    problem: 'no .teamree/relay in this project, so teamree does not know which relay your team meets on',
    committed: {
      url: null,
      problem: 'no .teamree/relay in this project, so teamree does not know which relay your team meets on'
    },
    override: { name: 'TEAMREE_RELAY_URL', value: null },
    readAt: 0,
    ...overrides
  }
}

const committedRelay = (url = 'wss://relay.example/v1/relay'): RelaySetting =>
  relay({ url, source: 'repository', problem: null, committed: { url, problem: null } })

function status(overrides: Partial<TeamworkStatus> = {}): TeamworkStatus {
  return {
    projectId: 'p1',
    relay: { url: 'wss://relay.example/v1/relay', source: 'repository' },
    disabledReason: null,
    origin: { ok: true },
    links: [],
    readAt: 0,
    ...overrides
  }
}

const link = (overrides: Partial<PeerLink> = {}): PeerLink => ({
  publicKey: 'peerkey',
  handle: 'priya',
  phase: 'waiting',
  since: 0,
  attempts: 1,
  ...overrides
})

const step = (input: StartTeamworkInput, id: StepId) => {
  const found = startTeamworkFlow(input).steps.find((entry) => entry.id === id)
  if (!found) throw new Error(`no step ${id}`)
  return found
}

/** Everything read, and nothing done. The state a fresh project is in. */
const fresh: StartTeamworkInput = { list: list(), relay: relay(), status: status() }

/** Both files written and the relay committed, with nobody else on the roster. */
const written: StartTeamworkInput = { list: enrolled(), relay: committedRelay(), status: status() }

describe('step 1, your identity', () => {
  it('is done as soon as the roster has been read, because the keypair is made on first run', () => {
    expect(step(fresh, 'identity').mark).toBe('done')
  })

  it('is not done while nothing has been read, and does not pretend otherwise', () => {
    const pending = step({ list: undefined, relay: undefined, status: undefined }, 'identity')
    expect(pending.mark).toBe('todo')
    expect(pending.summary).toMatch(/Reading/)
  })

  it('says the key has no name here when git has no user.email to take one from', () => {
    const nameless = step(
      { ...fresh, list: list({ self: { handle: null, publicKey: SELF_KEY }, selfFile: null }) },
      'identity'
    )
    expect(nameless.mark).toBe('done')
    expect(nameless.summary).toMatch(/no user\.email/)
  })
})

describe('step 2, your key is in the repository', () => {
  it('is not done, and says what that costs, before the key is written', () => {
    const pending = step(fresh, 'key')
    expect(pending.mark).toBe('todo')
    expect(pending.summary).toMatch(/no teammate can reach this machine/)
  })

  it('is done once the key is in the checkout, and names the file it is in', () => {
    const done = step(written, 'key')
    expect(done.mark).toBe('done')
    expect(done.summary).toContain('.teamree/members/ada.pub')
  })
})

describe('step 3, the team’s relay', () => {
  it('is not done when nothing is committed, and repeats the runtime’s reason as a sentence', () => {
    const pending = step(fresh, 'relay')
    expect(pending.mark).toBe('todo')
    expect(pending.summary).toBe(
      'No .teamree/relay in this project, so teamree does not know which relay your team meets on.'
    )
  })

  it('is done when the repository names one, because that is what a teammate reads', () => {
    const done = step(written, 'relay')
    expect(done.mark).toBe('done')
    expect(done.summary).toContain('wss://relay.example/v1/relay')
  })

  // The override is for the ephemeral tunnel URL, which is per-machine and dies
  // with the process. Treating it as the team's relay would tell somebody they
  // were set up when no teammate can read a thing.
  it('is not done when only the environment names a relay, and says why that is not enough', () => {
    const overridden = step(
      {
        ...fresh,
        relay: relay({
          url: 'wss://tunnel.example/v1/relay',
          source: 'environment',
          problem: null,
          override: { name: 'TEAMREE_RELAY_URL', value: 'wss://tunnel.example/v1/relay' }
        })
      },
      'relay'
    )
    expect(overridden.mark).toBe('todo')
    expect(overridden.summary).toMatch(/per-machine and dies with this process/)
  })

  it('offers four ways to get one, each saying whether its address is stable enough to commit', () => {
    expect(RELAY_OPTIONS.map((option) => option.id)).toEqual(['worker', 'tunnel', 'mesh', 'vps'])
    // The tunnel is the one that must not be committed: it changes every time
    // it restarts, and a dead URL in a diff is worse than no URL.
    expect(RELAY_OPTIONS.find((option) => option.id === 'tunnel')?.keep).toBe('override')
    expect(RELAY_OPTIONS.filter((option) => option.keep === 'commit').map((option) => option.id)).toEqual([
      'worker',
      'mesh',
      'vps'
    ])
    for (const option of RELAY_OPTIONS) {
      expect(option.effort).not.toBe('')
      expect(option.money).not.toBe('')
      expect(option.commands).not.toBe('')
    }
  })

  it('does not promise the Worker is free, because relay/README.md does not', () => {
    const worker = RELAY_OPTIONS.find((option) => option.id === 'worker')!
    expect(worker.money).toMatch(/very likely free/)
    expect(worker.money).toMatch(/has not re-verified/)
  })
})

describe('the relay field’s verdict on what has been typed', () => {
  it('accepts a websocket URL and normalises the trailing slash away', () => {
    expect(checkRelayDraft(' wss://relay.example/v1/relay/ ')).toEqual({
      state: 'ok',
      url: 'wss://relay.example/v1/relay'
    })
  })

  // The address a deploy prints is the one input everybody arrives with.
  it('refuses the https:// address a deploy prints, and offers the corrected one', () => {
    expect(checkRelayDraft('https://teamree-relay.example.workers.dev')).toEqual({
      state: 'bad',
      reason:
        'The scheme is "https", not ws or wss. A deployed relay is reached at wss://teamree-relay.example.workers.dev/v1/relay.',
      suggestion: 'wss://teamree-relay.example.workers.dev/v1/relay'
    })
  })

  it('keeps a path somebody has already chosen, and only corrects the scheme', () => {
    expect(checkRelayDraft('https://relay.example/some/path')).toMatchObject({
      suggestion: 'wss://relay.example/some/path'
    })
  })

  it('has no suggestion for an address nothing like a relay, and still says what is wrong', () => {
    expect(checkRelayDraft('not a url')).toEqual({ state: 'bad', reason: 'It is not a URL.', suggestion: null })
  })

  it('says nothing at all about an empty field', () => {
    expect(checkRelayDraft('   ')).toEqual({ state: 'empty' })
  })
})

describe('step 4, commit and push', () => {
  it('has nothing to say until a file has been written', () => {
    const nothing = step(fresh, 'push')
    expect(nothing.mark).toBe('todo')
    expect(pushPlan(fresh.list, fresh.relay)).toBeNull()
  })

  // A tick here would be the app claiming the one act it deliberately refuses
  // to perform. It has no way to see a commit and says so instead.
  it('is never marked done, because teamree cannot see a commit', () => {
    const owed = step(written, 'push')
    expect(owed.mark).toBe('unchecked')
    expect(owed.summary).toMatch(/does not check/)
  })

  it('names both files and one commit that carries them', () => {
    expect(pushPlan(written.list, written.relay)).toEqual({
      files: ['.teamree/members/ada.pub', '.teamree/relay'],
      commands: 'git add .teamree\ngit commit -m "Set up teamwork"\ngit push'
    })
  })

  it('names only the key when that is all that was written', () => {
    expect(pushPlan(enrolled(), relay())).toEqual({
      files: ['.teamree/members/ada.pub'],
      commands: 'git add .teamree\ngit commit -m "Add my key to the team"\ngit push'
    })
  })

  it('names only the relay when somebody set that and has not joined', () => {
    expect(pushPlan(list(), committedRelay())).toEqual({
      files: ['.teamree/relay'],
      commands: 'git add .teamree\ngit commit -m "Meet on our relay"\ngit push'
    })
  })
})

describe('step 5, connected', () => {
  it('is done when a link has authenticated against a key in the repository', () => {
    const done = step({ ...written, status: status({ links: [link({ phase: 'connected' })] }) }, 'connected')
    expect(done.mark).toBe('done')
    expect(done.summary).toMatch(/priya is connected/)
  })

  it('counts the rest of the roster as away rather than dropping them', () => {
    const mixed = step(
      {
        ...written,
        status: status({
          links: [link({ phase: 'connected' }), link({ publicKey: 'k2', handle: 'marcus', phase: 'waiting' })]
        })
      },
      'connected'
    )
    expect(mixed.summary).toMatch(/1 other on the roster is not/)
  })

  it('does not blame the network for a project nobody has set up', () => {
    expect(step(fresh, 'connected').summary).toMatch(/Nothing to connect to yet/)
  })

  it('says a roster of one is a roster of one, once everything else is done', () => {
    expect(step(written, 'connected').summary).toMatch(/nobody in it but you/)
  })

  it('separates a relay this machine cannot reach from a teammate who is away', () => {
    const unreachable = step({ ...written, status: status({ links: [link({ phase: 'unreachable' })] }) }, 'connected')
    expect(unreachable.summary).toMatch(/cannot reach wss:\/\/relay\.example\/v1\/relay/)
    expect(unreachable.summary).toMatch(/may be perfectly fine/)
  })

  it('leads with a refusal, which is the one that means somebody was there', () => {
    const refused = step({ ...written, status: status({ links: [link({ phase: 'refused' })] }) }, 'connected')
    expect(refused.summary).toMatch(/did not authenticate/)
  })
})

describe('a checkout with no origin', () => {
  const noOrigin = status({
    origin: {
      ok: false,
      reason: 'this project has no origin remote, so teamree cannot tell it is the same repository your teammates have'
    },
    // The runtime names the relay first, because that is the first thing to
    // fix. The flow must still find the origin underneath it.
    disabledReason: 'no .teamree/relay in this project, so teamree does not know which relay your team meets on'
  })

  it('says so at the top of the flow, rather than after four steps of work', () => {
    const flow = startTeamworkFlow({ ...fresh, status: noOrigin })
    expect(flow.blocker).toMatch(/no origin remote/)
  })

  it('names the command to run, and that a path on this disk is not one', () => {
    const flow = startTeamworkFlow({ ...fresh, status: noOrigin })
    expect(flow.blocker).toMatch(/git remote add origin/)
    expect(flow.blocker).toMatch(/a filesystem path is not a URL/)
  })

  it('blocks the connected step rather than showing it as merely not done', () => {
    const blocked = step({ ...written, status: noOrigin }, 'connected')
    expect(blocked.mark).toBe('blocked')
    expect(blocked.summary).toMatch(/git remote add origin/)
  })

  it('carries the runtime’s other origin refusal too, for a remote that is not comparable', () => {
    const unusable = status({
      origin: { ok: false, reason: 'the origin remote is not a URL teamree can compare with a teammate’s' }
    })
    expect(startTeamworkFlow({ ...written, status: unusable }).blocker).toMatch(/not a URL teamree can compare/)
  })

  it('does not block anything when origin is fine', () => {
    expect(startTeamworkFlow(written).blocker).toBeNull()
  })
})

describe('which step to lead with', () => {
  it('is the first one that is not done', () => {
    expect(startTeamworkFlow(fresh).currentId).toBe('key')
    expect(startTeamworkFlow({ ...fresh, list: enrolled() }).currentId).toBe('relay')
    expect(startTeamworkFlow(written).currentId).toBe('push')
  })

  it('is the push step for as long as anything is written, because that never self-completes', () => {
    const connected = startTeamworkFlow({ ...written, status: status({ links: [link({ phase: 'connected' })] }) })
    expect(connected.currentId).toBe('push')
    expect(connected.steps.filter((entry) => entry.mark === 'done').map((entry) => entry.id)).toEqual([
      'identity',
      'key',
      'relay',
      'connected'
    ])
  })
})

describe('every step, in every state', () => {
  it('always has a sentence, never a bare code or an empty line', () => {
    const inputs: StartTeamworkInput[] = [
      { list: undefined, relay: undefined, status: undefined },
      fresh,
      written,
      { ...written, status: status({ links: [link({ phase: 'connecting' })] }) },
      { ...written, status: status({ links: [link({ phase: 'stopped', detail: 'gave up' })] }) }
    ]
    for (const input of inputs) {
      for (const entry of startTeamworkFlow(input).steps) {
        expect(entry.summary.length).toBeGreaterThan(20)
        expect(entry.summary.trim()).toBe(entry.summary)
      }
    }
  })
})
