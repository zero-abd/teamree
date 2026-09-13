// What the setup panel says at each point of setting teamwork up.
//
// The cases worth pinning are the ones where being wrong is expensive: a step
// that claims to be done when it is not, a step that says "blocked" without
// naming what to fix, and the push step, which must never show a tick because
// nothing in the window can see a commit.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { MemberList, PeerLink, RelaySetting, TeamworkStatus } from '@shared/entities'
import {
  checkOriginDraft,
  checkRelayDraft,
  memberFilePreview,
  MORE_RELAYS_LEAD,
  ORIGIN_DETAIL,
  pushPlan,
  RELAY_DEPLOY,
  RELAY_LEAD,
  RELAY_OPTIONS,
  relayUrlFromOutput,
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
    onDisk: {
      url: null,
      problem: 'no .teamree/relay in this project, so teamree does not know which relay your team meets on'
    },
    override: { name: 'TEAMREE_RELAY_URL', value: null },
    deploy: { command: '/apps/teamree.app/Contents/Resources/relay/teamree-relay deploy', reason: null },
    readAt: 0,
    ...overrides
  }
}

const relayOnDisk = (url = 'wss://relay.example/v1/relay'): RelaySetting =>
  relay({ url, source: 'repository', problem: null, onDisk: { url, problem: null } })

function status(overrides: Partial<TeamworkStatus> = {}): TeamworkStatus {
  return {
    projectId: 'p1',
    relay: { url: 'wss://relay.example/v1/relay', source: 'repository' },
    disabledReason: null,
    origin: { ok: true },
    enrolled: true,
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

/** Both files written into the checkout, with nobody else on the roster. */
const written: StartTeamworkInput = { list: enrolled(), relay: relayOnDisk(), status: status() }

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
  it('is not done when nothing has been written, and repeats the runtime’s reason as a sentence', () => {
    const pending = step(fresh, 'relay')
    expect(pending.mark).toBe('todo')
    expect(pending.summary).toBe(
      'No .teamree/relay in this project, so teamree does not know which relay your team meets on.'
    )
  })

  // The read behind this is the file in the working tree, so what it can say is
  // what step 2 says about the key: it is in this checkout, and step 4 is what
  // makes it the team's. "Everyone who pulls it meets there" was true of a push
  // this panel deliberately does not perform and cannot see.
  it('is done when the file in this checkout names one, and does not claim it was pushed', () => {
    const done = step(written, 'relay')
    expect(done.mark).toBe('done')
    expect(done.summary).toContain('wss://relay.example/v1/relay')
    expect(done.summary).toMatch(/Step 4 is what makes it the team’s/)
  })

  // The override is for the ephemeral tunnel URL, which is per-machine and dies
  // with the process. Treating it as the team's relay would tell somebody they
  // were set up when no teammate can read a thing — so it is done for this run
  // and never simply done.
  it('is done only for this run when the environment names a relay, and says why that is not enough', () => {
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
    expect(overridden.mark).toBe('this-run')
    expect(overridden.summary).toMatch(/per-machine and dies with this process/)
  })

  // The recommendation stopped being one of four equals the moment it became a
  // button, so what is left in this list is genuinely "other ways" — and every
  // one of them is behind a disclosure.
  it('lists only the ways that are not the button, quickest to try first', () => {
    expect(RELAY_OPTIONS.map((option) => option.id)).toEqual(['tunnel', 'mesh', 'vps'])
    expect(RELAY_OPTIONS.map((option) => option.tier)).toEqual(['fallback', 'more', 'more'])
  })

  it('says of each whether its address is stable enough to commit', () => {
    // The tunnel is the one that must not be committed: it changes every time
    // it restarts, and a dead URL in a diff is worse than no URL.
    expect(RELAY_OPTIONS.find((option) => option.id === 'tunnel')?.keep).toBe('override')
    expect(RELAY_OPTIONS.filter((option) => option.keep === 'commit').map((option) => option.id)).toEqual([
      'mesh',
      'vps'
    ])
    for (const option of RELAY_OPTIONS) {
      expect(option.effort).not.toBe('')
      expect(option.money).not.toBe('')
      expect(option.commands).not.toBe('')
    }
  })

  // Every option left in the list needs a clone, because the Dockerfile is in
  // one — and the one that does not is the button, whose command the runtime
  // reports rather than this file guessing at it. A panel that gave the old
  // single answer sent half its readers to a directory they do not have.
  it('says where these commands run, and agrees with relay/README.md that it is a clone', () => {
    const readme = readFileSync(new URL('../../../../relay/README.md', import.meta.url), 'utf8')
    for (const option of RELAY_OPTIONS) expect(option.commands.startsWith('cd relay')).toBe(true)
    expect(MORE_RELAYS_LEAD).toMatch(/clone of the\s+teamree repository/)
    expect(readme).toMatch(/does need a clone of this repository/)
  })

  // The command is the runtime's answer now, because it is different in a
  // checkout and in an installed app; what stays here is only that the deploy
  // is described as going to the team's own account and hosting nothing.
  it('never suggests teamree hosts a relay for anybody', () => {
    expect(RELAY_DEPLOY.what).toMatch(/own Cloudflare account/)
    expect(RELAY_DEPLOY.what).toMatch(/teamree hosts nothing/)
    expect(RELAY_DEPLOY.browser).toMatch(/A browser opens once/)
  })

  it('does not promise the Worker is free, and no longer argues the point in the panel', () => {
    const readme = readFileSync(new URL('../../../../relay/README.md', import.meta.url), 'utf8')
    // The pricing paragraph was several lines in front of the button. It is a
    // thing to look up, and relay/README.md is where it is looked up.
    expect(`${RELAY_LEAD} ${RELAY_DEPLOY.what} ${RELAY_DEPLOY.browser}`).not.toMatch(/free/i)
    expect(readme).toMatch(/pricing/i)
  })
})

describe('the wss:// URL a finished deploy printed', () => {
  it('is read out of what the pane has said', () => {
    expect(
      relayUrlFromOutput(
        'teamree-relay: deployed. Your relay endpoint is\n\n    wss://teamree-relay.ada.workers.dev/v1/relay\n'
      )
    ).toBe('wss://teamree-relay.ada.workers.dev/v1/relay')
  })

  // Somebody who deploys twice in one pane means the second one.
  it('takes the last one when a pane holds more than one deploy', () => {
    expect(relayUrlFromOutput('wss://one.example/v1/relay ... later ... wss://two.example/v1/relay')).toBe(
      'wss://two.example/v1/relay'
    )
  })

  it('is null when nothing in the pane is a relay URL', () => {
    expect(relayUrlFromOutput('Authenticating with Cloudflare... https://dash.cloudflare.com')).toBeNull()
  })
})

describe('the origin field’s verdict on what has been typed', () => {
  it('accepts the URL forms two people cloning one repository actually use', () => {
    expect(checkOriginDraft('https://github.com/ada/pager.git')).toEqual({
      state: 'ok',
      url: 'https://github.com/ada/pager.git'
    })
    expect(checkOriginDraft(' git@github.com:ada/pager.git ')).toEqual({
      state: 'ok',
      url: 'git@github.com:ada/pager.git'
    })
  })

  // The one refusal somebody will actually hit, and the reason it is a sentence
  // rather than a code: a path is a perfectly good git remote and a useless
  // project identity, because nobody else can clone it.
  it('refuses a path on this disk, and says why rather than only that', () => {
    const refused = checkOriginDraft('/Users/ada/code/pager')
    expect(refused.state).toBe('bad')
    expect(refused).toMatchObject({ reason: expect.stringMatching(/path on this disk/) })
    expect(checkOriginDraft('../pager').state).toBe('bad')
    expect(checkOriginDraft('file:///Users/ada/code/pager').state).toBe('bad')
  })

  it('refuses anything with no host in it', () => {
    expect(checkOriginDraft('pager')).toEqual({
      state: 'bad',
      reason: 'That is not a URL with a host in it, like https://github.com/you/repo.git.'
    })
  })

  it('says nothing at all about an empty field', () => {
    expect(checkOriginDraft('   ')).toEqual({ state: 'empty' })
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
  /** Where `.teamree` is: the primary checkout, which is not where a pane is. */
  const PROJECT_PATH = '/Users/ada/code/teamree'

  it('has nothing to say until a file has been written', () => {
    const nothing = step(fresh, 'push')
    expect(nothing.mark).toBe('todo')
    expect(pushPlan(fresh.list, fresh.relay, PROJECT_PATH)).toBeNull()
  })

  // A tick here would be the app claiming something it cannot see. There is a
  // button for the act now, and pressing it is still not a thing the panel can
  // observe afterwards: nothing in the window reads the repository's history.
  it('is never marked done, because teamree cannot see a commit', () => {
    const owed = step(written, 'push')
    expect(owed.mark).toBe('unchecked')
    expect(owed.summary).toMatch(/cannot see whether you have done that/)
    expect(owed.summary).toMatch(/says what it will commit and where it will send it/)
  })

  it('names both files and one commit that carries them', () => {
    expect(pushPlan(written.list, written.relay, PROJECT_PATH)).toEqual({
      files: ['.teamree/members/ada.pub', '.teamree/relay'],
      commands: `cd ${PROJECT_PATH}\ngit add .teamree\ngit commit -m "Set up teamwork"\ngit push`
    })
  })

  it('names only the key when that is all that was written', () => {
    expect(pushPlan(enrolled(), relay(), PROJECT_PATH)).toEqual({
      files: ['.teamree/members/ada.pub'],
      commands: `cd ${PROJECT_PATH}\ngit add .teamree\ngit commit -m "Add my key to the team"\ngit push`
    })
  })

  it('names only the relay when somebody set that and has not joined', () => {
    expect(pushPlan(list(), relayOnDisk(), PROJECT_PATH)).toEqual({
      files: ['.teamree/relay'],
      commands: `cd ${PROJECT_PATH}\ngit add .teamree\ngit commit -m "Meet on our relay"\ngit push`
    })
  })

  // The pane a person has in front of them is a worktree's, and `.teamree` is
  // in the primary checkout, so the commands without this stage nothing and
  // blame git for it. A path with a space in it is ordinary on a Mac.
  it('quotes the path when a shell would otherwise read it as two words', () => {
    expect(pushPlan(enrolled(), relay(), '/Users/ada/My Projects/teamree')?.commands).toMatch(
      /^cd '\/Users\/ada\/My Projects\/teamree'\n/
    )
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

  it('leads with a failed handshake, without saying whose end failed', () => {
    const refused = step({ ...written, status: status({ links: [link({ phase: 'refused' })] }) }, 'connected')
    expect(refused.summary).toMatch(/did not complete/)
    // This end raising an error before a byte is sent reaches the same phase,
    // so the panel must not accuse the teammate of answering wrongly.
    expect(refused.summary).not.toMatch(/did not authenticate/)
    expect(refused.summary).toMatch(/not established/)
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

  // One sentence, because the fix is a field and a button under it now rather
  // than a command to go and type somewhere else. The paragraph that explained
  // normalised origin hashes is behind a disclosure beside that field.
  it('says what to add in one sentence, and keeps the explanation for whoever asks', () => {
    const flow = startTeamworkFlow({ ...fresh, status: noOrigin })
    expect(flow.blocker).toMatch(/Add the URL you and your teammates both cloned/)
    expect(flow.blocker).toMatch(/not a path on this disk/)
    expect(flow.blocker).not.toMatch(/normalised/)
    expect(ORIGIN_DETAIL).toMatch(/normalised origin/)
  })

  it('blocks the connected step rather than showing it as merely not done', () => {
    const blocked = step({ ...written, status: noOrigin }, 'connected')
    expect(blocked.mark).toBe('blocked')
    expect(blocked.summary).toMatch(/Add the URL you and your teammates both cloned/)
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

describe('step 5 when this machine’s own key is not on the roster', () => {
  // The sidebar header has checked this before any phase since the day it was
  // written, for the reason its comment gives: every phase below it is a
  // sentence about somebody else's machine. The panel is the surface the
  // runbook sends people to, and it was saying the teammate was absent.
  it('blames this checkout rather than the teammate, and names the two steps that fix it', () => {
    const mine = step({ ...written, status: status({ enrolled: false, links: [link()] }) }, 'connected')
    expect(mine.mark).toBe('blocked')
    expect(mine.summary).toMatch(/step 2/i)
    expect(mine.summary).toMatch(/step 4/i)
    expect(mine.summary).not.toMatch(/no teammate’s machine is on it yet/)
  })

  // The rendezvous is derived from the two keys and this checkout's roster is
  // not one of them, so a teammate who still has the key can be connected while
  // this checkout has lost it. A link that is up outranks what a file says.
  it('does not deny a link that is up, whatever this checkout’s roster says', () => {
    const live = step(
      { ...written, status: status({ enrolled: false, links: [link({ phase: 'connected' })] }) },
      'connected'
    )
    expect(live.mark).toBe('done')
  })
})

describe('step 5 while the links are still being opened', () => {
  const withTeammate = (): MemberList =>
    list({
      enrolled: true,
      members: [
        { handle: 'ada', publicKey: SELF_KEY, addedAt: '2026-03-01', file: '.teamree/members/ada.pub', isSelf: true },
        {
          handle: 'priya',
          publicKey: 'peerkey',
          addedAt: '2026-03-02',
          file: '.teamree/members/priya.pub',
          isSelf: false
        }
      ]
    })

  // For the length of one reconcile the roster is on disk and the links are
  // not, and the roster this panel renders three lines below says so.
  it('does not call a roster of several a roster of one', () => {
    const coming = step({ ...written, list: withTeammate(), status: status({ links: [] }) }, 'connected')
    expect(coming.summary).not.toMatch(/nobody in it but you/)
    expect(coming.summary).toMatch(/priya/)
  })

  it('still says a roster of one is a roster of one', () => {
    expect(step(written, 'connected').summary).toMatch(/nobody in it but you/)
  })
})

describe('the file the handle field promises', () => {
  it('is the name the runtime will write, not the one that was typed', () => {
    expect(memberFilePreview(enrolled(), 'Ada Lovelace')).toBe('.teamree/members/ada-lovelace.pub')
  })

  it('is the name git already gives this machine when nothing has been typed', () => {
    expect(memberFilePreview(enrolled(), '   ')).toBe('.teamree/members/ada.pub')
  })

  // Nothing survives sanitising, so there is no filename to promise and the
  // field must not invent one.
  it('is nothing at all when the typed name has nothing usable in it', () => {
    expect(memberFilePreview(enrolled(), '???')).toBeNull()
  })
})

describe('a read that failed', () => {
  const nothingRead: StartTeamworkInput = {
    list: undefined,
    relay: undefined,
    status: undefined,
    failedReads: { list: 'EISDIR: illegal operation on a directory, read', status: 'identity.key is empty' }
  }

  // "Reading…" for ever is the same sentence as "this is still loading", and
  // the one thing certainly true after a throw is that it is not.
  it('says what failed rather than claiming it is still reading', () => {
    const identity = step(nothingRead, 'identity')
    expect(identity.mark).toBe('blocked')
    expect(identity.summary).toContain('EISDIR')
    expect(identity.summary).not.toMatch(/Reading/)
    expect(step(nothingRead, 'key').summary).toContain('EISDIR')
    // Clause-shaped runtime reasons are capitalised into sentences here, the
    // way every other reason this panel repeats is.
    expect(step(nothingRead, 'connected').summary).toMatch(/identity\.key is empty/i)
    expect(step(nothingRead, 'connected').mark).toBe('blocked')
  })

  it('still says it is reading while a read is merely in flight', () => {
    const pending = step({ list: undefined, relay: undefined, status: undefined }, 'identity')
    expect(pending.mark).toBe('todo')
    expect(pending.summary).toMatch(/Reading/)
  })
})

describe('step 3 when the recommended tunnel path was followed', () => {
  const overridden: StartTeamworkInput = {
    ...written,
    relay: relay({
      url: 'wss://tunnel.example/v1/relay',
      source: 'environment',
      problem: null,
      override: { name: 'TEAMREE_RELAY_URL', value: 'wss://tunnel.example/v1/relay' }
    })
  }

  // RELAY_OPTIONS' tunnel entry says to set the override and leave the file
  // alone. Marking that todo parks the flow on step 3 for the whole session and
  // keeps the wall of four options on screen while a teammate is connected.
  it('does not park the flow on step 3 for the whole session', () => {
    expect(startTeamworkFlow(overridden).currentId).not.toBe('relay')
    expect(startTeamworkFlow(overridden).currentId).toBe('push')
  })
})
