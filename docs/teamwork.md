# Teamwork

Everything below is decided. It is written down because the decisions constrain
each other — the identity scheme is what makes the relay untrusted, and the
relay being untrusted is what makes "anyone can type" survivable — and a
later change to one of them is a change to the others. One of them has since
been changed, deliberately, and that is written down where it lives: typing into
a teammate's pane now waits for that teammate to allow it.

The milestones at the bottom are the order it was built in, and each one is
useful on its own. All six have landed: identity, the peer crypto, the relay
and the transport, watching a pane, typing into one, the stale cache, and the
owner's consent in front of every keystroke.

**Every sentence below that says something cannot happen names the test that
holds it up.** Not decoration: a security claim nobody has asserted is a
security claim that is true until somebody edits the line under it, and this
repository has twice found something believed to be working because it was
written down. So the citations are in the prose rather than in a table at the
end, and they are there for the next person to edit one of these sentences —
the test that would have to go red is named in the sentence they are changing.
Paths are relative to the repository root; a bare `foo.test.ts` is the one
beside the code it is about, and the adversarial ones live in `tests/security/`.

## The shape of it

A project is already a git repository that several people push to. Teamwork
adds nothing to that: **the people who can push are the team**. Their worktrees
and the panes inside them become visible to each other, live, in the same
sidebar that shows their own.

The thing that makes this cheap to build is that it is not a new protocol. The
runtime already answers a catalogue of methods over two transports — Electron
IPC for the window, a unix socket for the CLI. A teammate is a **third
transport onto the same catalogue**. `terminal.subscribe` already streams a
pane's bytes; `terminal.write` already types into one. Neither needs to learn
that the caller is two thousand miles away.

## Decisions

### Identity is the git remote

Each installation generates an **X25519 keypair** on first run. The private key
never leaves the machine: it is written to the app's own data directory —
`~/Library/Application Support/teamree/identity.key` — and never under a
repository. The public key is committed to the repository at
`.teamree/members/<handle>.pub`. Held up by
`src/main/teamwork/privateKeyStaysHome.test.ts`, which joins a repository and
then goes looking for the private half anywhere under it, `.git` included.

**The key is per machine, not per project.** That one file is this installation's
identity in every project it takes part in, so what reads it is not a member of
one repository but of all of them, and what a second machine needs is its own
keypair rather than a copy of this one. Both consequences are drawn out below —
the first in Risks, the second in the list that follows.

That file is the entire membership list, and it needs no administration,
because **push access already is membership**: if you can add your key to the
repository, you are on the team, and if you are removed from the repository you
can no longer change it. There is no second list to keep in step with the first,
no invitations, and no accounts.

**What the file actually holds**, now that milestone A has shipped it: a short
comment header saying what the thing is and that push access is what makes it
membership, then three labelled lines — `handle:`, `key: x25519 <base64>`, and
`added:`. The key is base64 of the raw 32 bytes, not PEM and not a hex blob,
because this file is read in a diff far more often than it is read by a parser
and a reviewer should be able to see at a glance that a person was added and
which key they were added with. The parser forgives reordering, comments, blank
lines and labels it has never heard of, and refuses anything it cannot read
exactly — a guess here is a stranger in the roster
(`src/main/teamwork/memberFile.test.ts`).

**A handle is lowercase**, drawn from `[a-z0-9._-]`, at most 48 characters, and
derived from the local part of `git config user.email` unless someone sets their
own. The lowercasing is not cosmetic and is the reason this is written down:
macOS folds `Ana.pub` and `ana.pub` into one file and Linux does not, so a
mixed-platform team could otherwise end up with a roster that disagrees with
itself about how many people are on it. Windows device names are refused outright
for the same family of reason — `nul.pub` cannot be created there whatever the
extension, and a member file the whole team can read except one person is not a
roster (`src/main/teamwork/handle.test.ts`).

**Two people joining at once is the first thing a real pair hits.** Both commit a
key onto the same base, and the second push is rejected. This is not a merge
conflict and should not be presented as one: the two keys are different files and
git merges them without complaint. The resolution is `git pull --rebase` and push
again. It is worth saying because the failure arrives as a scary-looking push
rejection at the exact moment two people are first trying to work together.

The consequences are worth stating plainly:

- **Revocation happens at git-fetch speed.** Deleting a key removes someone at
  the next fetch, not instantly, and it removes them from each peer separately
  as that peer fetches. A teammate who has not pulled still opens a link to the
  removed member and still accepts everything a member may do. For a stronger
  guarantee the peers would have to agree on a revocation feed, which is a
  service, which is the thing this design is avoiding.
- **A repository you can push to is a repository whose members you can rewrite.**
  That is already true of everything else in it. It is worth saying in the other
  direction too: any member with push can add any key, including a key belonging
  to somebody the rest of the team has never heard of, and nothing in the app
  says a word about it — see Risks.
- **One installation, one key.** Copying `identity.key` to a second machine does
  not put a second machine on the team; it puts one identity on two machines,
  both computing the same rendezvous and displacing each other on it. A second
  machine generates its own key and joins under its own handle; two member files
  for one person is the intended shape.
- **A key that is gone leaves a member file that has to go with it.** A machine
  that loses `identity.key` — a new laptop, a reinstall, a file that no longer
  parses — starts again with a new keypair and no claim on its old entry, and
  that entry is not inert: every teammate goes on opening a link to a key nobody
  holds, which never connects and never can. Deleting it is part of re-joining.
  `docs/trying-teamwork.md` has the steps, because the app's own advice at that
  moment points the other way.

### The relay is a dumb pipe the team runs

Two machines behind two NATs cannot reach each other. So neither tries: **each
opens an outbound WebSocket to a relay, and the relay splices the two streams
together**. Outbound-only means no port forwarding, no STUN, no public address.

The relay is **hosted by the team, never by us**. There is no service to sign up
for and nothing of ours to depend on, which also means no baked-in default URL:
a team that has not stood one up has no relay, and the app must say so rather
than quietly reaching somewhere.

There are two ways to stand one up, and both are supported because they fail in
different directions, so both are a button in the setup panel rather than one
button and a paragraph of prose. A team can **deploy the Worker to their own
account**, which is one command, needs no server, and works from anywhere
because both peers dial out to it. Or they can **run the relay themselves** on a
box, a NAS or a laptop — direct if everyone is on one network, and needing a
tunnel or a port forward to cross the internet.

The second is the one to reach for if a team will not use a hosted runtime, or
is on one network anyway, and it is not the one to lead with, because a relay on
a laptop re-inherits the NAT problem the relay exists to solve and goes away when
the laptop sleeps. **That limitation is said where the choice is made**, not in a
document: an option whose failure is "nobody ever connects and neither machine
says why" is worse than no option unless the window states, at the moment it is
offered, exactly who it will and will not serve.

Two facts about a self-hosted relay belong with it, and are on screen for the
same reason. Plain **`ws://` is a first-class address** — the runtime dials it,
and content is encrypted end to end either way — so a team on one network needs
no certificate and no tunnel. And **the relay authenticates nobody**: anybody who
can reach the address can open a connection, though they cannot join a pairing
without a rendezvous token derived from two members' keys, and cannot read a byte
of what crosses it. On a private network that is nobody; on a public address it
is anybody, which is a thing to know before renting a server rather than after.

It is a small program with no database and no accounts, and it is deliberately
boring, because:

**The relay is never trusted with content.** Peers establish a
[Noise](https://noiseprotocol.org/) `IK` session over the spliced connection —
`IK` because each side already knows the other's static public key, from the
repository — and everything after the handshake is ciphertext the relay cannot
read. `src/shared/peer/session.test.ts` is where that is asserted, against the
published `IK` vector and then against every way a relay in the middle could
try to interfere with a transport message: replayed, reordered, truncated at
every offset, one bit flipped anywhere in it, or with bytes appended. It also
holds the property the splice depends on — that two different pairings are
mutually unintelligible, so a relay cannot cross two sessions.

A compromised relay cannot read, alter or forge content. It **can** do two
things, and an early version of this document wrongly said it could not. It can
drop frames or refuse to pair, which is denial of service and was always
conceded. And, because `IK`'s first message is inherently replayable and the
relay holds both that frame and the rendezvous token, it can replay a recorded
handshake — which, for as long as anything hung off the handshake having parsed,
forged a peer's *presence*: a session the other side believed was established and
authenticated to a colleague who was not there. It could never send a second
frame or read a byte.

**That fix is in, and this is where the property lives.** A session tells
`confirmed` apart from `established` and says so in its own API: `confirmed`
means a transport frame decrypted under keys derived from the initiator's
ephemeral *and* static private keys, which is exactly what a replayer of message
one does not hold, and it is what gates the call that names the peer — the
session will not tell anyone whose key it is talking to before then
(`src/shared/peer/session.ts`; `session.test.ts`, "does not confirm a peer on a
message it has only ever seen replayed" and "refuses to reveal a peer key or
transcript before either is authenticated"). Message one is allowed no payload
at all, so a replay carries nothing even in the window before it is thrown away
(`session.test.ts`, "cannot be asked to put anything in the first message, which
anyone who records it can replay", and the other direction, "refuses a first
message that arrives carrying a payload, whoever wrote it"). The link hangs
everything on that moment rather than on the handshake parsing: no `connected`
phase, no presence subscription and no snapshot until a frame decrypts, and the
handshake deadline reaps a session that never confirms rather than leaving a
replayer parked on a rendezvous (`src/main/teamwork/peer/peerLink.ts`;
`peerLink.test.ts`, "does not call a link connected until something from the far
end decrypts" and "gives up on a peer that completed a handshake it cannot
follow through"). Remote keystrokes are refused outright while a session is
unconfirmed (`src/main/runtime/peerTransport.ts`) — which is belt as well as
braces, because `receive` confirms before it routes anything at all, and
`peerTransport.test.ts`'s "key confirmation" holds that nobody who cannot
produce a valid transport message ever confirms. A replay still reaches
`established` on the responder — nothing can stop that, it is what "replayable"
means — but `established` is no longer a state anything is shown or done on.

Noise rather than a scheme of our own. A hand-rolled handshake is where this
kind of project gets its one unrecoverable bug.

What the relay does still learn is **who talks to whom, and when**. A team that
cares runs it themselves, which they are doing anyway.

### Everyone sees everything; anyone may ask to type

Within a project, all panes are visible to all members, and **any member may
type into any pane — once its owner allows it**.

*Within a project* is the load-bearing half of that sentence and it is the one
thing here that would be a breach rather than a bug. A teammate on one
repository's roster reaches that repository's panes and nothing else on the
machine, and asking about anything else answers exactly as asking about
something that has never existed — because a refusal that could be told apart
from "no such pane" is a way to enumerate somebody's machine from the far end of
a relay. `tests/security/paneScoping.test.ts` holds it for typing;
`tests/security/peerReachability.test.ts` holds it for the other five methods a
teammate can call, including the one that hands over a list without being asked
about anything in particular.

This is remote code execution, by design and by request. It is the feature: a
teammate who can see your agent stuck on a question can answer it. But it is
worth being exact about what it means — a member of the project can run
arbitrary commands on your machine, as you.

**This is the one decision here that has been reversed.** For a long time a
teammate's keystroke landed immediately, carrying attribution, and the owner's
only recourse was a mute after the fact. The argument was that a permission
model would be a lie at this granularity: everyone who can push can already run
anything, so a prompt would be theatre. That argument is about what a *hostile*
member could do, and it is still true. It is the wrong argument for the ordinary
case, which is not hostility but surprise — a colleague answering what they
think is a prompt in a pane that has moved on, an agent driven by somebody who
cannot see what yours is doing this second, a paste into the wrong window. Those
are not attacks and they still run as you. So:

**A keystroke from a teammate is held, not applied, until the owner says.**

- The write does not reach the pty. The bytes sit in the owner's runtime,
  the teammate's request stays open, and nothing has happened to the pane
  (`consent.test.ts`, "is held rather than answered, and nothing about it has
  happened yet"; `peerTransport.test.ts`, "runs nothing at all while a keystroke
  is held for the owner").
- The owner is shown **who** is asking, **which pane**, and **what** they are
  about to send — the actual bytes, rendered so that every control character is
  visible and none of them can act. An escape sequence is printed rather than
  obeyed, a return is drawn as a mark, and the characters that make text read
  backwards or disappear are named. The person being asked about does not get to
  paint the question (`writePreview.test.ts`; `consent.test.ts`, "shows the
  owner who, which pane, and what — rendered so it cannot act").
- The answers are **allow once**, **allow for this session**, **always allow
  this teammate in this pane**, and **refuse**. "This session" means that
  teammate in that pane until the runtime stops or their link drops. "Always"
  survives a restart, filed beside the mute against the pane's own record, and
  goes when the pane does (`consent.test.ts`, "a standing permission is the
  owner's and stays visible"; `src/main/store/workspaceStore.test.ts`, "drops
  the permission with the record it was about, so nothing has to be swept").
- **Allow once means what the owner was shown.** A burst grows while the prompt
  is up, so the answer carries the number of keystrokes on the screen that was
  read; anything that arrived after it stays held and asks again
  (`consent.test.ts`, "keeps a keystroke that arrived after the owner looked,
  and asks again for it").
- **A burst is one question.** Somebody typing `npm test` sends nine keystrokes,
  and nine prompts would be a prompt nobody reads — which is worse than no
  prompt, because it trains people to click through. Keystrokes from one
  teammate at one pane join the question already open, and the preview grows
  underneath (`consent.test.ts`, "a burst is one question").
- **Nothing waits forever.** A request nobody answers expires after a minute and
  the teammate is told that it expired, which is a different sentence from being
  refused. The person who typed always learns what became of it: allowed,
  refused, expired, or the link went — and one clause of that is an inequality
  rather than a code path, because the caller's own deadline has to outlast the
  owner's window or a teammate would be told nobody answered at the moment
  somebody did (`consent.test.ts`, "expires with a stated reason when nobody
  answers, rather than hanging"; `peerLink.test.ts`, "settles a keystroke that
  was in flight rather than holding it for ever";
  `tests/security/consentIsNotABypass.test.ts`, "a keystroke nobody will ever
  answer", for the runtime shutting down under a question and for the deadline
  ordering).
- **Mute still wins, and still answers instantly.** A muted pane refuses without
  a prompt, because a mute is that question already answered; muting also
  cancels anything waiting on that pane and lifts every permission on it
  (`consent.test.ts`, "a mute answers the question before it is asked").
- **Being allowed is permission to run, not a promise that running is still
  possible.** An allowed keystroke goes back through the whole judgment on its
  way out with exactly one step skipped — the asking — so a pane that exited or
  closed while the question was on screen refuses the owner's own yes, and the
  log says what happened rather than what was authorised. A teammate the roster
  drops mid-question does not get to be allowed at all: the revocation answers
  the question rather than leaving it up for somebody to click through
  (`tests/security/consentIsNotABypass.test.ts`, "what the owner's yes is, and
  what it is not").

None of this replaces the older half of the bargain, which is still the reason
any of it is survivable — **almost nothing can be done invisibly**. The word is
"almost" because one thing can, and it is named at the end of this list rather
than left for somebody to discover:

- **A pane somebody has a stream open on says so, and by whom**
  (`peerTransport.test.ts`, "what the owner is told about who is reading"). The
  exception is the last bullet.
- Typing is attributed live — the pane shows who is typing while they type
  (`peerService.test.ts`, "attributes her keystroke to her name on this
  project, live and in the log").
- **Every keystroke this machine judged is recorded locally**, with who and
  when, in a log the owner can read after the fact — allowed, refused, muted
  and expired alike, because somebody repeatedly asking is itself worth knowing
  (`consent.test.ts`; `tests/security/auditLogErasure.test.ts`). *Judged* is
  the exact word and it is narrower than "every keystroke that arrived": a
  teammate who types faster than `PEER_WRITES_PER_SECOND` is refused by the
  transport in front of the verdict, and so is a paste too large for the wire
  or a pane id longer than a pane id. Those are answered and never written
  down, on purpose — a flood the owner's disk faithfully recorded would be a
  flood of the owner's audit log, which is the one thing that log has to
  survive (`tests/security/remoteWriteRate.test.ts`;
  `tests/security/auditLogErasure.test.ts`, "refuses a write whose pane id is
  longer than a pane id, before anything is recorded").
- **Mute is instant and per-pane**, and it is the owner's, not a negotiation
  (`consent.test.ts`, "a mute answers the question before it is asked").
- A standing permission is listed wherever the mute is, because a permission the
  owner cannot see is one they cannot lift (`consent.test.ts`, "is shown to the
  owner beside the questions, so it can be lifted").
- **And the thing that is invisible: a scrollback read.** `terminal.read`
  answers a pane's retained output and leaves nothing behind, so a teammate who
  polls it instead of opening a stream never appears on the watched-by row.
  Reading was never gated and this changes nothing about who may look — see
  Risks — but it does mean the row above is a statement about streams and not
  about reading. Written down here, and pinned by
  `tests/security/peerReachability.test.ts` ("says nothing about a teammate who
  only reads the scrollback, which is the limit of the promise"), so that
  narrowing it back is a decision somebody makes rather than something that
  quietly stops being true.

Be clear about what the prompt is and is not. It is not a security boundary
against a member who means harm: they can be allowed once, legitimately, and
type anything. It is a boundary against *accident and inattention*, which is
what almost every bad keystroke actually is — and it is the one point at which
the owner gets to read what is about to run as them.

### Metadata flows by default, bytes flow on demand

The default is **automatic**: a teammate's worktrees and panes appear without
anyone subscribing to anything, because a sidebar you have to populate by hand
is a sidebar nobody populates.

But only the *metadata* is automatic — names, branches, pane states, the last
line each pane said. Actual terminal output flows **only for a pane somebody has
opened**. Ten people each streaming forty panes to each other is N² bandwidth
for output nobody is reading.

Per-pane mute overrides all of it in the owner's favour.

### What presence carries

Per worktree: its name, branch and state, and per pane the title, shell, label,
agent, whether it is running or busy, its size and how long it has been quiet.
While **Settings › Teamwork › Share Task Details** is on (the default), each
worktree also carries:

| Field      | What                                          | Bound          |
| ---------- | --------------------------------------------- | -------------- |
| `task`     | the task's first line                         | 200 characters |
| `parentId` | the worktree it is a child of                 | an id          |
| `paths`    | changed paths, repo-relative                  | 200 paths      |
| `ahead`    | commits ahead of its base                     | a number       |
| `stage`    | working, asking, stopped, ready, done, failed | one word       |
| `report`   | outcome and the summary's first sentence      | 300 characters |

Paths, never what is in them, and never a byte a pane printed:
`tests/security/presenceCarriesNoContents.test.ts` holds that against real git.
Off, only the fields in the first sentence cross. Receivers bound every field
again and drop a malformed one alone; a build older than the fields ignores
them. The local cache keeps what it heard under 1.5 MB, shedding the paths of
the teammate heard from longest ago first.

### Offline is stale, not absent

When a peer drops, **their worktrees stay in the sidebar, marked stale**, with
the age of what is shown. Each peer keeps a local cache of what it last saw.

Rows vanishing when a laptop closes would make the sidebar a liveness display
rather than a picture of the project, and "it disappeared" reads as "it was
deleted" — which, for a worktree, is the one thing it must never wrongly say.

A peer **drops when this machine stops hearing from them**, not when a socket
closes. A suspended laptop leaves its connection open on both hosts, and neither
relay host will end it for us: the Worker host cannot send a protocol ping from
a Durable Object, and its idle timer is defeated by the surviving peer, whose
keepalive refreshes the sleeping peer's idle clock. So the link carries a
deadline of its own — nothing successfully decrypted for two and a half
keepalive intervals, five minutes, and the link is over — and everything
downstream follows from the phase changing: the stale badge, the calls in
flight, and any pane being watched over it (`peerLink.test.ts`, "a teammate
whose machine stopped answering").

The cost is that a shut lid reads as present for up to those five minutes. The
alternative is worse in the direction that matters: a screen saying a colleague
is there when they are not is the same error as a vanishing row, pointed the
reassuring way, on the feature whose whole safety argument is that nothing can
happen invisibly.

**The shut lid may be this one.** A deadline measured on the wall clock cannot
tell a teammate who went quiet from a machine that suspended with the lid down,
which on a Mac is the ordinary case: the timers stop, the clock jumps by the
whole sleep, and the deadline fires on waking with five minutes of silence to
account for — the same wrong sentence as a vanishing row, pointed at whoever was
on the other end. So every deadline here is measured against a monotonic clock
as well as the wall clock, and a one-shot that comes back from a window this
process did not run through concludes nothing about anybody: the link says **this
machine was asleep, so nothing is known about your teammate until this link is
back**, and goes and re-establishes it. The rows go stale and dated in the
meantime, exactly as they do for a teammate who really did leave, because
"unknown" is what both of them are. Where there is an Electron to ask,
`powerMonitor`'s `resume` starts the same thing at once instead of at the next
deadline; there is no Electron in the acceptance suite or the CLI, which is why
it is an accelerator and never the mechanism (`peerLink.test.ts`, "a machine
that was asleep itself", which holds both directions: a sleep is not evidence
about the teammate, and a teammate who really did stop answering is still said
to have).

## Risks

Recorded now, so none of them is a surprise later.

- **RCE is the feature.** Held for the owner's consent, attributed, recorded,
  and stoppable with a mute — but a member who is allowed can run anything, and
  allowing is one click. The prompt catches accidents; it does not make a
  teammate you should not have added safe. Anyone deploying this should know it
  about their team.
- **A prompt people are shown too often is a prompt they stop reading.** The
  reason bursts are gathered, the reason "allow for this session" exists, and
  the reason "always allow" is offered at all: a question asked once per
  keystroke would be answered by reflex, which is worse than not asking. The
  cost of that choice is real — "always" is a standing grant to run anything in
  that pane, and it survives restarts — and it is why it is listed beside the
  mute where the owner can see and lift it.
- **Revocation is eventually-consistent**, bounded by fetch interval. What it
  is not is deferred: once this machine has re-read the roster, the removed key
  is refused at the next keystroke and the next read, its links are dropped, and
  any question it left on the owner's screen is answered rather than left there
  (`tests/security/paneScoping.test.ts`, "is refused at the next keystroke once
  its key leaves the roster"; `tests/security/peerReachability.test.ts`, for
  presence; `tests/security/consentIsNotABypass.test.ts`, for the question).
- **The relay sees the social graph** even though it sees no content.
- **Terminal dimensions belong to the owner.** A watcher with a smaller window
  gets letterboxed rather than resizing someone else's PTY under a program that
  is only being read. `terminal.resize` is not a method a teammate can call and
  `peerTransport.test.ts` asserts its absence by name.
- **A muted pane still exists.** Mute stops the bytes; it does not hide that the
  worktree is there. Hiding it would make mute a way to work unobserved on a
  shared project, which is a different feature and probably a worse one.
- **Membership is one level, and reading is not gated at all.** There is no
  read-only member: the allow-list a teammate reaches carries `terminal.write`
  beside `terminal.read` (`peerTransport.test.ts`, "lets a teammate read a pane
  and type into one, and reach nothing else"). What the owner controls is
  writing — the prompt, the standing permissions and the mute all gate
  keystrokes and deliberately gate nothing about who may look. A member of the
  project can read every pane in it and always could, and a member who reads by
  polling `terminal.read` rather than by opening a stream is not shown on the
  watched-by row at all.
- **The private key is a file, and everything on this machine runs as you.**
  `identity.key` is mode 0600 in the app's data directory, which keeps it out of
  a repository and away from other accounts on the machine. It is not protected
  from anything already running as you — and this product exists to run coding
  agents in ptys owned by that same account, and hands every teammate the
  ability to type into them. So an agent, a command a teammate types, or an
  `npm install` in a worktree can read that file and be that member from then
  on, on every project that member is on rather than only the one it was read
  from. Nothing distinguishes a copied key from the original, and there is no
  revocation short of a roster commit. This is inherent rather than an
  oversight: push access is the trust boundary, and everyone inside it can
  already run commands as everyone else. The same is true of the CLI socket, for
  the same reason and with the same answer — `docs/local-access.md` is that
  boundary written down, and it is the local one rather than this document's.
- **A roster change is silent.** Nothing announces that somebody was added. A
  new key becomes another teammate in the **Teamwork** panel and another
  link in the header's count, indistinguishable from a colleague who was always
  there. The only control is somebody reading the diff, so a team that wants
  this watched should watch `.teamree/members/` where it changes — in review, on
  the branch the roster lives on.

## Milestones

Each is useful finished, and each is a strict prerequisite for the next.

### A — Identity, with no network at all

Generate the keypair, write the public half to `.teamree/members/<handle>.pub`,
read the directory, and show the project's members in the app. No sockets, no
relay, nothing to deploy. This is the whole trust model, testable offline.

### B — The relay, and presence

**Settled while building it:** the relay URL lives at `.teamree/relay`, committed
beside the member keys, with an environment variable overriding it for one run
and no default ever.

A relay is a team-wide fact, not a per-machine preference: everyone has to name
the same one or they never meet. Anywhere else is a second list to keep in step
with the first, which is the thing the identity design spends its whole argument
avoiding. So one person deploys a relay, pushes a one-line file, and the team is
connected — visible in a diff like every other decision here. The obvious
objection, that whoever can push can redirect the team, costs nothing already
conceded: `IK` authenticates both static keys, so a relay someone redirects you
to can still only refuse to pair or drop frames. The override exists for the
ephemeral tunnel URL the relay's own documentation describes — a thing to try,
not a thing to commit, so it lives somewhere that dies with the process.

Two more decisions the build forced, recorded because neither was in this
document and both had to be invented:

**What makes two checkouts the same project** is the SHA-256 of the normalised
origin remote. This document said teammates' worktrees appear "under the same
project" without ever saying what that meant, and project ids are per-
installation. A project with no origin is honestly non-participating rather than
quietly matching nothing.

Most origins are URLs, and for those the normalisation is forgiving on purpose:
scheme, credentials, port, a trailing `.git` and the case of the host all go, so
one person cloning over ssh and another over https are on the same project
without having agreed on anything. What is left is host and path, which is a
fact about a server both machines can name.

**A repository shared over a filesystem path is a project too, on the terms a
path can support.** A team whose remote is a bare repository on a mounted volume
or a file server is an ordinary team, and refusing them was a real hole. What
they have instead of a server to name is a path, and a path is a fact about a
*mount*: nothing readable from either Mac can show that `/Volumes/team/app.git`
here and `/Users/ada/mnt/team/app.git` there are one directory. There is no
third party to ask, and a volume UUID or an inode answers a question about this
machine rather than about the repository two people share. So the identity is
the path itself and the promise is exactly this:

> **Both Macs have to reach the repository at the same absolute path, spelled
> the same way.** Same path, same project. Different paths, two projects — and
> neither machine ever sees the other.

That is a narrow promise, and it is kept rather than approximated. It is why so
little is normalised away from a path: repeated slashes, a trailing slash and a
`.` segment go, because those name the same directory on every filesystem there
is, and nothing else does.

- **Case stays**, because macOS volumes are usually case-insensitive and are not
  always — APFS can be formatted case-sensitive, and a network volume answers to
  whatever is serving it. Folding case would merge `/Volumes/src/Repo` and
  `/Volumes/src/repo`, which on such a volume are two repositories. Two
  teammates who spell it differently not meeting is a bad afternoon; two teams
  quietly becoming one is a breach, and that is the one that must not happen.
- **A trailing `.git` stays**, because on a disk `app` and `app.git` are two
  directories and a bare repository beside a working checkout is exactly how
  people lay this out. The convention that makes them one repository belongs to
  hosting services, not to filesystems.
- **The Unicode form of a name stays**, for the same reason case does. Paste the
  path you were given rather than retyping it.
- **Symlinks are not resolved, and a `..` segment is refused** rather than
  folded. Collapsing `a/link/../b` lexically names a different directory the
  moment `link` is a symlink, and resolving it for real would make the identity
  a fact about one Mac's disk instead of about the string both people hold.
- **A relative path and a `~` are refused outright**, with what to type instead.
  Neither can name one directory on two machines, so neither can be an identity.

**A path can never be hashed to a URL's key.** A normalised URL is `host/path`
with a host in it, so it never begins with a slash; a normalised path always
does. That leading slash is the whole namespace — and it costs nothing, because
every URL's key is byte-for-byte what it was before paths were allowed here. A
project key that quietly moved would be a team that quietly stops meeting.
Both halves are in `projectKey.test.ts`: "keeps a path and a URL apart even when
they read alike", and "has not moved for a URL now that a path can have one
too", which pins the key of a known origin against its literal digest. The
refusals that keep a path an identity rather than an approximation — a relative
path, a `~`, a `..` segment — are beside them.

**A path is never a default.** If `origin` is a URL, none of the above applies
to it.

What none of this can do is notice the mismatch. Two machines that hash
different keys do not fail to connect; they compute different rendezvous points,
never look for each other, and both read "nobody is here yet" for as long as
anybody is willing to wait. So the product says the condition out loud at the
three moments it can: the field that sets a path origin prints the exact string
it will hash and what the other person has to match, the invitation names the
path to mount at, and the **Connected** step, while it is waiting, says that
this project is matched by its mount path and that a teammate anywhere else will
never appear.

**A teammate reaches an allow-list, not the whole method catalogue.** The
transport can carry anything the runtime answers, which includes
`worktree.remove` and `project.remove`. "Everyone sees everything; anyone can
type" is a statement about panes, and reading it as a licence to delete a
colleague's worktree would be a stretch nobody intended — but the document did
not say so, and an allow-list is the difference between a decision and an
oversight. The list is asserted whole, and each entry names the project check it
goes through, so widening it stays a deliberate edit to one line rather than a
side effect of registering a handler (`peerTransport.test.ts`, "lets a teammate
read a pane and type into one, and reach nothing else" and "says of every
admitted method which project check it goes through"). A method that is off the
list is answered exactly as a method that was never written, so the catalogue
cannot be enumerated by asking for everything and reading which refusals differ
(`tests/security/peerReachability.test.ts`).

The relay itself; outbound connections from each peer; the Noise `IK` handshake
against keys from the roster; teammates' worktrees appearing in the sidebar with
their branches and pane states. No terminal output yet.

### C — Watching a pane

`terminal.subscribe` over the peer transport. Opening a teammate's pane streams
it; closing it stops. Read-only, letterboxed to the owner's dimensions. The
pane says it is being watched, and by whom.

### D — Typing into a pane

`terminal.write` over the same transport, with live attribution, the local audit
log, and per-pane mute. This is the milestone that needs the most care, because
it is the one that hands somebody else a shell.

### E — Staleness

The local cache, the stale marking with its age, and reconnection that
reconciles rather than re-fetching the world.

### F — The owner's consent

The reversal. A teammate's keystroke is held on the owner's machine until the
owner has been shown it and has answered: `terminal.write` gets a verdict that
is neither yes nor no but *held*, and nothing reaches the dispatcher — and
therefore nothing reaches the pty — until that promise settles.

What it added: `teamwork.requests`, `teamwork.decide` and `teamwork.revoke` for
the owner, in the window and on the CLI; a preview that renders a teammate's
bytes so that every control character is visible and none of them can act; one
question per burst rather than one per keystroke; an expiry so nothing waits
forever and nobody is left wondering; and standing permissions, per teammate per
pane, the durable half of which is filed beside the mute so it comes back with
the pane it is about and goes when that pane does.

What it deliberately did not change: reading is not gated, attribution is still
live, the log still records everything the owner's machine decided — now
including what was refused and what expired — and the mute is still instant,
still the owner's alone, and still the answer that outranks all of this.

The suite that holds this milestone up is `consent.test.ts` for the clauses
themselves and `tests/security/consentIsNotABypass.test.ts` for the two that are
easiest to lose: that being allowed is not a bypass of the rest of the judgment,
and that every held keystroke ends in an answer whatever happens to the machine
holding it.
