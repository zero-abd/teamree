# Trying teamwork

Two people, one repository, and each one's worktrees visible in the other's
sidebar. This is the walkthrough: what to run, in what order, and what you should
see after each step.

`docs/teamwork.md` is why it is built this way. This is how to actually do it.

> **Read this first.** Teamwork is remote code execution, deliberately. A person
> on this team can type into a pane on your machine, which means running
> arbitrary commands as you. That is the feature — a teammate who can see your
> agent stuck on a question can answer it — and what makes it survivable is that
> it cannot be done invisibly: the pane says it is being watched and by whom,
> typing is attributed live, every remote write is logged locally, and mute is
> instant and yours. Try this with people you would hand an unlocked laptop to.

## Two roles

One of you is the **leader** and the other is the **joiner**. This only says who
does each thing first. Neither of you hosts anything for the other, and the roles
have no meaning to the software — after setup you are two members of the same
project with identical powers.

## What you need

- teamree running on both machines, from source or installed.
- A git repository you can both push to. Push access *is* membership, so this is
  not a detail: whatever decides who can push is what decides who is on the team.
- A relay, which step 2 sets up. Neither machine needs an address, a port
  forwarded or a hole punched — both dial out to it.
- Node 20 or newer on both machines, for the example project.

## 1. Both get the example repository

There is a project in this repository that exists to be tried on:
`examples/ledger`, a small program that splits a shared bill. It has a test suite
that runs in a second, no dependencies to install, and `TASKS.md` lists three
pieces of work chosen so that three people can take one each without touching the
same file. That last part is what makes it worth using here — two agents in two
worktrees should be able to finish and both merge.

**Leader**, from a teamree checkout:

```sh
node examples/init-example-repo.mjs ~/teamree-example
```

That gives you a real git repository with six commits on `main` and a
`spike/json-output` branch, and a `.teamree/members/` directory waiting for keys.

Push it somewhere the joiner can also push to:

```sh
cd ~/teamree-example
git remote add origin <the repository you both can push to>
git push -u origin main spike/json-output
```

**Joiner**:

```sh
git clone <the same repository> ~/teamree-example
```

Both of you, check it works before going any further. If this fails, nothing
later will tell you anything useful:

```sh
cd ~/teamree-example && npm test
```

39 tests, about a second, and no network.

## 2. Set up the relay

> **Hand-off.** The relay is its own piece of work, with its own instructions.
> Follow **`relay/README.md`** for this step, then come back with its URL. The
> commands live there so that there is one copy of them and it is the one that is
> kept true.

Two paths, and the README covers both:

- **Deploy it to your own Cloudflare account.** One command, a permanent URL, and
  nothing to run or keep alive afterwards. It works from anywhere, because both
  peers dial out to it rather than to each other. Start here unless you have a
  reason not to.
- **Run the relay container yourself**, on a box, a NAS, a VPS or a laptop.
  Direct if everyone is on the same network; across the internet it needs a
  tunnel or a forwarded port.

Either way, what you need at the end of this step is **one URL, and both of you
have it**. Whoever sets it up sends it to the other.

The relay is deliberately dull, and it is worth knowing why before you decide
where to put it. It has no database and no accounts. It never sees your terminal
output: the two peers run a Noise `IK` handshake over it and everything after
that is ciphertext it cannot read. A compromised relay can drop frames or refuse
to pair you, and that is the whole of its power. What it does learn is who talks
to whom and when — which is the reason the team runs its own rather than using
somebody else's.

## 3. Both add your key to the repository

Membership is a file. Your machine has an X25519 keypair; the private half never
leaves it, and the public half goes in the repository at
`.teamree/members/<handle>.pub`. There is no account to make and nobody to ask:
if you can push that file, you are on the team.

> **Pending — milestone A.** Generating the keypair and writing it out is
> milestone A's, and is not built yet. The exact command goes here once it is.
> What it will produce is one file at `.teamree/members/<your-handle>.pub`
> containing your public key.

Then — and this is the step people forget — commit it and push it:

```sh
cd ~/teamree-example
git add .teamree/members/
git commit -m "Add <your handle> to the team"
git push
```

**Do this one at a time.** If you both commit a key onto the same base, the
second push is rejected, because you have diverged. It is not a conflict — you
touched different files — so the second person pulls with a rebase and pushes
again:

```sh
git pull --rebase && git push
```

When it has worked, both of you should see both files:

```sh
ls .teamree/members/
```

If you do not see your teammate's key here, nothing in the rest of this document
will work, and no error message anywhere will be about this. Fix it now.

## 4. Both point teamree at the project and the relay

Add `~/teamree-example` as a project in teamree on both machines, the same way
you would add any repository.

> **Pending — milestone B.** Where the relay URL is entered, and how a peer is
> told to dial it, belong to milestone B. The step goes here once it exists. What
> it will do is open an outbound connection from each of you to the relay, which
> splices you together; you then authenticate each other against the public keys
> from step 3, and a teammate becomes a third transport onto the same method
> catalogue the window and the CLI already use.

You should now see each other's names on the project's member list — that part
is milestone A and reads the directory from step 3, so it works with no network
at all. Seeing both names there is a good check on step 3 before you blame
anything on the relay.

## 5. The leader starts some work

**Leader**: create a worktree — describe the task, pick an agent, pick what to
start from — and let the agent run. `TASKS.md` in the example has three real
ones; task 1, `--json` output, is a good first choice because the
`spike/json-output` branch already has a half-finished note about it to start
from.

You should see, on your own machine, what you always see: the worktree in the
sidebar, its pane underneath, a state dot and how long since it last said
anything.

## 6. The joiner sees it

> **Pending — milestone B.**

**Joiner**: the leader's worktree appears in your sidebar. You did not ask for
it and there is nothing to subscribe to — a sidebar you have to populate by hand
is a sidebar nobody populates. What arrives is metadata only: the worktree's
name, its branch, its panes and their states, and the last line each one said.

No terminal output has crossed yet. That is on purpose: ten people each streaming
forty panes at each other is bandwidth spent on output nobody is reading.

## 7. The joiner opens the pane, and helps

> **Pending — milestones C and D.**

**Joiner**: open the leader's pane. Now the bytes flow, because somebody is
actually reading them. It is letterboxed to the leader's window rather than
resized to yours — the leader's terminal dimensions belong to the leader, and a
program being read should not be reflowed under them by a spectator.

**Leader**: your pane says it is being watched, and by whom.

**Joiner**: type. The agent's question gets its answer.

**Leader**: you see the joiner named as the author while they type, and it is in
your local audit log afterwards with who and when.

**Leader**: mute the pane. The joiner's typing stops reaching it immediately.
Mute is yours and is not a negotiation. The worktree is still in the joiner's
sidebar, because hiding it would turn mute into a way to work unobserved on a
shared project, which is a different feature and a worse one.

## 8. Finish the work

Nothing here is new — it is the single-user flow. The agent commits, the leader
checks whether the branch would merge into its base, and pushes. The joiner does
the same in their own worktree on a different task from `TASKS.md`. Both should
merge, because the tasks were chosen not to overlap.

That is the end-to-end pass. `docs/teamwork-scenario.md` is the same story
written as steps with expected observations, and `tests/teamwork/scenario.test.ts`
is that document as a test.

---

## Trying it without a second machine

Most of the debugging will happen on one machine, because one machine can be
restarted a hundred times and put under a debugger:

```sh
node scripts/teamwork/two-peers.mjs --keep
```

Two runtimes, two data directories, two identities, two clones of the example,
and a teardown that leaves nothing running. The relay and the peer transport are
a marked seam in it, so today it stands up everything except the distance.

---

## When it does not work

### Your teammate's key is not in `.teamree/members/`

This is the most common failure by a wide margin, and it is worth checking before
anything else, because nothing else reports it clearly. Membership is push
access: a key that is written but not committed, or committed but not pushed,
makes you a member of nothing.

```sh
cd ~/teamree-example && git pull && ls .teamree/members/
```

Both handles, or you are not done. If your own key is missing after a pull,
you never pushed it. If your teammate's is missing, they never pushed theirs —
and no message on your machine will say so, because your machine has no way to
know they meant to.

Related: revocation works the same way and at the same speed. Deleting a key
removes somebody at the next fetch, not instantly. There is no revocation feed,
because a revocation feed is a service, and avoiding services is the entire
design.

### The relay is not reachable

Both of you should check the URL from step 2 the same way — if one of you can
reach it and the other cannot, you have learned which end the problem is at,
which is most of the answer.

- **On the deployed path**, a wrong URL is the usual cause: check you are both
  using the exact string, scheme included.
- **On the container path**, check the relay is actually running and that you are
  using the address the other machine can reach, not `localhost` — `localhost` on
  the joiner's machine is the joiner's machine.

Nothing here involves inbound connections to either of your machines, so if you
find yourself opening a port on a laptop, something has gone wrong further back.

### It worked, and then stopped

If you are running the relay container on a laptop, the laptop is the relay. It
sleeps, it leaves the café's wifi, it gets carried to a meeting — and every time
it does, both of you drop. This is the main reason to prefer the deployed path:
not that it is faster, but that nobody has to keep a machine awake for the team.

The same applies to a relay on a home network reached through a tunnel: the
tunnel is now a thing that can be down independently of the relay.

### The two of you are not on the same network

Only matters on the container path, and only when you are reaching the relay
directly. Two machines that can both reach the relay do not need to reach each
other at all — that is the whole point of it — so "can they see each other" is
the wrong question. The right one is "can each of us, separately, reach the
relay".

### Your clocks disagree

A machine whose clock is badly wrong is a machine whose git history is confusing
and whose logs cannot be lined up with anybody else's, which turns a
five-minute diagnosis into an afternoon. If two people's accounts of what
happened will not reconcile, check this before you doubt the accounts:

```sh
date -u
```

Run it on both machines. They should agree to within a few seconds. Turn on
network time rather than setting it by hand.

### The worktree is there, but the pane is empty

Expected, until you open it. Metadata flows on its own and bytes do not; a pane
you have not opened has nothing streaming to you. Open it.

### A worktree is there but marked stale

> **Pending — milestone E.**

That means the peer dropped, and what you are looking at is the last thing you
saw, with its age. It is deliberately not removed: a row vanishing when a laptop
closes would make the sidebar a liveness display rather than a picture of the
project, and "it disappeared" reads as "it was deleted" — which, for a worktree,
is the one thing it must never wrongly say.
