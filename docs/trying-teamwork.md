# Trying teamwork

Two people, two Macs, one repository, and each one's worktrees visible in the
other's sidebar. This is the walkthrough: what to run, in what order, and what
you should see after each step.

`docs/teamwork.md` is why it is built this way. This is how to actually do it.

macOS is the supported platform, and CI builds nothing else. Everything below
assumes two Macs.

> **Nothing here has been done across two real machines yet.** The identity, the
> relay and the presence transport are built and tested — including two runtimes
> with separate data directories and separate identities talking over the real
> relay process on a real port — but that test is two peers on *one* computer.
> Where a step below has only ever been exercised that way, it says so. If you
> are the first pair to do this properly, the parts that surprise you are worth
> writing down.

## What actually works today

Be clear about this before you spend an afternoon on it, because what the
roster grants has changed and the change is the whole point of reading this.

**Working.** Your keypair and the roster. The relay. Outbound connections from
both machines and the Noise `IK` handshake against the keys in the repository.
A teammate's worktrees, branches and panes appearing in your sidebar without
either of you subscribing to anything. Opening one of their panes and reading
it live. Typing into it, attributed by name, recorded locally, and stoppable by
the owner at any moment. A teammate whose machine goes away leaving their rows
behind, marked stale and dated, rather than vanishing.

**Not exercised between two Macs in two places.** All of the above has been
driven between two runtimes through a real relay, with real Noise and real
PTYs, on one computer and in CI. Nobody has yet watched it work across a
network from two houses. That is what this document is for, and it is the one
claim here you should treat as untested rather than merely new.

**Known rough edges** are in `ROADMAP.md` under "Known gaps", kept honest and
worth a minute before you start.

> **Read this before you start. It is live now, not a promise about later.**
> Teamwork is remote code execution, deliberately. A person whose key is in
> `.teamree/members/` can type into a pane on your machine, which means running
> arbitrary commands as you. That is the feature — a teammate who can see your
> agent stuck on a question can answer it — and what makes it survivable is not
> a permission model, which would be a lie at this granularity, but that it
> cannot be done invisibly: the pane says it is being watched and by whom,
> typing is attributed live, every remote write is recorded on your machine
> with who and when, and mute is instant, per-pane and yours alone.
>
> So adding a key to this repository is not a formality and no longer grants
> only a view of worktree names. Add the keys of people you would hand an
> unlocked laptop to, because that is now exactly what you are doing.

## Two roles

One of you is the **leader** and the other is the **joiner**. This only says who
does each thing first. Neither of you hosts anything for the other, and the
roles have no meaning to the software — after setup you are two members of the
same project with identical powers.

## What you need

- A Mac each, with teamree on it. `docs/install.md` covers installing a build,
  including the unsigned-app warning and the exact way past it; from a checkout
  it is `npm install && npm run dev`.
- A git repository you can both push to. Push access *is* membership, so this is
  not a detail: whatever decides who can push is what decides who is on the
  team. It also has to be a repository each of you cloned — see step 2, because
  the thing that makes two checkouts "the same project" is the origin remote.
- A relay, which step 3 sets up. Neither machine needs an address, a port
  forwarded or a hole punched — both dial out to it.
- Node 20 or newer on both machines, for the example project.

## 1. Install teamree on both Macs

Read **[`docs/install.md`](install.md)** and follow it. Do not skip the part
about the quarantine attribute: nothing here is signed, macOS will refuse the
first launch, and that document explains what the warning is actually saying and
the one command that gets past it.

Open the app once on each machine before going further. The first run is what
generates your keypair — an X25519 pair written to the app's own data directory,
never to a repository — and step 4 needs it to exist.

## 2. Both get the example repository

There is a project in this repository that exists to be tried on:
`examples/ledger`, a small program that splits a shared bill. It has a test suite
that runs in a second, no dependencies to install, and `TASKS.md` lists three
pieces of work chosen so that three people can take one each without touching the
same file. That last part is what makes it worth using here — two agents in two
worktrees should be able to finish and both merge.

Each task has a test that fails today and passes when the task is done, so "done"
is a command either of you can run rather than a judgement, and the diff the
merge preview shows you has a green suite behind it. One task also has a question
in it that whoever takes it cannot answer alone: that is step 7, and it is the
thing you are really here to try.

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

**The `origin` remote is load-bearing and not a formality.** Project ids are
generated per installation and mean nothing to anybody else, so what teamree
uses to decide that your checkout and your teammate's are the same project is a
hash of the normalised `origin` URL. A project with no origin does not take part
at all, and says so rather than quietly matching nothing. Normalisation takes
care of the differences that do not matter — ssh against https, a port, a
trailing `.git`, the case of the host — so one of you cloning over ssh and the
other over https is fine.

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

The three task targets are deliberately outside that suite, and red:

```sh
npm run test:task1   # 5 of 6 failing, until somebody writes --json
```

That is the shape to expect: `npm test` green means you have broken nothing, and
one target test going green means somebody finished something.

## 3. Stand up a relay, and commit where it is

Two machines behind two routers cannot reach each other, so neither tries: each
opens an outbound WebSocket to a relay your team runs, and the relay splices the
two streams together.

> **Hand-off.** The relay is its own piece of work, with its own instructions.
> Follow **[`relay/README.md`](../relay/README.md)** for this step, then come
> back with its URL. The commands live there so that there is one copy of them
> and it is the one that is kept true.

Two paths, and that README covers both. Deploying the Worker to your own account
is one command, gives a permanent URL, and works from anywhere because both
peers dial out to it; start there unless you have a reason not to. Running the
container yourself works too, and is the answer for a team that will not use a
hosted runtime — but a relay on a laptop re-inherits the NAT problem the relay
exists to solve and goes away when the laptop sleeps.

What you need at the end of it is **one WebSocket URL**. It is not the address
the deploy printed: what you get is an `https://` host, and the relay endpoint is
that host with `/v1/relay` on it, spoken as `wss://`. teamree refuses an
`https://` URL rather than guessing at it, because guessing would work often
enough to be trusted and then fail on the one deployment where the relay is not
at the root — but the refusal now says what the corrected URL would be, so
pasting the address the deploy printed costs you a sentence rather than a
search.

### Write it into the repository

The relay goes in the repository, at **`.teamree/relay`**, beside the member
keys. There is no settings pane for it, and there is deliberately **no default
anywhere**: teams host their own, nobody hosts one for you, and a URL baked into
the app would be either a lie or a server this project was quietly asking you to
trust. A team that has not stood one up has no relay, and the app says so
instead of reaching somewhere.

It is in the repository for the same reason the roster is. A relay is a
team-wide fact, not a per-machine preference — everybody has to name the same
one or they never meet — and anywhere else is a second list to keep in step with
the first, which is the thing the identity design spends its whole argument
avoiding. One person deploys a relay, pushes a one-line file, and the team is
connected, visibly, in a diff.

**Whoever set the relay up** does it in the app, in the same **Members** dialog
step 4 uses: paste the URL into **Set the relay for this project** and press
**Write relay file**. That writes `.teamree/relay` — the same file, with the
same comment header — and stops there, exactly as adding your key does. The
dialog then names both files it has written and the one commit that covers them,
which is step 4's commit: you can do this step and the next one and push once.

Blank lines and `#` comments are skipped, the same way the member files' are;
the first line that is neither is the URL. It must be `ws://` or `wss://`, and
it carries no query string and no fragment.

**The other one**: `git pull`, and check you have the same file. The dialog
shows the URL in effect and where it came from, so the check is two people
reading the same line rather than two people reading two files. If you are each
pointing at a different relay you will never meet — and after an hour or two of
that, the project header's tooltip says so and names the two things to check.

There is one override, `TEAMREE_RELAY_URL` in the environment, and it is for a
single run of a single machine: it exists for the ephemeral tunnel URL that the
relay's README describes, which changes every time the tunnel restarts and is a
thing to try rather than a thing to commit. It beats the committed file when it
is set. Two cautions, both from how macOS works rather than from teamree: an app
launched from Finder or Spotlight does not inherit your shell's environment, so
the override only applies if you start teamree from the terminal that has the
variable set; and because it is per-machine it is exactly the second list this
design avoids, so use it to test a relay and then commit the real one. The
Members dialog says which of the two it is looking at — including *"No
`TEAMREE_RELAY_URL` in this app's environment"*, which is the answer to "I set
the variable and nothing happened".

## 4. Both add your key to the repository, commit it, and push it

Membership is a file. Your machine generated an X25519 keypair on first run; the
private half never leaves it, and the public half goes in the repository at
`.teamree/members/<handle>.pub`. There is no account to make and nobody to ask:
if you can push that file, you are on the team.

In the app, open the project's **Members** dialog — the button is in the project
header in the sidebar — and press **Add my key**.

Your handle defaults to the local part of `git config user.email` as configured
*in that repository*, lowercased and reduced to `[a-z0-9._-]`, at most 48
characters, so `Ada.Lovelace@example.com` files you under `ada.lovelace`. You can
type a different one. If git has no `user.email` there, teamree will not invent
a name for a file the whole team is going to read — it asks you to choose one. If
the handle you want is already somebody else's file, it refuses rather than
overwriting it.

The lowercasing is not cosmetic. macOS folds `Ana.pub` and `ana.pub` into one
file and Linux does not, so a team whose roster spelled handles freely could end
up disagreeing with itself about how many people are on it — and because a
member file's *name* is what decides whose key it is, a second spelling of a
colleague's handle would be a way to file your own key under their name, and
attribution is the whole mitigation for a feature that grants remote code
execution.

**Then commit it and push it, and this is the step people forget.** The app
writes the file and stops. It does not stage it, commit it or push it — not
because that would be hard, but because doing it for you would hide the only
step that means anything. A key nobody pushed is not membership; a key the app
pushed on your behalf would be a claim you never made.

The dialog prints these underneath, naming every file it has written — so if you
also set the relay in step 3, this one commit carries both:

```sh
cd ~/teamree-example
git add .teamree
git commit -m "Add <your handle> to the team"
git push
```

### When the second push is rejected

You will both do this at roughly the same moment, and the second one to push
will be turned away:

```
 ! [rejected]        main -> main (fetch first)
error: failed to push some refs to '<your repository>'
hint: Updates were rejected because the remote contains work that you do not
hint: have locally.
```

**This is not a merge conflict, and it should not be treated as one.** You each
added a different file; git merges them without an opinion. What happened is
only that you both committed onto the same base and one of you got there first.
The answer is to rebase onto what is now there and push again:

```sh
git pull --rebase && git push
```

It is worth writing out because it arrives as a scary-looking rejection at the
exact moment two people are first trying to work together, and because the
instinct it provokes — force-pushing, or "resolving" a conflict that does not
exist — is the wrong one.

When it has worked, both of you should see both files:

```sh
git pull && ls .teamree/members/
```

Both handles, or you are not done. If your own key is missing after a pull, you
never pushed it. If your teammate's is missing, they never pushed theirs — and
no message on your machine will ever say so, because your machine has no way to
know they meant to.

## 5. Both open the project

Add `~/teamree-example` as a project in teamree on both machines, the same way
you would add any repository.

There is nothing to restart. teamree watches `.teamree` in each project's
primary checkout, so a pull that brings in your teammate's key or the relay file
reaches the app by itself: the roster is re-read, the links are rebuilt against
it, and the project header moves. Opening the Members dialog re-reads both
files as well, which is the belt-and-braces half of the same thing — and if the
watch could not be set up at all, that is the dialog that says so rather than
letting a list nothing is following look as live as one that is.

Open the Members dialog on both machines. You should each see two entries, one
of them marked as you. That part reads the directory and needs no network at
all, so it is a clean check on step 4 before you blame anything on the relay.

Then look at the project header in the sidebar, which says in one phrase what
teamwork is doing. The ones you will see are:

- **Teamwork off** — nothing is set up here, and the tooltip says which thing:
  no `.teamree/relay`, no `origin` remote, or a roster with nobody in it. This
  is the ordinary state of a project nobody has done this to, not a fault.
- **No teammates** — the roster has nobody in it but you.
- **Connecting…** — dialling.
- **Nobody connected** — the relay is reachable and no teammate's machine is on
  it. Normal when your colleague has not got there yet.
- **1 connected** — the one you are after, and it means a Noise session that
  authenticated against the key in the repository and has since been confirmed
  by a frame only the holder of the private half could have sent.
- **Relay unreachable** — this machine cannot get to the relay. Your teammate
  may be perfectly fine.
- **1 refused** — somebody answered on your rendezvous and was not who they
  should have been. This is the one that is worth reading the tooltip for.

## 6. The leader starts some work, and the joiner sees it

**Leader**: create a worktree — describe the task, pick an agent, pick what to
start from — and let the agent run. `TASKS.md` in the example has three real
ones; task 1, `--json` output, is the one to take here: the `spike/json-output`
branch already has a half-finished note about it to start from, and it is the
task with the unanswerable question in it. Give the agent the task and tell it to
run `npm run test:task1` until that passes.

You should see, on your own machine, what you always see: the worktree in the
sidebar, its pane underneath, a state dot and how long since it last said
anything.

**Joiner**: the leader's worktree appears in your sidebar, under the same
project, indented and tinted and with the leader's handle on the row. You did
not ask for it and there is nothing to subscribe to — a sidebar you have to
populate by hand is a sidebar nobody populates.

What arrives so far is metadata only: the worktree's name, its branch, its
state, its panes and how long each has been quiet. No terminal output has
crossed yet, and none will until somebody opens a pane — ten people each
streaming forty panes at each other is bandwidth spent on output nobody is
reading. Silence crosses as a *duration* rather than a timestamp, because the
two machines do not agree about what time it is, and your machine adds what has
elapsed since it heard.

## 7. The joiner reads the pane, and then answers it

**Joiner**: open the leader's pane. The scrollback arrives first and the live
tail follows it, each line exactly once, letterboxed to the leader's
dimensions — your window does not resize a PTY under a program you are only
reading.

**Leader**: your own pane now says it is being watched, and by whom, by the
handle their key is filed under in `.teamree/members/`.

Now the part the whole design is for. Wait for the agent to stop on the question
task 1 puts in front of it, and have the **joiner type the answer into the
leader's pane**.

The question is marked **Ask first** in `TASKS.md`, and it is real: under
`--json`, what happens to a ledger that does not parse — today's message on
stderr with nothing on stdout, or a JSON error object on stdout so the caller
only ever parses one format? Both are ordinary, nothing in the repository
prefers either, and the target test says nothing about it on purpose. The joiner
answers in one line, and the agent carries on. That is the ninety seconds the
whole feature exists for.

If the agent decides for itself instead of asking, that is worth writing down:
it is the sample failing to produce the moment, not the feature failing.

- The leader's pane names the joiner while they type, and goes on saying they
  typed there after they stop.
- The keystrokes reach a real shell on the leader's machine, as the leader.
- The leader can **mute that pane** at any moment, and the next keystroke does
  not land: the joiner is told, in the leader's own words, in the pane where
  their typing would have gone. A muted pane keeps streaming and keeps its row.
  Mute stops the bytes; it does not hide the work.
- On the leader's machine, `teamwork.writeLog` holds who typed, when, into
  which pane, how many bytes and how many submissions — and never what was
  typed. Input includes what a program deliberately does not echo, and a
  passphrase at an `ssh` prompt is not something a safety feature should be
  writing to disk.

Try muting deliberately, while the joiner is mid-sentence. Watching a refusal
arrive is the fastest way to believe the rest of it.

## 8. Finish the work

Nothing here is new — it is the single-user flow. The agent commits, the leader
checks whether the branch would merge into its base, and pushes. The joiner does
the same in their own worktree on a different task from `TASKS.md`. Both should
merge, because the tasks were chosen not to overlap.

Before either of you pushes, the same two commands each: `npm test` still 39
passing, and your own `npm run test:task<n>` now passing. Two green targets and
two branches that merge is the whole claim of this walkthrough, and it is
checkable in about two seconds.

**Leader**: close your laptop, or quit teamree, and watch the joiner's sidebar.
Your worktrees stay where they were, marked stale and dated, rather than
vanishing — a row disappearing reads as a worktree deleted, and for a worktree
that is the one thing this display must never wrongly say.

`docs/teamwork-scenario.md` is the whole story written as steps with expected
observations, and `tests/teamwork/scenario.test.ts` is that document as a
test.

---

## Trying it without a second machine

Most of the debugging will happen on one machine, because one machine can be
restarted a hundred times and put under a debugger.

The peer transport's own suite already does the interesting version of this:
`src/main/teamwork/peer/relayProcess.test.ts` runs the real relay as a child
process on a real port and puts two runtimes, with their own data directories
and their own identities, through real WebSockets and a real Noise handshake. It
needs the relay built, and says so and skips if it is not:

```sh
cd relay && npm install && npm run build
```

There is also a harness that stands up two runtimes with two clones, two
identities and two home directories, puts them on a relay of its own, and tears
all of it down afterwards:

```sh
node scripts/teamwork/two-peers.mjs --keep
```

It runs the whole of step 4 and step 5 for you: each runtime generates its own
keypair, joins the roster through the same `members.join` the **Add my key**
button calls, and the pair meet over a relay child process on a port the OS
picked. `--keep` leaves them up with the CLI commands to drive each one.

`tests/teamwork/scenario.test.ts` is this document's step 6 through step 8
driven through that harness, including the two that are not about the happy
path. It is the closest thing to doing this by hand that does not need a second
Mac.

---

## When it does not work

### Your teammate's key is not in `.teamree/members/`

This is the most common failure by a wide margin, and it is worth checking
before anything else, because nothing else reports it clearly. Membership is
push access: a key that is written but not committed, or committed but not
pushed, makes you a member of nothing.

```sh
cd ~/teamree-example && git pull && ls .teamree/members/
```

Both handles, or you are not done. The app follows that directory, so what is
in it is what the Members dialog shows within a moment of the pull finishing —
and opening the dialog re-reads it in any case. If the dialog shows two people
and the header still says **No teammates**, that is worth reporting: it is the
one shape of this failure the app is supposed to have stopped being able to
have.

If a key is in the directory and not in the dialog, the dialog will name the
file and say why it was skipped — a name that is not exactly `<handle>.pub`, a
file whose contents name somebody other than its filename, two files with one
key. One bad file costs one member and never the list.

Related: revocation works the same way and at the same speed. Deleting a key
removes somebody at the next fetch that brings the deletion in, not instantly.
There is no revocation feed, because a revocation feed is a service, and
avoiding services is the entire design.

### There is no relay, or nobody committed one

The header says **Teamwork off** and the tooltip says *no `.teamree/relay` in
this project, so teamree does not know which relay your team meets on*. That is
the ordinary state of a project nobody has done step 3 to, and it is what you
get instead of the app quietly connecting to somebody else's server.

```sh
cd ~/teamree-example && git pull && cat .teamree/relay
```

Both of you, and compare the strings exactly, scheme included — or open the
Members dialog on each machine, which shows the URL in effect and which of the
two places it came from. If one of you has the file and the other does not,
somebody did not push. If it says the scheme is `https`, not ws or wss, you
pasted the address the deploy printed rather than the endpoint — add `/v1/relay`
and make it `wss://`, which is what the dialog says back to you if you paste it
there. If you set `TEAMREE_RELAY_URL` earlier to test a tunnel and forgot, it is
still winning over the file in whatever process inherited it; the header's
tooltip says `(from the environment)` when that is what happened, and the
dialog names the variable and its value.

### The relay is not reachable

Both of you should check the URL the same way — if one of you can reach it and
the other cannot, you have learned which end the problem is at, which is most of
the answer. The header distinguishes these for you: **Relay unreachable** is
this machine failing to get there, while **Nobody connected** means you are on
the relay and your teammate is not.

On the deployed path a wrong URL is the usual cause. On the container path,
check the relay is running — it answers `/healthz` over plain HTTP — and that
you are using an address the *other* machine can reach, not `localhost`, which
on your teammate's Mac is your teammate's Mac.

Nothing here involves inbound connections to either of your machines, so if you
find yourself opening a port on a laptop, something has gone wrong further back.

### The project has no `origin` remote

The header says **Teamwork off**, and the tooltip says *this project has no
origin remote, so teamree cannot tell it is the same repository your teammates
have*. This is the honest answer rather than a fault: what makes two checkouts
the same project is a hash of the normalised origin URL, so a checkout with no
origin cannot be matched to anything.

```sh
cd ~/teamree-example && git remote get-url origin
```

It catches the leader most often, because `init-example-repo.mjs` makes a
repository with no remote and step 2 is where one gets added. A remote under any
other name does not count — teamree does not guess at which of several remotes
you meant, because two peers guessing differently would show each other nothing
and say nothing about why.

### Your clocks disagree

This one has a specific and confusing symptom, so it is worth knowing the shape
of it. Two peers find each other by deriving a rendezvous token from the
Diffie-Hellman between their two keys, the project, and **the current hour**.
The token rotates hourly so that no stable identifier accumulates against a
pair, and neither side guesses at neighbouring hours: pairing with whoever
answered on a token derived from a different epoch is not a thing teamree will
do to paper over a wrong clock.

So if your clocks are far enough apart to straddle the boundary, you are each
waiting at a different address and both of you see **Nobody connected**. A peer
still waiting when the hour turns re-registers under the new token by itself —
so the shape of a small skew is intermittent: you meet for most of the hour and
lose each other for about as long as the skew, around the boundary, and it
clears itself. A skew of more than an hour means you never meet at all.

The app cannot diagnose this, and neither can the relay: to the relay a
rendezvous nobody answers and a rendezvous nobody else ever computed are the
same 32 opaque bytes, which is the design working. What the app does know is how
long it has waited, so a link that has waited across two hourly rotations says
so in the header's tooltip and names the two things worth checking — the clocks,
and whether you both have the same `.teamree/relay`. It is a narrowing, not a
diagnosis, and it is deliberately not offered before then: a colleague making
coffee accounts for the first hour.

```sh
date -u
```

Run it on both machines. They should agree to within a few seconds. Turn network
time on — System Settings, Date & Time, "Set time and time zone automatically" —
rather than setting it by hand.

The same wrong clock is also why two people's accounts of what happened will not
reconcile, and why a git history can look impossible. Check it before you doubt
the accounts.

### A laptop slept, and then came back

Expect a delay, not a permanent failure. When a machine sleeps its socket dies;
both ends drop, and each of them retries with a backoff that doubles up to a
ceiling of a minute, with full jitter so a relay coming back does not get the
whole team at once. The reconnect is automatic and there is nothing to press —
but it can be up to a minute after the lid opens before the header says
**1 connected** again, and the first attempt after waking often fails on wifi
that has not reassociated yet.

If you are running the relay container on a laptop, the laptop *is* the relay:
it sleeps, it leaves the café's wifi, it gets carried to a meeting, and every
time it does, both of you drop. This is the main reason to prefer the deployed
path — not that it is faster, but that nobody has to keep a machine awake for
the team. The same goes for a relay reached through a tunnel: the tunnel is now
a thing that can be down independently of the relay.

### A teammate's worktrees vanished instead of going stale

They should not. A peer who drops leaves their worktrees where they were,
marked stale and carrying the age of what you are looking at, because a row
that disappears when a laptop closes reads as "it was deleted" — which for a
worktree is the one thing this display must never wrongly say.

So a row that *goes* means something different from a row that greys: their
key was taken off the roster, or the project was removed. If a teammate's rows
vanish while they are merely offline, that is a bug worth reporting rather than
something to work around. Check the project header — **Nobody connected** or
**Relay unreachable** says the same event in a place that is not guessing.

### The worktree is there, but the pane shows nothing

Metadata flows on its own and bytes flow on demand, so a pane you have not
opened has sent you nothing by design. Open it and the scrollback arrives
first.

If you have opened it and it stays empty, the pane may genuinely be quiet —
check the age beside it. If it is not quiet, note it: there is a known defect
where the first thing a pane says after a watch opens could be dropped under
load, recorded in `ROADMAP.md`, and a report that it happened to you on two
real Macs is more useful than the measurement we have.

### Your typing does not reach the pane

The owner muted it. That is not a failure and it does not need diagnosing: mute
is theirs, it takes effect on the next keystroke, and the refusal you see in
the pane is in their words. A muted pane deliberately keeps streaming and keeps
its row, so it looks exactly like an unmuted one apart from refusing you.

If there is no refusal at all and the keystrokes simply go nowhere, check the
project header first — a link that has dropped is the commoner explanation, and
it says so.
