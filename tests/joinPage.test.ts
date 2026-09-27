/** @vitest-environment jsdom */

// The site's join page: an https invitation a chat app makes clickable opens the app with the same facts.

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { formatInvitation, parseInvitation } from '../src/shared/invitation'

const PAGE = readFileSync(resolve('site/public/join.html'), 'utf8')
const BODY = PAGE.slice(PAGE.indexOf('<main>'), PAGE.indexOf('<script>'))
const SCRIPT = PAGE.slice(PAGE.indexOf('<script>') + '<script>'.length, PAGE.indexOf('</script>'))

function open(url: string): void {
  document.body.innerHTML = BODY
  location.hash = new URL(url).hash
  new Function(SCRIPT)()
}

const byId = (id: string): HTMLElement => document.getElementById(id) as HTMLElement

describe('the join page', () => {
  it('opens the app with the invitation the link carries', () => {
    const invitation = { origin: 'git@github.com:ana/ledger.', project: 'ledger', from: 'ana' }
    open(formatInvitation(invitation, 'page'))
    const parsed = parseInvitation(byId('open').getAttribute('href') ?? '')
    expect(parsed.ok && parsed.invitation).toEqual(invitation)
    expect(byId('title').textContent).toBe('Join ledger')
    expect(byId('invite').hidden).toBe(false)
  })

  it('says it is not an invitation when a field is missing, and links nowhere', () => {
    open('https://teamree.us/join#v=1&project=ledger&from=ana')
    expect(byId('invite').hidden).toBe(true)
    expect(byId('refused').hidden).toBe(false)
    expect(byId('open').getAttribute('href')).toBe('/')
  })
})
