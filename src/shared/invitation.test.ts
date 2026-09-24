// What has to stay true about the one string a person copies out of one machine
// and pastes into another: formatting survives re-flowed whitespace, parsing is
// generous about what people paste and refuses a missing field by name.

import { describe, expect, it } from 'vitest'
import {
  formatInvitation,
  parseInvitation,
  parsePastedInvitation,
  withoutCredentials,
  type Invitation
} from './invitation'

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
  // The whole of the format's job.
  it('is one unbroken token that reads back as the four facts it was given', () => {
    const link = formatInvitation(ADA)
    expect(link).not.toMatch(/\s/)
    expect(link.includes('\n')).toBe(false)
    expect(accepted(link)).toEqual(ADA)
  })

  // A literal, so changing the format is a decision: every teamree reads this prefix.
  it('announces its version before anything else, so an older teamree can say what it holds', () => {
    expect(formatInvitation(ADA).startsWith('teamree://join?v=1&')).toBe(true)
  })

  // A space becomes `+`, which is not whitespace, so the token stays a token.
  it('keeps a project name with spaces in it inside the token, and gives the spaces back', () => {
    const link = formatInvitation({ ...ADA, project: 'design system' })
    expect(link).not.toMatch(/\s/)
    expect(link).toContain('project=design+system')
    expect(accepted(link).project).toBe('design system')
  })

  // Why the platform URL parser is used at all.
  it('carries an origin with &, ? and # in it without losing the rest of the fields', () => {
    const origin = 'https://git.example.com/scm?repo=pager&fork=1#main'
    const parsed = accepted(formatInvitation({ ...ADA, origin }))
    expect(parsed.origin).toBe(origin)
    expect(parsed.relay).toBe('wss://relay.teamree.dev')
    expect(parsed.project).toBe('pager')
  })

  it('carries an absolute path origin, space in the volume name and all', () => {
    const origin = '/Volumes/team share/api.git'
    const link = formatInvitation({ ...ADA, origin })
    expect(link).not.toMatch(/\s/)
    expect(accepted(link).origin).toBe(origin)
  })

  it('gives back a last field that ends in a full stop, rather than losing it to the peeling', () => {
    // The one character URLSearchParams leaves unescaped that a sentence also
    // ends with: `ada.` and a link ending a sentence would be the same string.
    const dotted: Invitation = { ...ADA, from: 'ada.' }
    expect(accepted(formatInvitation(dotted))).toEqual(dotted)
    expect(accepted(`${formatInvitation(dotted)}.`)).toEqual(dotted)
  })

  it('is still found when a phone has capitalised the start of it', () => {
    // Autocapitalisation hits the first letter, which is the scheme.
    const link = formatInvitation(ADA)
    expect(accepted(`Teamree${link.slice('teamree'.length)}`)).toEqual(ADA)
  })
})

describe('finding the link inside whatever it arrived in', () => {
  const link = formatInvitation(ADA)

  it('reads a link with a sentence written around it', () => {
    expect(accepted(`hey, join the pager work: ${link} -- ping me when you are in`)).toEqual(ADA)
  })

  // The format never ends in a full stop, so peeling one is safe.
  it('leaves behind the full stop somebody wrote straight after it', () => {
    expect(accepted(`Here is the invitation: ${link}.`)).toEqual(ADA)
  })

  it('unwraps the angle brackets, backticks and parentheses people paste links inside', () => {
    for (const message of [`see <${link}>`, `run \`${link}\``, `the invitation (${link}) is fresh`]) {
      expect(accepted(message), message).toEqual(ADA)
    }
  })
})

describe('what an invitation is allowed to carry', () => {
  it('refuses a field with a control character in it, naming which field', () => {
    // The format carries a percent-encoded escape fine, and every field is
    // printed, one into a .git/config: a link that moves the cursor can erase a line.
    const link = formatInvitation({ ...ADA, project: 'pager\u001b[2K' })
    expect(link).not.toMatch(/\s/)
    expect(refused(link).reason).toBe(
      'its project has a control character in it, which nothing that is really an invitation has'
    )
  })

  it('ignores a parameter it does not know rather than refusing the whole link', () => {
    // An added field is not a dropped instruction; the version covers those.
    expect(accepted(`${formatInvitation(ADA)}&colour=green`)).toEqual(ADA)
  })

  it('takes a token out of an https origin and says it did', () => {
    const stripped = withoutCredentials('https://x-access-token:ghp_secret@github.com/acme/api.git')
    expect(stripped).toEqual({ origin: 'https://github.com/acme/api.git', removed: true })
  })

  it('leaves the ssh user alone, because that is not a secret and the address needs it', () => {
    for (const origin of ['git@github.com:acme/api.git', 'ssh://git@github.com/acme/api.git']) {
      expect(withoutCredentials(origin)).toEqual({ origin, removed: false })
    }
  })

  it('leaves an ordinary https origin and a path exactly as they were', () => {
    for (const origin of ['https://github.com/acme/api.git', '/Volumes/team/api.git']) {
      expect(withoutCredentials(origin)).toEqual({ origin, removed: false })
    }
  })
})

describe('refusing a string that is not an invitation', () => {
  it('says there is no invitation in it and names the command that writes one', () => {
    const { reason, hint } = refused('sure, I will send it over in a minute')
    expect(reason).toBe('it does not contain a teamree invitation')
    expect(hint).toContain('teamree team invite')
    expect(hint).toContain('teamree://join?')
  })

  it('tells a link with no version apart from a link from a newer teamree', () => {
    const missing = refused(linkOf({ ...ADA }))
    expect(missing.reason).toBe('it carries no version')
    expect(missing.hint).toBe('Ask whoever sent it to run `teamree team invite <project>` again on a current teamree.')

    const newer = refused(linkOf({ v: '2', ...ADA }))
    expect(newer.reason).toBe('it is a version 2 invitation and this teamree reads version 1')
    expect(newer.hint).toBe('Update teamree on this machine, or ask for an invitation from a teamree that matches it.')
  })

  it('names the field that is missing rather than guessing at it', () => {
    for (const field of ['origin', 'project', 'from'] as const) {
      const fields: Record<string, string> = { v: '1', ...ADA }
      delete fields[field]
      const { reason, hint } = refused(linkOf(fields))
      expect(reason, field).toBe(`it names no ${field}`)
      expect(hint, field).toContain(`An invitation that names no ${field} cannot be acted on.`)
      expect(hint, field).toContain('teamree team invite')
    }
  })

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

describe('a link with no relay in it', () => {
  // The relay is read from `.teamree/relay` after cloning, so the link names nothing the repository does not.
  it('is written without one and reads back without one', () => {
    const { relay: _relay, ...rest } = ADA
    const link = formatInvitation(rest)
    expect(link).not.toContain('relay=')
    expect(accepted(link)).toEqual(rest)
  })

  it('refuses a bad scheme and a link with no origin', () => {
    expect(refused('https://join?v=1&origin=x&project=p&from=a').reason).toBe(
      'it does not contain a teamree invitation'
    )
    expect(refused(linkOf({ v: '1', project: 'pager', from: 'ada' })).reason).toBe('it names no origin')
  })
})

describe('what somebody pastes into Paste Invitation…', () => {
  it('takes the link', () => {
    const parsed = parsePastedInvitation(`come join ${formatInvitation(ADA)}`)
    expect(parsed.ok && parsed.invitation).toEqual(ADA)
  })

  it('takes the older invitation text, clone command and all', () => {
    const text = [
      'I (ada) have set up teamwork on pager in teamree. Push access is membership — nothing to accept.',
      '',
      "1. Clone it if you have not: git clone 'https://github.com/ada/pager.git'",
      '2. Open teamree on your Mac and add that checkout as a project.'
    ].join('\n')
    const parsed = parsePastedInvitation(text)
    expect(parsed.ok && parsed.invitation).toEqual({
      origin: 'https://github.com/ada/pager.git',
      project: 'pager',
      from: 'ada'
    })
  })

  it('refuses text with no clone command and no link', () => {
    expect(parsePastedInvitation('see you tomorrow').ok).toBe(false)
  })
})
