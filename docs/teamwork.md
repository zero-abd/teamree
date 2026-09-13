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

The relay is **self-hosted by the team**. It is a small program with no
database and no accounts, and it is deliberately boring, because:

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
