/** @vitest-environment jsdom */

// The setup panel, driven rather than read.
//
// `StartTeamworkDialog.test.tsx` renders the same component to a string and
// settles what it *says* in each state. This file is the other half: what it
// does when somebody types into it. Those are the states a person gets stuck
// in — a handle the runtime refused, a relay URL pasted out of a browser, a
// button that is enabled when it should not be — and none of them exist until
// there is a keystroke and a form.

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MemberList, RelaySetting, TeamworkStatus } from '@shared/entities'
import { TeamworkSteps, type TeamworkStepsProps } from './StartTeamworkDialog'

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

const relay = (overrides: Partial<RelaySetting> = {}): RelaySetting => ({
  projectId: 'p1',
  file: '.teamree/relay',
  url: null,
  source: null,
  problem: 'no .teamree/relay in this project',
  committed: { url: null, problem: 'no .teamree/relay in this project' },
  override: { name: 'TEAMREE_RELAY_URL', value: null },
  readAt: 0,
  ...overrides
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

const handleField = (): HTMLInputElement => screen.getByRole('textbox', { name: /^Handle/ })
const relayField = (): HTMLInputElement => screen.getByRole('textbox', { name: /relay for this project/ })
const addKey = (): HTMLButtonElement => screen.getByRole('button', { name: /Add my key|Writing…/ })
const writeRelay = (): HTMLButtonElement => screen.getByRole('button', { name: /Write relay file|Writing…/ })

/** The refusal line, read whole: it carries the corrected URL as a button. */
const relayRefusal = (): string => document.querySelector('.members__relay-error')?.textContent ?? ''

beforeEach(() => {
  for (const handler of Object.values(handlers)) handler.mockReset()
})

describe('adding this machine’s key', () => {
  it('defaults to the handle git already implies, without putting it in the box', () => {
    mount()
    expect(handleField().value).toBe('')
    expect(handleField().placeholder).toBe('ada')
    fireEvent.submit(addKey().closest('form') as HTMLFormElement)
    expect(handlers.onJoin).toHaveBeenCalledExactlyOnceWith(undefined)
  })

  it('sends the handle that was typed, trimmed', () => {
    mount()
    fireEvent.change(handleField(), { target: { value: '  ada-laptop  ' } })
    fireEvent.submit(addKey().closest('form') as HTMLFormElement)
    expect(handlers.onJoin).toHaveBeenCalledExactlyOnceWith('ada-laptop')
  })

  it('says which file it will write, so the commit in step 4 is no surprise', () => {
    mount()
    fireEvent.change(handleField(), { target: { value: 'ada-laptop' } })
    expect(screen.getByText(/Writes \.teamree\/members\/ada-laptop\.pub/)).toBeTruthy()
  })

  // A checkout with no user.email has no name to default to, so the button
  // cannot be pressed until one is chosen — and the hint has to say why rather
  // than leaving a dead button.
  it('cannot be pressed at all when git gave no name to fall back on', () => {
    mount({ list: roster({ self: { handle: null, publicKey: SELF_KEY } }) })
    expect(addKey().disabled).toBe(true)
    expect(screen.getByText(/git has no user\.email here/)).toBeTruthy()
    fireEvent.change(handleField(), { target: { value: 'ada' } })
    expect(addKey().disabled).toBe(false)
  })

  it('says it is writing, and refuses a second press while it is', () => {
    mount({ membersPending: true })
    expect(screen.getByRole('button', { name: 'Writing…' })).toBeTruthy()
    expect(addKey().disabled).toBe(true)
  })

  it('stops at the file, and says so rather than implying a push', () => {
    mount()
    expect(screen.getByText('This writes the file and stops. Step 4 is the part that means something.')).toBeTruthy()
  })
})

describe('a handle the runtime refused', () => {
  const taken = '.teamree/members/ana.pub is already somebody else’s key; choose another handle'

  it('marks the box itself as the thing that was refused', () => {
    mount({ membersError: taken })
    expect(handleField().getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByText(taken)).toBeTruthy()
  })

  // The refusal names this box, so answering it is the keystroke that makes it
  // stale — not the next submit, which would leave a stale sentence under a
  // field somebody has already corrected.
  it('is cleared by the keystroke that answers it, not by the next attempt', () => {
    mount({ membersError: taken })
    fireEvent.change(handleField(), { target: { value: 'ana-2' } })
    expect(handlers.onClearMembersError).toHaveBeenCalledOnce()
    expect(handlers.onJoin).not.toHaveBeenCalled()
  })

  it('leaves the button pressable, because the remedy is to try again', () => {
    mount({ membersError: taken })
    expect(addKey().disabled).toBe(false)
  })

  it('says nothing, and marks nothing invalid, when nothing was refused', () => {
    mount()
    expect(handleField().getAttribute('aria-invalid')).toBe('false')
    expect(document.querySelector('.field__error')).toBeNull()
  })
})

describe('setting the relay', () => {
  it('will not write an empty field', () => {
    mount()
    expect(writeRelay().disabled).toBe(true)
  })

  it('writes a well-formed WebSocket URL, normalised', () => {
    mount()
    fireEvent.change(relayField(), { target: { value: '  wss://relay.example/v1/relay/  ' } })
    expect(writeRelay().disabled).toBe(false)
    fireEvent.submit(writeRelay().closest('form') as HTMLFormElement)
    expect(handlers.onSetRelay).toHaveBeenCalledExactlyOnceWith('wss://relay.example/v1/relay')
  })

  // The one address everybody arrives with is the https:// their deploy
  // printed. Refusing it and stopping leaves the remedy in a README nobody is
  // reading; substituting it quietly would be wrong on the one deployment
  // whose relay is not at the root.
  it('refuses the https:// a deploy prints, and offers the corrected URL as a choice', () => {
    mount()
    fireEvent.change(relayField(), { target: { value: 'https://relay.example' } })
    expect(writeRelay().disabled).toBe(true)
    expect(relayRefusal()).toContain('The scheme is "https", not ws or wss')

    fireEvent.click(screen.getByRole('button', { name: 'Use wss://relay.example/v1/relay' }))
    expect(relayField().value).toBe('wss://relay.example/v1/relay')
    expect(handlers.onSetRelay).not.toHaveBeenCalled()
    expect(writeRelay().disabled).toBe(false)
  })

  // The half-followed instruction: scheme corrected, endpoint forgotten. It
  // cannot be dialled by any relay configuration, and accepting it would send
  // two people to debug a healthy deploy.
  it('refuses a bare origin, and names the path it is missing', () => {
    mount()
    fireEvent.change(relayField(), { target: { value: 'wss://relay.example' } })
    expect(relayRefusal()).toContain('It has no path, and a relay is served under one')
    expect(screen.getByRole('button', { name: 'Use wss://relay.example/v1/relay' })).toBeTruthy()
    expect(writeRelay().disabled).toBe(true)
  })

  it('refuses something that is not a URL at all, with nothing to suggest', () => {
    mount()
    fireEvent.change(relayField(), { target: { value: 'relay.example' } })
    expect(relayRefusal()).toContain('It is not a URL.')
    expect(screen.queryByRole('button', { name: /^Use / })).toBeNull()
  })

  it('refuses a query or a fragment, which a rendezvous would be appended after', () => {
    mount()
    fireEvent.change(relayField(), { target: { value: 'wss://relay.example/v1/relay?token=x' } })
    expect(relayRefusal()).toContain('carries no query or fragment')
    expect(writeRelay().disabled).toBe(true)
  })

  it('shows the runtime’s own refusal when the write itself failed', () => {
    mount({ relayError: 'EACCES: permission denied, open ".teamree/relay"' })
    expect(screen.getByText('EACCES: permission denied, open ".teamree/relay"')).toBeTruthy()
  })

  it('says it is writing, and refuses a second press while it is', () => {
    mount({ relayPending: true })
    fireEvent.change(relayField(), { target: { value: 'wss://relay.example/v1/relay' } })
    expect(writeRelay().disabled).toBe(true)
    expect(screen.getByRole('button', { name: 'Writing…' })).toBeTruthy()
  })

  // A joiner has no decision to make: their relay arrives in the repository.
  it('offers to change rather than to set, once the project already has one', () => {
    mount({
      relay: relay({
        url: 'wss://relay.example/v1/relay',
        source: 'repository',
        problem: null,
        committed: { url: 'wss://relay.example/v1/relay', problem: null }
      }),
      list: roster({ enrolled: true })
    })
    expect(screen.getByText('Change the relay for this project')).toBeTruthy()
    expect(screen.queryByText(/A VPS you rent/)).toBeNull()
  })

  // "I set TEAMREE_RELAY_URL and nothing happened" is predictable on macOS,
  // where an app opened from Finder inherits no shell environment. Only the
  // process can say whether it saw the override at all.
  it('reports the environment override, including when there is none', () => {
    mount()
    expect(document.querySelector('.members__relay-note')?.textContent).toMatch(
      /^No\s*TEAMREE_RELAY_URL\s*in this app.s environment/
    )
    mount({
      relay: relay({
        override: { name: 'TEAMREE_RELAY_URL', value: 'wss://dev.example/v1/relay' },
        committed: { url: 'wss://relay.example/v1/relay', problem: null }
      })
    })
    const note = screen.getAllByText(/is set to/)[0]
    expect(note?.textContent).toContain('wss://dev.example/v1/relay')
    expect(note?.textContent).toContain('the environment is beating it for this run')
  })
})
