import { describe, expect, it } from 'vitest'
import type { CliInstall, CliStatus } from '@shared/entities'
import { cliActionLabel, cliOffer, cliOutcome, cliPanel, offerCliInstall } from './cliInstallModel'

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
    expect(panel.promise).toBe(`/usr/local/bin/teamree → ${APP_CLI}`)
  })

  it('links a checkout’s CLI where it is', () => {
    const panel = cliPanel(status({ packaged: false, source: CHECKOUT_CLI, bundle: `${CHECKOUT_CLI}.mjs` }))
    expect(panel.action).toBe('Put teamree on my PATH')
    expect(panel.promise).toContain(CHECKOUT_CLI)
  })

  it('says a password is coming, in one line, before it is asked for', () => {
    const panel = cliPanel(status({ needsAdministrator: true }))
    expect(panel.password).toBe('Administrator password for /usr/local/bin')
  })

  it('says when no password will be asked for, which is the common case with Homebrew', () => {
    expect(cliPanel(status({ needsAdministrator: false })).password).toBe('No password')
  })

  it('warns when the link will be made somewhere no shell looks', () => {
    const panel = cliPanel(status({ onPath: null }))
    expect(panel.pathWarning).toBe('/usr/local/bin not on PATH')
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
    expect(panel.headline).toBe('On your PATH')
    expect(panel.detail).toBe(`/usr/local/bin/teamree → ${APP_CLI}`)
    expect(panel.action).toBeNull()
  })

  it('names the other teamree when the link leads to one', () => {
    const older = '/Users/ann/Downloads/teamree.app/Contents/Resources/cli/teamree'
    const panel = cliPanel(status({ state: 'elsewhere', resolved: older }))
    expect(panel.headline).toBe('Linked to another copy')
    expect(panel.detail).toBe(`/usr/local/bin/teamree → ${older}`)
    expect(panel.action).toBe('Point it at this app')
    expect(panel.promise).toContain(APP_CLI)
  })
})

describe('something in the way', () => {
  it('refuses a regular file and says what is there', () => {
    const panel = cliPanel(status({ state: 'file', resolved: '/usr/local/bin/teamree' }))
    expect(panel.headline).toBe('/usr/local/bin/teamree is a regular file — move it aside')
    expect(panel.detail).toBeNull()
    expect(panel.action).toBeNull()
  })

  it('says the same of a directory', () => {
    expect(cliPanel(status({ state: 'directory' })).headline).toContain('is a directory')
  })
})

describe('a CLI nothing has built yet', () => {
  /** `npm run dev` builds the app and not the CLI, so this is every fresh checkout. */
  function unbuilt(extra: Partial<CliStatus> = {}): CliStatus {
    return status({ packaged: false, source: CHECKOUT_CLI, bundle: null, ...extra })
  }

  it('names the command that builds it rather than offering to link it', () => {
    const panel = cliPanel(unbuilt())
    expect(panel.headline).toBe('CLI not built')
    expect(panel.detail).toBe(CHECKOUT_CLI)
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
    expect(panel.headline).toBe('Not installable on linux')
    expect(panel.action).toBeNull()
    expect(panel.manual).toBe('sudo ln -sf /opt/teamree/resources/cli/teamree /usr/local/bin/teamree')
  })

  it('says so when the build has no CLI in it at all', () => {
    const panel = cliPanel(status({ source: null }))
    expect(panel.headline).toBe('No CLI in this build')
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
  const CHECKED = '/usr/local/bin in /etc/paths (login shell not asked)'

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
    expect(cliOutcome(install())).toBe(`Linked /usr/local/bin/teamree → ${APP_CLI} · ${CHECKED}`)
  })

  it('treats an existing correct link as success rather than as an error', () => {
    expect(cliOutcome(install({ outcome: 'already-linked' }))).toBe(
      `Already linked: /usr/local/bin/teamree → ${APP_CLI} · ${CHECKED}`
    )
  })

  it('says what the link used to point at when it replaced one', () => {
    const older = '/Users/ann/Downloads/teamree.app/Contents/Resources/cli/teamree'
    const message = cliOutcome(install({ outcome: 'replaced', replaced: older }))
    expect(message).toContain(`replacing ${older}`)
  })
})

describe('whether the sidebar offers it', () => {
  it('offers it while there is something to do', () => {
    expect(offerCliInstall(status({ state: 'absent' }))).toBe(true)
    expect(offerCliInstall(status({ state: 'elsewhere', resolved: '/elsewhere/teamree' }))).toBe(true)
    expect(offerCliInstall(status({ state: 'file' }))).toBe(true)
  })

  // Taken off a real mounted disk image of this build, which is how every macOS
  // user meets this app before they drag it anywhere: open the .dmg,
  // double-click, look around. The runtime really does report
  // `impermanent: "volume"` and a source under /Volumes there.
  //
  // The rail still carries a way in — that is deliberate and asserted below,
  // because the panel is where the answer lives and this is how somebody finds
  // it. What it must not do is get them there by naming an action it cannot
  // perform: in this state the panel has no control at all, so a label reading
  // "Point teamree at this app" is a promise the next screen breaks.
  it('routes to the explanation without promising an action it cannot perform', () => {
    const fromTheImage = status({
      state: 'elsewhere',
      impermanent: 'volume',
      source: '/Volumes/teamree 0.2.0-universal/teamree.app/Contents/Resources/cli/teamree',
      resolved: '/somewhere/else/teamree',
      needsAdministrator: true
    })

    expect(offerCliInstall(fromTheImage)).toBe(true)
    expect(cliActionLabel(fromTheImage)).toBe('Why teamree is not on your PATH')
    expect(cliActionLabel(fromTheImage)).not.toContain('Point teamree')

    // And what it routes to: which state it is, what to do instead, no control.
    const panel = cliPanel(fromTheImage)
    expect(panel.headline).toContain('disk image')
    expect(panel.headline).toContain('Applications')
    expect(panel.action).toBeNull()
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
    expect(offer?.password).toContain('Administrator password')
    // The same sentences the panel uses, so the two cannot drift apart.
    expect(offer?.promise).toBe(cliPanel(status({ needsAdministrator: true })).promise)
    expect(offer?.password).toBe(cliPanel(status({ needsAdministrator: true })).password)
    expect(offer?.accept).toBe('Put teamree on my PATH')
    expect(offer?.decline).toBe('No thanks')
  })

  it('says the other thing when the link exists and leads to another copy', () => {
    const older = '/Users/ann/Downloads/teamree.app/Contents/Resources/cli/teamree'
    const offer = cliOffer(status({ state: 'elsewhere', resolved: older }))
    expect(offer?.headline).toContain('another copy')
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
    expect(panel.headline).toContain('disk image')
    expect(panel.detail).toBe(ON_VOLUME)
    // The one thing to do about it, where somebody looking for a button is.
    expect(panel.headline).toContain('Applications')
    expect(panel.action).toBeNull()
    expect(panel.password).toBeNull()
  })

  it('says the same of the copy macOS translocated the app to', () => {
    const panel = cliPanel(status({ impermanent: 'translocated' }))
    expect(panel.headline).toContain('translocated copy')
    expect(panel.headline).toContain('Applications')
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
    expect(panel.headline).toBe('Broken link')
    expect(panel.detail).toBe(`/usr/local/bin/teamree → ${gone} (missing)`)
    // Still the same thing to press: pointing it here is exactly the repair.
    expect(panel.action).toBe('Point it at this app')
    expect(panel.promise).toContain(APP_CLI)
  })

  it('keeps the other headline for a link that does lead to a copy', () => {
    const panel = cliPanel(status({ state: 'elsewhere', resolved: gone, dangling: false }))
    expect(panel.headline).toBe('Linked to another copy')
    expect(panel.detail).not.toContain('missing')
  })

  it('says the same on the card shown on first run', () => {
    const offer = cliOffer(missing)
    expect(offer?.headline).not.toContain('another copy')
    expect(offer?.headline).toContain('broken link')
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
  it('names /etc/paths as a fallback, and says the login shell was not asked', () => {
    const message = cliOutcome(linked({ onPath: 'login' }))
    expect(message).toContain('/usr/local/bin in /etc/paths')
    expect(message).toContain('login shell not asked')
    expect(message).not.toContain('teamree cannot read your shell profile')
  })

  // The strong answer, and the one a Mac normally gives now.
  it('names the login shell’s own PATH when that is what answered', () => {
    expect(cliOutcome(linked({ onPath: 'shell' }))).toContain('/usr/local/bin on your login shell’s PATH')
  })

  it('names this app’s own PATH, and that it is not the terminal’s, when that is what answered', () => {
    const message = cliOutcome(linked({ onPath: 'environment' }))
    expect(message).toContain('on the app’s PATH')
    expect(message).toContain('not necessarily your terminal’s')
  })

  it('says nothing it can read claims the directory, rather than calling it done', () => {
    const message = cliOutcome(linked({ onPath: null }))
    expect(message).toContain('/usr/local/bin not on PATH')
  })

  it('stands the already-linked line on the same footing', () => {
    expect(cliOutcome({ ...linked({ onPath: 'login' }), outcome: 'already-linked' })).toContain('/etc/paths')
  })
})
