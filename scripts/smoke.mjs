// Boots the built app with the window hidden, asserts the renderer mounted, the
// preload bridge is reachable and the runtime behind it answers, then exits. Run
// by `npm run smoke`, which is one of the gates `npm run release` refuses to
// publish without.
//
// It boots the real main process — `out/main/index.js`, the file the packaged
// app starts — rather than opening a window of its own onto the renderer. It
// used to do the latter, and the difference mattered: nothing in this process
// installed the IPC bridge, so every call the renderer made on mount was
// answered by Electron with "No handler registered for 'teamree:rpc:call'", the
// window put up "Could not reach the runtime", and the smoke test called that a
// pass. It asserted that a renderer can mount, which it can do with nothing
// behind it at all. Booting the real main process is also the only way the
// assembly in startRuntime.ts is ever exercised outside a unit test.
//
// The app is pointed at the throwaway user data directory the launcher named,
// before anything else happens. That is not tidiness: the runtime restores the
// last session's panes from there, so a smoke test that read a developer's
// workspace would spawn their agents, take the single-instance lock their
// running copy holds, and write to the file that copy is keeping.
//
// That directory does not exist when this starts, which is deliberate and is
// what lets the last check below mean anything: Electron creates it, so its
// permissions are the ones a first launch would produce rather than a temporary
// directory's. See `checkLocalBoundary`.
//
// It also runs the peer library's cipher check here, in a genuine Electron main
// process, which is the process the teamwork feature's handshakes actually
// happen in. `src/shared/peer/electronRuntime.test.ts` runs the same check under
// every `npm test` with `ELECTRON_RUN_AS_NODE=1`, which is the same binary and
// the same BoringSSL but not the same process type — and the whole reason this
// check exists is that a runtime difference nobody had exercised took the
// feature out of every shipped build. So it is exercised in both.
//
// Electron does not pump its event loop until this module finishes evaluating,
// so everything here hangs off callbacks rather than top-level await.
import { app, Menu } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runPeerCheck } from './electron-peer-check.mjs'
import { FIXTURE_REPO_FLAG, PEER_BUNDLE_FLAG, USER_DATA_FLAG, readNamedArg } from './smoke-args.mjs'

const TIMEOUT_MS = 30_000
const READY_MS = 15_000
const root = process.cwd()
const failures = []

const bail = setTimeout(() => {
  console.error(`smoke: timed out after ${TIMEOUT_MS}ms`)
  process.exit(1)
}, TIMEOUT_MS)

// Both of these are settled before the app's own module body runs, which is why
// the import of it is deferred rather than written at the top of this file: the
// first is read while Electron is still deciding whether this process is a
// second instance, and the second while the window is deciding whether to show
// itself.
//
// A run with no directory to point at stops here rather than continuing into
// the real one. Refusing is the whole safeguard: the alternative is a gate that
// reads the workspace of whoever ran it, restores their panes, and spawns the
// agents in them.
const userDataDir = readNamedArg(USER_DATA_FLAG)
if (!userDataDir) {
  console.error('smoke: no user data directory was passed; run this through scripts/run-smoke.mjs')
  process.exit(1)
}
app.setPath('userData', userDataDir)
// The app shows its window as soon as it can paint unless this says otherwise.
// A gate has no business taking focus from whoever is running it; the packaged
// app check sets the same variable for the same reason. Set here rather than by
// the launcher so it holds however this script was started.
process.env.TEAMREE_BACKGROUND_LAUNCH = '1'

// Without this, closing the hidden window would quit before assertions finish.
app.on('window-all-closed', () => {})

// Attached at construction: the app loads the renderer into the window in the
// same breath as it creates it, and a listener added after that would miss
// whatever the first load had to say.
// Raised only while `checkRendererBoundary` is deliberately provoking the
// content security policy. Chromium reports a script it refused to run as a
// console *error*, and a refusal is what that check is asking for — so for the
// length of it the refusal is collected from the page's own
// `securitypolicyviolation` event and the console line it also produces is not
// counted as a fault. Nothing else in this file turns it on.
let provoking = false

const opened = new Promise((resolve) => {
  app.once('browser-window-created', (_event, window) => {
    window.webContents.on('console-message', (event) => {
      if (event.level === 'error' && !provoking) failures.push(`console error: ${event.message}`)
    })
    window.webContents.on('did-fail-load', (_loadEvent, code, description) => {
      failures.push(`did-fail-load ${code} ${description}`)
    })
    window.webContents.on('preload-error', (_preloadEvent, path, error) => {
      failures.push(`preload-error ${path} ${error.message}`)
    })
    resolve(window)
  })
})

function finish() {
  clearTimeout(bail)
  if (failures.length) {
    for (const failure of failures) console.error(`smoke: ${failure}`)
    process.exitCode = 1
    // And again at the last moment, because `process.exitCode` alone does not
    // survive this exit. Electron's `app.quit()` ends the process through
    // `Browser::Quit` with an exit code of its own, which is zero unless
    // somebody names another — so every failure this file has ever found was
    // printed in full and then reported as a pass. `will-quit` is the safe
    // moment to name one: the quit sequence has already stopped the runtime by
    // then, so every pty is dead and there is no exit callback left to wake in
    // a closing environment, which is the whole reason `app.exit()` is not
    // called here directly. See the note below.
    app.once('will-quit', () => process.exit(1))
  } else {
    console.log('smoke: renderer mounted, preload bridge reachable, runtime answering')
    process.exitCode = 0
  }
  // `app.quit()` rather than `app.exit()`, and the difference is the whole of
  // the fix. This gate used to print its success line and then die with
  // SIGABRT — "terminating due to uncaught exception of type Napi::Error" —
  // on any run that had opened a pane, and the mechanism is in node-pty's
  // `SetupExitCallback` (src/unix/pty.cc): every pty gets a thread of its own
  // that waits for the child to die and then calls back into JavaScript
  // through a ThreadSafeFunction. `app.exit()` starts tearing the Node
  // environment down while those children are still alive; they die as the
  // process goes, their threads wake, and a callback into an environment that
  // is closing throws a C++ exception that nothing on that thread catches.
  // How often it happened tracked how many panes were open — one was usually
  // fine, three was every time — and the menu bar's arrival shifted the
  // timing enough that one pane started to hit it too.
  //
  // `quit` goes through the app's own `before-quit`, and that sequence stops
  // the runtime first, which kills every pty and *awaits* each exit callback
  // (`terminals.shutdown()` in `startRuntime.ts`) before the process leaves.
  // No thread is left to wake late. It is the sequence a person pressing ⌘Q
  // gets, and it is the one that ends cleanly; the exit code rides on
  // `process.exitCode`, which `quit` honours and `exit` never needed to.
  app.quit()
}

/** Polls `probe` until it is true, and records `failure` if it never is. */
async function waitFor(probe, failure) {
  const deadline = Date.now() + READY_MS
  for (;;) {
    if (await probe()) return true
    if (Date.now() >= deadline) {
      failures.push(failure)
      return false
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

async function run() {
  // After `whenReady`, which is safe — a `whenReady` asked for later resolves
  // just the same — and which is what lets the two settings above be made
  // before the app reads them.
  await import(pathToFileURL(join(root, 'out/main/index.js')).href)

  const window = await opened
  if (window.webContents.isLoading()) {
    await new Promise((resolve) => window.webContents.once('did-finish-load', resolve))
  }

  const ask = (expression) => window.webContents.executeJavaScript(expression)

  await waitFor(
    () => ask('Boolean(document.querySelector("#root")?.childElementCount)'),
    'renderer did not mount into #root'
  )
  await waitFor(
    () => ask('typeof window.teamree?.versions?.electron === "string"'),
    'preload bridge is not exposed on window.teamree'
  )
  // The assertion the old harness could not make: a call placed by the renderer,
  // over the bridge the product uses, answered by the runtime this launch
  // started. Anything less proves only that a window can open.
  await waitFor(
    () => ask('window.teamree.runtime.call("status.get", {}).then((response) => response.ok === true, () => false)'),
    'the runtime did not answer a call from the renderer'
  )

  await checkContrast(ask, 'first launch')
  await checkWindowSurfaces(ask)
  await checkMenuBar(ask)
  await checkWorktreeSurfaces(ask)
  await checkRendererBoundary(window, ask)
  await checkPeerCrypto()
  checkLocalBoundary()
}

/**
 * That the surfaces which take the main area can actually be reached.
 *
 * Everything else in this file proves the window is alive and correctly walled
 * off. None of it proves anybody can get anywhere, and that is a real gap: a
 * surface can have a component, a store action, a full set of passing unit
 * tests, and no way in. Settings and Help both shipped in exactly that state —
 * reachable from the empty state and from each other, and absent from the rail
 * and the palette, so anybody with a worktree open could not get to either. The
 * unit tests were green throughout, because each one rendered the component it
 * was about.
 *
 * So this presses the buttons. It is deliberately the shallowest possible
 * version of that — is the control there, does pressing it put the surface on
 * screen, and does the surface have its own heading — because a smoke test that
 * asserted layout would break on every honest change and be deleted. What it
 * pins is the thing unit tests structurally cannot: the wiring between a rail
 * button and the area it is supposed to fill.
 *
 * Run against the first-launch state, with no repository added, which is the
 * one state this harness has. Both of these are window-level surfaces rather
 * than worktree ones, so that is exactly where they have to work.
 */
async function checkWindowSurfaces(ask) {
  // By the words on them rather than by class or position: the label is the
  // thing a person looks for, and a selector that survived a renamed class
  // while the button said something else would be worse than no check.
  const press = (label) =>
    ask(
      `(() => {
        const found = [...document.querySelectorAll('button')].find(
          (button) => button.textContent?.trim().startsWith(${JSON.stringify(label)})
        )
        if (!found) return false
        found.click()
        return true
      })()`
    )

  const heading = (text) =>
    ask(`[...document.querySelectorAll('h1')].some((node) => node.textContent?.trim() === ${JSON.stringify(text)})`)

  for (const [label, title] of [
    ['Settings', 'Settings'],
    ['Help', 'Help']
  ]) {
    if (!(await press(label))) {
      failures.push(`no ${label} control in the window, so the surface cannot be reached`)
      continue
    }
    await waitFor(() => heading(title), `pressing ${label} did not put the ${title} surface on screen`)
    await checkContrast(ask, title)
  }
}

/**
 * Text nobody can read, measured rather than eyeballed.
 *
 * Every colour in this window comes out of one palette, and the palette has a
 * legibility pass — including for the ones a person builds by hand, which is
 * the whole argument for letting them edit all forty-two. What that pass cannot
 * see is a *pairing*: a token that is perfectly legible on the ground it was
 * designed for, used by a new element on a ground it was not. Dim-on-dim is the
 * ordinary way an interface goes quietly unreadable, and it is invisible to
 * every other check here, because nothing about it is an error.
 *
 * So this reads the computed colour of every text node on screen, walks up for
 * the first ancestor that actually paints an opaque background, composites the
 * two, and computes the WCAG contrast ratio. The threshold is AA — 4.5:1, or
 * 3:1 for text that is genuinely large — which is the floor Apple's own
 * accessibility guidance points at.
 *
 * It ran clean on every surface the first time it was written, which is the
 * result worth having: it is not fixing anything, it is holding something that
 * is already true.
 */
const MEASURE_CONTRAST = `(() => {
  const parse = (value) => {
    const found = value.match(/rgba?\\(([^)]+)\\)/)
    if (!found) return null
    const parts = found[1].split(',').map((part) => parseFloat(part))
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 }
  }
  const channel = (value) => {
    const v = value / 255
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  }
  const luminance = (c) => 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b)
  const composite = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1
  })
  // Up the tree until something actually paints. A translucent fill is not a
  // ground; compositing against it would flatter every pairing above it.
  const groundOf = (element) => {
    let node = element
    while (node && node !== document.documentElement) {
      const found = parse(getComputedStyle(node).backgroundColor)
      if (found && found.a > 0.95) return found
      node = node.parentElement
    }
    return { r: 0, g: 0, b: 0, a: 1 }
  }

  const failures = []
  for (const element of document.querySelectorAll('*')) {
    const own = [...element.childNodes]
      .filter((node) => node.nodeType === 3)
      .map((node) => node.textContent.trim())
      .join('')
    if (own === '') continue
    const style = getComputedStyle(element)
    if (style.visibility === 'hidden' || style.display === 'none' || parseFloat(style.opacity) < 0.1) continue
    const colour = parse(style.color)
    if (!colour) continue
    const ground = groundOf(element)
    const front = luminance(composite(colour, ground))
    const back = luminance(ground)
    const ratio = (Math.max(front, back) + 0.05) / (Math.min(front, back) + 0.05)
    const size = parseFloat(style.fontSize)
    const weight = parseInt(style.fontWeight, 10) || 400
    const large = size >= 24 || (size >= 18.66 && weight >= 700)
    const needed = large ? 3 : 4.5
    if (ratio + 0.005 < needed) {
      failures.push(own.slice(0, 40) + ' at ' + (Math.round(ratio * 100) / 100) + ':1, needs ' + needed)
    }
  }
  return JSON.stringify(failures)
})()`

/**
 * Measures what is on screen now, and records anything unreadable.
 *
 * The local array is deliberately not called `failures`. The first version of
 * this named it that, which shadowed the module-level one it was supposed to be
 * reporting into — so every finding was pushed onto the list that had just been
 * parsed out of the page and thrown away, and the check could not fail. It was
 * only caught by insisting on a mutation that should break it.
 */
async function checkContrast(ask, surface) {
  const unreadable = JSON.parse(await ask(MEASURE_CONTRAST))
  // Named individually rather than counted: a count tells somebody a number,
  // and this tells them which sentence to go and look at.
  for (const one of unreadable.slice(0, 6)) failures.push(`unreadable on ${surface}: ${one}`)
  if (unreadable.length > 6) failures.push(`and ${unreadable.length - 6} more unreadable on ${surface}`)
}

/**
 * That the menu bar has this app's commands in it, and that choosing one works.
 *
 * The menu bar is the one surface in this app that no unit test can see the
 * whole of, because it is assembled across the process boundary: the window
 * works out what its menus should contain — labels, chords, and which items
 * could do anything right now — and the main process draws what it is told.
 * Each half has tests of its own and both were green through a version of this
 * where the window published to a channel nothing served, so the menu bar was
 * the platform's roles and nothing else and the app looked exactly as it had
 * before. Only a running app can say otherwise.
 *
 * Two things are asserted, and the second is the one worth the trouble. That
 * the commands are in the menu at all, read off `Menu.getApplicationMenu()` —
 * the object the platform is showing, not a template. And that choosing one
 * reaches the window: the item's own click is invoked and the surface it opens
 * is waited for, which is the full round trip of menu to main to renderer to
 * screen.
 *
 * Run against the first-launch state, so the pane commands are correctly greyed
 * and there is not much left that can be chosen. The dashboard item is the one
 * picked because it is a window-level view that needs nothing open — the same
 * reason `checkWindowSurfaces` uses Settings and Help — and because it toggles,
 * so this can put the window back the way it found it for the checks below.
 */
async function checkMenuBar(ask) {
  const named = (label) => {
    const walk = (menu) => (menu?.items ?? []).flatMap((item) => [item, ...(item.submenu ? walk(item.submenu) : [])])
    return walk(Menu.getApplicationMenu()).find((item) => item.label === label)
  }

  // Waited for rather than read once: the window publishes its menus on mount,
  // and the main process installs them when the message arrives.
  const arrived = await waitFor(
    async () => named('New task') !== undefined,
    'the window\u2019s commands never reached the menu bar'
  )
  if (!arrived) return

  for (const [label, accelerator] of [
    ['New task', 'CommandOrControl+N'],
    ['Close pane', 'CommandOrControl+W'],
    // \u2318, opens the settings page — the one with the CLI link, the update
    // preference and the relay on it. It used to open the theme editor, which
    // now has an item of its own under View and no chord at all.
    ['Settings\u2026', 'CommandOrControl+,'],
    ['All panes', 'CommandOrControl+E'],
    ['Toggle right panel', 'CommandOrControl+J'],
    // The four moves. Worth reading off a running app rather than trusting the
    // unit tests, because these are the ones whose chords are not characters:
    // the arrows and Return are spelled for Electron's parser rather than for
    // `KeyboardEvent.key`, and a name it does not recognise is rejected where
    // no test in the renderer can see it — the item draws with no chord beside
    // it, or the whole menu fails to build.
    ['Previous worktree', 'CommandOrControl+Alt+Up'],
    ['Next worktree', 'CommandOrControl+Alt+Down'],
    ['Focus previous pane', 'CommandOrControl+['],
    ['Maximize pane', 'CommandOrControl+Shift+Enter'],
    // In the Help menu, which carries the `help` role. Reading it off a running
    // app proves the submenu survived the role — that Electron built both onto
    // one item — and no more than that: whether macOS adopted it as the app's
    // Help menu is not something `Menu.getApplicationMenu()` can say.
    ['Shortcuts', 'CommandOrControl+/']
  ]) {
    const item = named(label)
    if (!item) {
      failures.push(`the menu bar has no ${label} item`)
      continue
    }
    // The chord beside the item is the chord that fires. A menu that printed a
    // different one would be a wrong answer given to somebody who came to the
    // menu because they did not know.
    if (item.accelerator !== accelerator) {
      failures.push(`the menu bar shows ${item.accelerator} for ${label}, not ${accelerator}`)
    }
  }

  // The mnemonic marker, which this platform does not have. `&File` is how
  // Windows and Linux are told that Alt-F opens the menu, and there the `&` is
  // consumed rather than drawn; macOS consumes nothing, so an unconditional
  // marker is an ampersand in the menu bar. Only a running app can say what the
  // bar actually reads, and the submenu walk above never looks at the top row.
  for (const item of process.platform === 'darwin' ? (Menu.getApplicationMenu()?.items ?? []) : []) {
    if ((item.label ?? '').includes('&')) {
      failures.push(`the menu bar draws ${item.label} with a mnemonic marker macOS does not use`)
    }
  }

  // Nothing offered that cannot work: on a first launch there is no pane, so
  // the pane commands are grey and the window-level ones are not.
  if (named('Close pane')?.enabled !== false) {
    failures.push('Close pane is live in a window with no pane in it')
  }
  if (named('All panes')?.enabled !== true) {
    failures.push('the menu bar greys a command that needs nothing to be open')
  }

  // The theme editor's own item, which is what stops \u2318, from landing on it.
  // Read off the running menu rather than trusted to the unit tests, because an
  // item with no accelerator is one Electron could drop on its way through:
  // `appMenu.ts` has to hand it `undefined` rather than an empty string.
  const appearance = named('Appearance\u2026')
  if (!appearance) {
    failures.push('the menu bar has no Appearance\u2026 item, so \u2318, is the only way to the theme editor')
  } else if (appearance.accelerator) {
    failures.push(`the menu bar shows ${appearance.accelerator} for Appearance\u2026, which nothing binds`)
  }

  // And the two git commands, which the menu bar could not reach at all. Grey
  // on a first launch, with no worktree and nothing to send.
  for (const label of ['Commit\u2026', 'Push']) {
    const item = named(label)
    if (!item) failures.push(`the menu bar has no ${label} item`)
    else if (item.enabled !== false) failures.push(`${label} is live in a window with no worktree in it`)
  }

  // And the round trip. `click()` on the item is what the platform does when
  // somebody chooses it, so this goes the whole way: main names the command to
  // the window, the window runs it through the same dispatcher a chord uses,
  // and the view changes.
  const showsDashboard = () =>
    ask('[...document.querySelectorAll("h1")].some((node) => node.textContent?.trim() === "All panes")')

  named('All panes')?.click()
  const reached = await waitFor(showsDashboard, 'choosing a menu item did not reach the window')

  // And away again, which is both what that command does and what leaves the
  // window as the checks after this one expect to find it.
  if (reached) {
    named('All panes')?.click()
    await waitFor(async () => !(await showsDashboard()), 'choosing the same menu item again did not put the view away')
  }
}

/**
 * The surfaces that only exist once there is a worktree open.
 *
 * `checkWindowSurfaces` above presses the two buttons that work on a first
 * launch. Everything else in this window needs a repository, and so until now
 * the strip of terminal tabs and the behaviour of closing a pane had never been
 * observed anywhere — they had unit tests, and unit tests render a component
 * against props they were handed. Whether a pane that the runtime made appears
 * as a tab is a question about the wiring between them, which is the seam no
 * unit test on either side can see.
 *
 * Driven through `window.teamree.runtime.call` — the renderer's own bridge, the
 * one the product uses — so that what is being exercised is the path a person
 * clicking would take, not a back door into the store.
 *
 * Skipped, loudly, when the launcher could not build a repository. A check that
 * quietly does nothing is worse than one that is not there.
 */
async function checkWorktreeSurfaces(ask) {
  const repo = readNamedArg(FIXTURE_REPO_FLAG)
  if (repo === undefined) {
    console.log('smoke: no fixture repository, so the worktree surfaces were not checked')
    return
  }

  const call = async (method, params) => {
    const answer = await ask(
      `window.teamree.runtime.call(${JSON.stringify(method)}, ${JSON.stringify(params)}).then(
         (response) => JSON.stringify(response),
         (error) => JSON.stringify({ ok: false, error: String(error) })
       )`
    )
    return JSON.parse(answer)
  }

  const project = await call('project.add', { path: repo, name: 'smoke' })
  if (project.ok !== true) {
    failures.push(`could not add the fixture repository: ${JSON.stringify(project.error ?? project)}`)
    return
  }

  const worktree = await call('worktree.create', { projectId: project.result.id, name: 'smoke task' })
  if (worktree.ok !== true) {
    failures.push(`could not create a worktree: ${JSON.stringify(worktree.error ?? worktree)}`)
    return
  }
  const worktreeId = worktree.result.id

  // A checkout is made on a thread of its own and the record says `creating`
  // until it is there. Opening a terminal in one that is not ready is a race
  // this check would report as a broken window.
  const ready = await waitFor(async () => {
    const read = await call('worktree.get', { worktreeId })
    return read.ok === true && read.result.state === 'ready'
  }, 'the worktree never became ready, so nothing below it could be checked')
  if (!ready) return

  // Opened the way a person opens it: by pressing its row in the sidebar. The
  // runtime making a worktree does not put it on screen, and driving the store
  // directly would skip the wiring this check exists to exercise.
  // Pressed the way a person presses it, and only once it can be pressed. The
  // row is deliberately disabled while the checkout is still being made — there
  // is nothing to open yet — and the first version of this check clicked it
  // anyway and reported the window as broken, because a click on a disabled
  // button succeeds at doing nothing. The runtime saying `ready` is not the same
  // fact as this window having heard it.
  const opened = await waitFor(
    () =>
      ask(
        `(() => {
           const row = [...document.querySelectorAll('button')].find(
             (node) => node.textContent?.includes('smoke task')
           )
           if (!row || row.disabled) return false
           row.click()
           return true
         })()`
      ),
    'the worktree never became openable in the sidebar'
  )
  if (!opened) return

  // And that pressing it actually took the area. Opening a worktree is supposed
  // to release whatever else had it — this check runs straight after the one
  // that leaves Help on screen, which is exactly the case that would otherwise
  // pass while the panes were nowhere to be seen.
  await waitFor(
    () => ask(`document.querySelector('.workspace') !== null && document.querySelector('.help') === null`),
    'pressing the worktree did not give the main area back to the workspace'
  )

  // The row's own menu, opened the way a right mouse button opens it.
  //
  // Everything about what is in that menu is a unit test. What only a running
  // window can say is that the event a real right-click delivers reaches the
  // row at all: the handler is on the `<li>` and every control inside it is a
  // button of its own, so a menu wired one element off is invisible to a test
  // that renders the component and asks it nicely. This is also the only place
  // the row's one destructive action is now reached from, which makes "does the
  // menu open" the same question as "can this worktree be removed".
  const rightClicked = await ask(
    `(() => {
       const row = [...document.querySelectorAll('.worktree')].find(
         (node) => node.textContent?.includes('smoke task')
       )
       if (!row) return false
       row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, detail: 1, clientX: 60, clientY: 120 }))
       return true
     })()`
  )
  if (rightClicked !== true) {
    failures.push('no worktree row in the sidebar to right-click')
    return
  }
  const menuOpen = await waitFor(
    () => ask(`document.querySelector('[role="menu"]') !== null`),
    'a right-click on the worktree row put no menu on screen'
  )
  if (menuOpen) {
    const items = JSON.parse(
      await ask(
        `JSON.stringify([...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map((node) => node.textContent.trim()))`
      )
    )
    // Last, and only last: the whole point of the menu is that the destructive
    // item is somewhere nobody arrives at by momentum.
    if (items.at(-1) !== 'Remove') failures.push(`the row menu does not end with Remove: ${JSON.stringify(items)}`)
    if (items.length !== 5) failures.push(`the row menu has ${items.length} items rather than five`)
  }
  // Closed again, so nothing below this is driving a window with a menu over it.
  await ask(
    `(() => {
       document
         .querySelector('[role="menu"]')
         ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
       return true
     })()`
  )
  await waitFor(() => ask(`document.querySelector('[role="menu"]') === null`), 'the row menu would not close on Escape')

  const terminal = await call('terminal.create', { worktreeId })
  if (terminal.ok !== true) {
    failures.push(`could not open a terminal in the worktree: ${JSON.stringify(terminal.error ?? terminal)}`)
    return
  }

  // The strip above the panes carries one tab per pane in the worktree on
  // screen. Matched on the pane's own title rather than on a count, because a
  // strip showing some other worktree's panes — which is exactly what this
  // replaced — would satisfy a count and is the thing being ruled out.
  const title = terminal.result.title
  await waitFor(
    () =>
      ask(
        `[...document.querySelectorAll('[role="tablist"] button, .tabs button')].some(
           (node) => node.textContent?.includes(${JSON.stringify(title)})
         )`
      ),
    `no tab for the pane the runtime opened (${title})`
  )

  await checkPaneLinks(ask, call, terminal.result.id)

  // The menu bar's New terminal, chosen the way the platform chooses it, opens
  // a second pane in this worktree. `checkMenuBar` above proved a menu item
  // reaches the window; this proves one that needs a worktree open acts on the
  // right one, which the enablement alone cannot say.
  const menuItem = (label) => {
    const walk = (menu) => (menu?.items ?? []).flatMap((item) => [item, ...(item.submenu ? walk(item.submenu) : [])])
    return walk(Menu.getApplicationMenu()).find((item) => item.label === label)
  }
  // Tabs, not buttons: every tab carries its own close button beside it, so a
  // count of buttons rises by two per pane and a check written against it
  // reported the menu as broken the first time it ran.
  const tabCount = () => ask(`document.querySelectorAll('[role="tab"]').length`)
  const before = await tabCount()
  const newTerminal = menuItem('New terminal')
  if (newTerminal?.enabled !== true) {
    failures.push('New terminal is not live in the menu bar with a worktree open')
  } else {
    newTerminal.click()
    const opened = await waitFor(
      async () => (await tabCount()) === before + 1,
      'choosing New terminal from the menu bar did not open a pane in the open worktree'
    )
    if (!opened) {
      // Whatever the window said about it, so the failure names a cause.
      const said = await ask(
        `[...document.querySelectorAll('.notice, [role="status"], [role="alert"]')].map((n) => n.textContent).join(' | ')`
      )
      if (said) failures.push(`the window said: ${said}`)
    }
  }

  // And that the panes' own strip carries the same command, which is the gap
  // this function exists for. Splitting and opening a pane used to be words in
  // the header above the strip; they are icons at the end of it now, and an
  // icon that calls nothing looks exactly like one that works. Pressed by its
  // accessible name, because an icon has no text to match on.
  const pressLabel = (label) =>
    ask(
      `(() => {
         const found = [...document.querySelectorAll('button')].find(
           (button) => button.getAttribute('aria-label') === ${JSON.stringify(label)}
         )
         if (!found || found.disabled) return false
         found.click()
         return true
       })()`
    )

  const beforeStrip = await tabCount()
  if (!(await pressLabel('New terminal'))) {
    failures.push('the pane strip has no New terminal control, so no pointer can open a pane')
    return
  }
  await waitFor(
    async () => (await tabCount()) > beforeStrip,
    'pressing New terminal on the pane strip did not open a pane'
  )

  await checkPatch(ask, worktreeId)

  // No row between the strip and the panes. The worktree's name is in the
  // sidebar's selected row and in the status bar, the way to its directory is
  // in the row's menu, and its counts are the status bar's — so a header that
  // came back would be a fourth copy of things said three times already.
  const head = await ask(`document.querySelector('.workspace__head') !== null`)
  if (head === true) failures.push('a worktree header row is drawn between the pane strip and the panes')

  // And the decision that a quiet shell closes on one press. A pane running an
  // agent, or one still producing output, is asked about first — that is
  // deliberate, and so is this: a question on every close is one people learn
  // to press through. A fresh shell is the ordinary case and must not ask.
  const closed = await ask(
    `(() => {
       const button = document.querySelector('.pane__close')
       if (!button) return false
       button.click()
       return true
     })()`
  )
  if (closed !== true) {
    failures.push('the pane had no close control')
    return
  }
  await waitFor(
    () => ask('document.querySelector(\'[role="dialog"]\') === null'),
    'closing a quiet shell put a question on the screen, which it is not supposed to'
  )

  await checkUnreadPanes(ask, call, worktreeId)
}

/**
 * That a pane which printed while somebody was looking at another one says so.
 *
 * The one behaviour in this window whose two halves are both real: when a pty
 * last spoke, which only a running runtime knows, and when its pane was last in
 * front of this person, which only a rendered window does. A unit test can say
 * that a class is drawn from a set; nothing short of a launch can say that
 * output arriving in one pane while the focus is in another ends as a mark on
 * the right row.
 *
 * Last in this function, and after the close above rather than before it: a
 * pane is busy for four seconds after it prints, and a busy pane is one the
 * window is right to ask about before closing — so printing into one earlier
 * would have this check break the one below it.
 */
async function checkUnreadPanes(ask, call, worktreeId) {
  // Every pane is read first, by pressing each tab in turn: focusing a pane
  // writes down both the one taken and the one left behind. So whatever is
  // marked afterwards is what this check caused, rather than a prompt that
  // happened to print while the panes were being opened.
  const strip = await ask(`document.querySelectorAll('[role="tab"]').length`)
  for (let index = 0; index < strip; index += 1) {
    await ask(
      `(() => {
         const tabs = [...document.querySelectorAll('[role="tab"]')]
         tabs[${index}]?.click()
         return true
       })()`
    )
  }

  // Which pane the last of those presses landed on, read twice so a `layout.set`
  // still in flight cannot be mistaken for the answer.
  let focusedPaneId = null
  const settled = await waitFor(async () => {
    const read = await call('layout.get', { worktreeId })
    if (read.ok !== true || read.result.focusedTerminalId === null) return false
    const same = read.result.focusedTerminalId === focusedPaneId
    focusedPaneId = read.result.focusedTerminalId
    return same
  }, 'the window never settled on a focused pane, so nothing could be left unread')
  if (!settled) return

  const panes = await call('terminal.list', { worktreeId })
  const quiet = panes.ok === true ? panes.result.find((pane) => pane.id !== focusedPaneId) : undefined
  if (quiet === undefined) {
    failures.push('there was no second pane to print into, so the unread mark could not be checked')
    return
  }

  const wrote = await call('terminal.write', { terminalId: quiet.id, data: 'echo teamree-unread\n' })
  if (wrote.ok !== true) {
    failures.push(`could not print into a pane: ${JSON.stringify(wrote.error ?? wrote)}`)
    return
  }

  // Both surfaces in one wait rather than two, because the budget this whole
  // gate runs on is thirty seconds and a wait that never comes true spends
  // fifteen of them.
  const marked = await waitFor(
    () =>
      ask(
        `(() => {
           const tabs = [...document.querySelectorAll('[role="tab"]')]
           const unread = tabs.filter((tab) => tab.closest('.tab')?.classList.contains('tab--unread'))
           const selected = tabs.find((tab) => tab.getAttribute('aria-selected') === 'true')
           // Exactly one, and never the pane being looked at: a mark on the
           // focused tab would be the window telling somebody they have not
           // read what is on their screen.
           return (
             unread.length === 1 &&
             !selected?.closest('.tab')?.classList.contains('tab--unread') &&
             document.querySelector('.pane-row--unread') !== null
           )
         })()`
      ),
    'a pane that printed while another was focused was not marked unread on the strip and in the sidebar'
  )
  if (!marked) {
    // What the window actually had, so the failure names a cause rather than a
    // selector.
    const said = await ask(
      `JSON.stringify({
         tabs: [...document.querySelectorAll('[role="tab"]')].map((tab) => ({
           name: tab.textContent?.trim(),
           selected: tab.getAttribute('aria-selected'),
           unread: Boolean(tab.closest('.tab')?.classList.contains('tab--unread'))
         })),
         sidebarRows: document.querySelectorAll('.pane-row--unread').length
       })`
    )
    failures.push(`the window said: ${said}`)
  }
}

/**
 * That a patch on screen is something a person can read a line number off.
 *
 * The changes panel is the surface this app exists for the moment an agent says
 * it is done, and until now the only thing observed about it was that the
 * button opening it was there. What a unit test cannot say about it is whether
 * a real patch — produced by real git, over a file a real command changed —
 * comes out of the runtime, through the bridge, and onto the screen as hunks
 * with numbers beside them. Every part of that is a seam between two halves
 * that each have their own passing tests.
 *
 * The worktree is dirtied through the shipped CLI rather than by writing a file
 * from here, and that is the point rather than a flourish: `teamree terminal
 * run` is the command an agent is given, it goes in over the same socket a
 * teammate's would, and the file it changes is changed by a process in the
 * worktree. Writing the file from this process would prove the panel can render
 * a diff of something this process did, which is not the situation.
 */
async function checkPatch(ask, worktreeId) {
  const changed = await runCli([
    'terminal',
    'run',
    '--worktree',
    worktreeId,
    // One line changed and one added, so the patch has context on both sides of
    // them — which is the only arrangement where the two gutters disagree, and
    // so the only one where their numbers mean anything. Written as four
    // `echo`s rather than one `printf` because a `\n` would have to survive
    // this file, a JSON frame, and a shell, and it only has to be four lines.
    '--command',
    "{ echo 'const one = 1'; echo 'const two = TWO'; echo 'const three = 3'; echo 'const four = 4'; } > note.ts"
  ])
  if (!changed.ok) {
    failures.push(`could not change a file in the worktree through the CLI: ${changed.said.trim()}`)
    return
  }

  // Opened by its own control, the way the window-level surfaces above are, and
  // by the name rather than the class: the count is part of the name, so the
  // match is on the start of it.
  const pressed = await waitFor(
    () =>
      ask(
        `(() => {
           const found = document.querySelector('button[aria-label^="Changes"]')
           if (!found || found.getAttribute('aria-pressed') === 'true') return found !== null
           found.click()
           return true
         })()`
      ),
    'the worktree header offers no way to open the changes panel'
  )
  if (!pressed) return

  // The panel lists what changed; pressing a row is what asks for its patch.
  const selected = await waitFor(
    () =>
      ask(
        `(() => {
           const row = [...document.querySelectorAll('.changes__list .change')].find(
             (node) => node.textContent?.includes('note.ts')
           )
           if (!row) return false
           if (!row.classList.contains('change--selected')) row.click()
           return true
         })()`
      ),
    'the changed file never appeared in the changes panel'
  )
  if (!selected) return

  // The two things the panel could not say before: which hunk this is, and
  // which line. A patch with no `@@` separator and no gutter is the monospace
  // block this replaced, and it would satisfy any check written against the
  // text of the diff.
  await waitFor(
    () => ask(`document.querySelector('.patch__hunkHead')?.textContent?.startsWith('@@') === true`),
    'the patch on screen has no hunk header to say where in the file it is'
  )
  await waitFor(
    () => ask(`[...document.querySelectorAll('.patch__num')].some((cell) => /^\\d+$/.test(cell.textContent ?? ''))`),
    'the patch on screen has no line number in its gutter'
  )

  // And that the whole of it — the gutters, the hunk header, the syntax colour,
  // the two words above it — is legible. This surface paints more colours than
  // any other in the window, and every one of them is a palette token used on a
  // ground it was not designed for until this says otherwise.
  await checkContrast(ask, 'the patch')

  await checkFilesTab(ask)
}

/**
 * That the files tab lists the checkout the runtime made, with the letter the
 * changes tab printed a moment ago beside the file the CLI changed — `M`,
 * because the fixture commits `note.ts` before the CLI edits it.
 *
 * The tree is read one directory per call through `worktree.files`, which is
 * the seam this proves: a real directory, listed by the runtime, drawn by the
 * window — and git's verdict on the file, read off the same list the patch
 * came from, on the same row.
 */
async function checkFilesTab(ask) {
  const pressed = await ask(
    `(() => {
       const tab = document.querySelector('[role="tab"][aria-label^="Files"]')
       if (!tab) return false
       tab.click()
       return true
     })()`
  )
  if (pressed !== true) {
    failures.push('the right panel offers no Files tab')
    return
  }

  await waitFor(
    () =>
      ask(
        `[...document.querySelectorAll('[role="tree"] .tree__row')].some(
           (row) => row.textContent?.startsWith('note.ts') && row.querySelector('.tree__status')?.textContent === 'M'
         )`
      ),
    'the files tab never listed note.ts with the modified mark beside it'
  )

  // Back to the changes tab, which is where the checks after this one expect
  // the panel to be.
  await ask(`document.querySelector('[role="tab"][aria-label^="Changes"]')?.click()`)
}

/**
 * Runs the built CLI against this launch's runtime, and comes back with what it
 * said.
 *
 * `ELECTRON_RUN_AS_NODE` because `process.execPath` here is Electron, and
 * `TEAMREE_RUNTIME_FILE` because the CLI would otherwise look in the real user
 * data directory — which is the developer's, and whose app is not this one.
 *
 * Spawned rather than `spawnSync`: the runtime the CLI is dialling is *this*
 * process, so blocking this event loop until the CLI returns is a wait for an
 * answer that cannot be written.
 */
function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(root, 'out/cli/index.js'), ...args], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        TEAMREE_RUNTIME_FILE: join(userDataDir, 'runtime.json')
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let said = ''
    child.stdout.on('data', (chunk) => {
      said += chunk
    })
    child.stderr.on('data', (chunk) => {
      said += chunk
    })
    child.on('error', (error) => resolve({ ok: false, said: error.message }))
    child.on('close', (code) => resolve({ ok: code === 0, said }))
  })
}

/**
 * That a URL an agent printed is a link, in a window that was really built.
 *
 * The unit tests state that the addon offers a link and that activating one
 * ends in `window.open`. Neither says the pane loaded the addon: a `loadAddon`
 * deleted from `TerminalView` takes nothing red with it, because every one of
 * those tests builds its own emulator. That is the gap this closes, and it can
 * only be closed here — the thing to observe is a decoration on an emulator
 * that a real pane created.
 *
 * Observed through the cursor, which is the one piece of xterm's link handling
 * that reaches the DOM whatever is drawing the cells: a link under the pointer
 * puts `xterm-cursor-pointer` on the screen element and takes it off again on
 * the way out. The underline is drawn by the renderer — into a canvas under
 * WebGL — and is not a thing a selector can find.
 *
 * So the pointer is swept along the row the URL landed on. Coarsely, in steps
 * of a few pixels, because the cell width is a function of the font this
 * machine resolved and guessing it would be a check that passes on the machine
 * it was written on. A sweep that finds nothing is retried by `waitFor`, which
 * is also what gives the shell time to print.
 */
async function checkPaneLinks(ask, call, terminalId) {
  const url = 'https://example.com/x'
  // Printed rather than typed as a bare word, so the pane is not left with a
  // command in its history that somebody's shell might later try to run.
  const printed = await call('terminal.write', { terminalId, data: `printf '%s\\n' ${url}\r` })
  if (printed.ok !== true) {
    failures.push(`could not print a URL into the pane: ${JSON.stringify(printed.error ?? printed)}`)
    return
  }

  const hovered = await waitFor(
    () =>
      ask(
        `(() => {
           const screen = document.querySelector('.terminal-surface .xterm-screen')
           if (!screen) return false
           const box = screen.getBoundingClientRect()
           if (box.width === 0 || box.height === 0) return false
           const at = (x, y) => {
             for (const type of ['mousemove', 'mouseover']) {
               screen.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true }))
             }
           }
           for (let y = box.top + 2; y < box.bottom; y += 4) {
             for (let x = box.left + 2; x < box.right; x += 4) {
               at(x, y)
               if (screen.classList.contains('xterm-cursor-pointer')) return true
             }
           }
           return false
         })()`
      ),
    `no cell in the pane offered a link after it printed ${url}`
  )
  if (hovered) console.log('smoke: a URL printed in a pane is a link')
}

/**
 * What the window does with bytes it did not write.
 *
 * Every line of `docs/renderer-boundary.md` rests on four settings and one
 * refusal, and none of them can be read off the source with any confidence: a
 * `webPreferences` is a request, what the window ended up with is a fact, and
 * the two are only the same until somebody adds a second window or a default
 * changes under the app. So they are read back off the running window.
 *
 * Two of the three settings turn out to pin themselves, which was worth finding
 * out rather than assuming. Turning the sandbox on breaks the preload outright —
 * it is an ES module and a sandboxed preload is a classic script — and turning
 * `contextIsolation` off makes `contextBridge` refuse to run at all; this
 * harness already fails on a preload that will not load, so neither can be done
 * quietly. `nodeIntegration` is the one that can: with context isolation still
 * on, turning it on injects nothing the page can see, the bridge is still there,
 * the runtime still answers, and every check below this one but the first would
 * pass. That is the setting this reads back.
 *
 * The navigation check is the one that found something. A navigated-to document
 * keeps this window's preload — which is the whole runtime, the same catalogue
 * `docs/local-access.md` describes — and brings no policy of its own, because
 * the app's is a `<meta>` tag in the app's own HTML. That was watched happening
 * before `will-navigate` existed: the window went to a file written seconds
 * earlier and `window.teamree.runtime.call('status.get')` answered from it.
 */
async function checkRendererBoundary(window, ask) {
  const prefs = window.webContents.getLastWebPreferences() ?? {}
  const expected = { contextIsolation: true, nodeIntegration: false, sandbox: false }
  for (const [setting, want] of Object.entries(expected)) {
    if (prefs[setting] !== want) failures.push(`webPreferences.${setting} is ${prefs[setting]}, expected ${want}`)
  }

  // The consequence of the two above, rather than a restatement of them: with
  // context isolation on and node integration off there is no Node in the page
  // at all, which is what makes the bridge the only way out of it.
  const nodeInThePage = JSON.parse(
    await ask('JSON.stringify([typeof require, typeof process, typeof module, typeof Buffer])')
  )
  if (nodeInThePage.some((seen) => seen !== 'undefined')) {
    failures.push(`the renderer can see Node: require/process/module/Buffer are ${nodeInThePage.join(', ')}`)
  }

  // The policy in index.html, enforced rather than merely present. `script-src`
  // is not set there, so this is `default-src 'self'` doing the work — which is
  // the half of a meta policy worth checking, because a meta policy is also the
  // half that a navigation leaves behind.
  provoking = true
  const refusal = await ask(
    'new Promise((resolve) => {' +
      'document.addEventListener("securitypolicyviolation", (event) => resolve(event.effectiveDirective), { once: true });' +
      'const script = document.createElement("script");' +
      'script.textContent = "window.__smokeInlineRan = true";' +
      'document.head.appendChild(script);' +
      'setTimeout(() => resolve("the inline script was not refused"), 1000)' +
      '})'
  )
  const inlineRan = await ask('Boolean(window.__smokeInlineRan)')
  provoking = false
  if (refusal !== 'script-src-elem') failures.push(`an inline script in the renderer was answered with ${refusal}`)
  if (inlineRan) failures.push('an inline script ran in the renderer, so the content security policy is not enforced')

  // And the refusal the document is mostly about. A page that could navigate
  // could replace itself with anything and keep the bridge.
  const onTheApp = window.webContents.getURL()
  const elsewhere = pathToFileURL(join(root, 'package.json')).href
  await ask(`(() => { location.href = ${JSON.stringify(elsewhere)}; return "asked" })()`)
  await new Promise((resolve) => setTimeout(resolve, 1_000))
  const landed = window.webContents.getURL()
  if (landed !== onTheApp) failures.push(`the renderer navigated the window to ${landed}`)
  if (failures.length === 0) {
    console.log('smoke: renderer has no Node, refuses an inline script, and cannot navigate the window')
  }
}

/**
 * Who on this machine can drive the runtime this launch started.
 *
 * The CLI socket serves the whole catalogue — create and remove worktrees,
 * spawn terminals, read any pane and type into it — so what stands in front of
 * it is two permissions and nothing else, and both of them are only ever real
 * in a running app. `docs/local-access.md` is the argument; this is the place
 * where it is checked against a Mac rather than against a unit test's tmpdir.
 *
 * The directory is the half this project does not set. Electron creates the
 * user data directory 0700 and every unit test that could assert it has a
 * `mkdtemp` directory, which is 0700 whatever anybody intended — so this is the
 * only check in the repository where a failure would mean something. If it ever
 * goes red, the enclosing directory is being made by something other than
 * Electron (every `mkdir` in this repository would leave 0755) and the local
 * model is wrong rather than merely undocumented.
 */
function checkLocalBoundary() {
  const mode = (path) => statSync(path).mode & 0o777
  const octal = (value) => `0${value.toString(8).padStart(3, '0')}`

  const dirMode = mode(userDataDir)
  if (dirMode !== 0o700) failures.push(`user data directory is ${octal(dirMode)}, expected 0700`)

  const discoveryPath = join(userDataDir, 'runtime.json')
  if (!existsSync(discoveryPath)) {
    failures.push('the runtime wrote no runtime.json, so the CLI has no way to find it')
    return
  }
  // Followed rather than assumed: `resolveEndpoint` puts the socket beside this
  // file, but falls back to a shared directory when the path would not fit in
  // sun_path, and the point of the mode below is that case.
  const { endpoint } = JSON.parse(readFileSync(discoveryPath, 'utf8'))
  if (!existsSync(endpoint)) {
    failures.push(`runtime.json names ${endpoint}, which does not exist`)
    return
  }
  const endpointMode = mode(endpoint)
  // ENDPOINT_MODE in src/main/runtime/socketServer.ts, spelled out because this
  // file is plain JavaScript in an Electron main process and imports no TypeScript.
  if (endpointMode !== 0o600) failures.push(`CLI socket is ${octal(endpointMode)}, expected 0600`)
  if (failures.length === 0) {
    console.log(`smoke: user data directory ${octal(dirMode)}, CLI socket ${octal(endpointMode)}`)
  }
}

/**
 * The peer library, in this process. `run-smoke.mjs` compiled it and named the
 * directory on the command line; without one, say so rather than quietly
 * checking nothing, because a check that can skip itself is how the cipher
 * defect survived 1803 passing tests.
 */
async function checkPeerCrypto() {
  const bundle = readNamedArg(PEER_BUNDLE_FLAG)
  if (!bundle) {
    failures.push('no peer bundle was passed; run this through scripts/run-smoke.mjs')
    return
  }
  const result = await runPeerCheck(bundle)
  for (const failure of result.failures) failures.push(`peer crypto: ${failure}`)
  if (result.nativeChaCha) {
    // Not a failure — but it means this run proved less than it looks like it
    // did, and the reader should know which runtime actually answered.
    console.log(`smoke: note — ${result.runtime} has a native chacha20-poly1305, which Electron 38 did not`)
  }
  if (result.failures.length === 0) {
    console.log(`smoke: peer handshake and published Noise vectors pass under ${result.runtime}`)
  }
}

app
  .whenReady()
  .then(run)
  .catch((error) => {
    failures.push(String(error))
  })
  .finally(finish)
