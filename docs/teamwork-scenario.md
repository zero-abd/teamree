# The teamwork scenario

What a passing end-to-end teamwork test looks like, step by step.

There is one story, and it is the one `docs/teamwork.md` says the whole feature
is for: an agent stops with a question, and the person who can answer it is not
the person whose machine it is running on. Everything teamwork adds exists to
make the next ninety seconds possible.

`tests/teamwork/scenario.test.ts` is this document as a test, with the same step
numbers. The steps that can run, run. The steps that cannot are `it.todo` with
the assertion written above them in words — not skipped assertions, and not
assertions against a guess at an interface that does not exist yet.

## The cast

**ana** is the leader and **bo** is the joiner. The roles say who moves first and
nothing else; after setup they are two members with identical powers.

The project is `examples/ledger`. Its `TASKS.md` has three pieces of work chosen
not to overlap, and the agent in this story is taking task 1.

## Setup — they are on a team

**0. Both public keys are in the repository, and both have pulled.**

Not preamble. Under `docs/teamwork.md` the roster in git *is* the trust model:
`.teamree/members/ana.pub` and `.teamree/members/bo.pub` are what the Noise `IK`
handshake authenticates against. A scenario that skipped this would be testing
two people who are not on a team, and would pass for a relay that pairs anybody.

*Runs today.* Reading the directory needs no network.

## Act I — on ana's machine

Everything bo will eventually do remotely is done here locally first. When the
transport lands, the transport is then the only new variable — and a scenario
whose local half was never proved cannot tell a broken relay from a broken pane.

**1. ana opens a worktree and starts an agent in it.**

A worktree from `main`, and a pane running an agent on task 1. The pane prints,
and then stops with a question it needs answered.

*Runs today.*

**2a. The worktree and its pane are in ana's workspace.**

This is the metadata that has to reach bo in step 2: the worktree's name, its
branch, its panes and their states.

*Runs today.*

**2b. The change is announced, not polled for.**

A new pane raises an invalidation on the stream the GUI already runs on. bo's
sidebar filling itself is that same stream with a further source behind it, which
is why this is worth pinning down on one machine first.

*Runs today.*

**3a. The pane's output contains the question.**

What bo will read across the relay is what `terminal.read` returns here.

*Runs today.*

**4a. Typing into the pane reaches the program, and it answers.**

`terminal.write` is the same method bo will call across the transport. A teammate
is a third transport onto this catalogue, not a second catalogue, so this is
literally the same call with a longer wire.

*Runs today.*

## Act II — across the relay

**2. bo sees ana's worktree appear, unasked.**

It arrives in bo's sidebar with ana's branch name and the state of her pane. bo
subscribed to nothing: metadata flows by default, because a sidebar you have to
populate by hand is a sidebar nobody populates.

*Assert:* bo's view of the workspace contains a worktree owned by ana, with her
branch and her pane's state, and bo made no subscribing call to get it.

*Pending — milestone B.*

**2c. No terminal output has crossed the wire yet.**

The negative, and the one that protects the owner. Metadata is automatic; bytes
are not.

*Assert:* no terminal data has reached bo for a pane nobody has opened.

*Pending — milestone B.*

**3. bo opens the pane and sees the question.**

The scrollback first, then the live stream. It is letterboxed to ana's
dimensions, not resized to bo's: ana's terminal belongs to ana, and a program
being read should not be reflowed under it by a spectator.

*Assert:* bo reads the same question step 3a proved is there, and ana's PTY was
never resized.

*Pending — milestone C.*

**3b. ana's pane says it is being watched, and by whom.**

Half of what makes "anyone can type" survivable. Not a nicety, and not optional.

*Assert:* ana's pane reports a watcher, named as bo.

*Pending — milestone C.*

**4. bo types the answer, and the agent takes the task.**

*Assert:* the bytes reach ana's PTY and the program acts on them — the same
assertion as 4a, with a relay in the middle.

*Pending — milestone D.*

**5. ana sees bo attributed, live and afterwards.**

Two different promises, so two assertions. While bo types, ana's pane names bo as
the author. Afterwards, ana's local audit log has the write recorded with who and
when — a record she can read after the fact, on her own machine, without asking
anybody.

*Assert:* the live attribution names bo during the write; the audit log contains
the write, attributed to bo, with a timestamp.

*Pending — milestone D.*

**6. ana mutes the pane, and bo's typing stops arriving.**

Instant, per-pane, and ana's. Not a negotiation and not a request.

*Assert:* after the mute, a write from bo does not reach ana's PTY. The assertion
is about ana's PTY, not about bo being told no — what matters is that nothing
arrives, whatever bo's end believes.

*Pending — milestone D.*

**6b. The muted pane is still visible to bo.**

Mute stops the bytes. It does not hide that the worktree is there. Hiding it
would make mute a way to work unobserved on a shared project, which is a
different feature and probably a worse one.

*Assert:* ana's worktree is still in bo's sidebar after the mute.

*Pending — milestone D.*

## The two that are not about the happy path

**7. A peer whose key is not in the roster cannot complete the handshake.**

The one that proves the trust model rather than the plumbing. Without it, every
step above passes for a relay that pairs anybody with anybody.

*Assert:* a peer whose public key is absent from `.teamree/members/` fails the
Noise `IK` handshake and never reaches the method catalogue at all.

*Pending — milestone B.*

**8. ana goes offline, and her worktrees go stale rather than absent.**

*Assert:* when ana's runtime stops, her worktree stays in bo's sidebar, marked
stale, showing the age of what is displayed. It does not disappear: a row
vanishing when a laptop closes reads as "it was deleted", which for a worktree is
the one thing it must never wrongly say.

*Pending — milestone E.*

## What "passing" means

All of Act I, all of Act II, and both of the last two. Act I alone passing means
teamree still works single-user. It is Act II that means teamwork works, and step
7 that means it works only for the team.
