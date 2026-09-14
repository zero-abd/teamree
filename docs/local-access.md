# Who on this machine can drive teamree

[`teamwork.md`](teamwork.md) writes down one boundary in detail: what a teammate
across a relay can reach, with the test named beside every sentence. This is the
other one, and it had never been written down at all. Every use of the word
"trust" in this repository's documentation was about the relay or a teammate,
and yet the most powerful way into this app is not either of them.

**The CLI socket is that way in.** The runtime answers one catalogue of methods
over three transports — Electron IPC for the window, a unix socket for the
`teamree` command, and a Noise link for a teammate — and only one of the three
is an allow-list. A teammate gets six methods (`PEER_METHODS` in
`src/main/runtime/peerTransport.ts`, asserted whole in
`src/main/runtime/peerTransport.test.ts`). A client on the socket gets all of
them: create a worktree, remove one, spawn a terminal, read any pane's
scrollback, type into it. Even the one method both may call is not the same
call — a teammate's `terminal.write` is held for the owner's consent, and a CLI
client's goes straight to the pty, because nobody is asked to consent to
themselves. That asymmetry is the point of the CLI and it is not a defect, but
it does mean the local socket is strictly more powerful than any peer link, and
that whatever stands in front of it is the most important permission check in
the product. `tests/security/localSocketReach.test.ts` states the asymmetry as a
test, so nobody reads `PEER_METHODS` and believes it limits the CLI too.

## What actually protects it

Observed rather than assumed, and one of the four marked where it is not. These
are the modes a real launch produces, read off a booted app rather than reasoned
about:

- **`~/Library/Application Support/teamree` is `0700`.** Electron creates it,
  and it is Electron's decision, not an accident of the umask: a run under
  `umask 000` produces `0700` just the same. Nothing this repository does would
  have produced that — every `mkdir` in this tree takes node's default, which is
  `0755`.
- **`~/Library` is itself `0700`** on macOS, and has been since the folder was
  hidden — a second layer, independent of the first and of us. This is the one
  line in this list that was *not* read off anything: it cannot be, from a
  machine that is not a Mac. It is in [`mac-checks.md`](mac-checks.md) as ten
  seconds of `ls -ld`, and nothing below depends on it being true, because the
  directory inside it is closed on its own account.
- **`runtime.sock` is `0600`.** This one *is* ours, and it was `0755` before the
  change this document arrived with — see below.
- **`runtime.json` is `0644`**, which is the umask's doing and is deliberately
  left that way.

On an ordinary single-user Mac, the directory is doing all the work. The socket
sits inside two nested directories that no other account may enter, so its own
mode is never reached — another user cannot get far enough along the path to be
judged by it. **That defence is real and entirely inherited**, which is why
`scripts/smoke.mjs` now asserts it against a real app launch. It has to be
asserted there and nowhere else: every unit test that could make the claim would
be making it about a `mkdtemp` directory, and `mkdtemp` is `0700` by definition
whatever anybody intended. The smoke test points Electron at a directory that
does not exist yet, lets Electron create it, and reads the mode back. If that
ever goes red, something other than Electron is creating the directory and every
sentence above it is wrong.

## Why the socket got a mode of its own

`listen` takes no mode, so before this change the socket's permissions were
whatever umask the app happened to inherit — `0755` from a Finder launch, `0777`
from a shell whose profile sets `umask 000`. The difference matters more than it
looks. Connecting to a unix socket is an authorisation check: the kernel asks
for **write** permission on the file. `0755` therefore already shuts other
accounts out, and `0777` hands them the whole catalogue. Which of the two you
got depended on how the app was started, which is not a decision anybody made
about this socket.

That alone would be a weak argument for a `chmod`, because inside a `0700`
directory neither value is reachable. The real argument is that the directory is
not always there:

- **The endpoint is not always in the user data directory.** `sun_path` holds
  104 bytes on macOS, and when the user data path will not fit,
  `resolveEndpoint` falls back to the temp directory and then to `/tmp` — a
  directory every account on the machine can walk into. That fallback chain is
  pinned in `tests/platform/socket-endpoint.test.ts`; it is a supported path,
  not a hypothetical.
- **The user data directory is not always one Electron made.** Electron sets
  `0700` on a directory it creates and leaves an existing one alone, so a
  profile restored from a backup, copied between machines, or named with
  Chromium's `--user-data-dir` switch keeps whatever mode it already had. A
  directory at `0755` in a shared location was observed to survive a launch
  untouched.

In both of those the enclosing directory protects nothing, and the socket's own
mode is the only thing left. So `ENDPOINT_MODE` in
`src/main/runtime/socketServer.ts` sets it to `0600` explicitly, and
`startSocketServer` refuses to serve from an endpoint it could not restrict
rather than leaving that claim written down and false. It is asserted in
`src/main/runtime/socketServer.test.ts` twice: once as an exact mode, and once
under `umask 000`, which is the only version of the test that could have failed
before.

Be clear about what that buys. **It does not make an ordinary Mac safer** — the
directory had already closed that door. What it does is make the answer a
property of the app rather than of where the socket landed and how the app was
started.

## The discovery file is a signpost, not a key

`runtime.json` carries the endpoint path, the pid, the version, the protocol
version and a start time. None of it is a capability. The endpoint is a pure
function of the user data directory — a truncated SHA-256 of it — so anything
that could use the path can compute the path, and the pid is in the process
table for anyone who runs `ps`. A mode on this file would protect nothing that
is not already public, which is why it has not been given one.

What the file does have is **integrity that matters**: short of the
`TEAMREE_ENDPOINT` and `TEAMREE_RUNTIME_FILE` environment variables, which
belong to whoever runs the command anyway, it is the only thing the CLI trusts
to say where to dial. Anything that could rewrite it could point the `teamree`
command at a socket of its own and answer as the runtime — to an agent that
believed it was talking to the app. That protection is the directory's again,
and is not something a mode on the file could provide: a file only you can
rewrite is exactly what a directory only you can enter already gives. Whether the file
stays harmless is pinned in `tests/security/localSocketReach.test.ts`, which
asserts its key set whole: a future field that *is* a secret cannot be added
without that going red.

## The threat model, plainly

**One person, one account, one Mac.** The ordinary case, and the risk is small.
The socket is inside two directories no other account may enter, and it is
owner-only wherever it lands. There is nothing here for a normal user to do.

**A shared or managed Mac.** Several accounts on one machine, a lab or a loaner,
an MDM fleet. Other accounts still cannot enter `~/Library`, and since this
change the endpoint refuses them even when it lands somewhere they can reach.
An administrator with root is a different matter and is not a boundary this app
can defend: root can read the directory, the socket and `identity.key` alike.

**Another process running as you.** Not defended, at all, and not defensible by
any mode. Everything that runs as your account can connect to that socket and
drive the whole catalogue — which on a developer's Mac means a postinstall
script, a build plugin, a shell alias, and above all the coding agents this
product exists to run in ptys owned by that account. This is the same sentence
`teamwork.md` already writes about `identity.key`, for the same reason: push
access is the trust boundary, and everything inside it can already run commands
as you. Closing it would take something a file mode cannot express — verifying
the connecting process rather than the connecting user, which macOS can do and
this project does not attempt. What is written down here is the boundary that
exists, not one that would be nicer.

## What has been checked, and where

Everything above was observed on Linux under Electron 38.8.6, which is the same
Chromium and the same libuv the Mac build ships, and the modes are set by code
with no platform branch in it. Three things it cannot show, and they are listed
in [`mac-checks.md`](mac-checks.md) with the rest of the verification this
project cannot do for itself: that `~/Library` is `0700` on a real Mac, that the
`0700` Electron gives the user data directory is what a Mac sees too, and that
macOS refuses a connection to a socket the connecting account has no write
permission on — which is what was watched happen on Linux, a mode at a time, and
is the mechanism the whole of `ENDPOINT_MODE` depends on. The second is asserted
by `npm run smoke`, which is a gate and runs on a Mac before a release is cut.
The other two are a line of `ls` and a minute with a second account.
