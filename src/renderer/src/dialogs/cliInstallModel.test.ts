import { describe, expect, it } from 'vitest'
import type { CliInstall, CliStatus } from '@shared/entities'
import { cliOffer, cliOutcome, cliPanel, offerCliInstall } from './cliInstallModel'

const APP_CLI = '/Applications/teamree.app/Contents/Resources/cli/teamree'
const APP_BUNDLE = '/Applications/teamree.app/Contents/Resources/cli/teamree.mjs'
const CHECKOUT_CLI = '/Users/ann/src/teamree/resources/cli/teamree'
const ON_VOLUME = '/Volumes/teamree 0.1.0/teamree.app/Contents/Resources/cli/teamree'

function status(extra: Partial<CliStatus> = {}): CliStatus {
  return {
    installable: true,
    platform: 'darwin',
    source: APP_CLI,
    packaged: true,
    bundle: APP_BUNDLE,
    impermanent: null,
    destination: '/usr/local/bin/teamree',
    directory: '/usr/local/bin',
    state: 'absent',
    resolved: null,
    dangling: false,
    needsAdministrator: false,
    onPath: 'login',
    askedAt: null,
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

  it('does not tell a checkout that its CLI ships inside the app, and says what a link there costs', () => {
    const panel = cliPanel(status({ packaged: false, source: CHECKOUT_CLI, bundle: `${CHECKOUT_CLI}.mjs` }))
    expect(panel.action).toBe('Put teamree on my PATH')
    expect(panel.detail).toContain(CHECKOUT_CLI)
    expect(panel.detail).not.toContain('ships inside this app')
    // The reason the first-run offer stays quiet here, said where the button is.
    expect(panel.detail).toContain('move')
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

describe('a CLI nothing has built yet', () => {
  /** `npm run dev` builds the app and not the CLI, so this is every fresh checkout. */
  function unbuilt(extra: Partial<CliStatus> = {}): CliStatus {
    return status({ packaged: false, source: CHECKOUT_CLI, bundle: null, ...extra })
  }

  it('names the command that builds it rather than offering to link it', () => {
    const panel = cliPanel(unbuilt())
    expect(panel.headline).toBe('The teamree CLI has not been built yet.')
    expect(panel.detail).toContain(CHECKOUT_CLI)
    expect(panel.manual).toBe('npm run build:cli')
    expect(panel.action).toBeNull()
    expect(panel.password).toBeNull()
  })

  it('does not call a link to it being on your PATH', () => {
    const panel = cliPanel(unbuilt({ state: 'linked', resolved: CHECKOUT_CLI }))
    expect(panel.headline).not.toContain('on your PATH')
    expect(panel.manual).toBe('npm run build:cli')
  })

  it('keeps it off the sidebar, which would be a password spent on a broken command', () => {
    expect(offerCliInstall(unbuilt())).toBe(false)
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
  /** The basis the success line carries, for the status above: onPath 'login'. */
  const CHECKED =
    'Your login shell could not be asked, so this is checked against /etc/paths, and /usr/local/bin is in it. ' +
    'That is the PATH a shell *starts* with: a profile that sets PATH rather than adding to it replaces it, and ' +
    'then the command will not be found in a terminal even though the link is fine.'

  function install(extra: Partial<CliInstall> = {}): CliInstall {
    return {
      outcome: 'linked',
      replaced: null,
      administrator: false,
      status: status({ state: 'linked', resolved: APP_CLI }),
      ...extra
    }
  }

  it('names the link, what it leads to, and what that was checked against', () => {
    expect(cliOutcome(install())).toBe(`/usr/local/bin/teamree now points at ${APP_CLI}. ${CHECKED}`)
  })

  it('says a password was given, when one was', () => {
    expect(cliOutcome(install({ administrator: true }))).toContain('An administrator password was given.')
  })

  it('treats an existing correct link as success rather than as an error', () => {
    expect(cliOutcome(install({ outcome: 'already-linked' }))).toBe(
      `/usr/local/bin/teamree already pointed at this app, so nothing was changed. ${CHECKED}`
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

describe('the offer made once, unprompted, on first run', () => {
  it('says where the link goes and that a password is coming, before anything is pressed', () => {
    const offer = cliOffer(status({ needsAdministrator: true }))
    expect(offer).not.toBeNull()
    expect(offer?.promise).toContain('/usr/local/bin/teamree')
    expect(offer?.password).toContain('administrator password')
    // The same sentences the panel uses, so the two cannot drift apart.
    expect(offer?.promise).toBe(cliPanel(status({ needsAdministrator: true })).promise)
    expect(offer?.password).toBe(cliPanel(status({ needsAdministrator: true })).password)
    expect(offer?.accept).toBe('Put teamree on my PATH')
    expect(offer?.decline).toBe('No thanks')
    expect(offer?.once).toContain('once')
  })

  it('says the other thing when the link exists and leads to another copy', () => {
    const older = '/Users/ann/Downloads/teamree.app/Contents/Resources/cli/teamree'
    const offer = cliOffer(status({ state: 'elsewhere', resolved: older }))
    expect(offer?.headline).toContain('different copy')
    expect(offer?.accept).toBe('Point it at this app')
  })

  it('is not made again once this installation has been asked', () => {
    expect(cliOffer(status({ askedAt: 1700000000000 }))).toBeNull()
  })

  it('is not made when the link is already right', () => {
    expect(cliOffer(status({ state: 'linked', resolved: APP_CLI }))).toBeNull()
  })

  it('is not made for a source checkout, which would ask on every npm run dev', () => {
    expect(cliOffer(status({ packaged: false }))).toBeNull()
    // The sidebar still offers it: running from source is a fine reason to
    // want the command, just not a reason to be asked unprompted.
    expect(offerCliInstall(status({ packaged: false }))).toBe(true)
  })

  it('is not made where the app could not do it, or has nothing to link', () => {
    expect(cliOffer(status({ installable: false, platform: 'linux' }))).toBeNull()
    expect(cliOffer(status({ source: null }))).toBeNull()
    expect(cliOffer(null)).toBeNull()
  })

  it('is not made when something is in the way: that is a problem, not an offer', () => {
    expect(cliOffer(status({ state: 'file' }))).toBeNull()
    expect(cliOffer(status({ state: 'directory' }))).toBeNull()
    // Still on the sidebar, where the panel can explain what is there.
    expect(offerCliInstall(status({ state: 'file' }))).toBe(true)
  })
})

describe('an app that is not where it will be tomorrow', () => {
  it('names the disk image instead of offering to link out of it', () => {
    const panel = cliPanel(status({ impermanent: 'volume', source: ON_VOLUME, bundle: `${ON_VOLUME}.mjs` }))
    expect(panel.headline).toContain('mounted volume')
    expect(panel.detail).toContain(ON_VOLUME)
    expect(panel.detail).toContain('eject')
    // The one thing to do about it, where somebody looking for a button is.
    expect(panel.detail).toContain('Applications')
    expect(panel.action).toBeNull()
    expect(panel.password).toBeNull()
  })

  it('says the same of the copy macOS translocated the app to', () => {
    const panel = cliPanel(status({ impermanent: 'translocated' }))
    expect(panel.headline).toContain('temporary copy')
    expect(panel.detail).toContain('Applications')
    expect(panel.action).toBeNull()
  })

  it('outranks a link that already points at that copy, which reads as done and is not', () => {
    const panel = cliPanel(status({ impermanent: 'volume', state: 'linked', resolved: ON_VOLUME, source: ON_VOLUME }))
    expect(panel.headline).not.toContain('on your PATH')
    expect(panel.action).toBeNull()
  })

  it('makes no first-run offer from inside the disk image', () => {
    expect(cliOffer(status({ impermanent: 'volume' }))).toBeNull()
    expect(cliOffer(status({ impermanent: 'translocated' }))).toBeNull()
    // The sidebar still carries it, to the panel that says what to do instead.
    expect(offerCliInstall(status({ impermanent: 'volume' }))).toBe(true)
  })
})

describe('a link to a teamree that is not there any more', () => {
  const gone = '/Users/ann/Downloads/teamree.app/Contents/Resources/cli/teamree'
  const missing = status({ state: 'elsewhere', resolved: gone, dangling: true })

  it('does not say the command drives that copy, because it does not run at all', () => {
    const panel = cliPanel(missing)
    expect(panel.detail).toContain(gone)
    expect(panel.detail).not.toContain('drives that copy')
    expect(panel.detail).toContain('nothing is there')
    // Still the same thing to press: pointing it here is exactly the repair.
    expect(panel.action).toBe('Point it at this app')
    expect(panel.promise).toContain(APP_CLI)
  })

  it('keeps the other sentence for a link that does lead to a copy', () => {
    const panel = cliPanel(status({ state: 'elsewhere', resolved: gone, dangling: false }))
    expect(panel.detail).toContain('drives that copy')
  })

  it('says the same on the card shown on first run', () => {
    const offer = cliOffer(missing)
    expect(offer?.headline).not.toContain('a different copy')
    expect(offer?.headline).toContain('nothing')
  })
})

describe('what the line reporting success is standing on', () => {
  function linked(extra: Partial<CliStatus> = {}): CliInstall {
    return {
      outcome: 'linked',
      replaced: null,
      administrator: false,
      status: status({ state: 'linked', resolved: APP_CLI, ...extra })
    }
  }

  // This used to assert that the line said "teamree cannot read your shell
  // profile", which was the sentence appended to every one of these answers —
  // and was false. teamree starts the login shell and reads the PATH it ends up
  // with for every pane in the app. The panel was the one place that did not
  // ask, and it said the app could not.
  it('names /etc/paths as a fallback, and says what that does not prove', () => {
    const message = cliOutcome(linked({ onPath: 'login' }))
    expect(message).toContain('/etc/paths')
    expect(message).toContain('login shell could not be asked')
    expect(message).toContain('will not be found in a terminal')
    expect(message).not.toContain('teamree cannot read your shell profile')
  })

  // The strong answer, and the one a Mac normally gives now.
  it('names the login shell’s own PATH when that is what answered', () => {
    const message = cliOutcome(linked({ onPath: 'shell' }))
    expect(message).toContain('PATH your login shell reports after reading your profile')
    expect(message).toContain('a terminal you open will have')
  })

  it('names this app’s own PATH when that is what answered', () => {
    expect(cliOutcome(linked({ onPath: 'environment' }))).toContain('this app’s own PATH')
  })

  it('says nothing it can read claims the directory, rather than calling it done', () => {
    const message = cliOutcome(linked({ onPath: null }))
    expect(message).toContain('Nothing teamree can read puts /usr/local/bin on a PATH')
  })

  it('stands the already-linked line on the same footing', () => {
    expect(cliOutcome({ ...linked({ onPath: 'login' }), outcome: 'already-linked' })).toContain('/etc/paths')
  })
})
