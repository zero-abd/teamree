// What has to stay true about the one string a person copies out of one machine
// and pastes into another.
//
// Two halves, and they are different kinds of promise. Formatting has to produce
// something that survives the trip: a chat client, a commit body and a shell all
// get to touch this string, and every one of them re-flows whitespace, so the
// test for "one token" is the test for the feature working at all. Parsing has
// to be generous about what people paste and blunt about what it will not guess
// -- a link with a field missing is refused by name, because the alternative is
// this CLI acting on half an instruction.

import { describe, expect, it } from 'vitest'
import { formatInvitation, parseInvitation, type Invitation } from './invitation.js'

const ADA: Invitation = {
  origin: 'https://github.com/ada/pager.git',
  relay: 'wss://relay.teamree.dev',
  project: 'pager',
  from: 'ada'
}

/** The invitation, or a failure that says which refusal came back instead. */
function accepted(raw: string): Invitation {
  const parsed = parseInvitation(raw)
  if (!parsed.ok) throw new Error(`expected an invitation, got a refusal: ${parsed.reason}`)
  return parsed.invitation
}

/** The refusal, or a failure -- so that a test about wording cannot pass on a success. */
function refused(raw: string): { reason: string; hint: string } {
  const parsed = parseInvitation(raw)
  if (parsed.ok) throw new Error(`expected a refusal, got an invitation for ${parsed.invitation.project}`)
  return { reason: parsed.reason, hint: parsed.hint }
}

/** A link written field by field, for the cases a well-formed one cannot produce. */
function linkOf(fields: Record<string, string>): string {
  return `teamree://join?${new URLSearchParams(fields).toString()}`
}

describe('the invitation somebody copies', () => {
  // The whole of the format's job. Anything that wraps, re-flows or trims the
  // text it is pasted into would break a link with a space or a break in it, and
  // it would break it in exactly the place the link is meant to work.
  it('is one unbroken token that reads back as the four facts it was given', () => {
    const link = formatInvitation(ADA)
    expect(link).not.toMatch(/\s/)
    expect(link.includes('\n')).toBe(false)
    expect(accepted(link)).toEqual(ADA)
  })

  // Stated as a literal so that changing the format has to be somebody's
  // decision rather than a side effect: every teamree already in the world reads
  // this prefix, and the version is first so an older build can say what it is
  // holding instead of quietly dropping a field it does not know about.
  it('announces its version before anything else, so an older teamree can say what it holds', () => {
    expect(formatInvitation(ADA).startsWith('teamree://join?v=1&')).toBe(true)
  })

  // Workspaces are named by people, and people use spaces. The encoding turns
  // one into `+`, which is not whitespace, so the token stays a token.
  it('keeps a project name with spaces in it inside the token, and gives the spaces back', () => {
    const link = formatInvitation({ ...ADA, project: 'design system' })
    expect(link).not.toMatch(/\s/)
    expect(link).toContain('project=design+system')
    expect(accepted(link).project).toBe('design system')
  })

  // The reason the platform URL parser is used at all: `&`, `?` and `#` are how
  // a nested URL written by hand loses everything after the first one of them.
  it('carries an origin with &, ? and # in it without losing the rest of the fields', () => {
    const origin = 'https://git.example.com/scm?repo=pager&fork=1#main'
    const parsed = accepted(formatInvitation({ ...ADA, origin }))
    expect(parsed.origin).toBe(origin)
    expect(parsed.relay).toBe('wss://relay.teamree.dev')
    expect(parsed.project).toBe('pager')
  })

  // A repository on a shared volume is named by its path, and a volume with a
  // space in its name is ordinary on a Mac -- so this is the same escaping
  // question as the URL above, asked by the other kind of origin.
  it('carries an absolute path origin, space in the volume name and all', () => {
    const origin = '/Volumes/team share/api.git'
    const link = formatInvitation({ ...ADA, origin })
    expect(link).not.toMatch(/\s/)
    expect(accepted(link).origin).toBe(origin)
  })

  it('gives back a last field that ends in a full stop, rather than losing it to the peeling', () => {
    // The one character URLSearchParams leaves unescaped that a sentence also
    // ends with. Without the escape in `formatInvitation`, a handle of `ada.`
    // and a link at the end of a sentence are the same string, and the reader
    // has to guess.
    const dotted: Invitation = { ...ADA, from: 'ada.' }
    expect(accepted(formatInvitation(dotted))).toEqual(dotted)
    expect(accepted(`${formatInvitation(dotted)}.`)).toEqual(dotted)
  })

  it('is still found when a phone has capitalised the start of it', () => {
    // Autocapitalisation takes the first letter of what it reads as a sentence,
    // which is the scheme and never the parameter names.
    const link = formatInvitation(ADA)
    expect(accepted(`Teamree${link.slice('teamree'.length)}`)).toEqual(ADA)
  })
})

describe('finding the link inside whatever it arrived in', () => {
  const link = formatInvitation(ADA)

  // What a person actually has is a message, not a selection. Refusing this
  // would send them back to pick out exactly the right characters with a mouse.
  it('reads a link with a sentence written around it', () => {
    expect(accepted(`hey, join the pager work: ${link} -- ping me when you are in`)).toEqual(ADA)
  })

  // The full stop is the author's punctuation, not the link's: the format never
  // ends in one, so peeling it is safe and keeping it is a broken link.
  it('leaves behind the full stop somebody wrote straight after it', () => {
    expect(accepted(`Here is the invitation: ${link}.`)).toEqual(ADA)
  })

  // `<...>` and backticks are how people stop a client mangling a URL, and
  // brackets are how they tuck it into a sentence. All three are the sender
  // being careful, and none of them should cost the receiver anything.
  it('unwraps the angle brackets, backticks and parentheses people paste links inside', () => {
    for (const message of [`see <${link}>`, `run \`${link}\``, `the invitation (${link}) is fresh`]) {
      expect(accepted(message), message).toEqual(ADA)
    }
  })
})

describe('refusing a string that is not an invitation', () => {
  // A refusal here is somebody holding the wrong string, so the remedy is always
  // the same one sentence: ask the sender to make another link.
  it('says there is no invitation in it and names the command that writes one', () => {
    const { reason, hint } = refused('sure, I will send it over in a minute')
    expect(reason).toBe('it does not contain a teamree invitation')
    expect(hint).toContain('teamree team invite')
    expect(hint).toContain('teamree://join?')
  })

  // Two different situations that both stop at the version check, and they want
  // two different things done about them: one is a link from a build too old to
  // stamp one, the other is a link from a build newer than this one.
  it('tells a link with no version apart from a link from a newer teamree', () => {
    const missing = refused(linkOf({ ...ADA }))
    expect(missing.reason).toBe('it carries no version')
    expect(missing.hint).toBe('Ask whoever sent it to run `teamree team invite <project>` again on a current teamree.')

    const newer = refused(linkOf({ v: '2', ...ADA }))
    expect(newer.reason).toBe('it is a version 2 invitation and this teamree reads version 1')
    expect(newer.hint).toBe('Update teamree on this machine, or ask for an invitation from a teamree that matches it.')
  })

  // Not one message about a malformed link: the field that is gone is the thing
  // the receiver has to ask for, so every refusal names it.
  it('names the field that is missing rather than guessing at it', () => {
    for (const field of ['origin', 'relay', 'project', 'from'] as const) {
      const fields: Record<string, string> = { v: '1', ...ADA }
      delete fields[field]
      const { reason, hint } = refused(linkOf(fields))
      expect(reason, field).toBe(`it names no ${field}`)
      expect(hint, field).toContain(`An invitation that names no ${field} cannot be acted on.`)
      expect(hint, field).toContain('teamree team invite')
    }
  })

  // `project=` and `project=%20` are a field that was never filled in, and a
  // receiver told "it names no project" is told the truth in both cases. Anything
  // else would have them hunting for a project that is not there.
  it('treats a field that is present but blank exactly as it treats a missing one', () => {
    for (const field of ['origin', 'relay', 'project', 'from'] as const) {
      const missing: Record<string, string> = { v: '1', ...ADA }
      delete missing[field]

      for (const blank of ['', '   ']) {
        const written: Record<string, string> = { v: '1', ...ADA, [field]: blank }
        expect(parseInvitation(linkOf(written)), `${field}=${blank}`).toEqual(parseInvitation(linkOf(missing)))
      }
    }
  })
})
