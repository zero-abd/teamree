import { describe, expect, it } from 'vitest'
import type { CliInstall, CliStatus } from '@shared/entities'
import { cliOutcome, cliPanel, offerCliInstall } from './cliInstallModel'

const APP_CLI = '/Applications/teamree.app/Contents/Resources/cli/teamree'

function status(extra: Partial<CliStatus> = {}): CliStatus {
  return {
    installable: true,
    platform: 'darwin',
    source: APP_CLI,
    destination: '/usr/local/bin/teamree',
    directory: '/usr/local/bin',
    state: 'absent',
    resolved: null,
    needsAdministrator: false,
    onPath: 'login',
    readAt: 0,
    ...extra
  }
}

describe('before anything is pressed', () => {
  it('says where the link goes and what it will point at', () => {
    const panel = cliPanel(status())
    expect(panel.action).toBe('Put teamree on my PATH')
    expect(panel.promise).toContain('/usr/local/bin/teamree')
    expect(panel.detail).toContain(APP_CLI)
  })

  it('says a password is coming, and why, before it is asked for', () => {
    const panel = cliPanel(status({ needsAdministrator: true }))
    expect(panel.password).toContain('administrator password')
    expect(panel.password).toContain('/usr/local/bin')
    expect(panel.password).toContain('never reaches teamree')
  })

  it('says when no password will be asked for, which is the common case with Homebrew', () => {
    expect(cliPanel(status({ needsAdministrator: false })).password).toBe(
      'No password: /usr/local/bin is writable as you.'
    )
  })

  it('warns when the link will be made somewhere no shell looks', () => {
    const panel = cliPanel(status({ onPath: null }))
    expect(panel.pathWarning).toContain('/usr/local/bin')
    expect(panel.pathWarning).toContain('/etc/paths')
    expect(panel.action).toBe('Put teamree on my PATH')
  })

  it('has nothing to warn about when the directory is on PATH', () => {
    expect(cliPanel(status({ onPath: 'environment' })).pathWarning).toBeNull()
    expect(cliPanel(status({ onPath: 'login' })).pathWarning).toBeNull()
  })
})

describe('a link that is already there', () => {
  it('says it is done and offers nothing to press', () => {
    const panel = cliPanel(status({ state: 'linked', resolved: APP_CLI }))
    expect(panel.headline).toBe('teamree is on your PATH.')
    expect(panel.action).toBeNull()
  })

  it('names the other teamree when the link leads to one', () => {
    const older = '/Users/ann/Downloads/teamree.app/Contents/Resources/cli/teamree'
    const panel = cliPanel(status({ state: 'elsewhere', resolved: older }))
    expect(panel.headline).toContain('a different copy of teamree')
    expect(panel.detail).toContain(older)
    // The whole point of naming it: the command works, and it drives that one.
    expect(panel.detail).toContain('drives that copy')
    expect(panel.action).toBe('Point it at this app')
    expect(panel.promise).toContain(APP_CLI)
  })
})

describe('something in the way', () => {
  it('refuses a regular file and says what is there', () => {
    const panel = cliPanel(status({ state: 'file', resolved: '/usr/local/bin/teamree' }))
    expect(panel.headline).toBe('There is a regular file at /usr/local/bin/teamree.')
    expect(panel.detail).toContain('will not delete it')
    expect(panel.action).toBeNull()
  })

  it('says the same of a directory', () => {
    expect(cliPanel(status({ state: 'directory' })).headline).toContain('a directory at')
  })
})

describe('platforms and builds this cannot serve', () => {
  it('offers the command instead of a button that could not work', () => {
    const panel = cliPanel(
      status({ installable: false, platform: 'linux', source: '/opt/teamree/resources/cli/teamree' })
    )
    expect(panel.headline).toContain('only')
    expect(panel.headline).toContain('macOS')
    expect(panel.action).toBeNull()
    expect(panel.manual).toBe('sudo ln -sf /opt/teamree/resources/cli/teamree /usr/local/bin/teamree')
  })

  it('says so when the build has no CLI in it at all', () => {
    const panel = cliPanel(status({ source: null }))
    expect(panel.headline).toContain('no CLI inside it')
    expect(panel.action).toBeNull()
    expect(panel.manual).toBeNull()
  })

  it('says nothing at all before the first read answers', () => {
    expect(cliPanel(null).action).toBeNull()
    expect(cliPanel(null).headline).toContain('Looking for')
  })
})

describe('what happened afterwards', () => {
  function install(extra: Partial<CliInstall> = {}): CliInstall {
    return {
      outcome: 'linked',
      replaced: null,
      administrator: false,
      status: status({ state: 'linked', resolved: APP_CLI }),
      ...extra
    }
  }

  it('names the link and what it leads to', () => {
    expect(cliOutcome(install())).toBe(`/usr/local/bin/teamree now points at ${APP_CLI}.`)
  })

  it('says a password was given, when one was', () => {
    expect(cliOutcome(install({ administrator: true }))).toContain('An administrator password was given.')
  })

  it('treats an existing correct link as success rather than as an error', () => {
    expect(cliOutcome(install({ outcome: 'already-linked' }))).toBe(
      '/usr/local/bin/teamree already pointed at this app, so nothing was changed.'
    )
  })

  it('says what the link used to point at when it replaced one', () => {
    const older = '/Users/ann/Downloads/teamree.app/Contents/Resources/cli/teamree'
    const message = cliOutcome(install({ outcome: 'replaced', replaced: older }))
    expect(message).toContain(older)
    expect(message).toContain('untouched')
  })
})

describe('whether the sidebar offers it', () => {
  it('offers it while there is something to do', () => {
    expect(offerCliInstall(status({ state: 'absent' }))).toBe(true)
    expect(offerCliInstall(status({ state: 'elsewhere', resolved: '/elsewhere/teamree' }))).toBe(true)
    expect(offerCliInstall(status({ state: 'file' }))).toBe(true)
  })

  it('offers nothing once the link is right, or where the button could not work', () => {
    expect(offerCliInstall(status({ state: 'linked', resolved: APP_CLI }))).toBe(false)
    expect(offerCliInstall(status({ installable: false, platform: 'linux' }))).toBe(false)
    expect(offerCliInstall(status({ source: null }))).toBe(false)
    expect(offerCliInstall(null)).toBe(false)
  })
})
