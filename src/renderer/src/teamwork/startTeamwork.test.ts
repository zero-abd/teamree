// What the setup panel says at each point of setting teamwork up.
//
// The cases worth pinning are the ones where being wrong is expensive: a step
// that claims to be done when it is not, a step that says "blocked" without
// naming what to fix, and the push step, which must never show a tick because
// nothing in the window can see a commit.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type {
  MemberList,
  PeerLink,
  RelaySetting,
  TeamworkPublish,
  TeamworkPublishProgress,
  TeamworkStatus
} from '@shared/entities'
import {
  checkOriginDraft,
  checkRelayDraft,
  formatElapsed,
  inviteText,
  memberFilePreview,
  MORE_RELAYS_LEAD,
  ORIGIN_DETAIL,
  PUBLISH_QUIET_MS,
  publishActivity,
  pushPlan,
  RELAY_DEPLOY,
  RELAY_LEAD,
  RELAY_OPTIONS,
  relayUrlFromOutput,
  retryHint,
  setupOutcome,
  startTeamworkFlow,
  suggestedPath,
  TEAMWORK_PATHS,
  type SetupOutcome,
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
    origin: { ok: true, url: 'https://example.com/ada/pager.git' },
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
      url: 'https://github.com/ada/pager.git',
      kind: 'url',
      note: null
    })
    expect(checkOriginDraft(' git@github.com:ada/pager.git ')).toEqual({
      state: 'ok',
      url: 'git@github.com:ada/pager.git',
      kind: 'url',
      note: null
    })
  })

  // The answer a team sharing a repository over a volume gets now, and the one
  // thing they have to be told while the string is still in front of them: the
  // path is the identity, so the other Mac has to mount it at the same one.
  it('accepts a shared path, and says what the other Mac has to match', () => {
    const checked = checkOriginDraft(' file:///Volumes/team/pager.git/ ')
    expect(checked).toMatchObject({ state: 'ok', kind: 'path', url: '/Volumes/team/pager.git' })
    expect(checked.state === 'ok' && checked.note).toMatch(/\/Volumes\/team\/pager\.git, character for character/)
  })

  // The refusals that are left are the paths no two machines could agree on,
  // and each says which kind of disagreement it would be rather than only that
  // the answer was wrong.
  it('refuses a path that means something different on each machine, and says why', () => {
    expect(checkOriginDraft('/Users/ada/code/pager').state).toBe('ok')
    expect(checkOriginDraft('../pager')).toMatchObject({ reason: expect.stringMatching(/relative path/) })
    expect(checkOriginDraft('~/code/pager')).toMatchObject({ reason: expect.stringMatching(/different directory/) })
    expect(checkOriginDraft('/Volumes/team/../team/pager.git')).toMatchObject({
      reason: expect.stringMatching(/\.\. segment/)
    })
  })

  it('refuses a word that is neither a URL nor a path', () => {
    expect(checkOriginDraft('pager')).toEqual({
      state: 'bad',
      reason:
        'That is neither a URL with a host in it, like https://github.com/you/repo.git, nor a path starting with /.'
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
    expect(unreachable.summary).toMatch(/teammates may be fine/)
  })

  // Two Macs that mounted the volume at different paths do not fail to
  // connect — they compute different project keys, look for each other at
  // different rendezvous points, and wait. This is the only place the panel can
  // say so, because it is the only symptom there is.
  it('names the mount path while a path-shared project is waiting for somebody', () => {
    const onAVolume = status({ origin: { ok: true, url: '/Volumes/team/pager.git' }, links: [link()] })
    const waiting = step({ ...written, status: onAVolume }, 'connected')
    expect(waiting.summary).toMatch(/matched by the path it is mounted at, \/Volumes\/team\/pager\.git/)
    expect(waiting.summary).toMatch(/any other path is on a different project/)
  })

  it('says nothing about mount paths for a repository with a URL, or once somebody is here', () => {
    expect(step({ ...written, status: status({ links: [link()] }) }, 'connected').summary).not.toMatch(/mounted at/)
    const met = status({ origin: { ok: true, url: '/Volumes/team/pager.git' }, links: [link({ phase: 'connected' })] })
    expect(step({ ...written, status: met }, 'connected').summary).not.toMatch(/mounted at/)
  })

  it('leads with a failed handshake, without saying whose end failed', () => {
    const refused = step({ ...written, status: status({ links: [link({ phase: 'refused' })] }) }, 'connected')
    expect(refused.summary).toMatch(/did not complete/)
    // This end raising an error before a byte is sent reaches the same phase,
    // so the panel must not accuse the teammate of answering wrongly.
    expect(refused.summary).not.toMatch(/did not authenticate/)
    expect(refused.summary).toMatch(/Either roster could be the stale one/)
    // And it still says what to do about it, on both ends.
    expect(refused.summary).toMatch(/pull, and ask them to pull/)
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
    // Both kinds of answer, because the sentence a team on a shared volume used
    // to get here told them only that their own answer was not allowed.
    expect(flow.blocker).toMatch(/the absolute path it is mounted at on every Mac/)
    expect(flow.blocker).not.toMatch(/normalised/)
    expect(ORIGIN_DETAIL).toMatch(/normalise/)
    expect(ORIGIN_DETAIL).toMatch(/one volume mounted at two paths/)
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

describe('which of the two jobs this is', () => {
  // Reading the repository is far better evidence than asking somebody who has
  // never done this before. It is still evidence about intent, so it is offered
  // rather than applied: the one thing this panel must not do is take a
  // decision quietly and then describe the result as though it were the
  // reader's.
  it('reads the repository and says which it looks like, with the fact behind it', () => {
    expect(suggestedPath(list(), relay())).toEqual({
      id: 'start',
      because: 'There is no relay and nobody’s key in this checkout, so nothing has been set up.'
    })
    expect(suggestedPath(list(), relayOnDisk())?.id).toBe('join')
    expect(suggestedPath(list(), relayOnDisk())?.because).toContain('.teamree/relay')
  })

  it('reads a colleague’s key as somebody having gone first, relay or no relay', () => {
    const withPriya = list({
      members: [
        {
          handle: 'priya',
          publicKey: 'peerkey',
          addedAt: '2026-03-01',
          file: '.teamree/members/priya.pub',
          isSelf: false
        }
      ]
    })
    expect(suggestedPath(withPriya, relay())).toEqual({
      id: 'join',
      because: 'priya is already on this project’s roster.'
    })
  })

  it('suggests nothing at all until both reads have landed', () => {
    expect(suggestedPath(undefined, relay())).toBeNull()
    expect(suggestedPath(list(), undefined)).toBeNull()
  })

  // The two ends do different things, and half of what anybody needs to know is
  // what the other one is waiting for. Both options say both halves.
  it('describes what the other person does, in both options', () => {
    expect(TEAMWORK_PATHS.map((option) => option.id)).toEqual(['start', 'join'])
    for (const option of TEAMWORK_PATHS) {
      expect(option.what).not.toBe('')
      expect(option.them).not.toBe('')
    }
    expect(TEAMWORK_PATHS[1]?.what).toMatch(/push access is what membership means/)
  })
})

describe('what each step says about the other machine', () => {
  // The sentence that stops two people each waiting for the other, which is the
  // way this goes wrong when it goes wrong.
  it('tells a joiner that their teammate is waiting for exactly this file', () => {
    const joining = step({ ...fresh, path: 'join' }, 'key')
    expect(joining.otherSide).toMatch(/waiting for/)
    expect(joining.otherSide).toMatch(/No teammates/)
  })

  it('tells somebody starting a team that nothing announces them either', () => {
    const starting = step({ ...fresh, path: 'start' }, 'key')
    expect(starting.otherSide).toMatch(/no announcement/i)
  })

  // A joiner who chooses a relay of their own is the failure that looks like
  // nothing being wrong on either machine.
  it('warns a joiner off choosing a relay, and tells a starter theirs is the team’s', () => {
    expect(step({ ...fresh, path: 'join' }, 'relay').why).toMatch(/everybody has to name the same relay/)
    expect(step({ ...fresh, path: 'join' }, 'relay').otherSide).toMatch(/Nobody connected/)
    expect(step({ ...fresh, path: 'start' }, 'relay').why).toMatch(/Your team runs it and teamree runs none/)
  })

  it('says why every step is there, whichever job it is', () => {
    for (const path of ['start', 'join'] as const) {
      for (const entry of startTeamworkFlow({ ...fresh, path }).steps) {
        expect(entry.why, `${entry.id} on the ${path} path`).not.toBe('')
      }
    }
  })

  // Both people hit this at the same moment on the same base, and the instinct
  // it provokes — forcing — is the wrong one.
  it('warns a joiner about the rejection two people pushing at once get', () => {
    expect(step({ ...fresh, path: 'join' }, 'push').otherSide).toMatch(/pull with rebase/i)
  })
})

describe('a push while it is running', () => {
  const progress = (overrides: Partial<TeamworkPublishProgress> = {}): TeamworkPublishProgress => ({
    projectId: 'p1',
    phase: 'pushing',
    startedAt: 1_000,
    lastOutputAt: 1_000,
    finishedAt: null,
    output: [],
    cancelling: false,
    readAt: 1_000,
    ...overrides
  })

  it('says what it is doing and for how long, in words rather than a phase name', () => {
    const activity = publishActivity(progress({ output: ['Writing objects:  60% (6/10)'] }), 6_500)
    expect(activity?.doing).toBe('Pushing to the remote')
    expect(activity?.elapsedMs).toBe(5_500)
    expect(formatElapsed(activity?.elapsedMs ?? 0)).toBe('6s')
    expect(activity?.lastLine).toBe('Writing objects:  60% (6/10)')
    expect(activity?.running).toBe(true)
  })

  // The sentence that turns "it appears stuck" into something to act on. A push
  // that is working talks; one waiting for a credential nothing can supply
  // never says a word.
  it('says nothing about silence until it is longer than a working push’s', () => {
    expect(publishActivity(progress(), 1_000 + PUBLISH_QUIET_MS - 1)?.quiet).toBeNull()
    const stalled = publishActivity(progress(), 1_000 + 45_000)
    expect(stalled?.quiet).toMatch(/git has printed nothing for 45s/)
    expect(stalled?.quiet).toMatch(/waiting for a credential/)
    expect(stalled?.quiet).toMatch(/run the same push once in Terminal/)
  })

  // Staging and committing are local and fast; blaming a credential for a
  // silence during them would be the panel guessing.
  it('blames nothing while it is still doing the local half', () => {
    expect(publishActivity(progress({ phase: 'staging' }), 1_000 + 120_000)?.quiet).toBeNull()
    expect(publishActivity(progress({ phase: 'staging' }), 1_000)?.doing).toBe('Staging the files')
  })

  it('says it is stopping rather than pushing once Stop has been pressed', () => {
    const activity = publishActivity(progress({ cancelling: true }), 1_000 + 60_000)
    expect(activity?.doing).toBe('Stopping')
    expect(activity?.quiet).toBeNull()
    expect(activity?.cancelling).toBe(true)
  })

  // How long it took is the answer to "was that normal?", which is the question
  // somebody has after sitting through a slow one.
  it('reports the whole duration once it is over, and stops counting', () => {
    const activity = publishActivity(progress({ finishedAt: 9_000, phase: 'finished' }), 500_000)
    expect(activity?.running).toBe(false)
    expect(activity?.elapsedMs).toBe(8_000)
    expect(formatElapsed(8_000)).toBe('8s')
  })

  it('has nothing to say when no publish has ever run', () => {
    expect(publishActivity(undefined, 1_000)).toBeNull()
  })
})

describe('how long something took, for somebody watching a clock', () => {
  it('counts in seconds below a minute and in minutes above one, never in decimals', () => {
    expect(formatElapsed(0)).toBe('0s')
    expect(formatElapsed(1_400)).toBe('1s')
    expect(formatElapsed(59_400)).toBe('59s')
    expect(formatElapsed(60_000)).toBe('1m 00s')
    expect(formatElapsed(754_000)).toBe('12m 34s')
  })
})

describe('what to do about a push that did not land', () => {
  // A rejection is the one failure trying again fixes, and only after a pull.
  it('says to pull first after a rejection, and never to force', () => {
    expect(retryHint('rejected')).toMatch(/git pull --rebase/)
    expect(retryHint('rejected')).not.toMatch(/force/i)
  })

  it('says a credential is not something this window changes', () => {
    expect(retryHint('auth')).toMatch(/nothing in this window changes it/)
    expect(retryHint('host-key')).toMatch(/nothing in this window changes it/)
  })

  it('reassures somebody who stopped one that nothing was sent', () => {
    expect(retryHint('cancelled')).toMatch(/Nothing was sent/)
  })

  it('has no opinion about a refusal it does not recognise', () => {
    expect(retryHint('other')).toBeNull()
  })
})

describe('the relay field, taking whatever form the URL arrives in', () => {
  // What people send each other is a sentence with a URL in it, not a bare
  // address — so a field that only accepts the bare address refuses the exact
  // input everybody has, with a message about schemes.
  it('takes the URL out of a message somebody pasted whole', () => {
    const pasted =
      'hey — the relay is wss://relay.example/v1/relay, clone https://example.com/ada/pager.git and add your key'
    expect(checkRelayDraft(pasted)).toEqual({ state: 'ok', url: 'wss://relay.example/v1/relay' })
  })

  it('drops the full stop a URL at the end of a sentence arrives with', () => {
    expect(checkRelayDraft('the relay is wss://relay.example/v1/relay.')).toEqual({
      state: 'ok',
      url: 'wss://relay.example/v1/relay'
    })
  })

  // The repository URL is only a URL by accident of being in the same
  // paragraph, and the WebSocket one is the answer to the question being asked.
  it('prefers the WebSocket URL to whatever else is in the message', () => {
    expect(checkRelayDraft('clone https://example.com/ada/pager.git — relay wss://r.example/v1/relay')).toEqual({
      state: 'ok',
      url: 'wss://r.example/v1/relay'
    })
  })

  // The grammar is unchanged: what is found goes through the same parser and is
  // refused on the same terms, with the same correction offered.
  it('still refuses an https address, and still offers the corrected one', () => {
    const check = checkRelayDraft('it is at https://ada.workers.dev')
    expect(check.state).toBe('bad')
    if (check.state === 'bad') expect(check.suggestion).toBe('wss://ada.workers.dev/v1/relay')
  })

  it('is empty rather than wrong when nothing has been typed', () => {
    expect(checkRelayDraft('   ')).toEqual({ state: 'empty' })
  })
})

describe('the message to send a teammate', () => {
  const invite = (overrides: Parameters<typeof inviteText>[0] | null = null): string | null =>
    inviteText(
      overrides ?? {
        originUrl: 'https://example.com/ada/pager.git',
        relayUrl: 'wss://relay.example/v1/relay',
        projectName: 'pager',
        handle: 'ada'
      }
    )

  // There is no invitation in this protocol, which is exactly why the person
  // doing this has to write one: they have to explain a system with no
  // invitations to somebody who is expecting one.
  it('names the repository, every step, and the one that people forget', () => {
    const text = invite() ?? ''
    expect(text).toContain('git clone https://example.com/ada/pager.git')
    expect(text).toContain('Add my key')
    expect(text).toContain('Commit and push')
    expect(text).toMatch(/That is what puts you on the team/)
    expect(text).toContain('wss://relay.example/v1/relay')
  })

  // The person being invited is the one taking on the grant, so the invitation
  // is where they find out about it — not the app, afterwards.
  it('says what a key in the roster grants, and what stops it being invisible', () => {
    const text = invite() ?? ''
    expect(text).toMatch(/running commands as you/)
    expect(text).toMatch(/attributed live/)
    expect(text).toMatch(/mute is/)
  })

  it('says the relay is still coming when it is not in the repository yet', () => {
    const text =
      invite({ originUrl: 'https://example.com/ada/pager.git', relayUrl: null, projectName: 'pager', handle: null }) ??
      ''
    expect(text).toMatch(/not in the repository yet/)
  })

  // An invitation that cannot say where the repository is is worse than no
  // button at all.
  it('is nothing when there is no repository URL to send', () => {
    expect(invite({ originUrl: null, relayUrl: null, projectName: 'pager', handle: 'ada' })).toBeNull()
  })

  // The only condition a teammate can fail while doing everything else right,
  // sent to them at the one moment somebody is writing to them about it.
  it('tells a teammate where to mount a repository that is shared over a path', () => {
    const text =
      invite({
        originUrl: '/Volumes/team/pager.git',
        relayUrl: 'wss://relay.example/v1/relay',
        projectName: 'pager',
        handle: 'ada'
      }) ?? ''
    expect(text).toContain('git clone /Volumes/team/pager.git')
    expect(text).toMatch(/mount it at exactly \/Volumes\/team\/pager\.git/)
    expect(text).toMatch(/we never see/)
  })

  it('says nothing about mounting anything when the origin is a URL', () => {
    expect(invite() ?? '').not.toMatch(/mount/)
  })
})

describe('where this ended up', () => {
  const pushed = (overrides?: TeamworkPublish['push']): TeamworkPublish => ({
    projectId: 'p1',
    files: ['.teamree/members/ada.pub'],
    commit: { sha: 'abc1234def', shortSha: 'abc1234', message: 'Add my key to the team' },
    remote: 'origin',
    branch: 'main',
    push: overrides ?? { ok: true, upstream: 'origin/main', setUpstream: false, alreadyUpToDate: false },
    at: 0
  })

  const outcome = (input: Partial<StartTeamworkInput> & { publish?: TeamworkPublish } = {}): SetupOutcome | null =>
    setupOutcome({ list: enrolled(), relay: relayOnDisk(), status: status(), ...input })

  // Four verdicts rather than one, because half-working is the normal outcome
  // here and a single tick would have to be wrong about one of the halves.
  it('answers whether it worked as four separate facts', () => {
    const result = outcome({ publish: pushed(), status: status({ links: [link({ phase: 'connected' })] }) })
    expect(result?.done).toBe(true)
    expect(result?.head).toBe('Teamwork is working in this repository.')
    expect(result?.facts.map((fact) => fact.label)).toEqual(['Your key', 'The relay', 'Pushed', 'Connected'])
    expect(result?.facts.every((fact) => fact.state === 'yes')).toBe(true)
    expect(result?.next).toBeNull()
  })

  it('names which half when the commit landed and the push did not', () => {
    const result = outcome({
      publish: pushed({
        ok: false,
        kind: 'rejected',
        error: '! [rejected] main -> main (fetch first)',
        advice: 'origin has commits that main does not. Pull or rebase onto origin/main and push again.'
      })
    })
    expect(result?.head).toMatch(/the commit was made here and the push did not land/)
    const push = result?.facts.find((fact) => fact.label === 'Pushed')
    expect(push?.state).toBe('no')
    expect(push?.detail).toMatch(/Pull or rebase onto origin\/main/)
  })

  // teamree cannot see a commit somebody made in a terminal, and either a tick
  // or a cross there would be it claiming that it can.
  it('refuses to guess at a push it did not make', () => {
    const push = outcome()?.facts.find((fact) => fact.label === 'Pushed')
    expect(push?.state).toBe('unknown')
    expect(push?.detail).toMatch(/git status/)
  })

  it('says what is left, and that waiting for somebody is not a fault', () => {
    expect(outcome({ publish: pushed() })?.head).toMatch(/What is left is somebody else opening teamree/)
    expect(outcome({ list: list() })?.next).toContain('Add my key')
    expect(outcome({ relay: relay() })?.next).toMatch(/Step 3/)
  })

  it('has nothing to say before the reads have landed', () => {
    expect(setupOutcome({ list: undefined, relay: undefined, status: undefined })).toBeNull()
  })
})
