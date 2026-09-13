# Roadmap

Milestone 1 is single-user and is the current target. Team features come after it works.

## Stack

- TypeScript end to end
- Electron for the shell, so terminal rendering behaves the same on every platform
- React + Vite for the renderer
- A runtime owning git, worktrees, terminals, and state
- One contract in `src/shared` typing the runtime, the GUI, and the CLI from a single declaration
- A `teamree` CLI over a local socket, so a coding agent can drive the app

## Architecture

Three consumers, one contract. The renderer reaches the runtime over Electron IPC through
an isolated preload bridge. The CLI reaches the same runtime over a unix socket, or a named
pipe on Windows, speaking newline-delimited JSON. Both are typed from `src/shared/methods.ts`,
so a change to a method signature breaks every caller at compile time rather than at runtime.

## M0 — Scaffold

- [x] Electron + Vite + React + TypeScript builds and launches
- [x] Main, preload, renderer split with strict process boundaries
- [x] Typecheck, lint, format, test wired up
- [x] Headless smoke test that boots the built app

## M1 — Contract and runtime

- [x] Domain entities, wire protocol, and method catalogue
- [x] Method registry, dispatcher, structured errors
- [x] Local socket server with runtime discovery
- [x] Subscription manager for streaming output
- [x] Durable store for projects, worktrees, layouts

## M2 — Repos and worktrees

- [x] Add and track a repo
- [x] List worktrees, reconciled against real git state
- [x] Create a worktree in the background with progress and failure recovery
- [x] Start-from picker: base ref, local branch, commit, remote branch
- [x] Live git status per worktree
- [x] Delete a worktree and optionally its branch

## M3 — Terminals

- [x] PTY sessions with a correct per-platform environment
- [x] Bounded scrollback, readable as a snapshot
- [x] Streaming output, title detection from escape sequences
- [x] Split panes, arbitrarily nested, resizable
- [x] Process-tree cleanup so nothing is orphaned

## M4 — GUI

- [x] App shell: sidebar, main area, status bar
- [x] Projects and worktrees in the sidebar with live status
- [x] Create-worktree flow that does not block
- [x] Terminal panes rendering the split tree
- [x] Keyboard shortcuts with correct per-platform modifiers

## M5 — CLI

- [x] Transport, discovery, and exit codes that mean something
- [x] `teamree status`
- [x] `teamree project` and `teamree worktree`
- [x] `teamree terminal` including read, send, and split
- [x] `--json` on every command

## M5b — Live workspace

The GUI polls today, so work a CLI does is invisible until the next poll and
terminals opened by an agent never appear at all. One coarse invalidation
stream replaces polling entirely.

- [x] `workspace.subscribe` streaming collection invalidations
- [x] Producers wired: projects, worktrees, terminals, layouts, terminal exit
- [x] GUI consumes the stream and drops its poll loop
- [x] `teamree worktree wait`, `teamree terminal wait`, and `teamree terminal run` for agents

## M6 — Acceptance

- [x] End-to-end: create a worktree, open a terminal, run a command, read the output back
- [x] The same flow driven entirely through the CLI
- [x] macOS, Linux, Windows path and process handling
- [x] Packaged build

## M7 — Live status

Status was the one part of a worktree row with no call behind it, so it was only
ever as fresh as the last command boundary.

- [x] A filesystem watch per ready worktree: the checkout and its git directory
- [x] Bursts settled and rate-limited, so a build cannot drive a status read per file
- [x] Degrades to the git directory alone where recursive watching is unavailable
- [x] The watch set follows git's own events, so nothing polls

## M8 — Reviewing the work

Counts tell you whether there is something to look at. They cannot tell you the
file you are about to commit is a stray log.

- [x] `worktree.changes`: every changed path, conflicts first, then staged
- [x] `worktree.diff`: the patch for a worktree or one path in it
- [x] Untracked files diffed as the patch that adds them, which plain `git diff` will not do
- [x] `teamree worktree changes` and `teamree worktree diff`
- [x] A changes panel in the GUI, live off the same watch as the chips

## M9 — Getting around

Tabs stop being a way to navigate somewhere around the sixth one.

- [x] A palette on one chord: worktrees by name, branch or project, and the
      actions worth reaching without the mouse
- [x] Ranking that puts the thing you meant first — whole-query hits over
      scattered letters, word starts over mid-word, initialisms over neither
- [x] The same chord closes it, arrows and Enter drive it, the mouse agrees
      with the keyboard about what is selected

## M10 — Picking a session back up

A PTY is a child process, so quitting ends it. For a coding agent that was
never the valuable part: the conversation is, and the agent already keeps it on
disk under a session id.

- [x] A durable record per terminal: worktree, directory, shell, and the agent
      session it was running
- [x] A session id pinned at launch where the agent's CLI allows one, so the
      next launch has an id to resume rather than a guess to make
- [x] Startup relaunches each recorded pane under its own terminal id, so
      stored pane trees need no rewriting
- [x] Agent panes resume; every other command is dropped for a plain shell,
      because restarting the app is not a request to run a deploy again
- [x] The pane says how it got here — resumed, or a new shell — until the user
      types into it, at which point the badge has said what it had to

## M11 — Which of these can actually go in

Several attempts at one task is the point; picking the one that merges is the
question that follows.

- [x] `worktree.mergePreview`: merged in memory with `merge-tree --write-tree`,
      so asking costs the repository nothing and starts no merge to abort
- [x] Conflicting paths named, each once, however many ways git mentions them
- [x] A base ref that does not resolve, unrelated histories, and a git too old
      to be asked each come back as themselves rather than as "clean"
- [x] A branch with nothing the base lacks reads "nothing to merge", never
      "merged": git cannot tell a finished branch from one that never started,
      and the row must not talk somebody into deleting unfinished work
- [x] `teamree worktree merges`
- [x] The answer shown per worktree in the sidebar, capped at four reads in
      flight so a refresh cannot fan out a git process per row

## M12 — Committing from the app

The first thing here that writes to a repository, so it is built to refuse
rather than to guess.

- [x] `worktree.commit`: stages only the paths named, or commits what is
      already staged — there is deliberately no "commit everything"
- [x] Refuses an unresolved conflict, and names the files, rather than
      committing the markers as if they were code
- [x] Refuses an empty message and an empty commit, and leaves the history
      untouched when it refuses
- [x] Reports what the commit actually captured, not what was asked for
- [x] `teamree worktree commit`, with paths after `--` so none reads as a flag
- [x] Staging and committing from the changes panel: ticking is browsing, and
      nothing reaches git's index until the commit itself

## M13 — Sending it somewhere

The only call in the git layer that leaves the machine.

- [x] `worktree.push`, with an explicit refspec so `push.default` cannot land
      the branch under another name
- [x] No force, and no flag to ask for one: the value of a force push is
      overwriting somebody else's history
- [x] Sets the upstream on the first push, and knows the difference between
      sending work and having had nothing to send
- [x] Uncommitted work is counted and reported rather than blocked, because
      what landed is then not what is in the worktree
- [x] A rejection is explained without git's hint to force it
- [x] `teamree worktree push`
- [x] A push button in the GUI, showing what it would send and saying what it
      did — including what stayed behind uncommitted
- [ ] Opening a review on the forge after a push

## M14 — Starting an agent

The app is built around coding agents and had no way to start one: you opened a
terminal and typed the name yourself.

- [x] `agent.list` probes PATH for the agents teamree knows how to resume,
      rather than asking the user to configure a list that goes stale
- [x] First match wins, the way a shell resolves it, and an empty PATH entry is
      not treated as the working directory
- [x] A button per installed agent in the header and in an empty worktree, and
      `teamree agent list`
- [x] A pane started this way is an ordinary pane: the runtime pins its session
      id, so it comes back resumed after a restart like any other

## M15 — Not losing somebody's afternoon

- [x] Removing a worktree from the sidebar is no longer forced. The runtime
      already refused to delete a checkout with uncommitted work; the GUI was
      passing `force` unconditionally and defeating it
- [x] That refusal now raises a confirmation naming what would be thrown away,
      and the removal only proceeds from there
- [x] A clean worktree still goes without a dialog, so the one that matters is
      not the one people learn to click through

## M16 — What the worktree actually did

An agent that finishes commits its work, and at that moment every view in the
app went quiet: the changes list emptied, the chips dropped to zero, and a
worktree that had just produced a day's work looked like one where nothing
happened.

- [x] `worktree.log`: the commits this branch has that its base does not,
      newest first, scoped to `base..branch`
- [x] Fields separated by NUL, since a commit subject can contain newlines and
      a line-based reader turns one commit into two
- [x] `teamree worktree log`, and a commits section in the changes panel
- [x] An empty changes list now distinguishes "everything here is committed"
      from "nothing changed here yet"

## M17 — What each agent is doing

The sidebar answered "what has changed in this worktree" and never "which of
these five agents needs me", which is the question running agents in parallel
creates.

- [x] Each pane reports whether output is still arriving, and the runtime
      announces only the two edges — busy, and quiet again — rather than one
      event per chunk
- [x] Worktree rows carry their panes underneath, each with a state dot and how
      long since it last said anything
- [x] Four states and no more: working, waiting, finished, failed. Teamree
      watches a PTY, not an agent's protocol, so "waiting for permission" is not
      knowable here and is not claimed
- [x] The sidebar's filter box is gone; the palette already finds things by
      name, branch and project from anywhere

## M18 — Which one of them needs you

M17 put each pane's state on its worktree row, which answers the question one
worktree at a time. With eight agents running, finding the one that wants you
still meant reading the whole tree.

- [x] One flat view of every pane in every worktree, taking the main area:
      which agent or shell it is, where it lives, its state, and its silence
- [x] Ordered by what would make somebody look — failures, then work in
      progress, then waiting, then finished — and longest-silent first inside a
      group, because the pane that has been sitting there is the neglected one
- [x] Counts per state, so "3 waiting" is read rather than tallied
- [x] A row opens its worktree and focuses its pane, which is also how the view
      is left
- [x] The same four states as the sidebar, derived by the same module: two
      readings of one PTY would be two things to reconcile
- [x] Live off the existing `terminals` invalidation, with the silences kept
      counting by a clock of their own — no new runtime method

## M19 — Finding something in a pane

Scrollback is where the answer usually is, and the only way to reach it was to
scroll.

- [x] A find bar over the pane, on the chord, scoped to that pane alone
- [x] Case and whole-word toggles, match counts, next and previous
- [x] Absolutely positioned over the terminal, taking no layout space: a bar
      that took space would resize the PTY under a program being read

## M20 — Starting work, not making directories

The create dialog made a checkout and left you to go and find an agent button.
Nobody wants a worktree; they want a thing done in one.

- [x] One dialog: describe the task, pick the agent, pick what it starts from
- [x] One submission creates the worktree, waits for it, and starts the agent
      inside it — the wait rides the existing change stream rather than a poll,
      serialises its reads so a burst of events cannot land answers out of
      order, and gives up after ten minutes rather than holding a subscription
      open for the life of the window
- [x] The footer never promises what it cannot deliver: an empty agent list
      means "not asked yet" until the startup probe answers, and only then
      "none on PATH" — at which point the button says "Create worktree"
- [x] The dialog closes on submit; creation narrates itself on the sidebar row

## M21 — What a pane actually said

The sidebar said a pane was working. It did not say what it was working on.

- [x] The last line each pane printed, on its row, replayed the way a terminal
      would — carriage returns, backspaces and erase-line sequences collapse a
      progress bar to its final state rather than the fragment that ended it
- [x] Bare prompts, spinner frames and rules refused; a tail that ends inside
      the alternate screen buffer refused outright, because the bottom row of a
      full-screen program is not the end of a story
- [x] Cheap on purpose: a 4KB tail, only for worktrees on screen, a floor per
      pane, a cap per tick, a quiet pane read only once output has arrived, and
      an exited pane read once more and then never again — no subscription,
      which would push every byte an agent prints into the renderer to show one
      line

## Known gaps

Milestone 1 is complete and verified. These are the honest limits of what it does,
recorded so none of them is discovered by surprise later.

- **A restarted shell is a fresh shell.** Panes and their directories come back, and
  an agent pane comes back with its conversation (see M10), but an ordinary pane's
  scrollback and whatever it was running are gone: the PTY died with the app. A
  command is never re-issued unless it resumes something, so a pane left on a deploy
  or a migration comes back as a shell rather than running it twice. Keeping the
  process itself alive would mean moving PTYs into a daemon that outlives the app.
- **macOS is the supported platform. Windows and Linux are not, for now.** That is a
  decision rather than a gap waiting to close: CI builds macOS only, and nobody should
  pick this up expecting to finish it. What was learned before narrowing is kept
  because it is true. Linux was packaged and launched for real — `npm ci` compiles
  node-pty, both the AppImage and the `.deb` are produced, and the packaged app was
  launched headless, driven through the CLI it ships, and made to spawn a real PTY,
  three times over: as the unpacked tree, as the AppImage's payload, and as a `.deb`
  installed with `dpkg`. It reached green in CI. Windows never did — it was still
  turning up a fresh POSIX assumption on every run — and the Windows installer has
  never been built nor the app started there. The platform-specific code and the
  Windows-conditional workflow steps are all still present, so putting a platform back
  is adding a block to the matrix rather than a rewrite.
- **CI runs, and macOS is green.** It runs typecheck, lint, format, the full suite,
  the build, the headless smoke test, the package and the packaged-app check — the one
  that launches the artifact and drives it — and macOS passes all of it and uploads a
  build. Its first four runs all failed, each for a real reason that a developer
  machine had been hiding: a stale CLI build, a configured git identity, LF line
  endings, and a sandbox helper that only needs its permissions fixed on a runner.
  The action versions have since been checked against the upstream tags
  and all resolve, so the first run will not fail on those; they are two to three
  majors behind current, which is a maintenance note rather than a fault. Those steps
  now live in `build.yml`, which `ci.yml` and `release.yml` both call rather than
  restate, so there is one sequence to be wrong rather than two. All three files are
  checked by actionlint with shellcheck behind it and are clean, which means the first
  run will not die on a syntax error, an unknown action input or a shell mistake in a
  `run:` block — it does not mean the jobs pass.
- **No release has ever been published.** `release.yml` builds on a `v*` tag through
  the same workflow CI uses, collects the three runners' installers, writes
  `SHA256SUMS.txt` and attaches the lot to a GitHub release. It has never been fired.
  The parts that can be checked without GitHub have been: the workflow parses and
  lints, and the note-writing and checksum steps were run here against stand-in files
  and produce what they claim to. What has not been checked is everything that needs
  the platform — whether the artifact upload and download hand the files between jobs
  as expected, and whether `gh release create` behaves as read. Until a tag is pushed,
  this is a pipeline that has been reasoned through, not one that has run.
- **Nothing is signed. That is a decision, not a task waiting to be done.** There is
  no Apple Developer certificate and no Windows code-signing certificate, and none is
  being bought, so macOS refuses the app as being from an unverified developer and
  Windows shows a SmartScreen panel. It is still the first thing a new user meets,
  which is why it is recorded here — but nobody should pick this entry up expecting to
  close it. Both warnings are documented rather than left to be discovered, in `docs/install.md` and in the notes
  every release carries, with what each warning does and does not mean and the exact
  way past it. A published checksum is the substitute for the integrity half of a
  signature. There is no substitute for the identity half: a colleague's confidence
  that the file is teamree rests on where they got the link, not on anything the
  operating system can tell them. The macOS instructions in that document are written
  from Apple's behaviour and the ad-hoc signing the build already does; they have not
  been walked through on a Mac at this commit.
- **A path is stored two ways.** A project's path is canonical — resolved, with its
  separators normalised — and a worktree's is joined the host's way, so on Windows the
  same location is spelled `C:/x/y` in one record and `C:\x\y` in another. Nothing is
  known to break: every comparison goes through `pathKey`/`samePath`, which normalises
  first, and git prints forward slashes on every platform regardless. It is recorded
  because two spellings of one thing in one data model is how a later comparison gets
  written without them, and because it was found by a test asserting equality rather
  than by anything going wrong.
- **Windows behaviour is reasoned, not observed.** Narrower than it was, and not
  closed. Command-line encoding is now checked exhaustively rather than by example:
  every argument up to four characters over the alphabet that drives the rules, and
  every pair of arguments up to two, round-trips through a reference
  `CommandLineToArgvW` parser, and the `cmd.exe` tail is checked against cmd's
  documented `/S` rule. That proves the encoder agrees with the parsers it is written
  for. It does not prove a live ConPTY agrees with either, because there is no
  Windows here to ask. The process-tree kill is still untested on Windows: taskkill
  is driven through an injected host, so the decisions around it are asserted, but no
  real taskkill has ever run. The POSIX equivalent is tested for real. Packaging at
  least fails loudly there now — the afterPack hook refuses a build whose node-pty is
  missing `conpty.node`, `pty.node`, `winpty.dll`, `winpty-agent.exe` or the bundled
  ConPTY sidecar, rather than shipping an app whose first terminal never opens.
- **The Windows CLI launcher is a batch shim**, not a native executable.
- **A chatty command keeps its tail on POSIX; Windows is unproven.** The loss was
  node-pty's reader stopping short of the end: the `tty.ReadStream` over the pty
  reports end-of-stream while bytes the child already wrote are still in the
  kernel, and node-pty then closes the descriptor — from its own close handling,
  or from the 200ms timer it arms when the child is reaped — taking those bytes
  with it. The session now reads that descriptor to its real end in the moment
  before the close, so on POSIX nothing is outstanding by the time exit is
  reported, which is the invariant `teamree terminal run` hands an agent. Measured
  here on a 3000-line command: 24 runs in 60 lost the tail before, 0 in 200 after;
  on four cores kept busy, 52 in 60 before and 0 in 60 after. Windows still has
  only the older mitigation — exit held until the output goes quiet — because
  ConPTY output arrives over a pipe node-pty owns rather than a descriptor we can
  read, and nothing has been observed there either way.

## Milestone 2 — Teamwork

Planned in full, with every decision made and written down, in
[docs/teamwork.md](docs/teamwork.md). The short version: the people who can push
to the repository are the team, their public keys live in the repository, an
untrusted relay the team hosts splices two outbound WebSockets together, and
everything across it is end-to-end encrypted. A teammate is a third transport
onto the method catalogue that already exists, not a new protocol.

- [x] **A — Identity, with no network at all.** Keypair, `.teamree/members/`,
      members shown in the app. The whole trust model, testable offline.
  - [x] A member file has to be named exactly `<handle>.pub`. It was matched
        case-insensitively at the suffix and case-sensitively at the stem, so
        `bob.PUB` was accepted as a fully authorised member named "bob" — which
        made attribution forgeable by anyone with push access, and attribution
        is the whole mitigation for a feature that grants remote code execution
  - [x] A public key whose ignored top bit is set is refused: X25519 masks it,
        so `K` and `K | 2^255` are one identity with two spellings, and every
        comparison here is on the spelling
  - [x] Text quoted out of a committed file into a member problem is flattened
        and capped before it reaches a window
- [x] **B — The relay, and presence.** Outbound connections, the Noise `IK`
      handshake against keys from the roster, teammates' worktrees in the
      sidebar. No terminal output yet.
  - [x] The relay URL is committed to the repository at `.teamree/relay`,
        beside the member keys, because a relay is a team-wide fact and a
        second place to keep it is a second place for it to go stale.
        `TEAMREE_RELAY_URL` overrides it for one run, for a tunnel nobody
        should commit. There is deliberately no default
  - [x] A rendezvous per teammate **per repository**, derived from the
        static-static Diffie-Hellman, the project and the hour, with the token
        in the first frame and only its hash in the URL. This diverges from
        `relay/README.md`, which specifies one pairwise rendezvous for all
        time: a pairwise session is one indistinguishable shape across every
        repository two people share, with nothing in its transcript saying
        which project it is for. The relay needs no change either way
  - [x] Noise `IK` over the splice, against the one key this link dialled,
        with a prologue that is never empty and carries the project and the
        pairing. Every way the handshake can fail ends the connection
        identically, so "not a member" and "wrong machine" are one answer on
        the wire and two in this machine's own log
  - [x] Completing a handshake is not evidence anybody is there: a responder
        finishes `IK` having only written its own message, so a replayed
        message 1 reaches `established` carrying the real peer's key. A link
        says `connected`, subscribes, and believes a snapshot only after the
        first transport message from the far end that decrypts — which needs
        keys a recording cannot supply
  - [x] A teammate is a fourth transport onto the existing catalogue, speaking
        the same newline-delimited JSON the CLI socket does — so the dispatcher,
        the subscription hub and every handler are unchanged. What a teammate
        may call is one explicit list, and it is presence and nothing else
  - [x] Worktrees, branches and per-pane activity cross as metadata. Silence
        crosses as a duration rather than an instant, because two machines do
        not agree about what time it is
  - [x] A project is matched across machines by a hash of its origin remote, so
        a teammate on one repository learns nothing about the others a pairwise
        link happens to span. The roster is filtered on both sides
  - [x] Teammates' worktrees under the same project in the sidebar, visibly
        theirs, with nothing on them to act on
  - [x] Connecting, connected, refused, relay-unreachable and "nobody is
        connected" are five separate things the header says separately —
        "not set up here" loudest of all, because it is the ordinary one
  - [x] Tested against the relay itself: the built container host, as a child
        process, on a real port, over real WebSockets, between two runtimes with
        their own data directories and their own identities
- [x] **C — Watching a pane.** `terminal.subscribe` over the peer transport,
      read-only, letterboxed to the owner's dimensions, and the pane says it is
      being watched.
  - [x] The allow-list widened by exactly two methods, both reads:
        `terminal.read` for the scrollback a watcher joins at and
        `terminal.subscribe` for everything after it. `terminal.write`,
        `terminal.resize` and `terminal.close` stay absent, and that absence is
        the whole of what makes watching read-only — a watcher's keystroke
        reaches a method the far runtime does not admit to having. Neither the
        terminal service nor the dispatcher was touched
  - [x] Bytes flow only for a pane somebody has open and stop when they close
        it, because ten people streaming forty panes at each other is N²
        bandwidth for output nobody is reading
  - [x] The join between the scrollback and the live tail, with neither a gap
        nor a duplicated overlap, and with no byte arithmetic: the subscribe
        goes first, everything the stream says is held until the read's answer
        lands, and the held output is discarded because the transport's own
        ordering guarantees the snapshot already contains it. An exit and a
        title survive that discarding, because a scrollback holds neither
  - [x] The owner's dimensions cross as metadata and a watcher letterboxes to
        them. There is no method through which a reader could change them
  - [x] A pane that outruns the relay's 200 frames and 4 MiB a second is
        coalesced first, which is lossless, and only then trimmed — and when it
        is trimmed the watcher is told how many bytes went, in the stream,
        where the hole is. Output dropped silently would make the view a lie
  - [x] A watch that ends for a reason the reader cannot see says so: the owner
        closing the pane, the pane exiting, and the link dropping are three
        notices rather than a window that quietly stops updating
  - [x] The owner sees who is reading each of their panes, by name and live,
        because the design's case for why "anyone can type" is survivable is
        that none of it can be done invisibly
  - [x] Tested against the relay itself again, with real PTYs behind it: two
        watchers on one pane, the owner watching their own pane while a
        teammate does, the pane exiting under a watcher, the owner closing it
        under a watcher, and the link dropping mid-stream and coming back
- [x] **D — Typing into a pane.** `terminal.write` over the same transport, with
      live attribution, a local audit log, and per-pane mute. The milestone that
      needs the most care: it is the one that hands somebody else a shell.
  - [x] The allow-list widened by exactly one method, and it is the only one on
        it that changes anything. `terminal.resize` and `terminal.close` stay
        absent — a teammate's window is not this pane's window and their
        keyboard is not its power switch — and so does everything touching git.
        Neither the terminal service nor the dispatcher was touched
  - [x] Being on the list is not the same as being allowed: every keystroke
        passes a verdict from the thing that knows whose link it arrived on,
        and a transport wired without one carries no keystrokes at all. A byte
        reaching a pty that nobody can attribute is the one outcome this
        milestone exists to make unreachable
  - [x] Attribution is live and is updated before the write is dispatched, in
        memory, where it cannot fail. The pane names whoever is typing while
        they type, and goes on saying they typed here after they stop, because
        a pane a teammate has run commands in is not a pane whose history is
        the owner's alone
  - [x] **The audit log holds who, when, which pane, how many bytes, how many
        submissions, and whether it landed — and never the bytes.** A remote
        write carries input, and input includes what a program deliberately
        does not echo; keeping it would build a plaintext store of teammates'
        passphrases out of a safety feature, and would hold strictly more than
        the screen the owner can already read. Refusals are recorded too:
        somebody still typing at a muted pane is the thing an owner most wants
        to know. It is JSON Lines beside the identity, rotated once at a cap,
        and it survives a restart because a record that did not would not be one
  - [x] Mute is the owner's, per-pane, and instant: no round trip, no
        agreement, and no way for a teammate to refuse it. It is checked in the
        same task that dispatches the write with nothing awaited in between, so
        a keystroke still in flight when the mute lands is refused rather than
        run. A muted pane keeps streaming and keeps its row — mute stops the
        bytes, it does not hide the worktree
  - [x] Nothing is dropped in silence. A refusal is answered with the owner's
        own words and drawn in the pane where the keystroke would have gone, so
        a mute, a pane that exited and a link that went are three sentences
        rather than a keyboard that quietly stopped working
  - [x] One write is capped below the relay's per-second byte budget, refused
        whole rather than chunked: half a paste landing in somebody's shell is
        worse than none of it
  - [x] A message that arrives over a session refused while that same message
        was being read runs nothing from it. Key confirmation can tear the link
        down mid-message, and a keystroke behind it must not run merely because
        the loop had already started
  - [x] Tested against the relay itself again, with real PTYs behind it: a
        keystroke landing and coming back out of the pty, the owner muting
        mid-stream, a muted pane still streaming and still in the sidebar, two
        teammates typing at once, a pane whose process has exited, a link that
        went while a keystroke travelled, and a key taken off the roster
- [ ] **E — Staleness.** The local cache, stale marking with its age, and
      reconnection that reconciles rather than re-fetching the world.

## Later

Graph-based unified memory. Per-person attribution of work under a shared
project.
