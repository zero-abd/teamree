# Teamwork

Everything below is decided. It is written down because the decisions constrain
each other — the identity scheme is what makes the relay untrusted, and the
relay being untrusted is what makes "anyone can type" survivable — and a
later change to one of them is a change to the others.

Nothing here is built yet. The milestones at the bottom are the order to build
it in, and each one is useful on its own.

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
never leaves the machine. The public key is committed to the repository at
`.teamree/members/<handle>.pub`.

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
exactly — a guess here is a stranger in the roster.

**A handle is lowercase**, drawn from `[a-z0-9._-]`, at most 48 characters, and
derived from the local part of `git config user.email` unless someone sets their
own. The lowercasing is not cosmetic and is the reason this is written down:
macOS folds `Ana.pub` and `ana.pub` into one file and Linux does not, so a
mixed-platform team could otherwise end up with a roster that disagrees with
itself about how many people are on it. Windows device names are refused outright
for the same family of reason — `nul.pub` cannot be created there whatever the
extension, and a member file the whole team can read except one person is not a
roster.

**Two people joining at once is the first thing a real pair hits.** Both commit a
key onto the same base, and the second push is rejected. This is not a merge
conflict and should not be presented as one: the two keys are different files and
git merges them without complaint. The resolution is `git pull --rebase` and push
again. It is worth saying because the failure arrives as a scary-looking push
rejection at the exact moment two people are first trying to work together.

The consequences are worth stating plainly:

- **Revocation happens at git-fetch speed.** Deleting a key removes someone at
  the next fetch, not instantly. For a stronger guarantee the peers would have
  to agree on a revocation feed, which is a service, which is the thing this
  design is avoiding.
- **A repository you can push to is a repository whose members you can rewrite.**
  That is already true of everything else in it.

### The relay is a dumb pipe the team runs

Two machines behind two NATs cannot reach each other. So neither tries: **each
opens an outbound WebSocket to a relay, and the relay splices the two streams
together**. Outbound-only means no port forwarding, no STUN, no public address.

The relay is **hosted by the team, never by us**. There is no service to sign up
for and nothing of ours to depend on, which also means no baked-in default URL:
a team that has not stood one up has no relay, and the app must say so rather
than quietly reaching somewhere.

There are two ways to stand one up, and both are supported because they fail in
different directions. A team can **deploy the Worker to their own account**,
which is one command, needs no server, and works from anywhere because both
peers dial out to it. Or they can **run the container themselves** on a box, a
NAS or a laptop — direct if everyone is on one network, and needing a tunnel or a
port forward to cross the internet. The second option is the one to reach for if
a team will not use a hosted runtime; it is not the one to lead with, because a
relay on a laptop re-inherits the NAT problem the relay exists to solve, and goes
away when the laptop sleeps.

It is a small program with no database and no accounts, and it is deliberately
boring, because:

**The relay is never trusted with content.** Peers establish a
[Noise](https://noiseprotocol.org/) `IK` session over the spliced connection —
`IK` because each side already knows the other's static public key, from the
repository — and everything after the handshake is ciphertext the relay cannot
read. A compromised relay can drop frames or refuse to pair, and that is the
whole of its power.

Noise rather than a scheme of our own. A hand-rolled handshake is where this
kind of project gets its one unrecoverable bug.

What the relay does still learn is **who talks to whom, and when**. A team that
cares runs it themselves, which they are doing anyway.

### Everyone sees everything; anyone can type

Within a project, all panes are visible to all members, and **any member can
type into any pane**.

This is remote code execution, by design and by request. It is the feature: a
teammate who can see your agent stuck on a question can answer it. But it is
worth being exact about what it means — a member of the project can run
arbitrary commands on your machine, as you.

What makes that survivable is not a permission model, which would be a lie at
this granularity, but **being unable to do it invisibly**:

- A pane being watched says so, and by whom.
- Typing is attributed live — the pane shows who is typing while they type.
- Every remote write is recorded locally, with who and when, in a log the owner
  can read after the fact.
- **Mute is instant and per-pane**, and it is the owner's, not a negotiation.

### Metadata flows by default, bytes flow on demand

The default is **automatic**: a teammate's worktrees and panes appear without
anyone subscribing to anything, because a sidebar you have to populate by hand
is a sidebar nobody populates.

But only the *metadata* is automatic — names, branches, pane states, the last
line each pane said. Actual terminal output flows **only for a pane somebody has
opened**. Ten people each streaming forty panes to each other is N² bandwidth
for output nobody is reading.

Per-pane mute overrides all of it in the owner's favour.

### Offline is stale, not absent

When a peer drops, **their worktrees stay in the sidebar, marked stale**, with
the age of what is shown. Each peer keeps a local cache of what it last saw.

Rows vanishing when a laptop closes would make the sidebar a liveness display
rather than a picture of the project, and "it disappeared" reads as "it was
deleted" — which, for a worktree, is the one thing it must never wrongly say.

## Risks

Recorded now, so none of them is a surprise later.

- **RCE is the feature.** Mitigated by attribution and instant mute, not by
  permissions. Anyone deploying this should know it about their team.
- **Revocation is eventually-consistent**, bounded by fetch interval.
- **The relay sees the social graph** even though it sees no content.
- **Terminal dimensions belong to the owner.** A watcher with a smaller window
  gets letterboxed rather than resizing someone else's PTY under a program that
  is only being read.
- **A muted pane still exists.** Mute stops the bytes; it does not hide that the
  worktree is there. Hiding it would make mute a way to work unobserved on a
  shared project, which is a different feature and probably a worse one.

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

**A teammate reaches an allow-list, not the whole method catalogue.** The
transport can carry anything the runtime answers, which includes
`worktree.remove` and `project.remove`. "Everyone sees everything; anyone can
type" is a statement about panes, and reading it as a licence to delete a
colleague's worktree would be a stretch nobody intended — but the document did
not say so, and an allow-list is the difference between a decision and an
oversight.

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
