# What the window does with bytes it did not write

[`local-access.md`](local-access.md) writes down who on this machine can drive
the runtime. [`teamwork.md`](teamwork.md) writes down what a teammate across a
relay can reach. This is the third of them and it is about the other direction:
not what somebody can call, but what happens to the window when somebody else's
bytes arrive in it.

They are neighbours rather than one document, and the seam between them is a
single sentence. **The preload bridge is the same catalogue the `teamree`
command gets** — `runtime.call(method, params)` with no allow-list in front of
it, which `local-access.md` spells out as create a worktree, remove one, spawn a
pty and type into it. Everything below is about keeping that bridge on the page
it was built for, and keeping the bytes that arrive in that page from becoming
instructions.

There are three streams the window is fed that it did not author:

- **A teammate's pane output**, from somebody else's machine, over a relay,
  written into an emulator.
- **GitHub release notes**, fetched by the update check and shown in a card.
- **Stored scrollback**, read off disk at launch and replayed into a pane.

The third was dealt with when it was built: `scrollbackRecord.ts` reduces a
record to text and colour on the way to disk and again on the way back, against
an allowlist rather than a list of the dangerous sequences. The other two had
not been looked at, and neither had the process boundary around them.

## The window, as it actually is

Four settings, read off a running window rather than off the source — because
`webPreferences` is a request and what the window ended up with is a fact.
`scripts/smoke.mjs` boots the real main process and reads them back through
`getLastWebPreferences()`:

| setting            | value   |                                                                       |
| ------------------ | ------- | --------------------------------------------------------------------- |
| `contextIsolation` | `true`  | the preload runs in its own world; the page cannot reach into it       |
| `nodeIntegration`  | `false` | no Node in the page                                                    |
| `webSecurity`      | `true`  | the default, never turned off here                                     |
| `sandbox`          | `false` | load-bearing, and the only one of the four that is not simply right    |

And the consequence of the first two, which is the part worth asserting because
it is what the rest depends on: in the running renderer `require`, `process`,
`module` and `Buffer` are all `undefined`. The bridge is the only way out of the
page. That is asserted in the smoke run.

Two of the three chosen settings pin themselves, which was worth finding out
rather than assuming. Turning the sandbox on breaks the preload outright (see
below). Turning `contextIsolation` off makes `contextBridge` refuse to run —
"contextBridge API can only be used when contextIsolation is enabled", watched
happening. Both of those fail the smoke run on their own, because it already
fails on a preload that will not load. **`nodeIntegration` is the one that does
not pin itself**: with context isolation still on, turning it on injects nothing
the page can see, the bridge is still there and the runtime still answers. So
that is the one the smoke check is really for.

## Why `sandbox` is off

Not because the preload needs Node. It touches `contextBridge`, `ipcRenderer`,
`process.platform` and `process.versions`, and a sandboxed preload has every one
of them.

It is off because **the preload is an ES module**. `out/preload/index.mjs` is
what electron-vite emits and what `index.ts` points at, and a sandboxed preload
is evaluated as a classic script. Turned on, the window comes up with no bridge
at all:

```
preload-error … Cannot use import statement outside a module
preload bridge is not exposed on window.teamree
```

That is the smoke run with the line flipped, not a quotation from documentation.

**It is not free, and this is the honest cost.** With `sandbox: false` the
renderer process runs outside Chromium's own sandbox. Everything above is about
a renderer that is behaving; this is about one that is not — a defect in the
code that parses somebody else's terminal output, reached through a stream from
another machine, lands with the user's account behind it rather than behind a
second wall. That is the single largest thing about this window that is worse
than it could be.

Turning it on is possible and is a build change rather than a code change: the
preload would have to be emitted as CommonJS, which with `"type": "module"` in
`package.json` means a `.cjs` file and a different `rollupOptions.output.format`
for the preload target only. Nothing in `src/preload/index.ts` would have to
change. It has not been done here because this document is an audit and that is
a packaging change with its own way of going wrong on a Mac — but it is the
thing to do next, and the comment on the line says so.

## What the preload grants

The whole runtime, and the honest answer is the same one `local-access.md` gives
about the CLI socket.

`src/preload/index.ts` exposes exactly one object. `selectProjectFolder` opens a
directory picker. `platform` and `versions` are strings. `runtime` is three
functions: `call(method, params)`, `onStream(listener)` and `release()`. There
is no method allow-list on `call` — the window is one of the three transports
the runtime answers, and unlike the peer link (six methods, `PEER_METHODS`) it
gets all of them. A page that can call it can create a worktree, spawn a
terminal and write bytes into it, which is to say run commands as the user.

That is not a defect. The window is the product; it is what the user is looking
at when they do those things. But it fixes the shape of everything else in this
document: **there is no partial compromise of this renderer.** Anything that can
run script in that page has the machine. Which is why the rest of this is about
making sure nothing ever does.

## The gap that was here: nothing stopped the window navigating

`setWindowOpenHandler` was already in place and denies every `window.open`.
There was no `will-navigate` handler, and `setWindowOpenHandler` never sees a
navigation.

A `webPreferences` belongs to the *web contents*, not to the document in it, so
a navigation does not leave the preload behind — it carries it onto whatever
lands. That was measured rather than reasoned about. The smoke harness wrote an
HTML file to a temporary directory, told the renderer `location.href = …`, and
then asked the page that arrived:

```
DID-NAVIGATE   file:///tmp/drop-NO75mv/dropped.html
BRIDGE-AFTER   {"teamree":"object","keys":["selectProjectFolder","platform","versions","runtime"], …}
RPC-AFTER      ok=true
```

A page nobody wrote, holding the whole runtime. The document that arrives has no
`Content-Security-Policy` either: the app's is a `<meta>` tag in the app's own
HTML and travels nowhere.

**And nothing in today's renderer can start one.** That was checked rather than
hoped: every `<form>` in the tree calls `preventDefault` in its submit handler
(there are five), the only `<a href>` is a constant with `target="_blank"` and
therefore goes through the window-open handler, and xterm's OSC 8 hyperlinks
cannot either — see below. So the handler added here defends against nothing
that can currently be triggered, and saying otherwise would be dressing it up.

It is here anyway, because the cost of the gap is not proportional to how hard
it is to reach. One anchor without a `target`, one form that forgets its
`preventDefault`, one future feature that loads a page — and the failure is not
partial. Three lines against that is worth it; three lines that also had to be
*written down* is what took the afternoon.

The rule is in `src/main/windowNavigation.ts` and has two branches, both of which
are easy to get wrong in opposite directions:

- **A navigation to the document already loaded is allowed**, because that is a
  reload. `location.reload()` raises `will-navigate` with the URL the window is
  already on — measured in the same harness — and the dev server does exactly
  that when it cannot hot-patch a change. A blanket refusal would be a refusal
  to reload the app.
- **A web address is opened in the browser** and the navigation is refused,
  which is the answer a link with a `target` already gets. Everything else is
  refused outright.

Compared field by field rather than by origin, because a `file:` URL's origin is
the string `"null"` and an equality test on it calls every file on the disk the
app's own page. That trap has a test of its own.

`setWindowOpenHandler` now also refuses to hand macOS anything that is not
`http:` or `https:`. Today the only thing that reaches it with anything else is
xterm opening `about:blank` before it discovers it has been denied, so this too
defends against nothing yet. `shell.openExternal` asks the OS to open whatever
it is given, and the day something else calls `window.open` is the day that
matters.

## What a crafted teammate stream can do

This is where the audit found something real.

### It can make your window type on their machine

**Terminal output is not text, and some of it is a question.** A cursor-position
report (`ESC [ 6 n`), a device-attributes request (`ESC [ c`), a mode query, a
request for the current attributes — an emulator answers each of these by
*sending bytes*, and xterm delivers those bytes on the very same `onData` a
keystroke arrives on, with nothing to tell the two apart. These are not exotic
payloads; a full-screen program asks its terminal these things constantly, which
is to say an agent pane does.

`scrollbackRecord.ts` already made this argument, for a record replayed off disk — and said, correctly, that *live* it is merely a conversation: a
program asked its own terminal a question and read the answer on its own stdin.

**That sentence is true of a pane of your own and false of a teammate's.** In
`WatchedPaneView` the program is on somebody else's machine, this emulator is a
second one reading the same bytes, and its answer does not go back to the
program. It went to `teamwork.type`, which is a keystroke, with the reader's name
on it. So before this change, a teammate whose agent printed `ESC [ 6 n`:

- had every watcher's window type a cursor report into their pty;
- had it recorded in their audit log as that watcher's keystrokes, and counted
  on the pane's hover — "ana: 3 keystrokes, 6 bytes" — for keystrokes ana never
  made;
- and, where the watcher had no standing permission, **raised a consent prompt
  on the owner's machine asking them to allow a keystroke nobody pressed.**

The last of those is the worst of the three. The whole argument for why a pane a
teammate can type into is survivable is that nothing about it is ambiguous:
their name is on the bar while they are typing, and the owner is asked before it
runs. A prompt raised by the owner's own output, naming somebody who did
nothing, is that promise being false at the exact moment somebody is making a
decision on the strength of it.

The fix is that the view sends only bytes a person in this window produced.
`handsHere` in `WatchedPaneView.tsx` marks the moments somebody acted — every
way xterm turns an action into data begins as a DOM event inside the terminal's
own element, and a capture listener there runs before xterm's own handler does.
A reply has no such event behind it. The mark lasts one microtask, which is
enough: xterm raises `onData` synchronously inside the handler for the event
that caused it, and its replies come out of `write()` in a later task.

It is a mark on the *action* and not a filter on the *bytes*, because a reply
and a keystroke can be the same string — there is nothing about the data that
could tell them apart. `emulatorReplies.test.ts` drives the real emulator and
states both halves: the same cursor report is sent when somebody pasted it and
not sent when the stream provoked it.

### What it cannot do

Measured against xterm 6.0.0, driven for real rather than read about:

- **No clipboard.** There is no OSC 52 handler in the build at all — the
  registered set is 0, 1, 2, 4, 8, 10, 11, 12, 104, 110, 111, 112 — and an OSC 52
  write produces no bytes and touches nothing.
- **No window title.** xterm raises `onTitleChange` and sets nothing itself;
  nothing in this renderer subscribes, and `document.title` does not move. (The
  main process *does* scan OSC 0 and 2 out of a **local** pty to name a pane —
  `title-sequence.ts` — which is a different stream in a different process.)
- **No link that goes anywhere.** xterm's OSC 8 provider refuses to offer a link
  at all unless its URL parses as `http:` or `https:`, so a `file:` or
  `javascript:` hyperlink is not clickable. An `https:` one is, and its default
  activation calls `window.open()` — which this window denies, so the link does
  nothing but print a warning to the console. That last step is read off the
  build rather than watched; what *is* watched is the denial it runs into, which
  is `setWindowOpenHandler` and the navigation rule above.
- **No escape from the pane.** Everything else a stream can do — alternate
  screen, mouse tracking, the colour palette, a screen reset — happens inside
  the emulator. It can make the pane unreadable. It cannot make it something
  else.
- **No frame the view has not checked.** `readWatchedPaneEvent` rebuilds every
  stream frame out of the fields it verified, so `term.write(42)` from a broken
  or hostile peer is not a thing that reaches the emulator.

Two smaller things, checked and found to be nothing, recorded so the next reader
does not have to check them again. A teammate chooses the text of a refusal —
their machine's error message — and it reaches two places: written into the pane
(which that same peer is already filling with bytes, so it is no new reach) and
into a React text node on the header (which escapes). And a teammate's pane
titles reach the sidebar as React text, clipped to a length by `boundPane` and
never written into an emulator. Neither is bounded in any way that would stop a
peer making a very wide line; that costs layout, not reach.

## The release notes

The claim that came with this feature was that the notes render in a React text
node with no `dangerouslySetInnerHTML`. That is true, and the whole path behind
it holds it up rather than the one component:

- `plainText` in `latestRelease.ts` drops every control character except tab and
  newline — spelled as the Unicode `Cc` category, so the eight-bit C1 range goes
  with the seven-bit one, which is now asserted — and cuts the result to 4,000
  characters. Markup is deliberately **not** stripped: nothing renders it, and
  taking it out would quietly rewrite what a maintainer wrote.
- The body is read through a byte budget before it is parsed, so a response that
  never ends is abandoned rather than accumulated.
- The card puts the result in `<p>{notice.notes}</p>`. `UpdateAvailableCard.test.tsx`
  renders a body of `<img onerror>` and `<script>` and asserts the characters are
  on screen, that `querySelector('img')` and `querySelector('script')` are both
  null, and that nothing ran.

There is no `dangerouslySetInnerHTML`, no `innerHTML`, no `insertAdjacentHTML`
and no `document.write` anywhere in `src/renderer` or `src/preload`. The download
link is separately refused unless it parses as an `https:` address on
`github.com` under this repository, and the release page is composed from a tag
that had to match this project's tag shape rather than taken from the API.

## What the content security policy covers

`src/renderer/index.html` carries
`default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:`.
Enforced, watched in the running window: `eval` and `new Function` both throw
`EvalError`, and a `<script>` element appended with a `textContent` is refused
with `script-src-elem` and does not run. Both of those are asserted in the smoke
run now, and removing the meta tag makes it fail.

What it does **not** cover is worth being exact about:

- `connect-src` falls back to `'self'`, which is right, and cheaply so: the
  renderer makes no network requests at all. There is no `fetch`, no
  `XMLHttpRequest`, no `WebSocket` and no `EventSource` in `src/renderer`. The
  update check's HTTPS request is made in the main process, and everything else
  the window needs comes over the bridge. So this line costs nothing today and
  would refuse the first thing that tried.
- `form-action` is not set, and `<meta>` cannot carry `frame-ancestors`,
  `sandbox` or `report-uri` at all — a `<meta>` policy is not the same object as
  one on a response header.
- **And it does not travel.** A policy in the app's HTML applies to the app's
  HTML. It is the navigation rule, not this, that keeps the window on a document
  that has one.

## The threat model, plainly

**Your own machine, your own panes.** The window shows what your programs print,
and an emulator answering their questions is a conversation with your own shell.
Nothing here is about you.

**A teammate whose pane you are watching.** They are on your roster, which
`teamwork.md` says means they have push access to the repository and could run
code on your machine that way already. What this boundary is for is narrower and
still worth having: that their *output* cannot do things their *keystrokes*
would have needed your consent for. Before the fix it could. Now the bytes their
stream provokes stay in your window, and the only bytes that leave it are ones
you produced.

**A page that is not the app.** Not reachable today, and total if it ever were.
This is the case the navigation rule exists for, and the honest description of it
is that the defence is one handler and one test, sitting in front of a failure
with no floor.

**A defect in Chromium or in xterm reached through somebody else's output.** Not
defended as well as it could be, and the reason is `sandbox: false` above. This
is the gap in this document that is real, known, and left open on purpose,
because closing it is a packaging change rather than a line.

## What has been checked, and where

Everything above was observed on Linux under Electron 38.8.6 and xterm 6.0.0 —
the same Chromium the Mac build ships, and there is no platform branch in any of
the code this document describes.

| the claim                                                        | where it is checked                                     |
| ---------------------------------------------------------------- | ------------------------------------------------------- |
| the window's four settings, off a real window                    | `scripts/smoke.mjs` · `checkRendererBoundary`            |
| the renderer has no `require`, `process`, `module` or `Buffer`   | same                                                     |
| an inline script is refused, and does not run                    | same                                                     |
| the renderer cannot navigate the window away from the app        | same                                                     |
| which navigations are allowed, sent to the browser, or refused   | `src/main/windowNavigation.test.ts`                      |
| only a web address is handed to macOS                            | same                                                     |
| a stream makes the real emulator send bytes                      | `src/renderer/src/terminal/emulatorReplies.test.ts`      |
| no OSC 52, no title change                                       | same                                                     |
| a person's bytes are sent and a stream's are not                 | same, and `WatchedPaneView.test.tsx`                     |
| release notes are text, and markup in them stays characters      | `src/renderer/src/updates/UpdateAvailableCard.test.tsx`  |
| release notes lose both the seven- and eight-bit controls        | `src/main/updates/latestRelease.test.ts`                 |

One thing is read off the build rather than watched, and is marked as such above:
that xterm's OSC 8 provider only offers `http:` and `https:` links and activates
them through `window.open()`. Everything it runs into afterwards is tested.
