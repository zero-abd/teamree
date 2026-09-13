// What the setup panel actually puts on screen, rendered rather than reasoned
// about.
//
// The model test covers what each step decides. This covers the two things only
// the markup can settle: that a step's state reaches a reader as words and not
// only as a colour, and — the one that matters — that what a key grants is on
// screen *above* the button that grants it. An order is not something a pure
// function can assert; it is a property of the rendered page, so it is checked
// on the rendered page.
//
// `renderToStaticMarkup` rather than a DOM: these components take their whole
// world as props, nothing here depends on layout or on an effect having run,
// and a string is the cheapest thing to ask "which of these comes first".

import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { MemberList, PeerLink, RelaySetting, TeamworkStatus } from '@shared/entities'
import { TeamworkSteps, type TeamworkStepsProps } from './StartTeamworkDialog'
import { KEY_GRANT_WARNING } from './startTeamwork'

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
  problem: 'no .teamree/relay in this project, so teamree does not know which relay your team meets on',
  committed: {
    url: null,
    problem: 'no .teamree/relay in this project, so teamree does not know which relay your team meets on'
  },
  override: { name: 'TEAMREE_RELAY_URL', value: null },
  readAt: 0
})

const committedRelay = (): RelaySetting => ({
  ...noRelay(),
  url: 'wss://relay.example/v1/relay',
  source: 'repository',
  problem: null,
  committed: { url: 'wss://relay.example/v1/relay', problem: null }
})

const status = (overrides: Partial<TeamworkStatus> = {}): TeamworkStatus => ({
  projectId: 'p1',
  relay: { url: 'wss://relay.example/v1/relay', source: 'repository' },
  disabledReason: null,
  origin: { ok: true },
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

function render(overrides: Partial<TeamworkStepsProps> = {}): string {
  const props: TeamworkStepsProps = {
    list: roster(),
    relay: noRelay(),
    status: status(),
    membersPending: false,
    membersError: null,
    relayPending: false,
    relayError: null,
    onJoin: () => {},
    onClearMembersError: () => {},
    onSetRelay: () => {},
    ...overrides
  }
  return renderToStaticMarkup(<TeamworkSteps {...props} />)
}

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
  // The whole argument of `docs/teamwork.md` is that this is survivable because
  // it cannot be done invisibly — not because it is small. A flow that let
  // somebody add a colleague first and explain afterwards would be the one
  // place that sentence never reached the person it is about.
  it('is on screen before the button that adds one', () => {
    const markup = render()
    const warned = markup.indexOf('can run commands on this machine')
    const button = markup.indexOf(JOIN_BUTTON)
    expect(warned).toBeGreaterThan(-1)
    expect(button).toBeGreaterThan(-1)
    expect(warned).toBeLessThan(button)
  })

  it('says what it is in plain words, and names every mitigation beside it', () => {
    const shown = text(render())
    expect(shown).toContain(KEY_GRANT_WARNING.head)
    expect(shown).toMatch(/running arbitrary commands as you/)
    for (const mitigation of KEY_GRANT_WARNING.mitigations) expect(shown).toContain(mitigation)
    expect(shown).toContain(KEY_GRANT_WARNING.close)
  })

  it('is gone once the key is in the repository, because there is no button left to warn about', () => {
    const markup = render({ list: enrolled() })
    expect(markup).not.toContain(JOIN_BUTTON)
    expect(markup).not.toContain('can run commands on this machine')
  })
})

describe('a refused handle', () => {
  const taken = '.teamree/members/ana.pub is already somebody else\u2019s key; choose another handle'

  // It used to be raised only as a notice, and the modal's own scrim was
  // painted over it: the dialog stayed open, the button came back to life, and
  // the sentence that named the remedy was never seen. Notices sit above the
  // scrim now, but a corner of the screen is still the wrong place for an
  // instruction about the box the cursor is in.
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
    const markup = render({ list: enrolled(), relay: committedRelay() })
    expect(markup).toContain('.teamree/members/ada.pub')
    expect(markup).toContain('wss://relay.example/v1/relay')
    expect(text(markup)).toContain('git commit -m "Set up teamwork"')
  })

  // Never a tick and never a cross. teamree cannot see a commit, and either
  // mark would be it claiming that it can.
  it('never claims the push happened', () => {
    const shown = text(render({ list: enrolled(), relay: committedRelay() }))
    expect(shown).toContain('yours to do — teamree does not check this')
  })

  it('shows a teammate’s link with the runtime’s own detail, not a phase code', () => {
    const waited = 'nobody has answered on this rendezvous across two hourly rotations'
    const shown = text(
      render({
        list: enrolled(),
        relay: committedRelay(),
        status: status({ links: [link({ detail: waited })] })
      })
    )
    expect(shown).toContain('priya')
    expect(shown).toContain('not connected')
    expect(shown).toContain(waited)
  })
})

describe('choosing a relay', () => {
  it('shows all four ways to get one, with their costs, to whoever has none', () => {
    const shown = text(render())
    expect(shown).toContain('Deploy the Worker to your team’s own Cloudflare account')
    expect(shown).toContain('A tunnel to a relay on your own machine')
    expect(shown).toContain('A mesh VPN, or a box on the LAN')
    expect(shown).toContain('A VPS you rent')
    expect(shown).toContain('npm run deploy')
    expect(shown).toContain('cloudflared tunnel --url http://localhost:8787')
    expect(shown).toMatch(/Effort/)
    expect(shown).toMatch(/Money/)
  })

  it('says which addresses are stable enough to commit and which belong in the override', () => {
    const shown = text(render())
    expect(shown).toContain('Stable enough to commit: paste it below and push .teamree/relay.')
    expect(shown).toContain('Too short-lived to commit: use TEAMREE_RELAY_URL instead')
  })

  // Somebody joining a team that already has a relay has no decision to make:
  // theirs arrives in the repository. A wall of options about a thing already
  // chosen is noise at the exact moment they want to know whether it worked.
  it('shows none of that to somebody whose team already has one', () => {
    const shown = text(render({ list: enrolled(), relay: committedRelay() }))
    expect(shown).not.toContain('A VPS you rent')
    expect(shown).not.toContain('npm run deploy')
    expect(shown).toContain('Change the relay for this project')
  })

  it('says teamree never starts a relay itself', () => {
    expect(text(render())).toMatch(/teamree never starts a relay itself/)
  })

  it('answers “I set TEAMREE_RELAY_URL and nothing happened” even when it is unset', () => {
    expect(text(render())).toMatch(/No\s+TEAMREE_RELAY_URL\s+in this app’s environment/)
  })
})

describe('a checkout with no origin', () => {
  const noOrigin = status({
    origin: {
      ok: false,
      reason: 'this project has no origin remote, so teamree cannot tell it is the same repository your teammates have'
    },
    disabledReason: 'no .teamree/relay in this project, so teamree does not know which relay your team meets on'
  })

  // The alternative is a step that sits at "not connected" for ever while the
  // person checks their wifi, their relay and their teammate's laptop.
  it('says so at the top, and names the command rather than showing a dead step', () => {
    const shown = text(render({ status: noOrigin }))
    expect(shown).toContain('This checkout cannot take part yet.')
    expect(shown).toMatch(/no origin remote/)
    expect(shown).toMatch(/git remote add origin/)
    expect(shown).toMatch(/a filesystem path is not a URL/)
  })

  it('marks the connected step blocked, in a word', () => {
    expect(render({ status: noOrigin })).toContain('step--blocked')
    expect(text(render({ status: noOrigin }))).toContain('blocked')
  })

  it('says none of that when origin is fine', () => {
    expect(text(render())).not.toContain('This checkout cannot take part yet.')
  })
})

describe('before anything has been read', () => {
  it('says it is reading rather than reporting nothing as “not set up”', () => {
    const shown = text(render({ list: undefined, relay: undefined, status: undefined }))
    expect(shown).toMatch(/Reading this machine’s identity/)
    expect(shown).toMatch(/Reading where this project’s relay is recorded/)
    expect(render({ list: undefined, relay: undefined, status: undefined })).not.toContain(JOIN_BUTTON)
  })
})
