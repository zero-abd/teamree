# Trying teamwork

Two people, two Macs, one repository, and each one's worktrees visible in the
other's sidebar. This is the walkthrough: what to run, in what order, and what
you should see after each step.

`docs/teamwork.md` is why it is built this way. This is how to actually do it.

macOS is the only platform with a published build. Everything below assumes two
Macs.

> **Nothing here has been done across two real machines yet.** All six
> milestones are built and tested — identity, the relay and presence, watching a
> pane, typing into one, staleness, and the owner's consent in front of every
> keystroke — including two runtimes with separate data directories and separate
> identities talking over the real relay process on a real port. But that test is
> two peers on *one* computer, and so is every other test behind this document:
> no step below has been exercised across a network. If you are the first pair to
> do this properly, the parts that surprise you are worth writing down.

## What actually works today

Be clear about this before you spend an afternoon on it, because what the
roster grants has changed and the change is the whole point of reading this.

**Working.** Your keypair and the roster. The relay. Outbound connections from
both machines and the Noise `IK` handshake against the keys in the repository.
A teammate's worktrees, branches and panes appearing in your sidebar without
either of you subscribing to anything. Opening one of their panes — in a pane of
your own, beside your work, as many at once as you like — and reading it live.
Typing into it, held on their machine until they have been shown it and have
allowed it, then attributed by name, recorded locally, and stoppable by the
owner at any moment. A teammate whose machine goes away leaving their rows
behind, marked stale and dated, rather than vanishing — after the link's own
five-minute silence deadline, which step 8 explains.

**Not exercised between two Macs in two places.** All of the above has been
driven between two runtimes through a real relay, with real Noise and real
PTYs, but on one computer. Nobody has yet watched it work across a
network from two houses. That is what this document is for, and it is the one
claim here you should treat as untested rather than merely new.

**Known rough edges** are in `ROADMAP.md` under "Known gaps", kept honest and
worth a minute before you start.

> **Read this before you start. It is live now, not a promise about later.**
> Teamwork is remote code execution, deliberately. A person whose key is in
> `.teamree/members/` can type into a pane on your machine, which means running
> arbitrary commands as you. That is the feature — a teammate who can see your
> agent stuck on a question can answer it — and two things make it survivable.
>
> The first is that **it waits for you.** A teammate's keystrokes are held on
> your machine until you have been shown who is asking, which pane, and the
> bytes themselves, and have answered: allow once, allow for this session, allow
> them in that pane from now on, or refuse. A request nobody answers expires
> after a minute and the teammate is told so. Muting a pane answers the question
> before it is asked, and lifts every permission on it.
>
> The second is that **none of it can be done invisibly**: the pane says it is
> being watched and by whom, typing is attributed live, every remote write your
> machine decided about is recorded with who and when — including the ones you
> refused — and mute is instant, per-pane and yours alone.
>
> The prompt catches accidents, which is what almost every bad keystroke is. It
> is not a wall against somebody you should not have added: once you allow them,
> they can run anything.
>
> So adding a key to this repository is not a formality and no longer grants
> only a view of worktree names. Add the keys of people you would hand an
> unlocked laptop to — you will be asked before their first keystroke runs, and
> "always allow" is one click away from handing it over for good.
>
> Your own identity is inside that grant. `identity.key` is an ordinary file
> owned by the same account every pane runs as, so a teammate typing into a
> pane, an agent working in one, or an `npm install` in a worktree can read it
> and be you — on every project you are on, not only this one, and with nothing
> to tell your teammates apart from the copy. Getting out of that means
> replacing your key in the roster, which is the recovery at the bottom of this
> document.

## Two roles

One of you is the **leader** and the other is the **joiner**. This only says who
does each thing first. Neither of you hosts anything for the other, and the
roles have no meaning to the software — after setup you are two members of the
same project with identical powers.

**The app asks which of the two you are, and it is the first thing it asks.**
Opening **Teamwork** on a project nobody has set up leads with two buttons —
*Start a Team* and *Join…* — and every step
after it is worded for the answer. It is not a permission or a role stored
anywhere; it is only which half of the work is left, so that the page can say
"your teammate is waiting for exactly this file" instead of writing every
sentence for both of you at once. The option the repository points at is the
primary button, with the reason under it — a `.teamree/relay` already in the checkout, a colleague's key
already on the roster — and neither is chosen for you. If you pick the wrong
one, **Not that** puts the question back.

## What you need

- A Mac each, with teamree on it. `docs/install.md` covers installing a build,
  including the unsigned-app warning and the exact way past it; from a checkout
  it is `npm install && npm run dev`.
- A git repository you can both push to. Push access *is* membership, so this is
  not a detail: whatever decides who can push is what decides who is on the
  team. It also has to be a repository each of you cloned — see step 2, because
  the thing that makes two checkouts "the same project" is the origin remote.
  A URL or a directory on a shared volume both work; step 2 says what each of
  them has to agree about.
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

**A card appears in the corner on that first run**, before you have done
anything else here, asking whether to put the `teamree` command on your PATH. It
is not part of teamwork and nothing below needs it; it is offered here because
it is the first thing you will see and because a question you did not expect is
worse than one you did. It takes no focus, the window works behind it, and it is
asked once whichever button you press — `docs/install.md` has what it does and
what it will ask for. Installed builds only: from a checkout nothing offers
itself.

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
hash of the normalised `origin` remote. A project with no origin does not take
part at all, and says so rather than quietly matching nothing. For a URL,
normalisation takes care of the differences that do not matter — ssh against
https, a port, a trailing `.git`, the case of the host — so one of you cloning
over ssh and the other over https is fine.

**If you share the repository over a mounted volume rather than a URL**, that
works too, on one condition: both Macs must reach it at the *same absolute
path*, spelled the same way — `/Volumes/team/example.git` on both, not
`/Volumes/team/example.git` on yours and `/Users/you/mnt/team/example.git` on
theirs. Nothing on either machine can tell that one volume mounted at two paths
is one repository, so the path is the identity, case and `.git` and all. Two
spellings are two projects and you will simply never see each other. The panel
prints the exact string it hashes when you set the origin, and the invitation it
writes for your teammate names the path to mount at; `docs/teamwork.md` has the
full rule, including what is and is not normalised away.

If you open **Teamwork** on a checkout that has no usable origin, the
panel says so at the top and puts an **Origin** field and an **Add origin**
button directly under the sentence, so the fix is where the problem is reported
rather than in another window. It takes either kind of answer, and refuses the
paths that could not be an identity for anybody — a relative path, a `~`, a path
with `..` in it — while you are still typing, saying which it is and what to
type instead.

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

One person does this, once, for the team. It is one command, it runs from any
directory, and **it does not need a clone of this repository** — the command
ships inside the app you installed:

```sh
/Applications/teamree.app/Contents/Resources/relay/teamree-relay deploy
```

That writes the Worker project into `~/teamree-relay` and deploys it to your own
Cloudflare account; a browser opens once to log you in, and then it prints the
`wss://` endpoint to paste below. You need a Cloudflare account and Node 20 or
newer — Wrangler, Cloudflare's deployment tool, is a Node program. If you are
working from a clone, the same command is `relay/teamree-relay deploy`.

> **Hand-off.** The relay is its own piece of work, with its own instructions.
> **[`relay/README.md`](../relay/README.md)** is the authority for this step —
> what it costs, what the operator can and cannot see, and how to change a
> limit. The command above is repeated here because it is one line; everything
> else about the relay lives there so that there is one copy of it and it is the
> one that is kept true.

**Take the Worker unless you have a specific reason not to.** It is one command,
a permanent address, and nothing to keep running; Cloudflare's free plan is
enough for a team, because a pair that is connected and quiet has its object
hibernated and costs nothing at all. The figures, and the date they were last
checked against Cloudflare's own page, are in that README.

**If you would rather run the relay yourself, that is now one command too:**

```sh
/Applications/teamree.app/Contents/Resources/relay/teamree-relay serve
```

It writes the relay into `~/teamree-relay-server`, builds it, runs it, and — the
part that matters — tells you who can and cannot reach it *before* it starts.
A relay on this Mac serves whoever can already reach this Mac: a team on one
office network, a mesh VPN, a rented server, or a tunnel in front of it. Two
laptops on two different home networks cannot meet on one, and that is the exact
problem a relay exists to solve, so the app and the command both say so rather
than letting you find out by having nobody connect. Plain `ws://` is fine for
this — teamree dials it without complaint, and what crosses a relay is encrypted
end to end either way.

And whichever way you got one, you can prove it answers before you commit it:

```sh
teamree-relay check ws://192.168.1.23:8787/v1/relay
```

That dials the address the way a peer does. It tells "nothing is running" apart
from "something else is on that port" apart from "the path is wrong", which are
three different evenings. It proves the machine you ran it on can reach the
relay and nothing more — a teammate on another network has to run it too.

What you need at the end of it is **one WebSocket URL**, and the command above
prints it ready to paste. If you got there another way — the container, or
`wrangler deploy` run by hand — what you have instead is an `https://` host, and
the relay endpoint is that host with `/v1/relay` on it, spoken as `wss://`.
teamree refuses an `https://` URL rather than guessing at it, because guessing would work often
enough to be trusted and then fail on the one deployment where the relay is not
at the root — but the refusal now says what the corrected URL would be, so
pasting the address the deploy printed costs you a sentence rather than a
search.

Both halves of that correction are required, and the app checks both: a `wss://`
URL with no path on it is refused the same way, with the same endpoint offered
back. The rendezvous id is appended to whatever you write, so a host on its own
dials a path no relay serves, and the 404 that comes back is indistinguishable
from a relay that is not there — which is how a healthy deploy gets reported as
unreachable on both machines at once.

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

**Whoever set the relay up** does it in the app, in the same **Teamwork**
panel step 4 uses — the **Teamwork** button in the project header opens it, and
step 3 of it is the relay.

That step leads with **Deploy a relay**, which runs the deploy that ships inside
teamree in a terminal pane inside the window: you watch it happen rather than
copying a command into Terminal.app, a browser opens once for the Cloudflare
sign-in, and when it finishes teamree reads the `wss://` URL it printed and
offers **Use this relay URL**. The command itself is still there, one disclosure
down, for anybody who would rather run it themselves — and the button is
disabled with a sentence when the build in front of you carries no relay
project. teamree still runs no relay of its own: it runs a deploy to your team's
own Cloudflare account, and nobody hosts one for you.

**Joiner**: if you chose *Join a team* and `.teamree/relay` is not in your
checkout yet, the step says so before it offers you anything — whoever set this
up has not got that far, and pulling in a moment is the answer. Only stand one
up yourself if the two of you have agreed that you are the one doing it. Two
relays is two halves of a team that never meet, and it looks like nothing being
wrong on either machine.

If you already have a URL, paste it into **Or paste a relay URL** and press
**Write relay file**. Paste the whole message your teammate sent if that is what
you have — the field takes the URL out of it, and a full stop on the end of a
sentence does not count. That writes `.teamree/relay` — the same file, with the
same comment header — and stops there, exactly as adding your key does. The
panel then names both files it has written and the one commit that covers them,
which is step 4's commit: you can do this step and the next one and push once.
The panel accepts any `ws://` or `wss://` URL — a deployed Worker, a tunnel, a
Tailscale address, a box on the LAN.

Blank lines and `#` comments are skipped, the same way the member files' are;
the first line that is neither is the URL. It must be `ws://` or `wss://`, and
it carries no query string and no fragment.

**The other one**: `git pull`, and check you have the same file. The panel
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
**Teamwork** panel says which of the two it is looking at — including *"No
`TEAMREE_RELAY_URL` in this app's environment"*, which is the answer to "I set
the variable and nothing happened".

## 4. Both add your key to the repository, commit it, and push it

Membership is a file. Your machine generated an X25519 keypair on first run; the
private half never leaves it, and the public half goes in the repository at
`.teamree/members/<handle>.pub`. There is no account to make and nobody to ask:
if you can push that file, you are on the team.

In the app, open the project's **Teamwork** panel — the **Teamwork**
button is in the project header in the sidebar — and press **Add my key** in
step 2. What that grants is written above the button rather than under it: a key
in `.teamree/members/` lets that person run commands on your machine, as you.

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

**One installation, one key, and never a copy of one.** Your keypair lives in
the app's own data directory, at `~/Library/Application Support/teamree/identity.key`,
and it is this machine's identity in *every* project it takes part in rather
than in this one. If you also work on a desktop, open teamree there and press
**Add my key** there too, typing a handle of its own — `ana` and `ana-desktop`
in the roster is the intended shape, not a mess to tidy up. Copying
`identity.key` across looks like it worked, because the second machine correctly
says you are already in, and then nothing settles afterwards: "Two machines, one
key" below is what that looks like from both ends.

**Adding a key is silent, and that is worth knowing before you rely on it.**
Nothing in the app announces that somebody joined. A new key becomes another
person in the **Teamwork** panel and another link in the header's count,
indistinguishable from a colleague who was there all along. Anybody who can push
can add any key, including one belonging to somebody the rest of you have never
met, and it is obeyed without comment. The only control is a person reading the
diff, so if your team wants this watched, watch the path it happens on:
`.teamree/members/`, in whatever review your repository already has.

**Then commit it and push it, and this is the step people forget.** Adding the
key writes the file and stops; getting it into the repository is a separate,
deliberate act, because a key nobody pushed is not membership. Until your key is
on the roster your checkout can see, the project header says **Your key is not
here** and names this step, rather than counting teammates who cannot reach you.

Step 4 of the panel is now a button for it. Before you press it, it names
exactly what it will do — the files it will stage, the commit message, the
remote and the branch, and whether this push is what sets the upstream — and it
stages those two paths and nothing else, so work you had already staged for a
commit of your own is left where it was. When git refuses, you get git's own
words in full alongside one sentence about what to do: a rejected
non-fast-forward, a branch with no upstream and a remote you cannot write to all
read as themselves rather than as "push failed".

**While it runs, it says what it is doing.** The push is the only part of this
that crosses a network and it is the one that can take a while, so the step
shows git's own progress line, how long it has been going, and — if git has said
nothing for half a minute — that a push this quiet is usually waiting for a
credential teamree cannot be asked for. **Stop** is beside the button the whole
time, and stopping it leaves whatever was committed committed. Afterwards
there is **Try the push again**, with the one thing to do first: `git pull
--rebase` after a rejection, or fixing the credential, which is not something
this window can do for you.

**If a push waits on a credential, it now fails instead of hanging.** teamree
runs git with no terminal to prompt on, and ssh is a separate program that would
otherwise open `/dev/tty` for a passphrase or an unknown host key — behind the
app's own window, where nobody can answer it. So the push runs ssh in batch
mode: a machine with no key in the agent gets an immediate refusal naming
`ssh-add --apple-use-keychain`, and an https remote with no stored credential
gets one naming `credential.helper osxkeychain`, rather than ten minutes of
nothing.

The commands are still there, one disclosure down, if you would rather — so if
you also set the relay in step 3, this one commit carries both:

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

### What to send the other person

At the bottom of **Teamwork** is the state this ended in, as four separate
verdicts rather than one: your key, the relay, the push, and whether anything is
connected. They are separate because half-working is the ordinary outcome — the
commit lands and the push is refused, or everything on this machine is done and
the other person has not opened the app — and one tick would have to be wrong
about one of those halves. The push is marked *teamree cannot check this* unless
teamree made it, because it cannot see a commit you made in a terminal.

Under that is **Invite somebody**: the message to send, written out in full with
a button that copies it. There is no invitation in this protocol — nothing is
sent anywhere, and push access is the whole of membership — which is exactly why
one has to be written by hand: you are explaining a system with no invitations
to somebody who is expecting one. It names the repository to clone, all four
steps including the push people forget, and what a key in the roster grants,
because the person receiving it is the one taking that on.

### All of steps 2 to 4 from a shell

Everything above is also four CLI commands, which matters when the person doing
it is an agent working in a pane rather than somebody reading this page.

**Whoever set it up**, once the relay and their own key are pushed:

```sh
teamree team invite api
```

That prints one line with no spaces in it — the repository, the relay, the
project's name and the sender's handle — and refuses to print anything at all if
it cannot name all of the first three. An invitation that cannot say where the
repository is is worse than no invitation.

**The joiner** pastes that line into:

```sh
teamree team accept "<the line>"
```

which finds the repository on their Mac or clones it, adds it as a project,
writes `.teamree/relay`, writes their key into the roster, and pushes — saying
what it did at each step, and stopping at the first thing it cannot do honestly.
It refuses rather than overwrite a relay their checkout already names, and
refuses rather than repoint an origin that names a different repository.

**The line is not a credential.** It carries four facts that are public already
and are typed by hand today; it grants nothing. `accept` still ends in a push to
that repository, and a machine that is not allowed to push is refused there in
git's own words — because being on the team *is* being able to push. And a
finished `accept` says a key was pushed, never that a teammate is connected:
that is a fact about somebody else's machine, and `teamree team status api` is
where it is answered.

If you are doing only the last half by hand, `teamree team publish api` is the
commit and push on its own, and `--dry-run` names the files, the message, the
remote and the branch without doing any of it.

## 5. Both open the project

Add `~/teamree-example` as a project in teamree on both machines, the same way
you would add any repository.

There is nothing to restart. teamree watches `.teamree` in each project's
primary checkout, so a pull that brings in your teammate's key or the relay file
reaches the app by itself: the roster is re-read, the links are rebuilt against
it, and the project header moves. Almost always that is immediate.

If it is not immediate, give it half a minute before you touch anything. A
filesystem watch is the fast path, not a promise — this project's own tests have
caught macOS starting a watch and then never saying a word on it — so underneath
the watch teamree re-checks `.teamree` on a timer, fast just after a project is
opened and settling to once every thirty seconds while nothing is happening. A
pull the watch misses is picked up by that instead. Half a minute late is the
worst this costs you; never noticing it at all is what it removes.

Opening the **Teamwork** panel re-reads both files as well, which is the
belt-and-braces half of the same thing — and if the watch could not be set up at
all, that is the panel that says so rather than letting a list nothing is
following look as live as one that is.

Open the **Teamwork** panel on both machines. Its last step, *Connected*,
lists the roster above the links: two entries, one of them marked **you**. That
part reads the directory and needs no network at all, so it is a clean check on
step 4 before you blame anything on the relay.

Then look at the project header in the sidebar, which says in one phrase what
teamwork is doing. The ones you will see are:

- **Teamwork off** — nothing is set up here, and the tooltip says which thing:
  no `.teamree/relay`, no `origin` remote, or a roster with nobody in it. This
  is the ordinary state of a project nobody has done this to, not a fault.
- **Your key is not here** — your own key is not in `.teamree/members` in this
  checkout, so nobody can address your machine. This is step 4, either not done
  or not pushed, and no amount of waiting fixes it. It is said before anything
  about somebody else's machine, deliberately: the fault is here.
- **No teammates** — the roster has nobody in it but you.
- **Connecting…** — dialling.
- **Nobody connected** — the relay is reachable, your key is on the roster, and
  no teammate's machine is on it. Normal when your colleague has not got there
  yet.
- **1 connected** — the one you are after, and it means a Noise session that
  authenticated against the key in the repository, was confirmed by a frame only
  the holder of the private half could have sent, and has said something within
  the last five minutes. Step 8 is why that last clause is there.
- **Relay unreachable** — this machine cannot get to the relay. Your teammate
  may be perfectly fine.
- **1 refused** — somebody answered on your rendezvous and was not who they
  should have been. This is the one that is worth reading the tooltip for.
- **1 stopped** — that link gave up rather than going round again, and the
  tooltip says what the relay said when it did. Also worth the tooltip.

With more than one teammate the connected phrase carries the rest: **2
connected · 1 away**.

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

**Joiner**: open the leader's pane. It takes a cell of its own beside your
worktree, moved and resized on the same gutter as your own panes and closed with
the same chord, so several of them can be open at once. The scrollback arrives
first and the live tail follows it, each line exactly once, letterboxed to the
leader's dimensions — your window does not resize a PTY under a program you are
only reading.

**Leader**: your own pane now says it is being watched, and by whom, by the
handle their key is filed under in `.teamree/members/`.

Now the part the whole design is for. Wait for the agent to stop on the question
task 1 puts in front of it, and have the **joiner type the answer into the
leader's pane**.

**Nothing runs until the leader says so**, and this is the step people are most
likely to sit through wondering what broke. The joiner's keystrokes stop on the
leader's machine and the leader is asked: who is typing, which pane, and the
bytes themselves, drawn so every control character is visible and none of them
can act. The leader answers **allow once**, **allow for this session**, **always
allow this teammate in this pane**, or **refuse** — and only then does the pty
move. A burst is one question rather than one per keystroke, a question nobody
answers expires after a minute, and the joiner is told which of the four
happened, including the expiry. Their own pane says, after a second of quiet,
that what they typed has not run: at a password prompt a pane echoes nothing, so
being held would otherwise look exactly like being ignored.

If the leader's machine is one nobody is sitting at, the same answers are on the
command line: `teamree team requests` lists what is waiting, and `teamree team
allow` and `teamree team deny` settle it. A `teamree team revoke` lifts a
standing permission afterwards.

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
- Once the leader has allowed them, the keystrokes reach a real shell on the
  leader's machine, as the leader. A standing answer — this session, or always —
  is listed beside the mute on that pane, because a permission the owner cannot
  see is one they cannot lift.
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
arrive is the fastest way to believe the rest of it — and a mute is the one
answer that needs no prompt, because it is that question already answered: it
cancels whatever was waiting on that pane and lifts every permission on it.

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

**Wait for it, and know which of the two you did.** Quitting teamree closes the
socket, so the joiner's header leaves **1 connected** at once. Closing the lid
does not: a suspended Mac leaves its connection open at both ends and neither
relay will end it for us, so the link has a deadline of its own — nothing
decrypted for two and a half keepalive intervals, **five minutes**, and the link
is over. Until then the joiner's header honestly says **1 connected**, because
five minutes ago it was. Then the rows are marked about fifteen seconds later,
which is the grace that stops an ordinary reconnection blinking a badge at
everybody.

So: about fifteen seconds for a quit, up to about five and a quarter minutes for
a lid. If you want to see it inside a coffee break, quit the app.

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
cd relay && npm ci && npm run build
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

Both handles, or you are not done. The app follows that directory, so the pull
reaches the **Teamwork** panel by itself — usually at once, and within
half a minute at worst, on the timer step 5 describes. Opening the panel re-reads
the directory in any case, which is the quickest way to skip that wait. If the
panel shows two people and the header still says **No teammates**, that is worth
reporting: it is the one shape of this failure the app is supposed to have
stopped being able to have.

If a key is in the directory and not in the panel, the panel will name the
file and say why it was skipped — a name that is not exactly `<handle>.pub`, a
file whose contents name somebody other than its filename, two files with one
key. One bad file costs one member and never the list.

Related: revocation works the same way and at the same speed. Deleting a key
removes somebody at the next fetch that brings the deletion in, not instantly,
and it takes effect on each machine separately as that machine fetches. Until a
teammate pulls, their copy of the roster still has the removed key in it, and
they go on opening a link to that person and accepting everything a member may
do — which is all of it. So a removal is only as done as the slowest checkout on
the team, and if it is urgent, say so out loud rather than assuming the commit
carried it. There is no revocation feed, because a revocation feed is a service,
and avoiding services is the entire design.

### Two machines, one key

If `identity.key` has been copied from one machine to another — or restored onto
a new one out of a backup of the old — both machines are the same member, and
the symptom is a link that never settles.

Two peers find each other at a rendezvous derived from the Diffie-Hellman
between their two keys and the project, and there is nothing per machine in it,
so both of your machines compute the same address as each other. A rendezvous
holds two connections; a third claims it and the relay ends the live pair rather
than guess which two belong together. Whichever of your machines dials last
therefore displaces whatever was connected, and the one it displaced comes back
and displaces that. Your teammate watches the header go **1 connected**, then
**Nobody connected**, then round again, for as long as both of your machines are
running.

When it is your two machines that get spliced to each other, the handshake
fails: each of them holds your private key and neither holds your teammate's.
Whichever of yours lost that exchange reads **1 refused**, with *authentication
failed; the message was not produced by this session (decryption_failed)* in the
tooltip.

Both sentences point at the wrong person. Your teammate is told *your teammate's
machine dropped the connection*, which is true of a machine of yours and not of
theirs, and the refusal reads as an accusation against them. Neither machine
knows your other machine exists, and from the wire neither can: it presents as
your key, because it is.

The fix is to stop using one key twice. On the machine that should not have it,
quit teamree, move `identity.key` out of the way, and start it again — it
generates a new keypair on a run that finds no file:

```sh
mv ~/Library/Application\ Support/teamree/identity.key ~/identity.key.old
```

Then press **Add my key** in that project with a handle of its own typed in the
field — `ana-desktop` rather than `ana`, which is taken by your other machine —
and commit and push the file it writes. Two member files for one person is the
shape this is meant to have.

### A new machine, or a key you no longer have

teamree generates a keypair on first run and never replaces one it can find, so
a machine that has lost `identity.key` — a new laptop, a reinstall, or a file
moved aside because the app said it was not a usable identity — comes back with
a new key and no claim on the member file the old one is filed under.

Press **Add my key** there and you are told something that sounds worse than it
is: *`.teamree/members/ana.pub` is already somebody else's key; choose another
handle*. It is your file. The app cannot tell — all it sees is a handle in the
roster whose key is not the key this machine holds, which is also exactly what a
real collision with a colleague looks like — but the advice is the wrong one to
take here. Filing yourself under `ana2` commits a second file and leaves
`ana.pub` in the roster for good, and an entry nobody holds the key for is not
inert: every teammate opens a link to it, it parks at waiting and never moves,
and after two hourly rotations each of them is told to go and check their clock
and their `.teamree/relay`. Both will be fine, and nothing they check will say
why.

Delete the entry first, then join:

```sh
cd ~/teamree-example
git rm .teamree/members/ana.pub
```

Then press **Add my key**. Your handle is free now, so it defaults back to it —
if the panel still refuses, close and reopen it, which re-reads the directory.
Commit both halves together and push:

```sh
git add .teamree
git commit -m "Re-key ana"
git push
```

What that commit shows is one member file with a new `key:` line, which is
exactly the diff your teammates should be looking at — and, if the check is to
mean anything, confirming with you somewhere that is not the repository, since
anyone who can push can write that same diff. Nothing else has to happen on
their machines: the next fetch brings the new key in and the link rebuilds
against it.

Removing somebody who has left the team is the same two steps without the
re-join — `git rm` their file, commit, push — and it arrives at the same speed:
on each machine as that machine fetches, and not before.

### There is no relay, or nobody committed one

The header says **Teamwork off** and the tooltip says *no `.teamree/relay`*. That is
the ordinary state of a project nobody has done step 3 to, and it is what you
get instead of the app quietly connecting to somebody else's server.

```sh
cd ~/teamree-example && git pull && cat .teamree/relay
```

Both of you, and compare the strings exactly, scheme included — or open the
**Teamwork** panel on each machine, which shows the URL in effect and
which of the two places it came from. If one of you has the file and the other
does not, somebody did not push. If it says the scheme is `https`, not ws or
wss, or that it has no path, you pasted the address the deploy printed rather
than the endpoint — add `/v1/relay` and make it `wss://`, which is what the
panel says back to you if you paste it there. If you set `TEAMREE_RELAY_URL`
earlier to test a tunnel and forgot, it is still winning over the file in
whatever process inherited it; the header's tooltip says `(from the
environment)` when that is what happened, and the panel names the variable and
its value.

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

The header says **Teamwork off**, and the tooltip says *no origin remote*. This
is the honest answer rather than a fault: what makes two checkouts
the same project is a hash of the normalised origin remote, so a checkout with
no origin cannot be matched to anything.

```sh
cd ~/teamree-example && git remote get-url origin
```

It catches the leader most often, because `init-example-repo.mjs` makes a
repository with no remote and step 2 is where one gets added. Adding one is the
whole fix: the next time the panel reads its status it asks git again, so there
is nothing to restart and nothing to wait for. A remote under any
other name does not count — teamree does not guess at which of several remotes
you meant, because two peers guessing differently would show each other nothing
and say nothing about why.

### You share the repository over a volume and never see each other

Both of you are on the relay, both rosters have both keys, both panels say
**Nobody connected**, and nothing anywhere is red. Check the two origins:

```sh
cd ~/teamree-example && git remote get-url origin
```

If they are paths and the two strings are not identical — one of you mounted the
volume somewhere else, or spelled it with different capitals, or wrote
`example.git` where the other wrote `example` — then the two machines hashed two
different projects, computed two different rendezvous points and never looked
for each other. There is no error to find because neither machine did anything
wrong. The fix is for both of you to point `origin` at the same string,
character for character; the **Connected** step says which path it is matching
on while it waits, which is the panel telling you this before you go looking at
your wifi.

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

The other end has its own delay and it is longer: the machine that stayed awake
goes on reading **1 connected** for up to five minutes after the lid shut, until
its silence deadline fires. Both of those are the same event seen from two
sides, and neither is a thing to press.

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

The opposite complaint is the commoner one, and it is not a fault: a teammate
who shut a laptop stays **1 connected** and un-greyed for up to five minutes.
Their socket is still open at both ends and this machine is the only thing that
can notice, which it does on the silence deadline in step 8. Give it the five
minutes before you read it as wrong.

### The worktree is there, but the pane shows nothing

Metadata flows on its own and bytes flow on demand, so a pane you have not
opened has sent you nothing by design. Open it and the scrollback arrives
first.

If you have opened it and it stays empty, the pane may genuinely be quiet —
check the age beside it. If it is not quiet, note it. The join between the
scrollback and the live tail used to drop output under load, the more of it the
busier the machine; it is fixed and covered by tests against the real relay, so
a pane that loses its first line on two real Macs is a new report rather than a
known one — and the interesting detail is what the machine was doing at the
time.

### Your typing does not reach the pane

The likeliest answer is that it has not been refused at all: it is waiting for
the owner. Their machine holds a teammate's keystrokes until they have been
shown them and have answered, and nobody has answered yet. Your pane says so
after a second of quiet, because a pane at a password prompt echoes nothing and
being held would otherwise look exactly like being ignored. It settles either
way within the minute: allowed, refused, or expired because nobody was at the
screen — and you are told which.

The other answer is that the owner muted it. That is not a failure and it does
not need diagnosing: mute is theirs, it takes effect on the next keystroke, and
the refusal you see in the pane is in their words. A muted pane deliberately
keeps streaming and keeps its row, so it looks exactly like an unmuted one apart
from refusing you.

If there is no sentence in the pane at all and the keystrokes simply go nowhere,
check the project header first — a link that has dropped is the commoner
explanation, and it says so.
