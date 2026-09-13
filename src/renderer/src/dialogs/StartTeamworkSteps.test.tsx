/** @vitest-environment jsdom */

// The setup panel, driven rather than read.
//
// `StartTeamworkDialog.test.tsx` renders the same component to a string and
// settles what it *says* in each state; `startTeamwork.test.ts` settles what
// each step decides. This file is the half neither can reach: what the panel
// does once somebody types into it, and what it refuses to do at all.
//
// Two things it is trying to hold still. The first is the set of states a
// person gets stuck in — a checkout git has no name for, a handle the runtime
// took as somebody else's, the `https://` URL a deploy printed, a button
// pressed twice because the first press said nothing. None of those exist
// until there is a keystroke and a form.
//
// The second is the three things this panel has decided not to do: it does not
// commit, it does not push, and it does not run a relay. Those are claims the
// prose makes, and prose drifts; a control is a fact. So they are asserted as
// the absence of an affordance — nothing here is a button but the two that
// write a file — rather than only as a sentence that happens to be on screen.
//
// Queried by role and accessible name throughout, so a class that gets renamed
// costs nothing and a control that loses its name costs a test.

import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MemberList, RelaySetting, TeamworkStatus } from '@shared/entities'
import { TeamworkSteps, type TeamworkStepsProps } from './StartTeamworkDialog'
import { RELAY_OPTIONS } from './startTeamwork'

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

/** The roster of somebody whose key is already in this checkout. */
const enrolled = (overrides: Partial<MemberList> = {}): MemberList =>
  roster({
    enrolled: true,
    members: [
      { handle: 'ada', publicKey: SELF_KEY, addedAt: '2026-03-01', file: '.teamree/members/ada.pub', isSelf: true }
    ],
    ...overrides
  })

const NO_RELAY = 'no .teamree/relay in this project, so teamree does not know which relay your team meets on'

const relay = (overrides: Partial<RelaySetting> = {}): RelaySetting => ({
  projectId: 'p1',
  file: '.teamree/relay',
  url: null,
  source: null,
  problem: NO_RELAY,
  committed: { url: null, problem: NO_RELAY },
  override: { name: 'TEAMREE_RELAY_URL', value: null },
  readAt: 0,
  ...overrides
})

const committedRelay = (): RelaySetting =>
  relay({
    url: 'wss://relay.example/v1/relay',
    source: 'repository',
    problem: null,
    committed: { url: 'wss://relay.example/v1/relay', problem: null }
  })

const status = (overrides: Partial<TeamworkStatus> = {}): TeamworkStatus => ({
  projectId: 'p1',
  relay: null,
  disabledReason: null,
  origin: { ok: true },
  enrolled: false,
  links: [],
  readAt: 0,
  ...overrides
})

const handlers = { onJoin: vi.fn(), onClearMembersError: vi.fn(), onSetRelay: vi.fn() }

function mount(overrides: Partial<TeamworkStepsProps> = {}): void {
  const props: TeamworkStepsProps = {
    list: roster(),
    relay: relay(),
    status: status(),
    membersPending: false,
    membersError: null,
    relayPending: false,
    relayError: null,
    ...handlers,
    ...overrides
  }
  render(<TeamworkSteps {...props} />)
}

// The two fields, by the name a screen reader would read out. Each label wraps
// its own hint, so the name carries what the field says it will write — which
// is the part worth asserting and the part that would silently go missing.
const handleField = (): HTMLInputElement => screen.getByRole('textbox', { name: /^Handle/ })
const relayField = (): HTMLInputElement => screen.getByRole('textbox', { name: /relay for this project/ })

/** The submit button of the form a field is in, whatever it currently says. */
const submitOf = (field: HTMLElement): HTMLButtonElement =>
  within(field.closest('form') as HTMLFormElement).getByRole('button', {
    name: /^(Add my key|Write relay file|Writing…)$/
  })

const addKey = (): HTMLButtonElement => submitOf(handleField())
const writeRelay = (): HTMLButtonElement => submitOf(relayField())

/** Every control on the panel, by accessible name. */
const controls = (): string[] => screen.getAllByRole('button').map((button) => button.textContent ?? '')

beforeEach(() => {
  for (const handler of Object.values(handlers)) handler.mockReset()
})

describe('adding this machine’s key', () => {
  it('offers the name git implies as the default, without typing it into the box', () => {
    mount()
    expect(handleField().value).toBe('')
    expect(handleField().placeholder).toBe('ada')
    fireEvent.click(addKey())
    // Undefined rather than 'ada': nothing was chosen, so the runtime picks,
    // and it is the one that knows what git says here.
    expect(handlers.onJoin).toHaveBeenCalledExactlyOnceWith(undefined)
  })

  it('sends what was typed, trimmed of what a paste brings with it', () => {
    mount()
    fireEvent.change(handleField(), { target: { value: '  ada-laptop  ' } })
    fireEvent.click(addKey())
    expect(handlers.onJoin).toHaveBeenCalledExactlyOnceWith('ada-laptop')
  })

  it('names the file the typed handle would write, in the field’s own description', () => {
    mount()
    fireEvent.change(handleField(), { target: { value: 'ada-laptop' } })
    expect(screen.getByRole('textbox', { name: /Writes \.teamree\/members\/ada-laptop\.pub\./ })).toBeTruthy()
  })

  // A checkout with no user.email has no name to fall back on, so there is
  // nothing to submit until one is chosen. The button says so by being dead,
  // and the hint has to say why — a disabled button with no reason beside it is
  // the worst of the states on this panel.
  it('cannot be pressed at all when git gave no name to fall back on', () => {
    mount({ list: roster({ self: { handle: null, publicKey: SELF_KEY } }) })
    expect(addKey().disabled).toBe(true)
    expect(handleField().placeholder).toBe('pick a name')
    expect(screen.getByRole('textbox', { name: /git has no user\.email here/ })).toBeTruthy()

    fireEvent.click(addKey())
    expect(handlers.onJoin).not.toHaveBeenCalled()

    fireEvent.change(handleField(), { target: { value: 'ada' } })
    expect(addKey().disabled).toBe(false)
  })

  it('is not fooled into enabling itself by a handle that is only spaces', () => {
    mount({ list: roster({ self: { handle: null, publicKey: SELF_KEY } }) })
    fireEvent.change(handleField(), { target: { value: '   ' } })
    expect(addKey().disabled).toBe(true)
  })

  // Writing the file is a round trip. Without this the button stays live and
  // looks ignored, and the second press is a second key file.
  it('says it is writing, and a second press does nothing while it is', () => {
    mount({ membersPending: true })
    expect(addKey().textContent).toBe('Writing…')
    expect(addKey().disabled).toBe(true)
    fireEvent.click(addKey())
    expect(handlers.onJoin).not.toHaveBeenCalled()
  })

  // The one thing people expect a button called "Add my key" to have done.
  // It has not: the file is in the working tree and nothing else happened.
  it('claims only that it wrote a file, and points at the step that matters', () => {
    mount()
    expect(screen.getByText('This writes the file and stops. Step 4 is the part that means something.')).toBeTruthy()
  })

  // Asserted as an absence rather than a sentence, because a sentence about not
  // pushing and a button that pushes can both be on the page at once.
  it('offers nothing that would commit or push on your behalf, only commands to run yourself', () => {
    mount({ list: enrolled(), relay: committedRelay() })
    expect(screen.getByText('git add .teamree git commit -m "Set up teamwork" git push')).toBeTruthy()
    expect(controls().some((name) => /commit|push|git/i.test(name))).toBe(false)
  })

  it('has no handle field left once the key is in this checkout', () => {
    mount({ list: enrolled() })
    expect(screen.queryByRole('textbox', { name: /^Handle/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add my key' })).toBeNull()
  })
})

describe('a handle the runtime refused', () => {
  const taken = '.teamree/members/ana.pub is already somebody else’s key; choose another handle'

  it('marks the box itself as the thing that was refused, and puts the sentence with it', () => {
    mount({ membersError: taken })
    expect(handleField().getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByText(taken)).toBeTruthy()
  })

  // The refusal is an instruction about this box, so answering it is the
  // keystroke that makes it stale. Waiting for the next submit would leave a
  // stale sentence under a field somebody has already corrected.
  it('is cleared by the keystroke that answers it, not by the next press', () => {
    mount({ membersError: taken })
    fireEvent.change(handleField(), { target: { value: 'ana-2' } })
    expect(handlers.onClearMembersError).toHaveBeenCalledOnce()
    expect(handlers.onJoin).not.toHaveBeenCalled()
  })

  it('leaves the button pressable, because the remedy is to press it again', () => {
    mount({ membersError: taken })
    expect(addKey().disabled).toBe(false)
    fireEvent.change(handleField(), { target: { value: 'ana-2' } })
    fireEvent.click(addKey())
    expect(handlers.onJoin).toHaveBeenCalledExactlyOnceWith('ana-2')
  })

  it('marks nothing invalid when nothing has been refused', () => {
    mount()
    expect(handleField().getAttribute('aria-invalid')).toBe('false')
    expect(screen.queryByText(taken)).toBeNull()
  })
})

describe('setting the relay', () => {
  /** The suggested correction, offered as a control rather than substituted. */
  const useSuggested = (url: string): HTMLElement => screen.getByRole('button', { name: `Use ${url}` })

  it('will not write an empty field', () => {
    mount()
    expect(writeRelay().disabled).toBe(true)
    fireEvent.click(writeRelay())
    expect(handlers.onSetRelay).not.toHaveBeenCalled()
  })

  it('writes a well-formed wss:// URL, with the trailing slash normalised away', () => {
    mount()
    fireEvent.change(relayField(), { target: { value: '  wss://relay.example/v1/relay/  ' } })
    expect(writeRelay().disabled).toBe(false)
    fireEvent.click(writeRelay())
    expect(handlers.onSetRelay).toHaveBeenCalledExactlyOnceWith('wss://relay.example/v1/relay')
  })

  // The one address everybody arrives with is the https:// their deploy
  // printed. Refusing it and stopping leaves the remedy in a README nobody is
  // reading; substituting it quietly would be wrong on the one deployment whose
  // relay is not at the root. So it is offered, and it takes a press.
  it('refuses the https:// a deploy prints, and offers the correction rather than taking it', () => {
    mount()
    fireEvent.change(relayField(), { target: { value: 'https://relay.example' } })
    expect(writeRelay().disabled).toBe(true)
    expect(screen.getByText(/^The scheme is "https", not ws or wss\./)).toBeTruthy()

    fireEvent.click(useSuggested('wss://relay.example/v1/relay'))
    expect(relayField().value).toBe('wss://relay.example/v1/relay')
    expect(handlers.onSetRelay).not.toHaveBeenCalled()

    expect(writeRelay().disabled).toBe(false)
    fireEvent.click(writeRelay())
    expect(handlers.onSetRelay).toHaveBeenCalledExactlyOnceWith('wss://relay.example/v1/relay')
  })

  // The half-followed instruction: scheme corrected, endpoint forgotten. No
  // relay configuration can serve it, and accepting it would send two people to
  // debug a healthy deploy.
  it('refuses a bare origin, and names the path it is missing', () => {
    mount()
    fireEvent.change(relayField(), { target: { value: 'wss://relay.example' } })
    expect(screen.getByText(/^It has no path, and a relay is served under one\./)).toBeTruthy()
    expect(useSuggested('wss://relay.example/v1/relay')).toBeTruthy()
    expect(writeRelay().disabled).toBe(true)
  })

  it('refuses something that is not a URL at all, with nothing to suggest', () => {
    mount()
    fireEvent.change(relayField(), { target: { value: 'relay.example' } })
    expect(screen.getByText('It is not a URL.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Use / })).toBeNull()
    expect(writeRelay().disabled).toBe(true)
  })

  // A rendezvous id is appended to this URL, so anything after it is already
  // in the wrong place — and nothing copied out of a deploy looks like this,
  // so there is no correction worth guessing at.
  it('refuses a query or a fragment, and guesses at no correction for it', () => {
    mount()
    fireEvent.change(relayField(), { target: { value: 'wss://relay.example/v1/relay?token=x' } })
    expect(screen.getByText('A relay URL carries no query or fragment.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Use / })).toBeNull()
    expect(writeRelay().disabled).toBe(true)
  })

  it('shows the runtime’s own refusal when the write itself failed', () => {
    mount({ relayError: 'EACCES: permission denied, open ".teamree/relay"' })
    expect(screen.getByText('EACCES: permission denied, open ".teamree/relay"')).toBeTruthy()
  })

  it('says it is writing, and a second press does nothing while it is', () => {
    mount({ relayPending: true })
    fireEvent.change(relayField(), { target: { value: 'wss://relay.example/v1/relay' } })
    expect(writeRelay().textContent).toBe('Writing…')
    expect(writeRelay().disabled).toBe(true)
    fireEvent.click(writeRelay())
    expect(handlers.onSetRelay).not.toHaveBeenCalled()
  })

  // Step 3 writes a file and that is the whole of it. The commit that makes it
  // the team's is step 4's, and the field has to say so itself: this is the
  // other control on the panel that looks like it finished something.
  it('says which file it writes and that it stops there', () => {
    mount()
    expect(screen.getByRole('textbox', { name: /Writes \.teamree\/relay, and stops there\./ })).toBeTruthy()
  })

  it('says it is replacing, rather than writing, once the file already names one', () => {
    mount({ list: enrolled(), relay: committedRelay() })
    expect(screen.getByRole('textbox', { name: /Replaces \.teamree\/relay, and stops there\./ })).toBeTruthy()
  })

  // Somebody joining a team that already has a relay has no decision to make:
  // theirs arrived in the repository, and a wall of options about a thing
  // already chosen is noise at the moment they want to know whether it worked.
  it('offers to change rather than to set once the project has one, and drops the options', () => {
    mount({ list: enrolled(), relay: committedRelay() })
    expect(screen.getByRole('textbox', { name: /^Change the relay for this project/ })).toBeTruthy()
    expect(screen.queryByText(/A VPS you rent/)).toBeNull()
  })

  // "I set TEAMREE_RELAY_URL and nothing happened" is predictable on macOS,
  // where an app opened from Finder inherits no shell environment. Only the
  // process can say whether it saw the override at all.
  it('reports that it saw no environment override, which is otherwise unanswerable', () => {
    mount()
    expect(screen.getByText(/^No in this app’s environment\./)).toBeTruthy()
    expect(screen.getByText('TEAMREE_RELAY_URL')).toBeTruthy()
    expect(screen.getByText(/does not inherit your shell’s/)).toBeTruthy()
  })

  it('says when the environment is beating the committed file, and with what', () => {
    mount({
      relay: relay({
        url: 'wss://dev.example/v1/relay',
        source: 'environment',
        problem: null,
        override: { name: 'TEAMREE_RELAY_URL', value: 'wss://dev.example/v1/relay' },
        committed: { url: 'wss://relay.example/v1/relay', problem: null }
      })
    })
    expect(screen.getByText(/the environment is beating it for this\s+run/)).toBeTruthy()
    expect(screen.getAllByText('wss://dev.example/v1/relay').length).toBeGreaterThan(0)
    expect(screen.getAllByText('wss://relay.example/v1/relay').length).toBeGreaterThan(0)
  })
})

describe('where the relay commands are said to run', () => {
  // teamree dials a URL; it does not stand a relay up. Saying so matters
  // because every option below is a block of shell that looks runnable.
  it('says teamree never starts one, and that standing one up happens in a terminal', () => {
    mount()
    expect(screen.getByText(/teamree never starts a relay itself/)).toBeTruthy()
    expect(screen.getByText(/standing one up happens in a terminal/)).toBeTruthy()
  })

  it('shows every option’s commands to copy, and offers no control that would run them', () => {
    mount()
    for (const option of RELAY_OPTIONS) {
      expect(screen.getByText(option.commands.replace(/\s+/g, ' ').trim())).toBeTruthy()
    }
    // The only two controls on a fresh project write a file each. Nothing here
    // deploys, builds, runs or logs in, whatever the blocks above contain.
    expect(controls()).toEqual(['Add my key', 'Write relay file'])
  })
})

describe('a checkout whose origin cannot be shared', () => {
  const REASON =
    'this project has no origin remote, so teamree cannot tell it is the same repository your teammates have'
  const noOrigin = (): TeamworkStatus => status({ origin: { ok: false, reason: REASON } })

  // A person who works through four steps and only then learns the fifth was
  // impossible has been wasted, so it is said before the list rather than only
  // inside the step it kills. And the runtime's reason says what is wrong
  // without saying what to type — while the obvious next guess, a path on this
  // disk, is the other half of this failure — so the panel says both.
  it('leads with the blocker, ahead of the steps it makes pointless, and names the command', () => {
    mount({ status: noOrigin() })
    const blocker = screen.getByText('This checkout cannot take part yet.').closest('p') as HTMLElement
    expect(blocker.textContent).toContain('no origin remote')
    expect(blocker.textContent).toContain('git remote add origin <url>')
    expect(blocker.textContent).toContain('a filesystem path is not a URL')

    const firstStep = screen.getByRole('heading', { name: '1. Your identity' })
    expect(blocker.compareDocumentPosition(firstStep) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  // In a word beside the step, not only as a colour on it.
  it('marks the step it kills as blocked rather than leaving it at “not done yet”', () => {
    mount({ status: noOrigin() })
    expect(screen.getByRole('heading', { name: '5. Connected' })).toBeTruthy()
    expect(screen.getByText('blocked')).toBeTruthy()
  })

  it('offers no control that would add the remote for you', () => {
    mount({ status: noOrigin() })
    expect(controls()).toEqual(['Add my key', 'Write relay file'])
  })

  // The blocker is about this checkout's remote, not about the two files. Both
  // are still the right files to have written once a remote is added, so
  // neither form is taken away — being blocked is not being stopped.
  it('still lets the steps it does not block be done', () => {
    mount({ status: noOrigin() })
    expect(addKey().disabled).toBe(false)
    fireEvent.click(addKey())
    expect(handlers.onJoin).toHaveBeenCalledExactlyOnceWith(undefined)

    fireEvent.change(relayField(), { target: { value: 'wss://relay.example/v1/relay' } })
    expect(writeRelay().disabled).toBe(false)
  })

  it('says none of that when origin is fine', () => {
    mount()
    expect(screen.queryByText('This checkout cannot take part yet.')).toBeNull()
  })
})

describe('a roster that cannot be believed on its own', () => {
  // Not a fault, and must not be shown as one: it means this list is only as
  // fresh as this read, which is a different sentence from "there is no team".
  it('says when nothing is watching the files, and what to do about it', () => {
    mount({ list: enrolled({ watched: false }) })
    expect(screen.getByText(/only as fresh as this read/)).toBeTruthy()
    expect(screen.getByText(/Open this dialog again\s+after a pull/)).toBeTruthy()
  })

  it('says nothing about freshness when the files are watched', () => {
    mount({ list: enrolled() })
    expect(screen.queryByText(/only as fresh as this read/)).toBeNull()
  })

  // A skipped file is somebody's key that is not working, and the only useful
  // version of that message is the one with the path in it.
  it('names each file it skipped rather than counting them', () => {
    mount({
      list: enrolled({
        problems: [{ file: '.teamree/members/priya.pub', reason: 'not 32 bytes of base64' }]
      })
    })
    expect(screen.getByText('1 file skipped')).toBeTruthy()
    expect(screen.getByText('.teamree/members/priya.pub')).toBeTruthy()
    expect(screen.getByText(/not 32 bytes of base64/)).toBeTruthy()
  })

  it('says the roster is empty rather than leaving a blank where a team would be', () => {
    mount()
    expect(screen.getByText(/No keys committed yet/)).toBeTruthy()
  })
})
