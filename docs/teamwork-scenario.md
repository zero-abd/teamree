# The teamwork scenario

What a passing end-to-end teamwork test looks like, step by step.

There is one story, and it is the one `docs/teamwork.md` says the whole feature
is for: an agent stops with a question, and the person who can answer it is not
the person whose machine it is running on. Everything teamwork adds exists to
make the next ninety seconds possible.

`tests/teamwork/scenario.test.ts` is this document as a test, with the same step
numbers. All of it runs. Act II needs the relay built — `cd relay && npm ci &&
npm run build` — and says so and skips when it is not, because another package's
missing build is not a broken peer transport.

## The cast

**ana** is the leader and **bo** is the joiner. The roles say who moves first and
nothing else; after setup they are two members with identical powers.

The project is `examples/ledger`. Its `TASKS.md` has three pieces of work chosen
not to overlap, and the agent in this story is taking task 1.

Task 1 is the one carrying a question its implementer cannot settle alone —
`--json` output, and what it should do with a ledger that does not parse. The
task marks it **Ask first** and its target test says nothing about it, so an
agent that reads the requirement properly stops there. The test below uses a
shorter stand-in question, because what is under test is a question crossing two
machines and an answer coming back, not an agent's judgement about JSON.

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

Nothing here is a stand-in. The relay is the relay's own build, as a child
process on a real port; the crypto is real Noise between two identities the two
runtimes generated for themselves; the pane is a real pty. Only the distance is
faked.

**2. bo sees ana's worktree appear, unasked.**

It arrives in bo's sidebar with ana's branch name and the state of her pane. bo
subscribed to nothing: metadata flows by default, because a sidebar you have to
populate by hand is a sidebar nobody populates.

*Assert:* bo's view of the workspace contains a worktree owned by ana, with her
branch and her pane's state, and bo made no subscribing call to get it.

*Runs today.*

**2c. No terminal output has crossed the wire yet.**

The negative, and the one that protects the owner. Metadata is automatic; bytes
are not.

*Assert:* no terminal data has reached bo for a pane nobody has opened.

*Runs today.*

**3. bo opens the pane and sees the question.**

The scrollback first, then the live stream. It is letterboxed to ana's
dimensions, not resized to bo's: ana's terminal belongs to ana, and a program
being read should not be reflowed under it by a spectator.

*Assert:* bo reads the same question step 3a proved is there, and ana's PTY was
never resized.

*Runs today.*

**3b. ana's pane says it is being watched, and by whom.**

Half of what makes "anyone may type here" survivable — the other half being that
their first keystroke waits for ana to allow it. Not a nicety, and not optional.

*Assert:* ana's pane reports a watcher, named as bo.

*Runs today.*

**4. bo types the answer, ana is asked, and the agent takes the task.**

Nothing runs until ana says so. bo's keystroke crosses the relay, reaches her
machine and stops there: her runtime holds the bytes and shows her who is
asking, which pane, and exactly what was sent, with every control character
drawn rather than obeyed. The agent is still waiting while she reads it.

*Assert:* the request is waiting on ana, named as bo and naming her own pane,
with the preview of what he sent; her PTY has not moved. Then she allows it, and
only then do the bytes reach the PTY and the program act on them — the same
assertion as 4a, with a relay and a decision in the middle.

*Runs today.*

**5. ana sees bo attributed, live and afterwards.**

Two different promises, so two assertions. While bo types, ana's pane names bo as
the author. Afterwards, ana's local audit log has the write recorded with who and
when — a record she can read after the fact, on her own machine, without asking
anybody.

*Assert:* the live attribution names bo during the write; the audit log contains
the write, attributed to bo, with a timestamp.

*Runs today.*

**6. ana mutes the pane, and bo's typing stops arriving.**

Instant, per-pane, and ana's. Not a negotiation and not a request.

*Assert:* after the mute, a write from bo does not reach ana's PTY. The assertion
is about ana's PTY, not about bo being told no — what matters is that nothing
arrives, whatever bo's end believes.

*Runs today.*

**6b. The muted pane is still visible to bo.**

Mute stops the bytes. It does not hide that the worktree is there. Hiding it
would make mute a way to work unobserved on a shared project, which is a
different feature and probably a worse one.

*Assert:* ana's worktree is still in bo's sidebar after the mute.

*Runs today.*

## The two that are not about the happy path

**7. A peer whose key is not in the roster cannot complete the handshake.**

The one that proves the trust model rather than the plumbing. Without it, every
step above passes for a relay that pairs anybody with anybody.

*Assert:* a peer whose public key is absent from `.teamree/members/` never
reaches the method catalogue at all, on the same relay and in the same minute
that the two members on it are connected — and the same runtime connects the
moment somebody pushes her key, so what turned her away was the repository.

Writing it found that the refusal is earlier and harder than this document
assumed. It does not come from the `IK` handshake failing: a rendezvous is
derived from the static-static Diffie-Hellman between two keys, so a member
registers only at addresses their teammates can compute, and a stranger is
never spliced to anybody to be refused by. The handshake's own roster check is
the second line, for a relay that splices the wrong two connections. Both are
real; only the second is the one this step used to name.

*Runs today.*

**8. ana goes offline, and her worktrees go stale rather than absent.**

*Assert:* when ana's runtime stops, her worktree stays in bo's sidebar, marked
stale, showing the age of what is displayed. It does not disappear: a row
vanishing when a laptop closes reads as "it was deleted", which for a worktree is
the one thing it must never wrongly say.

*Runs today*, for the ending where the socket closes — quitting the app. The
other ending, a lid shut on a socket that stays open at both ends, is bo's own
silence deadline: nothing decrypted for two and a half keepalive intervals, five
minutes, and the link is over. That is asserted in
`src/main/teamwork/peer/peerLink.ts`'s own suite, against an injected clock,
because five minutes of real time does not belong in this scenario.

## What "passing" means

All of Act I, all of Act II, and both of the last two. Act I alone passing means
teamree still works single-user. It is Act II that means teamwork works, and step
7 that means it works only for the team.
