// Where the relay comes from, and what the app says when it does not: a project
// with no relay is a setting to fill in, not a fault to investigate.

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseRelayUrl, readRelayConfig, RELAY_FILE_SEGMENTS, RELAY_URL_ENV, relayFileTemplate } from './relayUrl'

/** The corrected URL a refusal offers, or undefined when it offered none. */
function suggestionFor(raw: string): string | undefined {
  const parsed = parseRelayUrl(raw)
  return parsed.ok ? undefined : parsed.suggestion
}

async function projectWith(relayFile?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'teamree-relayurl-'))
  if (relayFile !== undefined) {
    await mkdir(join(root, RELAY_FILE_SEGMENTS[0]), { recursive: true })
    await writeFile(join(root, ...RELAY_FILE_SEGMENTS), relayFile, 'utf8')
  }
  return root
}

describe('reading the relay a project meets on', () => {
  it('takes the URL committed to the repository, beside the member keys', async () => {
    const root = await projectWith(relayFileTemplate('wss://relay.example/v1/relay'))
    const config = await readRelayConfig(root, {})
    expect(config).toEqual({
      configured: true,
      location: { url: 'wss://relay.example/v1/relay', source: 'repository' }
    })
  })

  it('lets the environment override it, for a tunnel nobody should commit', async () => {
    const root = await projectWith(relayFileTemplate('wss://relay.example/v1/relay'))
    const config = await readRelayConfig(root, { [RELAY_URL_ENV]: 'ws://127.0.0.1:8787/v1/relay' })
    expect(config).toEqual({
      configured: true,
      location: { url: 'ws://127.0.0.1:8787/v1/relay', source: 'environment' }
    })
  })

  it('skips the comments the committed file is mostly made of', async () => {
    const root = await projectWith('# a note\n\n#another\nwss://relay.example/v1/relay\n')
    const config = await readRelayConfig(root, {})
    expect(config).toMatchObject({ configured: true })
  })

  it('says a project has no relay rather than reporting it as offline', async () => {
    const root = await projectWith()
    const config = await readRelayConfig(root, {})
    expect(config.configured).toBe(false)
    // The words matter here: this is a thing to set up, not a thing that broke.
    expect(config.configured === false && config.reason).toBe('no .teamree/relay')
  })

  it('names the file when it is there and has nothing usable in it', async () => {
    const root = await projectWith('# only comments\n')
    const config = await readRelayConfig(root, {})
    expect(config.configured === false && config.reason).toContain('no URL in it')
  })

  it('refuses a bad URL loudly instead of dialling something surprising', async () => {
    const root = await projectWith('not a url at all\n')
    const config = await readRelayConfig(root, {})
    expect(config.configured === false && config.reason).toContain('not a relay URL')
  })
})

describe('what counts as a relay URL', () => {
  it('accepts ws and wss and keeps the path the relay is served at', () => {
    expect(parseRelayUrl('wss://relay.example/v1/relay')).toEqual({
      ok: true,
      url: 'wss://relay.example/v1/relay'
    })
    expect(parseRelayUrl('  ws://127.0.0.1:8787/v1/relay  ')).toEqual({
      ok: true,
      url: 'ws://127.0.0.1:8787/v1/relay'
    })
  })

  it('trims a trailing slash, which would otherwise become an empty path segment', () => {
    expect(parseRelayUrl('wss://relay.example/v1/relay/')).toEqual({
      ok: true,
      url: 'wss://relay.example/v1/relay'
    })
  })

  it('refuses the https URL somebody will paste out of their browser', () => {
    // Guessing wss:// from it would work often enough to be trusted and fail on
    // the one deployment where the relay is not at the root.
    const parsed = parseRelayUrl('https://relay.example/v1/relay')
    expect(parsed.ok).toBe(false)
    expect(parsed.ok === false && parsed.reason).toContain('https')
  })

  it('tells somebody who pasted the address a deploy printed what to type instead', () => {
    const parsed = parseRelayUrl('https://teamree-relay.example.workers.dev')
    expect(parsed.ok).toBe(false)
    expect(parsed.ok === false && parsed.suggestion).toBe('wss://teamree-relay.example.workers.dev/v1/relay')
    // In the reason too: most of the places this is reported show only that.
    expect(parsed.ok === false && parsed.reason).toContain('wss://teamree-relay.example.workers.dev/v1/relay')
  })

  it('corrects only the scheme when the address already has a path on it', () => {
    // The path is somebody's answer to where their relay is served, and
    // RELAY_PATH is configurable, so it is never overwritten with the default.
    expect(suggestionFor('https://relay.example/v1/relay/')).toBe('wss://relay.example/v1/relay')
    expect(suggestionFor('http://127.0.0.1:8787/meet')).toBe('ws://127.0.0.1:8787/meet')
  })

  it('guesses nothing at a scheme that was never an address anybody deployed', () => {
    expect(suggestionFor('ftp://relay.example/v1/relay')).toBeUndefined()
  })

  it('refuses the host on its own, which dials a path no relay can serve', () => {
    // The half-followed instruction: scheme corrected, endpoint never added.
    // Accepting it dialled wss://host/<rendezvous>, the relay answered 404, and
    // both machines called a relay that was up unreachable.
    const parsed = parseRelayUrl('wss://my-relay.example.workers.dev')
    expect(parsed.ok).toBe(false)
    expect(parsed.ok === false && parsed.suggestion).toBe('wss://my-relay.example.workers.dev/v1/relay')
    expect(parsed.ok === false && parsed.reason).toContain('wss://my-relay.example.workers.dev/v1/relay')
  })

  it('refuses a bare trailing slash too, which is the same address said differently', () => {
    expect(suggestionFor('ws://127.0.0.1:8787/')).toBe('ws://127.0.0.1:8787/v1/relay')
  })

  it('refuses a query or a fragment, which a relay URL never carries', () => {
    expect(parseRelayUrl('wss://relay.example/v1/relay?token=abc').ok).toBe(false)
    expect(parseRelayUrl('wss://relay.example/v1/relay#x').ok).toBe(false)
  })
})
