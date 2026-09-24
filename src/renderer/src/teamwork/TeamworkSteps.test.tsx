// What the setup panel puts on screen, rendered rather than reasoned about: that a step's
// state reaches a reader as words, and that what a key grants is above the button that
// grants it. `renderToStaticMarkup`: nothing here depends on layout or on an effect.

import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type {
  MemberList,
  PeerLink,
  RelaySetting,
  TeamworkPublish,
  TeamworkPublishProgress,
  TeamworkRead
} from '@shared/entities'
import { TeamworkSteps, type TeamworkStepsProps } from './TeamworkSteps'
import {
  ADD_KEY_BUTTON,
  KEY_GRANT_WARNING,
  RELAY_CHECK,
  RELAY_PANE_NO_URL,
  RELAY_SERVE,
  RELAY_SERVE_STOPPED,
  type RelayPaneState
} from './startTeamwork'
import { teamworkSummary } from '../sidebar/teamworkSummary'

const SELF_KEY = 'c2VsZmtleXNlbGZrZXlzZWxma2V5c2VsZmtleXNlbGZrZXk='

const roster = (overrides: Partial<MemberList> = {}): MemberList => ({
  projectId: 'p1',
  members: [],
  problems: [],
  self: { handle: 'ada', publicKey: SELF_KEY },
  selfFile: '.teamree/members/ada.pub',
  enrolled: false,
  watched: true,
  readAt: 0,
  ...overrides
})

const enrolled = (): MemberList =>
  roster({
    enrolled: true,
    members: [
      { handle: 'ada', publicKey: SELF_KEY, addedAt: '2026-03-01', file: '.teamree/members/ada.pub', isSelf: true }
    ]
  })

const noRelay = (): RelaySetting => ({
  projectId: 'p1',
  file: '.teamree/relay',
  url: null,
  source: null,
  problem: 'no .teamree/relay',
  onDisk: {
    url: null,
    problem: 'no .teamree/relay'
  },
  override: { name: 'TEAMREE_RELAY_URL', value: null },
  deploy: { command: '/apps/teamree.app/Contents/Resources/relay/teamree-relay deploy', reason: null },
  readAt: 0
})

const relayOnDisk = (): RelaySetting => ({
  ...noRelay(),
  url: 'wss://relay.example/v1/relay',
  source: 'repository',
  problem: null,
  onDisk: { url: 'wss://relay.example/v1/relay', problem: null }
})

const status = (overrides: Partial<TeamworkRead> = {}): TeamworkRead => ({
  state: 'read',
  projectId: 'p1',
  relay: { url: 'wss://relay.example/v1/relay', source: 'repository' },
  disabledReason: null,
  origin: { ok: true, url: 'https://example.com/ada/pager.git' },
  enrolled: true,
  links: [],
  readAt: 0,
  ...overrides
})

const link = (overrides: Partial<PeerLink> = {}): PeerLink => ({
  publicKey: 'peerkey',
  handle: 'priya',
  phase: 'waiting',
  since: 0,
  attempts: 1,
  ...overrides
})

/** The button itself: its words also appear in step 4's suggested commit message. */
const JOIN_BUTTON = 'Add my key</button>'

/** Where `.teamree` is: the primary checkout, which is not where a pane is. */
const PROJECT_PATH = '/Users/ada/code/teamree'

function render(overrides: Partial<TeamworkStepsProps> = {}): string {
  const props: TeamworkStepsProps = {
    projectPath: PROJECT_PATH,
    list: roster(),
    relay: noRelay(),
    status: status(),
    membersPending: false,
    membersError: null,
    relayPending: false,
    relayError: null,
    readErrors: {},
    onJoin: () => {},
    onClearMembersError: () => {},
    onSetRelay: () => {},
    onRetry: () => {},
    origin: { pending: false, error: null },
    onSetOrigin: () => {},
    pane: undefined,
    onStartRelayPane: () => {},
    onClosePane: () => {},
    renderRelayPane: () => null,
    publish: { plan: undefined, pending: false, error: null, result: undefined, progress: undefined },
    onPublish: () => {},
    onCancelPublish: () => {},
    // The choice in front of the steps is already made, except where the choice itself is tested.
    path: 'start',
    onChoosePath: () => {},
    projectName: 'pager',
    onCopy: () => {},
    ...overrides
  }
  return renderToStaticMarkup(<TeamworkSteps {...props} />)
}

/** One relay pane, in whichever of its states the test is about. */
const pane = (overrides: Partial<RelayPaneState> & Pick<RelayPaneState, 'kind'>): RelayPaneState => ({
  terminalId: 'term_2',
  url: null,
  urls: [],
  running: true,
  ...overrides
})

/** The labels of the buttons that cannot be pressed: the attribute that decides it, not the button's presence. */
const disabledButtons = (markup: string): string[] =>
  [...markup.matchAll(/<button[^>]*\sdisabled=""[^>]*>(.*?)<\/button>/g)].map((match) => text(match[1] ?? '').trim())

/** Undoes the escaping the markup applies, so assertions read like the page. */
const text = (markup: string): string =>
  markup
    .replace(/<[^>]+>/g, ' ')
    .replaceAll('&#x27;', '’')
    .replaceAll('&quot;', '"')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')

describe('what a key grants, and where it is said', () => {
  // `docs/teamwork.md`: survivable because it cannot be done invisibly, not because it is small.
  it('is on screen before the button that adds one', () => {
    const markup = render()
    const warned = markup.indexOf('type into any pane here')
    const button = markup.indexOf(JOIN_BUTTON)
    expect(warned).toBeGreaterThan(-1)
    expect(button).toBeGreaterThan(-1)
    expect(warned).toBeLessThan(button)
  })

  it('says what it is in one line, with nothing arguing around it', () => {
    const shown = text(render())
    expect(shown).toContain(KEY_GRANT_WARNING)
    expect(shown).not.toMatch(/None of it can be done invisibly/)
    expect(shown).not.toMatch(/unlocked laptop/)
  })

  it('is gone once the key is in the repository, because there is no button left to warn about', () => {
    const markup = render({ list: enrolled() })
    expect(markup).not.toContain(JOIN_BUTTON)
    expect(markup).not.toContain('type into any pane here')
  })
})

describe('a refused handle', () => {
  const taken = '.teamree/members/ana.pub is already somebody else\u2019s key; choose another handle'

  // A corner of the screen is the wrong place for an instruction about the box the cursor is in.
  it('is shown under the handle field, not only somewhere else', () => {
    const markup = render({ membersError: taken })
    const field = markup.indexOf('field__input')
    const refusal = markup.indexOf('choose another handle')
    expect(refusal).toBeGreaterThan(-1)
    expect(refusal).toBeGreaterThan(field)
    expect(refusal).toBeLessThan(markup.indexOf(JOIN_BUTTON))
    expect(markup).toContain('class="field__error"')
  })

  it('marks the field itself as the thing that was refused', () => {
    expect(render({ membersError: taken })).toContain('aria-invalid="true"')
    expect(render()).not.toContain('aria-invalid="true"')
  })

  it('carries the runtime\u2019s own sentence, which names the file and the remedy', () => {
    expect(text(render({ membersError: taken }))).toContain(taken)
  })

  it('says nothing when nothing has been refused', () => {
    expect(render()).not.toContain('field__error')
  })
})

describe('each step says whether it is done', () => {
  it('marks a fresh project’s steps not done, in words and not only in colour', () => {
    const shown = text(render())
    expect(shown).toContain('1. Your identity')
    expect(shown).toContain('2. Your key is in this repository')
    expect(shown).toContain('3. The team’s relay')
    expect(shown).toContain('4. Commit and push')
    expect(shown).toContain('5. Connected')
    expect(render()).toContain('class="step step--todo step--current"')
  })

  it('shows the identity’s handle and the short form of its key', () => {
    const shown = text(render())
    expect(shown).toContain('ada')
    expect(shown).toContain('c2VsZmtleXNlbGZr…')
    expect(shown).not.toContain(SELF_KEY)
  })

  it('marks the key and relay steps done once both files are in the checkout', () => {
    const markup = render({ list: enrolled(), relay: relayOnDisk() })
    expect(markup).toContain('.teamree/members/ada.pub')
    expect(markup).toContain('wss://relay.example/v1/relay')
    expect(text(markup)).toContain('git commit -m "Set up teamwork"')
  })

  // teamree only opens terminals in worktrees and `.teamree` is in the primary checkout, so the
  // cd is in the block that gets copied.
  it('puts the cd in the block the commands are copied from', () => {
    const markup = render({ list: enrolled(), relay: relayOnDisk() })
    expect(markup).toContain(`<pre class="members__push-commands">cd ${PROJECT_PATH}\ngit add .teamree\n`)
  })

  // teamree cannot see a commit; either mark would claim it can.
  it('never claims the push happened', () => {
    const shown = text(render({ list: enrolled(), relay: relayOnDisk() }))
    expect(shown).toContain('yours to do — teamree does not check this')
  })

  // The promise belongs where it is kept: on screen, above the button.
  it('says what it will commit and where it will send it, before the button', () => {
    const shown = text(
      render({
        list: enrolled(),
        relay: relayOnDisk(),
        publish: {
          plan: {
            projectId: 'project-1',
            files: ['.teamree/members/ada.pub', '.teamree/relay'],
            message: 'Add ada to the teamree roster',
            remote: 'origin',
            branch: 'main',
            upstream: 'origin/main',
            committed: false,
            blocker: null,
            readAt: 0
          },
          pending: false,
          error: null,
          result: undefined,
          progress: undefined
        }
      })
    )
    expect(shown).toContain('.teamree/members/ada.pub')
    expect(shown).toContain('Add ada to the teamree roster')
    expect(shown).toContain('Pushes to')
    expect(shown).toContain('origin/main')
  })

  it('shows a teammate’s link with the runtime’s own detail, not a phase code', () => {
    const waited = 'nobody has answered on this rendezvous across two hourly rotations'
    const shown = text(
      render({
        list: enrolled(),
        relay: relayOnDisk(),
        status: status({ links: [link({ detail: waited })] })
      })
    )
    expect(shown).toContain('priya')
    expect(shown).toContain('not connected')
    expect(shown).toContain(waited)
  })
})

describe('choosing a relay', () => {
  // The answer is a button; everything else is a disclosure away.
  it('leads with the button, and the command the runtime says this build carries', () => {
    const shown = text(render())
    expect(shown).toContain('Deploy a relay')
    expect(shown).toContain('/apps/teamree.app/Contents/Resources/relay/teamree-relay deploy')
    expect(shown).toContain('Cloudflare sign-in in your browser')
  })

  it('puts no other option in front of anybody who has not asked for one', () => {
    const shown = text(render())
    expect(shown).not.toContain('A tunnel to a relay on your own machine')
    expect(shown).not.toContain('A mesh VPN, or a box on the LAN')
    expect(shown).not.toContain('A VPS you rent')
    expect(shown).toContain('Other ways to get a relay')
  })

  // Each of these is answerable; none is a thing to wade through. "Is this going to bill me" is
  // asked before the button is pressed, so one sentence answers its shape; the figures are not ours.
  it('leaves the reasoning to relay/README.md rather than printing it', () => {
    const shown = text(render())
    expect(shown).not.toMatch(/Durable Objects/)
    expect(shown).not.toMatch(/normalised/)
    expect(shown).not.toMatch(/does not inherit your shell/)
  })

  it('prints no price list under the button', () => {
    const shown = text(render())
    expect(shown).not.toMatch(/free plan|daily allowance|pricing/i)
    expect(shown).not.toMatch(/reset at 00:00 UTC/)
  })

  it('says this build carries no relay, rather than offering a button that cannot work', () => {
    const shown = text(render({ relay: { ...noRelay(), deploy: { command: null, reason: 'no relay in this build' } } }))
    expect(shown).toContain('no relay in this build')
    expect(shown).not.toContain('teamree-relay deploy')
  })

  // A relay that arrives in the repository is a decision already taken.
  it('shows none of that to somebody whose team already has one', () => {
    const shown = text(render({ list: enrolled(), relay: relayOnDisk() }))
    expect(shown).not.toContain('Deploy a relay')
    expect(shown).not.toContain('Other ways to get a relay')
    expect(shown).toContain('Change the relay for this project')
  })

  it('never suggests anybody but the team hosts the relay', () => {
    expect(text(render())).not.toMatch(/our relay|teamree’s relay/i)
  })
})

// A relay on your own Mac is fastest for one network and a dead end for two home networks, and
// teamree cannot see which; the sentence saying so is on screen before the button.
describe('running a relay yourself', () => {
  it('stands beside the deploy rather than inside the other ways', () => {
    const markup = render()
    const serve = markup.indexOf('Run a relay yourself')
    const more = markup.indexOf('Other ways to get a relay')
    expect(serve).toBeGreaterThan(-1)
    expect(serve).toBeLessThan(more)
  })

  it('says it is waiting for a URL only while a relay is running', () => {
    expect(text(render())).not.toContain(RELAY_SERVE.watching)
    expect(text(render({ pane: pane({ kind: 'serve' }) }))).toContain(RELAY_SERVE.watching)
  })

  it('says who it will not work for, above the button and not after it', () => {
    const markup = render()
    const limit = markup.indexOf('Same LAN or VPN only')
    const button = markup.indexOf('Run a relay yourself</button>')
    expect(limit).toBeGreaterThan(-1)
    expect(button).toBeGreaterThan(-1)
    expect(limit).toBeLessThan(button)
    expect(text(markup)).toContain(RELAY_SERVE.limit)
  })

  // The runtime's command with the verb swapped: never a guess at a program, never hidden.
  it('shows the command it will run, one disclosure away', () => {
    expect(text(render())).toContain('/apps/teamree.app/Contents/Resources/relay/teamree-relay serve')
  })

  it('is disabled with the runtime’s own sentence when this build carries no relay', () => {
    const markup = render({ relay: { ...noRelay(), deploy: { command: null, reason: 'no relay in this build' } } })
    expect(markup).toContain('Run a relay yourself</button>')
    expect(markup).not.toContain('teamree-relay serve')
    expect(text(markup)).toContain('no relay in this build')
  })

  // Stripping the last word off an unrecognised command would run something nobody can predict.
  it('is disabled, rather than guessing, when the reported command is not the launcher', () => {
    const markup = render({
      relay: { ...noRelay(), deploy: { command: 'npx wrangler deploy --cwd relay', reason: null } }
    })
    expect(text(markup)).toContain('Unrecognised relay command')
    expect(markup).not.toContain('npx wrangler serve')
  })
})

describe('checking a relay', () => {
  const deployPane = pane({ kind: 'deploy', terminalId: 'term_1' })

  it('is offered beside the relay this project is configured with', () => {
    const markup = render({ list: enrolled(), relay: relayOnDisk() })
    const url = markup.indexOf('wss://relay.example/v1/relay')
    const check = markup.indexOf('Check this relay</button>')
    expect(url).toBeGreaterThan(-1)
    expect(check).toBeGreaterThan(url)
  })

  it('says what a pass proves, and what it says nothing about', () => {
    expect(text(render({ list: enrolled(), relay: relayOnDisk() }))).toContain(RELAY_CHECK.proves)
  })

  // The other place somebody has a URL and a doubt: the one typed and not yet committed.
  it('is disabled beside the paste field until something is typed, and says so', () => {
    const shown = text(render())
    expect(shown).toContain(RELAY_CHECK.nothing)
  })

  it('cannot be pressed while a pane is already open, and says which one', () => {
    const shown = text(render({ list: enrolled(), relay: relayOnDisk(), pane: deployPane }))
    expect(shown).toContain('Deploy pane open below')
  })
})

// One slot, three things that can be in it; a second is refused rather than replacing what somebody is reading.
describe('the one relay pane', () => {
  it('says which of the three it is holding', () => {
    const shown = text(render({ pane: pane({ kind: 'serve' }) }))
    expect(shown).toContain('Running a relay on this Mac')
  })

  // Disabled, not merely present: `Deploy a relay` is on the page either way.
  it('greys the other buttons while one is open, with the reason beside them', () => {
    const markup = render({ pane: pane({ kind: 'serve' }) })
    expect(markup).toContain('disabled=""')
    expect(disabledButtons(markup)).toContain('Deploy a relay')
    expect(text(markup)).toContain('Relay pane open below')
  })

  // Offered rather than written, with what committing it means beside the button.
  it('offers the URL a relay run here printed, and says what committing it costs', () => {
    const markup = render({
      pane: pane({ kind: 'serve', url: 'ws://192.168.1.23:8787/v1/relay', urls: ['ws://192.168.1.23:8787/v1/relay'] })
    })
    const shown = text(markup)
    expect(shown).toContain('Relay at')
    expect(shown).toContain('ws://192.168.1.23:8787/v1/relay')
    expect(markup).toContain('Use this relay URL</button>')
    expect(shown).toContain(RELAY_SERVE.committing)
  })

  // A check echoes its input, and its scrollback says `dialling ws://…`: one loosened scheme list
  // upstream would put a dead relay under a button that commits it.
  it('offers nothing out of a check pane, even one that somehow carries a URL', () => {
    const markup = render({
      list: enrolled(),
      relay: relayOnDisk(),
      pane: pane({ kind: 'check', terminalId: 'term_3', running: false, url: 'ws://10.0.0.4:8787/v1/relay' })
    })
    expect(markup).toContain('Checking a relay')
    expect(markup).not.toContain('Use this relay URL</button>')
    expect(text(markup)).not.toContain('The relay is at')
  })

  // An exited serve is a closed port; the address in the scrollback answers nothing.
  it('withdraws the offer when the relay it was running has stopped, and says why', () => {
    const markup = render({
      pane: pane({
        kind: 'serve',
        running: false,
        url: 'ws://192.168.1.23:8787/v1/relay',
        urls: ['ws://192.168.1.23:8787/v1/relay']
      })
    })
    expect(markup).not.toContain('Use this relay URL</button>')
    expect(text(markup)).toContain(RELAY_SERVE_STOPPED)
  })

  // The gate is on the verb, not `running`: a deploy exiting is how it succeeds, and the Worker outlives the pane.
  it('keeps offering what a finished deploy printed, because that outlives the pane', () => {
    const markup = render({
      pane: pane({
        kind: 'deploy',
        running: false,
        url: 'wss://teamree-relay.ada.workers.dev/v1/relay',
        urls: ['wss://teamree-relay.ada.workers.dev/v1/relay']
      })
    })
    expect(markup).toContain('Use this relay URL</button>')
    expect(text(markup)).toContain('Deployed at')
  })

  // A finished pane with nothing to show reads exactly like one still working.
  it('says so when a command has finished and printed no relay URL', () => {
    expect(text(render({ pane: pane({ kind: 'deploy', running: false }) }))).toContain(RELAY_PANE_NO_URL)
  })

  it('says none of that while the command is still running', () => {
    const shown = text(render({ pane: pane({ kind: 'deploy' }) }))
    expect(shown).not.toContain(RELAY_PANE_NO_URL)
    expect(shown).not.toContain(RELAY_SERVE_STOPPED)
  })
})

// The relay's first address is a guess — it cannot tell wifi from a VPN or a container bridge —
// so the panel shows the list rather than the assertion.
describe('a Mac with more than one address', () => {
  const several = (): TeamworkStepsProps['pane'] =>
    pane({
      kind: 'serve',
      url: 'ws://192.168.64.1:8787/v1/relay',
      urls: ['ws://127.0.0.1:8787/v1/relay', 'ws://192.168.64.1:8787/v1/relay', 'ws://192.168.1.23:8787/v1/relay']
    })

  it('offers every other address the pane printed, each with a button of its own', () => {
    const markup = render({ pane: several() })
    expect(markup).toContain('Use ws://192.168.1.23:8787/v1/relay</button>')
    expect(markup).toContain('Use ws://127.0.0.1:8787/v1/relay</button>')
    // The one already offered above is not offered twice.
    expect(markup).not.toContain('Use ws://192.168.64.1:8787/v1/relay</button>')
  })

  it('says the one it leads with is a guess, and that the order is not a ranking', () => {
    expect(text(render({ pane: several() }))).toContain(RELAY_SERVE.choice)
  })

  it('says none of that when the relay printed one address', () => {
    const markup = render({
      pane: pane({ kind: 'serve', url: 'ws://192.168.1.23:8787/v1/relay', urls: ['ws://192.168.1.23:8787/v1/relay'] })
    })
    expect(text(markup)).not.toContain(RELAY_SERVE.choice)
  })
})

// The override is read before the file, so an unreadable one leaves the project with no relay
// while .teamree/relay holds a good URL.
describe('an override that is set and cannot be read', () => {
  const broken = (): RelaySetting => ({
    ...noRelay(),
    url: null,
    source: null,
    onDisk: { url: 'wss://relay.example/v1/relay', problem: null },
    override: { name: 'TEAMREE_RELAY_URL', value: 'wss//typo.example/v1/relay' }
  })

  it('names the variable and the fix, above everything else on the step', () => {
    const markup = render({ relay: broken() })
    const said = text(markup)
    expect(said).toContain('TEAMREE_RELAY_URL=wss//typo.example/v1/relay is not a relay URL and hides .teamree/relay')
    // First on the step: every other line is about a relay the app will not dial.
    expect(markup.indexOf('TEAMREE_RELAY_URL=wss//typo')).toBeLessThan(
      markup.indexOf('Change the relay for this project')
    )
  })

  // The foot-of-step paragraph is written for an override that is winning; this one is breaking.
  it('does not also claim the environment is beating the file', () => {
    expect(text(render({ relay: broken() }))).not.toContain('the environment is beating it for this run')
  })

  it('says none of that when the override is one teamree can dial', () => {
    expect(text(render({ list: enrolled(), relay: relayOnDisk() }))).not.toContain('is not a relay URL')
  })
})

describe('a checkout with no origin', () => {
  const noOrigin = status({
    origin: {
      ok: false,
      reason: 'no origin remote'
    },
    disabledReason: 'no .teamree/relay'
  })

  // Otherwise the step sits at "not connected" for ever while the person checks their wifi.
  it('says so at the top, and puts the field that fixes it there too', () => {
    const shown = text(render({ status: noOrigin }))
    expect(shown).toMatch(/No origin remote/)
    expect(shown).toContain('Origin')
    expect(shown).toContain('Add origin')
    // Both kinds of answer are one disclosure away, rather than in the banner.
    expect(shown).toContain('Requirements')
  })

  it('marks the connected step blocked, in a word', () => {
    expect(render({ status: noOrigin })).toContain('step--blocked')
    expect(text(render({ status: noOrigin }))).toContain('blocked')
  })

  it('says none of that when origin is fine', () => {
    expect(text(render())).not.toContain('This checkout cannot take part yet.')
  })
})

describe('the button the project header sends people to', () => {
  // The header's "no key" tooltip names a button; rendering the two together keeps them from drifting apart.
  it('is on this panel, under the name the tooltip gives it', () => {
    const summary = teamworkSummary(status({ enrolled: false }), Date.now())
    expect(summary?.label).toBe('no key')
    expect(summary?.detail).toContain(ADD_KEY_BUTTON)
    expect(text(render())).toContain(ADD_KEY_BUTTON)
  })
})

describe('before anything has been read', () => {
  it('says it is reading rather than reporting nothing as “not set up”', () => {
    const shown = text(render({ list: undefined, relay: undefined, status: undefined }))
    expect(shown.match(/Reading…/g)?.length).toBe(3)
    expect(render({ list: undefined, relay: undefined, status: undefined })).not.toContain(JOIN_BUTTON)
  })
})

describe('a read that threw', () => {
  // A zero-byte identity.key is the common one.
  it('says what failed, in the step it failed for, and offers to read again', () => {
    const shown = text(
      render({
        list: undefined,
        status: undefined,
        readErrors: { list: 'EISDIR: illegal operation on a directory, read', status: 'identity.key is empty' }
      })
    )
    expect(shown).toContain('EISDIR: illegal operation on a directory, read')
    expect(shown).toMatch(/identity\.key is empty/i)
    expect(shown).not.toMatch(/Reading this machine’s identity/)
    expect(shown).toContain('Try again')
  })
})

describe('a roster nothing is watching', () => {
  // The sweep is the floor under a lost watch: the roster catches up on a timer.
  it('says the list is only as fresh as this read, rather than telling somebody to reopen it', () => {
    const shown = text(render({ list: roster({ watched: false }), relay: relayOnDisk() }))
    expect(shown).toContain('Not watching · may be stale')
    expect(shown).not.toMatch(/Open this dialog again after a pull/)
  })
})

describe('a relay that only the environment names', () => {
  const overridden = (): RelaySetting => ({
    ...noRelay(),
    url: 'wss://tunnel.example/v1/relay',
    source: 'environment',
    problem: null,
    override: { name: 'TEAMREE_RELAY_URL', value: 'wss://tunnel.example/v1/relay' }
  })

  // The tunnel option tells people to do this; following it must not leave step 3 not done for ever.
  it('stops offering the four ways to get one to somebody who has followed one', () => {
    const shown = text(render({ list: enrolled(), relay: overridden() }))
    expect(shown).not.toContain('A VPS you rent')
    expect(shown).toContain('done for this run')
  })
})

/** Each button's label and whether it is the primary, in document order. */
const buttonsIn = (markup: string): { label: string; primary: boolean }[] =>
  [...markup.matchAll(/<button[^>]*class="([^"]*)"[^>]*>([^<]*)<\/button>/g)].map(([, classes, label]) => ({
    label: label ?? '',
    primary: (classes ?? '').split(' ').includes('button--primary')
  }))

describe('the choice before the steps', () => {
  // Five ticks describing two different jobs is what "it worked and it was confusing" meant.
  it('puts both paths in front of somebody who has not said which they are, as two buttons', () => {
    const markup = render({ path: null })
    const shown = text(markup)
    expect(markup).toContain('Start a Team</button>')
    expect(markup).toContain('Join…</button>')
    expect(shown).not.toContain('?')
    // A wall of steps under an unanswered question is what the question replaced.
    expect(shown).not.toContain('1. Your identity')
  })

  // One primary, and no card around either button or around the pair.
  it('makes the likelier one the primary, inside no box', () => {
    const markup = render({ path: null })
    expect(buttonsIn(markup)).toEqual([
      { label: 'Start a Team', primary: true },
      { label: 'Join…', primary: false }
    ])
    expect(markup).not.toMatch(/path-option|<h2/)
  })

  // Marked, never taken: a relay file and a colleague's key are evidence, not intent.
  it('marks the one the repository points at, with the fact behind it, and picks neither', () => {
    const markup = render({ path: null, list: enrolled(), relay: relayOnDisk() })
    expect(text(markup)).toContain('.teamree/relay already here')
    expect(buttonsIn(markup)).toEqual([
      { label: 'Start a Team', primary: false },
      { label: 'Join…', primary: true }
    ])
  })

  // Somebody connected came here to look.
  it('asks nothing of a project where this already works', () => {
    const working = render({
      path: null,
      list: enrolled(),
      relay: relayOnDisk(),
      status: status({ links: [link({ phase: 'connected' })] }),
      publish: {
        plan: undefined,
        pending: false,
        error: null,
        progress: undefined,
        result: {
          projectId: 'p1',
          files: ['.teamree/members/ada.pub'],
          commit: null,
          remote: 'origin',
          branch: 'main',
          push: { ok: true, upstream: 'origin/main', setUpstream: false, alreadyUpToDate: true },
          at: 0
        }
      }
    })
    expect(working).not.toContain('Join…</button>')
    expect(text(working)).toContain('Teamwork is working')
  })

  // People pick the wrong one, and a choice that cannot be unmade is a trap.
  it('keeps the answer on screen with a way to take it back', () => {
    const shown = text(render({ path: 'join' }))
    expect(shown).toContain('Not that')
    expect(shown).toContain('Join a Team')
    expect(shown).not.toMatch(/You are/)
  })
})

// The title, the mark and one line; nothing about why the step is there.
describe('what a step puts on screen', () => {
  it('is the summary and nothing arguing around it', () => {
    const shown = text(render({ path: 'join' }))
    expect(shown).not.toContain('On their machine')
    expect(shown).not.toMatch(/teamree on their machine says “No teammates”/)
    expect(shown).not.toMatch(/everybody has to name the same relay/)
  })

  it('reads the same whichever of the two jobs it is', () => {
    const steps = (path: 'start' | 'join'): string[] =>
      [...render({ path }).matchAll(/class="step__summary">([^<]*)</g)].map((found) => found[1] as string)
    expect(steps('start')).toEqual(steps('join'))
    expect(steps('start').length).toBe(5)
  })

  // Two relays is two halves of a team that never meet.
  it('warns a joiner whose team has not pushed a relay yet, before offering them one', () => {
    const shown = text(render({ path: 'join' }))
    const warning = shown.indexOf('.teamree/relay not pushed yet')
    expect(warning).toBeGreaterThan(-1)
    expect(warning).toBeLessThan(shown.indexOf('Deploy a relay'))
  })

  it('says none of that to somebody who already has a relay', () => {
    expect(text(render({ path: 'join', relay: relayOnDisk() }))).not.toContain('Nobody has pushed')
  })
})

describe('a push that is taking its time', () => {
  const running = (overrides: Partial<TeamworkPublishProgress> = {}): Partial<TeamworkStepsProps> => ({
    list: enrolled(),
    relay: relayOnDisk(),
    now: 100_000,
    publish: {
      plan: {
        projectId: 'p1',
        files: ['.teamree/members/ada.pub'],
        message: 'Add my key to the team',
        remote: 'origin',
        branch: 'main',
        upstream: 'origin/main',
        committed: false,
        blocker: null,
        readAt: 0
      },
      pending: true,
      error: null,
      result: undefined,
      progress: {
        projectId: 'p1',
        phase: 'pushing',
        startedAt: 88_000,
        lastOutputAt: 99_000,
        finishedAt: null,
        output: ['Enumerating objects: 12, done.', 'Writing objects:  60% (6/10)'],
        cancelling: false,
        readAt: 100_000,
        ...overrides
      }
    }
  })

  // All three were being produced and thrown away between git and the window.
  it('says what it is doing, for how long, and what git last printed', () => {
    const shown = text(render(running()))
    expect(shown).toContain('Pushing to the remote')
    expect(shown).toContain('12s')
    expect(shown).toContain('Writing objects:  60% (6/10)')
  })

  // It changes on its own; a reader who cannot see it move is the one "it appears stuck" was worst for.
  it('announces itself to a reader who cannot watch the lines change', () => {
    expect(render(running())).toContain('aria-live="polite"')
  })

  it('offers a way out for as long as it is running', () => {
    expect(render(running())).toContain('Stop</button>')
    // And not before there is anything to stop.
    expect(render({ list: enrolled(), relay: relayOnDisk() })).not.toContain('Stop</button>')
  })

  it('says it is stopping once Stop has been pressed, rather than offering it again', () => {
    // Disabled on the same element, so a second press cannot ask for a thing already happening.
    expect(render(running({ cancelling: true }))).toContain('disabled="">Stopping…</button>')
  })

  // The sentence that makes a hang actionable instead of mysterious.
  it('says when git has gone quiet for longer than a working push does', () => {
    const shown = text(render(running({ lastOutputAt: 40_000 })))
    expect(shown).toMatch(/No output for 1m 00s/)
    expect(shown).toMatch(/credential prompt/)
  })

  it('says git has printed nothing at all rather than showing an empty line', () => {
    expect(text(render(running({ output: [] })))).toContain('No output yet')
  })
})

describe('a push that did not land', () => {
  const refused = (push: TeamworkPublish['push'], progress?: TeamworkPublishProgress): Partial<TeamworkStepsProps> => ({
    list: enrolled(),
    relay: relayOnDisk(),
    now: 100_000,
    publish: {
      plan: undefined,
      pending: false,
      error: null,
      progress,
      result: {
        projectId: 'p1',
        files: ['.teamree/members/ada.pub'],
        commit: { sha: 'abc1234def', shortSha: 'abc1234', message: 'Add my key to the team' },
        remote: 'origin',
        branch: 'main',
        push,
        at: 0
      }
    }
  })

  // Somebody pushed first is the ordinary outcome, fixed in two commands.
  it('offers the push again, and says what to do before pressing it', () => {
    const shown = text(
      render(
        refused({
          ok: false,
          kind: 'rejected',
          error: '! [rejected] main -> main (fetch first)',
          advice: 'origin has commits that main does not · pull or rebase onto origin/main'
        })
      )
    )
    expect(shown).toContain('Try the push again')
    expect(shown).toContain('git pull --rebase')
    expect(shown).not.toMatch(/--force/)
  })

  // This app runs git with no terminal to prompt on, so a push that would ask for a password refuses.
  it('carries the credential remedy the runtime worked out', () => {
    const shown = text(
      render(
        refused({
          ok: false,
          kind: 'auth',
          error: "fatal: could not read Username for 'https://example.com': terminal prompts disabled",
          advice:
            'origin refused the push: fatal: could not read Username. git config --global credential.helper osxkeychain'
        })
      )
    )
    expect(shown).toContain('credential.helper osxkeychain')
    expect(shown).toContain('terminal prompts disabled')
    expect(shown).toContain('Fix the credential outside teamree')
  })

  it('tells somebody who stopped one that nothing was sent, and that the commit is still here', () => {
    const shown = text(
      render(
        refused({
          ok: false,
          kind: 'cancelled',
          error: 'the push was stopped before it finished',
          advice: 'Nothing reached origin · commit kept'
        })
      )
    )
    expect(shown).toContain('Committed abc1234')
    expect(shown).toContain('Nothing sent')
  })

  // "Was that normal?" is unanswerable without the number.
  it('reports how long the whole thing took', () => {
    const shown = text(
      render(
        refused(
          { ok: false, kind: 'timeout', error: 'git push produced nothing', advice: 'It never finished.' },
          {
            projectId: 'p1',
            phase: 'finished',
            startedAt: 10_000,
            lastOutputAt: 10_000,
            finishedAt: 70_000,
            output: [],
            cancelling: false,
            readAt: 70_000
          }
        )
      )
    )
    expect(shown).toContain('· 1m 00s')
  })
})

describe('how it ends', () => {
  const finished = (overrides: Partial<TeamworkStepsProps> = {}): Partial<TeamworkStepsProps> => ({
    list: enrolled(),
    relay: relayOnDisk(),
    ...overrides
  })

  // Half-working is the normal outcome, so the ending is four verdicts and not one.
  it('says which halves worked, one line each', () => {
    const shown = text(render(finished()))
    expect(shown).toContain('Your key')
    expect(shown).toContain('The relay')
    expect(shown).toContain('Pushed')
    expect(shown).toContain('Connected')
    expect(shown).toContain('teamree cannot check this')
  })

  it('names the one thing left to do', () => {
    expect(text(render(finished({ list: roster() })))).toContain('Step 2: Add my key')
  })

  // There is no invitation in this protocol, which is why the person setting it up has to write one.
  it('writes the invitation out in full, and offers to copy it', () => {
    const shown = text(render(finished()))
    expect(shown).toContain('Invite somebody')
    expect(shown).toContain('git clone https://example.com/ada/pager.git')
    expect(shown).toContain('Copy the invitation')
  })

  it('offers no invitation for a checkout with no repository URL to send', () => {
    const shown = text(
      render(
        finished({
          status: status({ origin: { ok: false, reason: 'this project has no origin remote' } })
        })
      )
    )
    expect(shown).not.toContain('Invite somebody')
  })
})
