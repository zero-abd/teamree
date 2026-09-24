// Boots the built app hidden, asserts the renderer mounted, the preload bridge
// is reachable and the runtime answers, then exits; a `npm run release` gate.
// Boots the real `out/main/index.js`: a window of its own had no IPC bridge
// behind it and passed anyway. Callbacks, not top-level await — Electron does
// not pump its event loop until this module finishes evaluating.
import { app, Menu, systemPreferences } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { withoutSystemCa } from './child-env.mjs'
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

// Both settled before the app's module body runs, hence the deferred import.
// Refusing without a directory is the safeguard: the runtime restores the last
// session's panes, so a run on a developer's workspace would spawn their agents.
const userDataDir = readNamedArg(USER_DATA_FLAG)
if (!userDataDir) {
  console.error('smoke: no user data directory was passed; run this through scripts/run-smoke.mjs')
  process.exit(1)
}
// Via the variable, not `app.setPath`, so the gate runs the app's own override.
process.env.TEAMREE_USER_DATA_DIR = userDataDir
// A gate must not take focus from whoever runs it; set here rather than by the
// launcher so it holds however this script was started.
process.env.TEAMREE_BACKGROUND_LAUNCH = '1'

// Without this, closing the hidden window would quit before assertions finish.
app.on('window-all-closed', () => {})

// Attached at construction: the renderer loads in the same breath as the window
// is created, and a later listener would miss the first load.
// `provoking` is on only while `checkRendererBoundary` provokes the CSP: Chromium
// reports a refused script as a console error, and there the refusal is wanted.
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
    // `process.exitCode` alone does not survive `app.quit()`: `Browser::Quit`
    // exits zero unless told otherwise, so every failure used to print and pass.
    // `will-quit` is the safe moment: the runtime is stopped and every pty dead.
    app.once('will-quit', () => process.exit(1))
  } else {
    console.log('smoke: renderer mounted, preload bridge reachable, runtime answering')
    process.exitCode = 0
  }
  // `quit`, never `exit`: `app.exit()` tears Node down while ptys are alive, and
  // node-pty's per-pty exit thread (`SetupExitCallback`, src/unix/pty.cc) then
  // calls into a closing environment — an uncaught Napi::Error, SIGABRT after
  // the success line. `quit` runs `before-quit`, which stops the runtime and
  // awaits every pty exit (`terminals.shutdown()`), and honours `process.exitCode`.
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
  // After `whenReady`, so the two settings above are made before the app reads them.
  await import(pathToFileURL(join(root, 'out/main/index.js')).href)
  // Unset reads as '', registered false as '0'. See src/main/stateRestoration.ts.
  if (process.platform === 'darwin' && systemPreferences.getUserDefault('ApplePersistence', 'string') !== '0') {
    failures.push("AppKit's window restoration is still on")
  }

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
  // A call over the bridge the product uses, answered by the runtime this launch started.
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
 * That the surfaces which take the main area can be reached. Settings and Help
 * both shipped absent from the rail and the palette with green unit tests, so
 * this presses the button and waits for the heading — deliberately no more.
 */
async function checkWindowSurfaces(ask) {
  // By the words on them: a selector that outlived a relabelled button is worse than none.
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
 * Text nobody can read, measured. The palette's legibility pass cannot see a
 * pairing — a legible token used on a ground it was not designed for — so this
 * composites each text node on its first opaque ancestor and checks WCAG AA
 * (4.5:1, or 3:1 for large text).
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
 * Records anything unreadable on screen now. The local is not called `failures`:
 * that shadowed the module-level list once and the check could not fail.
 */
async function checkContrast(ask, surface) {
  const unreadable = JSON.parse(await ask(MEASURE_CONTRAST))
  // Named, not counted: a name says which sentence to go and look at.
  for (const one of unreadable.slice(0, 6)) failures.push(`unreadable on ${surface}: ${one}`)
  if (unreadable.length > 6) failures.push(`and ${unreadable.length - 6} more unreadable on ${surface}`)
}

/**
 * That the menu bar carries this app's commands and choosing one reaches the
 * window. Assembled across the process boundary, so both halves were green
 * while the window published to a channel nothing served. Read off
 * `Menu.getApplicationMenu()` — what the platform shows, not a template.
 */
async function checkMenuBar(ask) {
  const named = (label) => {
    const walk = (menu) => (menu?.items ?? []).flatMap((item) => [item, ...(item.submenu ? walk(item.submenu) : [])])
    return walk(Menu.getApplicationMenu()).find((item) => item.label === label)
  }

  // Waited for: the window publishes its menus on mount.
  const arrived = await waitFor(
    async () => named('New Task') !== undefined,
    'the window\u2019s commands never reached the menu bar'
  )
  if (!arrived) return

  for (const [label, accelerator] of [
    ['New Task', 'CommandOrControl+N'],
    ['Close Pane', 'CommandOrControl+W'],
    // \u2318, opens the settings page, not the theme editor (own item under View, no chord).
    ['Settings\u2026', 'CommandOrControl+,'],
    ['All Panes', 'CommandOrControl+E'],
    // Named for what choosing it does: the panel starts closed.
    ['Show Right Panel', 'CommandOrControl+J'],
    // Chords that are not characters: arrows and Return are spelled for
    // Electron's parser, and a name it rejects draws no chord or breaks the menu.
    ['Previous Worktree', 'CommandOrControl+Alt+Up'],
    ['Next Worktree', 'CommandOrControl+Alt+Down'],
    ['Focus Previous Pane', 'CommandOrControl+['],
    ['Maximize Pane', 'CommandOrControl+Shift+Enter'],
    // Under the `help` role: proves Electron built the submenu onto the role item.
    ['Shortcuts', 'CommandOrControl+/']
  ]) {
    const item = named(label)
    if (!item) {
      failures.push(`the menu bar has no ${label} item`)
      continue
    }
    // The chord beside the item is the one that fires.
    if (item.accelerator !== accelerator) {
      failures.push(`the menu bar shows ${item.accelerator} for ${label}, not ${accelerator}`)
    }
  }

  // `&File` is consumed on Windows and Linux; macOS draws the ampersand, and
  // the submenu walk above never looks at the top row.
  for (const item of process.platform === 'darwin' ? (Menu.getApplicationMenu()?.items ?? []) : []) {
    if ((item.label ?? '').includes('&')) {
      failures.push(`the menu bar draws ${item.label} with a mnemonic marker macOS does not use`)
    }
  }

  // First launch: no pane, so pane commands are grey and window-level ones are not.
  if (named('Close Pane')?.enabled !== false) {
    failures.push('Close Pane is live in a window with no pane in it')
  }
  if (named('All Panes')?.enabled !== true) {
    failures.push('the menu bar greys a command that needs nothing to be open')
  }

  // An item with no accelerator is one Electron could drop: `appMenu.ts` has to
  // hand it `undefined` rather than an empty string.
  const appearance = named('Appearance\u2026')
  if (!appearance) {
    failures.push('the menu bar has no Appearance\u2026 item, so \u2318, is the only way to the theme editor')
  } else if (appearance.accelerator) {
    failures.push(`the menu bar shows ${appearance.accelerator} for Appearance\u2026, which nothing binds`)
  }

  // Grey on a first launch: no worktree, nothing to send.
  for (const label of ['Commit\u2026', 'Push']) {
    const item = named(label)
    if (!item) failures.push(`the menu bar has no ${label} item`)
    else if (item.enabled !== false) failures.push(`${label} is live in a window with no worktree in it`)
  }

  // `click()` on the item is what the platform does: main to window to dispatcher to view.
  const showsDashboard = () =>
    ask('[...document.querySelectorAll("h1")].some((node) => node.textContent?.trim() === "All Panes")')

  named('All Panes')?.click()
  const reached = await waitFor(showsDashboard, 'choosing a menu item did not reach the window')

  // Toggled back so the checks below find the window as expected.
  if (reached) {
    named('All Panes')?.click()
    await waitFor(async () => !(await showsDashboard()), 'choosing the same menu item again did not put the view away')
  }
}

/**
 * The surfaces that only exist with a worktree open, driven through
 * `window.teamree.runtime.call` — the product's bridge, not the store — since
 * whether a pane the runtime made appears as a tab is a seam no unit test sees.
 * Skipped loudly when the launcher could not build a repository.
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

  // The record says `creating` until the checkout exists; a terminal opened
  // before then is a race this check would report as a broken window.
  const ready = await waitFor(async () => {
    const read = await call('worktree.get', { worktreeId })
    return read.ok === true && read.result.state === 'ready'
  }, 'the worktree never became ready, so nothing below it could be checked')
  if (!ready) return

  // Pressed in the sidebar, and only once it can be: the row is disabled while
  // the checkout is being made, and a click on a disabled button succeeds at
  // nothing. The runtime saying `ready` is not the window having heard it.
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

  // Opening a worktree must release Help, which the previous check left on screen.
  await waitFor(
    () =>
      ask(
        `document.querySelector('.workspace') !== null && document.querySelector('main[aria-label="Help"]') === null`
      ),
    'pressing the worktree did not give the main area back to the workspace'
  )

  // The row's menu, opened by a real contextmenu event: the handler is on the
  // `<li>` and every control inside is a button, so a menu wired one element
  // off is invisible to a test that renders the component and asks nicely.
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
    // Last: the destructive item is where nobody arrives by momentum.
    if (items.at(-1) !== 'Remove Worktree…')
      failures.push(`the row menu does not end with Remove Worktree…: ${JSON.stringify(items)}`)
    if (items[0] !== 'Rename…') failures.push(`the row menu does not start with Rename…: ${JSON.stringify(items)}`)
    if (items.length !== 6) failures.push(`the row menu has ${items.length} items rather than six`)
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

  // Matched on the pane's title, not a count: a strip showing another
  // worktree's panes would satisfy a count.
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

  // A menu item that needs a worktree open acts on the right one; enablement
  // alone cannot say so.
  const menuItem = (label) => {
    const walk = (menu) => (menu?.items ?? []).flatMap((item) => [item, ...(item.submenu ? walk(item.submenu) : [])])
    return walk(Menu.getApplicationMenu()).find((item) => item.label === label)
  }
  // Tabs, not buttons: every tab has its own close button, so a button count
  // rises by two per pane.
  const tabCount = () => ask(`document.querySelectorAll('[role="tab"]').length`)
  const before = await tabCount()
  const newTerminal = menuItem('New Terminal')
  if (newTerminal?.enabled !== true) {
    failures.push('New Terminal is not live in the menu bar with a worktree open')
  } else {
    newTerminal.click()
    const opened = await waitFor(
      async () => (await tabCount()) === before + 1,
      'choosing New Terminal from the menu bar did not open a pane in the open worktree'
    )
    if (!opened) {
      // Whatever the window said about it, so the failure names a cause.
      const said = await ask(
        `[...document.querySelectorAll('.notice, [role="status"], [role="alert"]')].map((n) => n.textContent).join(' | ')`
      )
      if (said) failures.push(`the window said: ${said}`)
    }
  }

  // The strip carries the same command as an icon, and an icon that calls
  // nothing looks like one that works. Pressed by accessible name.
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

  // The `+` opens a menu rather than a pane: a terminal first, then one row
  // per agent the runtime found on this machine — whatever `agent.list` says,
  // so the check reads the same list, by the kind on each row's glyph — then
  // the way to the agent settings.
  const beforeStrip = await tabCount()
  if (!(await pressLabel('New pane'))) {
    failures.push('the pane strip has no New pane control, so no pointer can open a pane')
    return
  }
  const menuRows = () =>
    ask(
      `[...document.querySelectorAll('[role="menu"] [role="menuitem"]')].map(
         (item) => item.querySelector('[data-agent]')?.dataset.agent ?? item.querySelector('.row-menu__label')?.textContent
       )`
    )
  await waitFor(async () => ((await menuRows()) ?? []).length > 0, 'pressing + on the pane strip opened no menu')
  const agents = (await call('agent.list', {})).result ?? []
  const expectedRows = ['New Terminal', 'New Markdown', ...agents.map((agent) => agent.kind), 'Agent Settings…']
  const rows = await menuRows()
  if (JSON.stringify(rows) !== JSON.stringify(expectedRows)) {
    failures.push(`the + menu lists ${JSON.stringify(rows)}, not ${JSON.stringify(expectedRows)}`)
  }
  const chose = await ask(
    `(() => {
       const row = [...document.querySelectorAll('[role="menuitem"]')].find(
         (item) => item.querySelector('.row-menu__label')?.textContent === 'New Terminal'
       )
       if (!row) return false
       row.click()
       return true
     })()`
  )
  if (chose !== true) {
    failures.push('the + menu has no New terminal row')
    return
  }
  await waitFor(
    async () => (await tabCount()) > beforeStrip,
    'choosing New terminal from the + menu did not open a pane'
  )

  await checkPatch(ask, worktreeId)

  // No header row: the name, path and counts are already in the sidebar row,
  // its menu and the status bar.
  const head = await ask(`document.querySelector('.workspace__head') !== null`)
  if (head === true) failures.push('a worktree header row is drawn between the pane strip and the panes')

  // A quiet fresh shell closes on one press; only a busy pane or an agent is
  // asked about, because a question on every close is one people press through.
  const closed = await ask(
    `(() => {
       // The diff above is zoomed, so the file column may be all there is; its tab holds its close.
       const button = document.querySelector('.pane__close, .column__close')
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
 * That a pane which printed while another was focused says so. Both halves are
 * real here: when the pty last spoke and when its pane was last in front.
 * After the close above, not before: a pane is busy for four seconds after it
 * prints, and a busy pane is asked about before closing.
 */
async function checkUnreadPanes(ask, call, worktreeId) {
  // Every tab pressed first, so whatever is marked afterwards is what this
  // check caused rather than a prompt that printed while panes were opening.
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

  // Read twice so a `layout.set` still in flight is not mistaken for the answer.
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

  // One wait for both surfaces: the gate has thirty seconds and a failed wait
  // spends fifteen.
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
    // So the failure names a cause rather than a selector.
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
 * That a patch on screen carries hunk headers and line numbers. The worktree is
 * dirtied through the shipped CLI, over the same socket a teammate's would use,
 * so the diff is of something a process in the worktree did — not this one.
 */
async function checkPatch(ask, worktreeId) {
  const changed = await runCli([
    'terminal',
    'run',
    '--worktree',
    worktreeId,
    // One line changed and one added, so the two gutters disagree. Four `echo`s
    // because a `\n` would have to survive this file, a JSON frame and a shell.
    '--command',
    "{ echo 'const one = 1'; echo 'const two = TWO'; echo 'const three = 3'; echo 'const four = 4'; } > note.ts"
  ])
  if (!changed.ok) {
    failures.push(`could not change a file in the worktree through the CLI: ${changed.said.trim()}`)
    return
  }

  // By name, not class; the count is part of the name, so the match is on its start.
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

  // A patch with no `@@` and no gutter would satisfy any check on the diff's text; the header reads its
  // place and keeps git's own line as its hover.
  await waitFor(
    () =>
      ask(
        `(() => {
           const at = document.querySelector('.patch__hunkHead .patch__hunkAt')
           return (at?.textContent ?? '') !== '' && at?.getAttribute('title')?.startsWith('@@') === true
         })()`
      ),
    'the patch on screen has no hunk header to say where in the file it is'
  )
  await waitFor(
    () => ask(`[...document.querySelectorAll('.patch__num')].some((cell) => /^\\d+$/.test(cell.textContent ?? ''))`),
    'the patch on screen has no line number in its gutter'
  )

  // This surface paints more palette tokens on foreign grounds than any other.
  await checkContrast(ask, 'the patch')

  await checkFilesTab(ask)
}

/**
 * That the files tab lists the checkout with `M` beside `note.ts` — the fixture
 * commits it before the CLI edits it. One directory per `worktree.files` call.
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

  // Back to the changes tab, where the checks after this expect the panel.
  await ask(`document.querySelector('[role="tab"][aria-label^="Changes"]')?.click()`)
}

/**
 * Runs the built CLI against this launch's runtime, found through the inherited
 * `TEAMREE_USER_DATA_DIR`. `ELECTRON_RUN_AS_NODE` since `process.execPath` is
 * Electron. Spawned, not `spawnSync`: the runtime it dials is this process.
 */
function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(root, 'out/cli/index.js'), ...args], {
      env: { ...withoutSystemCa(process.env), ELECTRON_RUN_AS_NODE: '1' },
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
 * That a URL an agent printed is a link on an emulator a real pane created — no
 * unit test proves `TerminalView` loaded the addon. Observed through the cursor:
 * a link under the pointer puts `xterm-cursor-pointer` on the screen element,
 * while the underline is on a WebGL canvas. Swept in pixel steps because the
 * cell width depends on the font this machine resolved.
 */
async function checkPaneLinks(ask, call, terminalId) {
  const url = 'https://example.com/x'
  // Printed, not typed bare, so nobody's shell later runs it from history.
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
 * What the window does with bytes it did not write: `docs/renderer-boundary.md`
 * read back off the running window, since `webPreferences` is a request. The
 * sandbox and `contextIsolation` pin themselves (the preload is an ES module,
 * `contextBridge` refuses); `nodeIntegration` can turn on quietly, and a
 * navigated-to document keeps the preload and brings no `<meta>` policy.
 */
async function checkRendererBoundary(window, ask) {
  const prefs = window.webContents.getLastWebPreferences() ?? {}
  const expected = { contextIsolation: true, nodeIntegration: false, sandbox: false }
  for (const [setting, want] of Object.entries(expected)) {
    if (prefs[setting] !== want) failures.push(`webPreferences.${setting} is ${prefs[setting]}, expected ${want}`)
  }

  // No Node in the page is what makes the bridge the only way out of it.
  const nodeInThePage = JSON.parse(
    await ask('JSON.stringify([typeof require, typeof process, typeof module, typeof Buffer])')
  )
  if (nodeInThePage.some((seen) => seen !== 'undefined')) {
    failures.push(`the renderer can see Node: require/process/module/Buffer are ${nodeInThePage.join(', ')}`)
  }

  // `script-src` is not set in index.html, so this is `default-src 'self'` doing
  // the work — the half of a meta policy a navigation leaves behind.
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

  // A page that could navigate could replace itself and keep the bridge.
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
 * Who on this machine can drive the runtime: two permissions, only real in a
 * running app. Electron creates the user data directory 0700 and every unit
 * test's `mkdtemp` is 0700 regardless — so this is the only check where red
 * would mean the local model in `docs/local-access.md` is wrong.
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
  // `resolveEndpoint` falls back to a shared directory when the path would not
  // fit in sun_path, and the mode below is about that case.
  const { endpoint } = JSON.parse(readFileSync(discoveryPath, 'utf8'))
  if (!existsSync(endpoint)) {
    failures.push(`runtime.json names ${endpoint}, which does not exist`)
    return
  }
  const endpointMode = mode(endpoint)
  // ENDPOINT_MODE in src/main/runtime/socketServer.ts; this file imports no TypeScript.
  if (endpointMode !== 0o600) failures.push(`CLI socket is ${octal(endpointMode)}, expected 0600`)
  if (failures.length === 0) {
    console.log(`smoke: user data directory ${octal(dirMode)}, CLI socket ${octal(endpointMode)}`)
  }
}

/**
 * The peer library in a genuine Electron main process, the process type the
 * handshakes happen in. Without a bundle, fail rather than skip: a check that
 * can skip itself is how the cipher defect survived 1803 passing tests.
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
    // Not a failure, but this run proved less than it looks like it did.
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
