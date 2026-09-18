# The teamree relay

Two laptops behind two routers cannot reach each other. So neither tries: each
opens an **outbound** WebSocket to a relay, and the relay splices the two
streams together. Outbound-only means no port forwarding, no STUN, no public
address on either machine, and no difference between an office, a café and a
phone tether.

Your team runs this. We do not run one for you, there is nothing to sign up for,
and the relay is never trusted with content — the two peers encrypt end to end
through it. [What the operator learns, and what they do not](#what-the-operator-learns-and-what-they-do-not)
is the whole of that argument, below, and it is worth reading before you hand
the address to anybody. The commands come first because they are what you came
for.

**Deploy it as a Cloudflare Worker.** That is the answer unless you have a
specific reason otherwise: one command, a permanent address, nothing to babysit,
it works from a café and a phone tether because both peers dial out to it, and
the free plan is enough for a team ([What it costs](#what-it-costs)). The
fallback — [run it yourself](#if-you-will-not-use-cloudflare-run-it-yourself) —
is at the bottom of this file, and is now also one command: for teams who will
not use Cloudflare at all, or who are all on one network anyway.

**Every sentence below that says something cannot happen names the test that
holds it up.** This is infrastructure a team stands up in their own Cloudflare
account and then never looks at again — nobody audits a relay after the week it
was deployed — so a limit nobody asserted is a limit that is true until somebody
edits the line under it. The citations are in the prose rather than in a table at
the end, and they are there for the next person to weaken one of these sentences:
the test that would have to go red is named in the line they are changing. Paths
are relative to this directory, except where they reach into `src/main/teamwork/`,
which is the client half of the same promise. Going through them found two
sentences that were wrong; both are corrected in place below, with what they used
to say, rather than quietly deleted.

---

## Deploy the Worker

**What you need first:** a Cloudflare account (the free plan is enough; see
[What it costs](#what-it-costs)), and **Node 20 or newer**, because Wrangler —
Cloudflare's deployment tool — is a Node program. Nothing else, and in
particular **no clone of this repository**: the command below ships inside the
installed app and carries the Worker's sources with it.

**Where to run it: anywhere.** It does not care what directory you are in. It
writes the Worker project into `~/teamree-relay` — a directory you own, that you
can edit and keep — and deploys from there.

```sh
/Applications/teamree.app/Contents/Resources/relay/teamree-relay deploy
```

If you *do* have a clone of this repository, the same command is
`relay/teamree-relay deploy` from the top of it. It is the same program: the app
ships a copy of this directory.

A browser opens once, for Cloudflare to log you in. Then it prints the line your
team needs:

```
teamree-relay: deployed. Your relay endpoint is

    wss://teamree-relay.<your-subdomain>.workers.dev/v1/relay
```

That is the whole of it. There are no resource ids to fill in, nothing to click
in the dashboard, and no secrets to set. The Durable Object namespace and its
migration are declared in `wrangler.jsonc`, and Wrangler creates them on first
deploy.

**The endpoint is not the address the deploy printed.** Wrangler prints an
`https://` host; the relay is that host with `/v1/relay` on the end, spoken as
`wss://`. The command does that conversion for you and prints the result, which
is the line to paste — teamree refuses an `https://` URL rather than guessing at
the rest of it (`src/main/teamwork/peer/relayUrl.test.ts`, "refuses the https URL
somebody will paste out of their browser" and "refuses the host on its own, which
dials a path no relay can serve").

Give that URL to everyone on the team by committing it: in teamree, **Teamwork →
Set the relay for this project → Write relay file**, which writes
`.teamree/relay`. One person deploys, pushes one line, and the team is connected.

### Deploying again, and changing it

The project is `~/teamree-relay`, and it is yours. `wrangler.jsonc` there holds
the Worker's name and the relay's limits under `vars`; edit one and deploy
again:

```sh
cd ~/teamree-relay
npx wrangler@4 deploy
```

**A value the relay cannot parse is refused rather than quietly ignored — but
this file used to say it stopped the Worker starting, and that is not what
happens.** A Worker is not a process there is a moment of starting; the deploy
succeeds, the bundle is fine, and the refusal arrives at the first connection
instead: every request fails, the upgrade is answered `500`, and nothing is
relayed until the value is fixed (`test/workerd/configuration.workerd.test.ts`,
"refuses every request rather than quietly falling back to the default", which is
that under the real runtime; the rule underneath it is
`test/operability.test.ts`, "refuses to start on a limit it cannot make sense of
rather than guessing"). Loud either way, which is the property that matters — a
relay that fell back to a default is one whose operator believes it is enforcing
something it is not — but loud at the first connection rather than at the deploy,
which is worth knowing before you change a number and walk away.

Only the limits this host can actually enforce are listed, and `wrangler.jsonc`
is held to that list in both directions (`test/hosts.test.ts`, "carries every
limit this host can enforce, and not one it cannot"). The ones missing from it
are named in [Two things this host does not
do](#two-things-this-host-does-not-do) rather than left for you to notice.
Re-running `teamree-relay deploy` is also safe: it never writes over a file that
is already there, so an edited limit survives (`test/deployCommand.test.ts`,
"never writes over a second time, so an edited limit survives a redeploy", and
"adds back a file somebody deleted without touching the rest").

If you want it on your own domain, add a [custom domain
route](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).

### If it refuses

Every refusal names the command that fixes it. Two are worth knowing about in
advance:

- **`ENOENT: no such file or directory, open '.../relay/package.json'`** is not
  this command. It is npm, answering `npm install` in a directory that has no
  project in it — which is what an older version of this file told people to do.
  There is no `mkdir`, no `cd relay` and no `npm install` step any more. Run the
  one command above instead, from wherever you are.
- **"there is no wrangler.jsonc here, so there is no relay in … to deploy"** is
  `--here` used in a directory that holds no Worker project. Drop `--here` and
  it writes one into `~/teamree-relay` first.

### What it costs

Durable Objects are available on the **Workers Free plan**; they were opened up
to it on 7 April 2025. The one constraint that matters is that a free account
may only use Durable Object classes with the **SQLite storage backend**, which
is what `wrangler.jsonc` here declares (`new_sqlite_classes`), so there is
nothing to change. Source: Cloudflare's [Durable Objects
pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
page, which states "Durable Objects are available both on Workers Free and
Workers Paid plans", and the changelog entry ["Durable Objects on Workers Free
plan"](https://developers.cloudflare.com/changelog/post/2025-04-07-durable-objects-free-tier/).

The free plan's limits are daily and per-account, and exceeding one makes
further operations of that type fail until 00:00 UTC. **Checked against that
page on 17 September 2026**, the included daily usage is:

| | Included per day, free plan |
|---|---|
| Requests | 100,000 |
| Duration | 13,000 GB-s |
| SQLite storage | 5 GB (not daily; a standing total) |

Three things turn those numbers into an answer rather than a table.

**Idle costs nothing.** Duration accrues while an object is executing, and while
it is idle and *not* eligible for hibernation. Cloudflare's wording: "an idle
Durable Object that qualifies for hibernation does not incur duration charges,
even during the brief window before the runtime hibernates it." This relay is
built for exactly that — `state.acceptWebSocket` rather than a held socket, and
`setWebSocketAutoResponse` so a keepalive is answered without waking the object
at all. A pair sitting connected and quiet overnight costs nothing.

**Duration is billed at a flat 128 MB per object**, "regardless of actual
usage", so 13,000 GB-s/day is about **28 hours of active object time a day** —
across the account, not per pair.

**WebSocket messages bill 20:1 on the request side**: 100 incoming messages
count as 5 requests. So 100,000 requests/day is on the order of **two million
WebSocket messages a day**.

A team is a long way inside all three, and the thing that would move first is
requests, which is the one with two million messages of headroom. This is not a
promise that it is free forever — they are Cloudflare's numbers, they move, and
the page above is the live source. It is a statement that as of that date, for a
team, the free plan is enough, and that this relay is written to stay on the
cheap side of it deliberately rather than by luck.

### Cloudflare's limits, and whether they bite

Checked against Cloudflare's own documentation, because a team that deploys this
and hits a wall an hour later is worse off than one that was told up front.

- **WebSocket message size: 32 MiB.** Raised from 1 MiB on 31 October 2025
  ([changelog](https://developers.cloudflare.com/changelog/post/2025-10-31-increased-websocket-message-size-limit/)).
  The relay's own cap is 256 KiB, two orders of magnitude below it. Not a
  problem.
- **Duration: not a wall.** A Worker's CPU-time limit is per event, not per
  connection, and forwarding one frame is microseconds of it. A WebSocket held
  by a Durable Object is not on a request clock, which is exactly why the pairing
  lives in the object rather than in the Worker.
- **Concurrency: 32,768 WebSockets per Durable Object.** An object here holds at
  most six: three for the pairing — two peers plus room for the one arriving to
  displace them — and three for connections that have not said anything yet.
  Cloudflare's ceiling is irrelevant by four orders of magnitude; the object's
  own is the one that matters, and the next section says why.
- **Hibernation is the reason this is cheap.** A pair that sits quiet overnight
  has its object evicted from memory while both sockets stay connected, and it
  is rebuilt on the next frame. That is why nothing is kept in a field anywhere
  in `src/workers/`, and why the tests throw the object away between every single
  frame (`test/hibernation.test.ts`, "splices two peers that were evicted from
  memory between every frame"; `test/workerd/pairing.workerd.test.ts`, "survives
  a hibernation wake with the pairing intact", which waits out a real eviction
  and checks it happened). Against `workerd` locally an object is evicted after
  about ten seconds of being left alone, and an object whose last connection has
  gone stops waking itself at all (`test/workerd/deadlines.workerd.test.ts`,
  "stops waking itself once the rendezvous it was holding is empty") — which it
  did not always do, and the section on testing says how that was found.

### Two things this host does not do

Both are real, and neither is a reason to prefer the container. They are here so
that nobody reads the limits table further down as a description of this host.

**There is no connection cap, no per-address cap and no connection-rate cap.**
`RELAY_MAX_CONNECTIONS`, `RELAY_MAX_CONNECTIONS_PER_ADDRESS` and
`RELAY_MAX_CONNECTIONS_PER_ADDRESS_PER_MINUTE` are counts across a whole process,
and a Worker has no process to count across. They are not in `wrangler.jsonc`
(`test/hosts.test.ts`, "leaves out the three counts a process keeps, rather than
reading and ignoring them") and setting them there would do nothing
(`test/hibernation.test.ts`, "has no connection cap to spend, because a Worker
has no process to count across", which sets one and then opens past it). What
bounds this host instead is that
**one Durable Object holds at most six sockets**, in two halves that are not
interchangeable. A bound is needed at all because the object's name in the URL is
a hash anybody may compute or simply invent — it carries no token and proves
nothing — so without one a single client could aim every socket it can open at a
single object, and every frame that object then handled would cost work in
proportion to how many were attached.

Three sockets may hold the pairing. Two is what a pairing is and the third is the
peer arriving to displace a stale one, which is how a laptop that slept gets its
session back (`test/hibernation.test.ts`, "still has room for the peer that
arrives to displace the pair"). A socket holds one of those only once it has sent
a hello whose token hashes to this object's own name; that check belongs to this
host, and it is what stops a hello carrying an invented token from parking a
socket here for the whole pairing budget (`test/hibernation.test.ts`, "turns away
a hello for a rendezvous it is not the home of";
`test/workerd/pairing.workerd.test.ts`, "turns away a hello that names a
rendezvous other than the one in the URL").

The other three are for sockets that have not said anything yet, and when they
are full an arriving connection displaces the one that has been silent longest —
told `4007` — rather than being refused itself. The direction matters. A
connection that is refused an upgrade is handed a transport error and cannot tell
it from a relay that is not there, so three sockets presenting nothing at all
must not be able to shut a rendezvous against the teammate it belongs to
(`test/hibernation.test.ts`, "keeps a rendezvous open for its own pair however
many sockets are aimed at it", which offers two hundred;
`test/workerd/pairing.workerd.test.ts`, "keeps a rendezvous open for its own
pair, whatever else is aimed at it", which checks under the real runtime that the
one displaced is the one that had been silent longest).

**What is left of the `503` is not what this file used to say.** It said a
rendezvous whose three pairing slots are all held by connections that presented
its token, and that state cannot arise. A hello that names this object parks,
pairs, or displaces the pair that was already in it, so the pairing half never
holds more than two live sockets however many teammates turn up: six arrivals in
a row and not one of them is refused (`test/hibernation.test.ts`, "never refuses
an upgrade to a connection that presents its own rendezvous"). What does reach
the `503` is the other thing counted against those slots — a socket whose
attachment the object cannot read, which is the runtime taking a connection away
while the object is still looking at it. Those are never displaced, because the
object cannot tell whether such a connection is finished, and guessing the other
way is how the cap gets walked past and how a live peer ends up with nothing
checking its deadlines. Three of them and the next upgrade is refused
(`test/hibernation.test.ts`, "refuses an upgrade only when it cannot account for
what is already attached"). Nobody holding the URL can arrange that, which is
why the correction is worth making rather than deleting: the refusal is not
something a stranger can aim at a pair.

That also settles the question a refusal always raises. Somebody who has the URL
has the hash and nothing else, and what they are told back must not vary with
whether the two people it belongs to are in there — an answer that only comes
when the rendezvous is busy is a way to watch a pair you cannot join. A hello
carrying an invented token gets the same `4000` and the same words at an empty
object and at one holding a live session, and the pair never hears that it
happened (`test/hibernation.test.ts`, "answers a hello for another rendezvous the
same way whether or not the pair is here").

Cloudflare's own per-account and per-request limits are what stand between you
and a flood of objects; the relay's job is to make each one cheap and bounded,
and that it does.

**The slow-consumer rule cannot fire.** The runtime does not expose a send-queue
depth to a Durable Object, so the relay has nothing to measure and never closes
a peer for not reading. Cloudflare owns that queue instead. Still true, and now
checked rather than assumed: a peer that asks for three hundred pongs and takes
none of them is left alone here, at the lowest buffer bound the configuration
accepts (`test/hibernation.test.ts`, "has no send queue to measure, so nobody
here is closed for not reading") — which is exactly the peer the container host
closes. The frame-rate and byte-rate budgets still apply and are what bound the
work (`test/hibernation.test.ts`, "charges a peer for its control frames as well
as for its content", "closes a peer sending bytes faster than its budget allows",
and "refuses a frame over the size cap rather than passing it on"). On the
container host, where the depth is visible, the rule is enforced and tested
(`test/limits.test.ts`, "drops a peer that cannot keep up rather than buffering
without bound" and "closes a peer that is not reading the answers it asked for").

Neither makes this a bad fit. It is close to the shape Durable Objects were built
for.

---

## If you will not use Cloudflare: run it yourself

**Take the Worker unless you have a specific reason not to.** This is the
fallback, and it is for teams who will not use a hosted runtime at all, or who
are all on one network anyway. It costs more than it looks: a relay on a laptop
re-inherits the NAT problem the relay exists to solve, and goes away when the
laptop sleeps.

**This no longer needs a clone of this repository.** It used to — that was the
whole of the complaint — and the Node host now ships inside the app beside the
Worker's sources, so one command writes the project somewhere you own, builds it
and runs it:

```sh
/Applications/teamree.app/Contents/Resources/relay/teamree-relay serve
```

or, from a clone, `relay/teamree-relay serve`. It writes into
`~/teamree-relay-server` unless you name somewhere else, installs its one
dependency, builds it, and prints the addresses it can be reached at before it
starts listening. `--port` and `--host` change what it binds; `--write-only`
stops after writing the project. Afterwards, `npm start` in that directory is
the whole of running it again.

There is also a Dockerfile here, for a machine you keep running rather than one
you are sitting at. That one does need a clone:

```sh
git clone https://github.com/zero-abd/teamree
cd teamree/relay
docker build -t teamree-relay .
docker run -d --name teamree-relay -p 8787:8787 --restart unless-stopped teamree-relay
```

Check it, either way:

```sh
teamree-relay check ws://localhost:8787/v1/relay
# teamree-relay: ws://localhost:8787/v1/relay answered the WebSocket upgrade. A relay is listening there.

curl -s localhost:8787/healthz
# {"status":"ok","uptimeMs":1200,"connections":{"total":0,"greeting":0,"waiting":0},"sessions":0}
```

`check` dials the address the way a peer does and says what answered, which is
the difference between "the relay is not running", "something else is on that
port", and "the path is wrong". It proves the machine you ran it on can reach
the relay and nothing more — a teammate on another network has to run it too.

The relay endpoint is `ws://<host>:8787/v1/relay`, or `wss://` once there is TLS
in front of it. **Plain `ws://` is not a second-class address here**: teamree
dials it without complaint, and the content crossing it is encrypted end to end
between the two peers either way, so TLS in front of a relay on a network you
already trust buys you very little. It matters when the relay is on the public
internet, where it also stops anyone in the middle learning which two anonymous
connections were spliced.

**The relay asks nobody who they are.** There is no token, no allowlist and no
account: anyone who can reach the address can open a connection to it. They
cannot join your pairing — that needs a rendezvous token derived from a
Diffie-Hellman between two members' keys, which nobody outside the roster can
compute — and they cannot read a byte of what crosses it. What they can do is
take up capacity. On a private network that is nobody. On a public address it is
anybody, so set `RELAY_MAX_CONNECTIONS` and the per-address limits deliberately,
and read [Limits, and why each one is where it is](#limits-and-why-each-one-is-where-it-is)
before you put one on the internet.

### Everyone on one network

Nothing further to do. Run it on any machine the others can reach — a desktop, a
NAS, a box in the office — and hand out its address. This is the case that works
out of the box.

### Reaching it across the internet

The relay exists because two machines behind two routers cannot reach each
other, and a container on a laptop inherits exactly that problem. The machine
running it has to be reachable, which means one of:

- **A VPS.** Rent a small one, run the container, point a hostname at it, put
  Caddy or nginx in front for TLS. Durable, costs money, and is real
  administration.
- **A mesh VPN** (Tailscale, WireGuard). Everybody is on one network again, so
  the section above applies. Good if your team already uses one.
- **A tunnel.** `cloudflared tunnel --url http://localhost:8787` needs no account
  and prints a public `https://` URL in a few seconds. It is genuinely the
  fastest way to test this with someone on another continent — and the URL is
  **ephemeral**: it changes every time the tunnel restarts, and dies with it. Use
  it to try things, not to run a team on. A named tunnel, which does need a
  Cloudflare account, gives a stable hostname; at which point compare the effort
  with the Worker, which needs the same account and less work.
- **A port forward.** Works, exposes a box on your home network to the internet,
  and breaks whenever the ISP changes your address. Only if you already know you
  want this.

### Behind a reverse proxy

The relay does no TLS of its own — deliberately, because certificate handling is
a solved problem it has no business reimplementing. Terminate TLS in front of it
and proxy the WebSocket through.

Forward the usual upgrade headers, and give the proxy a read timeout longer than
`RELAY_IDLE_TIMEOUT_MS` or it will cut quiet sessions before the relay decides
to. Then set `RELAY_TRUSTED_PROXY_HOPS` to the number of proxies in front, so
per-address limits count the client rather than counting the proxy as one very
busy client (`test/limits.test.ts`, "counts the address a trusted proxy reports
rather than the proxy itself"). Leave it at `0` and the socket address is used,
which is the only value a client cannot forge — so `0` is the right answer
whenever nothing trustworthy is adding `X-Forwarded-For` (`test/limits.test.ts`,
"ignores a forwarded address when no proxy is trusted", which is a client trying
to mint itself a fresh budget with a header).

### Stopping it

`docker stop` sends `SIGTERM`. The relay stops accepting connections, closes
every live session with a `1001 going away`, waits for the closing handshakes and
exits. Peers see an ordinary "come back in a moment", not a dropped socket
(`test/operability.test.ts`, "closes live sessions with a reason instead of
dropping them" and "stops accepting new peers while it is stopping").

---

## What the operator learns, and what they do not

This matters more for the container than for the Worker, because there the
operator is a colleague rather than a company. It is the same answer either way.

**Whoever runs the relay cannot read anyone's terminals.** Not with effort, not
by changing the code, not by keeping the logs. The two peers complete a Noise
`IK` handshake through the splice before any content moves, and the relay only
ever sees ciphertext going one way and ciphertext coming back. It has no key
material and no way to acquire any: `IK` authenticates both static keys, so a
relay that substituted its own would fail the handshake rather than sit in the
middle of it. Hosting buys no visibility at all. There are tests for the
observable half of this — that no payload byte and no rendezvous token reaches a
log or the health endpoint, on both hosts (`test/operability.test.ts`, "gives
whoever runs it no way to read what peers are saying" and "keeps no trace of a
payload in the log even when a peer is closed for sending it";
`test/hibernation.test.ts` and `test/workerd/pairing.workerd.test.ts`, both
"gives whoever deployed it no way to read what the pair is saying") — but the
load-bearing part is the encryption, which is not this program's to get wrong,
and `src/shared/peer/session.test.ts` is where that lives.

Reading is the claim. **Impersonation is a separate question and it is not
settled here.** The relay sees every frame, including the handshake ones, and it
sees the rendezvous token, which is the whole of what a peer presents to be
paired. Whether that lets it pass for a teammate rather than only disrupt one is
decided by the peer handshake, above this program. Assume the relay can deny and
disrupt; do not assume anything stronger about impersonation on the strength of
this file.

What the operator **does** learn:

- **The social graph.** Which pseudonymous pair is talking, when they started,
  when they stopped. This is accepted, not solved — `docs/teamwork.md` says so
  outright. A relay in the middle of two connections inevitably knows there are
  two connections.
- **Both peers' IP addresses**, as any server learns its clients'. Not logged by
  default; `RELAY_LOG_CLIENT_ADDRESS=1` turns that on for debugging. Both
  directions are asserted, because the default only means something if the
  address was there to be written down (`test/operability.test.ts`, "does not log
  a client address unless asked to" and "logs the address itself once an operator
  turns that on"). On the Worker, Cloudflare sees them regardless.
- **Timing and volume.** Frame sizes and when they arrive. Noise does not pad,
  so an idle session looks idle and a burst of typing looks like a burst of
  typing. Padding would be the peers' to add, not the relay's.
- **Nothing else.** No repository name, no branch, no handle, no pane, no file
  path, no command, no output. That is a claim about a shape rather than about
  any one line, so it is held as one: every field this relay is allowed to emit
  is listed in `test/operability.test.ts`, "writes no field an operator was not
  promised", and a new one has to be added there, in front of whoever adds it,
  before it can reach an operator's stdout.

Logs are JSON lines on stdout. They contain no payload bytes in any form, and no
rendezvous token: a token is a shared secret, and an operator holding a log of
them could displace any pairing in it. Correlation still works, through refs —
short labels derived under a key generated at start-up and discarded at exit. A
ref names a pairing within one run of the process and is meaningless outside it
(`test/operability.test.ts`, "hands the same address a different label in a
different run", which is both halves: the same label all the way through one run,
and no way to line two runs up afterwards).

---

## The rendezvous scheme

Two peers have to find each other without telling the relay who they are.

### How the identifier is derived

Both peers already share something the relay does not: each has its own X25519
private key, and has the other's public key from `.teamree/members/` in the
repository. The static-static Diffie-Hellman between them is a 32-byte secret
that both can compute and nobody else can. That is the seed.

```
shared  = X25519(my_private_key, their_public_key)   # both sides get the same bytes
epoch   = floor(unix_seconds / 3600)
token   = HKDF-SHA256(ikm = shared,
                      salt = "teamree/relay/rendezvous/v1",
                      info = epoch,
                      length = 32)                   # 64 lowercase hex characters
```

The token is what a peer presents in its hello, and it **rotates hourly**
(`src/main/teamwork/peer/rendezvous.test.ts`, "rotates every hour and is stable
within one").

**What the app actually derives differs from the sketch above, in `info`.** This
section described one token per pair of teammates; the app scopes it per project
as well, so two people who share three repositories have three rendezvous rather
than one. That came out of a security review: with a single token per pair,
every repository two colleagues share produced one indistinguishable session and
nothing in the handshake said which project it was for.

It also pins the encoding. `info = epoch` above never said whether that is
decimal text or eight big-endian bytes, and the relay cannot arbitrate — 32
opaque bytes either way — so two implementations that disagree simply never meet,
and are never told why. What the app derives is:

```
info = "teamree/rendezvous/v2" LF <project key> LF <epoch as decimal text>
```

Both halves of that are pinned against a fixed vector, so a change to either
fails loudly rather than quietly stranding every peer on the spelling it had
before (`src/main/teamwork/peer/rendezvous.test.ts`, "derives from a versioned,
unambiguous info the README leaves unspecified" and "is different for the same
pair in a different repository").

The relay itself knows none of this. To it, a rendezvous is 32 opaque bytes, and
its entire job is to notice that two connections presented the same ones
(`test/lifecycle.test.ts`, "pairs the two peers that present the same rendezvous"
and "pairs many simultaneous rendezvous without crossing them"). That is
why the divergence above costs it nothing, and why a team that wanted a different
scheme again — a fixed token per pair, say — would not have to change a line of
it. The rule for anyone writing a second client is simply that both ends must
derive `info` identically, byte for byte.

### The URL carries a hash, not the token

A peer connects to `<relay>/v1/relay/<id>`, where `id` is `SHA-256(token)` in
hex, and sends the token itself in the first WebSocket frame.

The split exists because URLs are the least private thing in an HTTP stack —
they reach proxy logs, analytics and error reports — and the token is a
capability: whoever holds it can claim the pairing. Its hash does not confer
that. On the Worker host the hash is also what names the Durable Object, which is
why it has to be in the URL at all: the object must be chosen before the first
frame arrives (`src/main/teamwork/peer/rendezvous.test.ts`, "carries the token's
hash and never the token"). The container host has no use for it and ignores it
(`test/lifecycle.test.ts`, "pairs on the token alone, whatever the URL claimed
the rendezvous was", where the two peers send different hints and one of them is
not a hash at all).

The hash is not nothing, though, and on the Worker host it is worth being exact.
It names a Durable Object, and an object holds a bounded number of sockets, so
whoever holds the hash can aim sockets at the pairing it names. What that used to
buy was a lock: three connections presenting no hello, no token and no proof of
anything took every slot the object had, and the teammate whose rendezvous it was
got the refusal — as an HTTP status, which a WebSocket client cannot read, so
what the person was shown was that the relay could not be reached. It does not
buy that now. A socket that has said nothing is displaced by the next arrival
rather than counted against the pair, and a hello is only honoured by the object
its own token names (`test/workerd/pairing.workerd.test.ts`, "keeps a rendezvous
open for its own pair, whatever else is aimed at it").

What holding the hash still buys is churn — traffic aimed at one object, which is
a cost to whoever is paying for it — and a narrow race, in which an arriving peer
is displaced in the moment before its own hello lands and comes back after the
`4007` it was given. So treat the hash as public, because it is: it is in a URL,
and a URL reaches request analytics, `wrangler tail`, Logpush and anything
terminating TLS in front — and the wire itself, if the URL in `.teamree/relay`
names `ws://` rather than `wss://`.

The Worker host does check that the hash and the token agree, and the check is
not about the peer that got it wrong. A Durable Object is chosen by the name in
the URL before any frame arrives, so a hello carrying some other token would park
a socket in an object it has no business being in, for the whole pairing budget,
holding a slot against the two peers whose rendezvous named it. Requiring the
hello to name the object it landed in costs a legitimate peer nothing — it
derived the one from the other — and a hello that does not is closed with `4000`
(`test/workerd/pairing.workerd.test.ts`, "turns away a hello that names a
rendezvous other than the one in the URL"; `test/hibernation.test.ts`, "turns
away a hello for a rendezvous it is not the home of", which also checks the hello
that *does* name it is untouched). The container host pairs on the token alone
and has no name to check against; it needs none, because there a peer that sends
a hint for one pairing and a token for another simply lands where its partner is
not, which costs only that peer (`test/lifecycle.test.ts`, "pairs on the token
alone, whatever the URL claimed the rendezvous was").

### What this hides, and what it does not

Hides:

- **The repository.** Nothing derived from its name, remote or contents is sent.
  What goes into the derivation is a project *key*, which is 32 bytes of hash
  (`src/main/teamwork/peer/projectKey.test.ts`).
- **Who the peers are.** No handle, no key, no email, no account. The token is
  256 bits that look like any other 256 bits (`test/lifecycle.test.ts`, "hangs up
  on a hello that is a rendezvous of the wrong shape" — the relay accepts one
  shape and one only, so no token can be told from another by its length or
  alphabet).
- **Any link between pairs.** Each pair's token is independent of every other
  pair's, so the relay cannot tell one team's full mesh from a set of strangers
  (`src/main/teamwork/peer/rendezvous.test.ts`, "is different for every pair, so
  one team's mesh looks like a set of strangers"). On the Worker each of them is
  a different Durable Object and they never share a home
  (`test/workerd/pairing.workerd.test.ts`, "keeps two rendezvous on one
  deployment from ever meeting"; `test/splice.test.ts`, "keeps pairs on different
  rendezvous from ever seeing each other", for the host where one process does
  hold them all).
- **Long-lived identity.** Hourly rotation means no stable identifier for the
  operator to accumulate against (`src/main/teamwork/peer/rendezvous.test.ts`,
  "rotates every hour and is stable within one").

Does not hide:

- **That two connections are a pair, and when.** That is what a rendezvous is.
- **Cross-epoch linkage against a determined operator.** Rotation defeats naive
  accumulation. It does not defeat someone correlating by IP address, or
  noticing that a session which ended at the top of the hour was immediately
  replaced by one of identical shape. Rotation raises the cost; it does not make
  linkage impossible, and pretending otherwise would be dishonest.
- **The number of pairs.** Concurrent rendezvous count is visible, and gives a
  lower bound on the size of any group the operator manages to link.
- **The fact that knowing a token is enough to break a pairing.** Anyone with the
  token — the two peers, and the relay, which sees it — can connect and displace
  the session. They cannot read or forge anything, because that needs a private
  key. Displacing is denial of service, which is already the relay's power.

### Clocks

Rotation needs the two machines to agree on the hour, roughly. Both peers derive
the token for the current epoch; a peer still waiting when the hour turns
re-registers under the new one. Ordinary NTP-level accuracy is enough, and a
pairing already established is unaffected — the token is only used to meet.

---

## The protocol on the wire

Enough to write another client against, and short on purpose.

1. Connect to `<relay><path>/<sha256-of-token>`.
2. Send one **text** frame: `{"version":1,"rendezvous":"<64 hex characters>"}`.
   Unknown fields are ignored (`test/lifecycle.test.ts`, "ignores fields it does
   not know rather than rejecting a newer peer"). Anything else, or nothing at
   all within the greeting deadline, and the connection is closed with `4000`
   (`test/lifecycle.test.ts`, "hangs up on a hello that is %s", which is six
   shapes of wrong, and "hangs up on a connection that opens and says nothing";
   `test/workerd/deadlines.workerd.test.ts`, "closes a connection that opened and
   then said nothing at all", for the deadline under the real runtime). On the
   Worker host the token must also be the one the URL names — the relay hashes it
   and compares — which a peer that derived the URL from the token always
   satisfies.
3. The relay replies with a text frame — `{"t":"waiting"}` if the partner has not
   arrived, and `{"t":"paired","session":"…","initiator":true|false}` when it
   has. Both sides get `paired`; exactly one gets `initiator: true`, which is the
   side that should open the Noise handshake. Two sides opening one at once
   simply fails, so the relay breaks the tie (`test/lifecycle.test.ts`,
   "nominates exactly one side to open the handshake").
4. From then on every **binary** frame is forwarded verbatim to the partner, and
   nothing else happens to it (`test/splice.test.ts`, "delivers a peer bytes to
   its partner unchanged", which sends every byte value there is, and "carries
   traffic in both directions and keeps each side in order").

Control is text and content is binary, in both directions, with no exceptions.
That is what makes "the relay does not touch payloads" checkable rather than
claimed: there is one line that writes a binary frame, and it writes the bytes it
was given (`test/splice.test.ts`, "forwards a payload shaped like a control frame
without acting on it", which sends the relay its own close frame as content and
watches it come out the other side; `test/lifecycle.test.ts`, "hangs up on a peer
that keeps talking in control frames after its hello", for the other direction).

A peer may send `{"t":"ping"}` at any time after its hello and will get
`{"t":"pong"}` back (`test/limits.test.ts`, "answers a peer that is keeping up
with its own pongs"). On the Worker host the runtime answers it without waking
anything, which is what keeps a quiet pair cheap; the relay learns of it from a
timestamp the runtime kept, not from the frame
(`test/workerd/pairing.workerd.test.ts`, "answers a peer keepalive without ever
waking the object to do it", which pings an object for long enough that it would
have been evicted and then proves it was; `test/hibernation.test.ts`, "counts
the keepalive the runtime answered without waking it"). Either way it counts:
send one more often than `RELAY_IDLE_TIMEOUT_MS` and a session that is otherwise
silent stays up (`test/lifecycle.test.ts`, "keeps a quiet pair that is sending
the keepalive the relay documents"; `test/workerd/deadlines.workerd.test.ts`,
"keeps a pair alive on nothing but the keepalive the runtime answered for it").
On the Worker host this is the only keepalive a peer has, because a Durable
Object is not given the WebSocket protocol's own ping.

Control frames from the relay are advisory. A relay that lied in one could, at
worst, tear a session down — which it could do anyway by hanging up.

### Close codes

| Code | Meaning | What a client should do |
| --- | --- | --- |
| `4000` | Hello absent, late, malformed, a version it does not speak, or naming a different rendezvous than the URL did | Fix the client |
| `4001` | Your partner disconnected | Reconnect now |
| `4002` | A newer connection claimed this rendezvous | Back off, then reconnect |
| `4003` | You stopped reading and the relay will not queue for you | Reconnect |
| `4004` | Over the frame or byte budget | Slow down, then reconnect |
| `4005` | The session showed no sign of life past the idle budget. Both halves get this | Reconnect, and keepalive more often than `RELAY_IDLE_TIMEOUT_MS` |
| `4006` | Nobody joined you within the pairing budget | Reconnect |
| `4007` | The relay is at capacity, or this connection was displaced before it said anything | Back off |
| `4008` | You sent something the protocol does not allow there | Fix the client |
| `1001` | The relay is going away, or has lost the state for this session | Reconnect shortly |
| `1009` | Frame over the size cap | Fix the client |

Every one of those is sent by a test, because a close code is the only thing a
client has to go on and one that drifted would be found by somebody's reconnect
loop rather than by us. In order: `4000`, `test/lifecycle.test.ts`, "hangs up on
a hello that is %s"; `4001`, "tells the survivor when its partner vanishes without
closing"; `4002`, "distinguishes being superseded from a partner that simply
left"; `4003`, `test/limits.test.ts`, "drops a peer that cannot keep up rather
than buffering without bound"; `4004`, "closes a peer sending frames faster than
its budget allows"; `4005`, `test/lifecycle.test.ts`, "closes a paired session
that has shown no sign of life within the idle budget"; `4006`, "sends a peer
away when nobody has joined it within the pairing budget"; `4007`,
`test/hibernation.test.ts`, "keeps a rendezvous open for its own pair however
many sockets are aimed at it"; `4008`, `test/splice.test.ts`, "refuses to carry
content from a peer that has not been paired yet"; `1001`,
`test/operability.test.ts`, "closes live sessions with a reason instead of
dropping them", and `test/hibernation.test.ts`, "sends a survivor back rather
than blaming it for state the object lost"; `1009`, `test/limits.test.ts`,
"refuses a frame larger than the cap instead of assembling it", and
`test/hibernation.test.ts`, "refuses a frame over the size cap rather than
passing it on", which is the same rule on the host that has no `ws` underneath it
to have refused the frame first.

`4001` and `4002` are deliberately different. A pair that treated being
superseded as a partner leaving would reconnect immediately, displace each other,
and do it again for as long as both were running (`test/lifecycle.test.ts`,
"distinguishes being superseded from a partner that simply left").

`4005` goes to both halves for the same reason. Nobody disconnected — the two of
them were quiet and both are being reaped for it — so telling either one its
partner left would be false, and would send it into an immediate reconnect for a
fault that did not happen (`test/hibernation.test.ts`, "tells both halves the
truth when it reaps a pair for silence"; `test/workerd/deadlines.workerd.test.ts`,
"reaps a silent pair on the alarm and tells both halves the same true thing").

`1001` covers one case worth naming, because the wrong code there is expensive. A
Durable Object rebuilds its pairing table from what is attached to each socket on
every event, and a socket it could not read for one event is one the table gets
rebuilt without. The peer on the other half of that pairing did nothing: its own
state says paired, the table no longer agrees, and its next frame — its keepalive
at the latest — finds no partner. That is the relay having lost state, so the
peer is told to go away and come back. A protocol complaint (`4008`) there reads
to a client as its own bug, and a client that believes that stops reconnecting
for the life of the process, for a fault that was never its
(`test/hibernation.test.ts`, "sends a survivor back rather than blaming it for
state the object lost", which takes the partner's socket away mid-event and
checks which of the two codes comes out).

---

## Limits, and why each one is where it is

Every one is an environment variable. All of them have a default that is safe to
deploy unchanged, and a value that cannot be parsed is refused rather than
replaced by the default (`test/operability.test.ts`, "refuses to start on a limit
it cannot make sense of rather than guessing"). On the container host that is a
process that exits; on the Worker it is every request failing, for the reason
[the deploy section](#deploying-again-and-changing-it) gives.

This table is the **container host**. Ten of its eighteen rows have nowhere to
apply on the Worker, and the "Where" column says which: `both` means the limit is
enforced on either host, `container` means the Worker has nothing to enforce it
with and setting the variable there would do nothing at all. The section on path
1 above says the same in longer form, and `wrangler.jsonc` carries only the rows
marked `both` — which is asserted against this table itself rather than left to
agree with it by hand (`test/hosts.test.ts`, "carries every limit this host can
enforce, and not one it cannot").

| Variable | Default | Where | Why |
| --- | --- | --- | --- |
| `RELAY_HOST` | `0.0.0.0` | container | Bind address. `127.0.0.1` if a proxy on the same box is the only client. |
| `RELAY_PORT` | `8787` | container | Listen port. `0` picks a free one. |
| `RELAY_PATH` | `/v1/relay` | both | The only upgradable path. Everything else is a 404. |
| `RELAY_MAX_CONNECTIONS` | `512` | container | 256 concurrent pairs. Far past any team, and a bound on the memory one process can be asked for. A Worker has no process to count across. |
| `RELAY_MAX_CONNECTIONS_PER_ADDRESS` | `32` | container | A team behind one office NAT shares an address; 32 leaves room for that without letting one address take the whole relay. |
| `RELAY_MAX_CONNECTIONS_PER_ADDRESS_PER_MINUTE` | `60` | container | Makes a reconnect loop cost the looper rather than the relay. |
| `RELAY_MAX_FRAME_BYTES` | `262144` | both | Noise caps a message at 65535 bytes, so 256 KiB carries several batched and still refuses anything designed to make the relay allocate. |
| `RELAY_MAX_FRAMES_PER_SECOND` | `200` | both | A terminal at full tilt is tens of frames a second. 200 is generous for typing and streaming, and stops a peer spending the relay's event loop. Every frame after the hello is counted, control frames included: a keepalive costs the relay what a content frame costs it, so it is charged the same. |
| `RELAY_MAX_BYTES_PER_SECOND` | `4194304` | both | 4 MiB/s per connection — more than a terminal produces, less than a peer needs to saturate a host. Counted over every frame, of either kind. |
| `RELAY_MAX_BUFFERED_BYTES` | `4194304` | container | The memory bound that matters. Past it the peer that stopped reading is closed and the relay never queues without limit — whether what it is not reading is its partner's traffic or the pongs it asked for itself. The Worker runtime owns that queue and does not show its depth. |
| `RELAY_HELLO_TIMEOUT_MS` | `10000` | both | A connection that opens and says nothing is the cheapest way to hold a slot, so this is the tightest deadline here. |
| `RELAY_PAIR_TIMEOUT_MS` | `600000` | both | How long a peer may park waiting for a teammate. `0` parks until the socket dies. |
| `RELAY_IDLE_TIMEOUT_MS` | `600000` | both | How long a paired session may show no sign of life at all — no content either way, and nothing from the peer, keepalives included. A pair that keepalives never reaches it. `0` disables. |
| `RELAY_KEEPALIVE_INTERVAL_MS` | `30000` | both | How often deadlines are checked, and how often a half-open socket is probed. |
| `RELAY_SHUTDOWN_GRACE_MS` | `5000` | container | How long shutdown waits for closing handshakes before cutting what is left. |
| `RELAY_TRUSTED_PROXY_HOPS` | `0` | container | Proxies in front. `0` uses the socket address, which a client cannot forge. |
| `RELAY_LOG_CLIENT_ADDRESS` | `0` | container | Off by default. Addresses appear as refs unless you turn this on; the Worker logs the ref and never the address. |
| `RELAY_HEALTH_TOKEN` | unset | container | When set, `/healthz` needs `Authorization: Bearer <token>`. |

The rate limits are token buckets with a burst equal to one second's budget, so
a peer that is quiet then sends a batch is fine, and a peer that is never quiet
is closed (`test/limits.test.ts`, "lets a peer keep sending once its budget has
refilled", and "counts a control frame against the byte budget as well as the
frame budget", because a frame nothing charges for is one a peer can send several
hundred thousand times a second).

`/healthz` reports aggregate counts only — connections, how many are waiting, how
many sessions. There is nothing per-peer in it (`test/operability.test.ts`,
"reports how much is connected without saying who any of it is", which asserts
the whole body rather than picking at it). Keep it off the public internet
anyway, or set `RELAY_HEALTH_TOKEN` (`test/operability.test.ts`, "refuses a
health read with no credential once one is configured"). The Worker's version is
thinner still (`{"status":"ok"}`), because a Worker has no global view and
manufacturing one would mean collecting the thing this relay exists not to
collect (`test/workerd/pairing.workerd.test.ts`, "answers a health check with a
count of nothing, and answers nothing else at all", which also holds the 404 on
every other path).

---

## The awkward cases, and what happens

These are not edge cases. They are what two laptops do.

**A peer vanishes mid-session.** The socket dies without a close frame. The
survivor is closed with `4001` and the pairing is forgotten. There is nothing to
preserve: a Noise session cannot outlive its transport, so the pair rebuilds from
scratch (`test/lifecycle.test.ts`, "tells the survivor when its partner vanishes
without closing"; `test/workerd/pairing.workerd.test.ts`, "tells a survivor its
partner left, from an object rebuilt since they paired", which is the same thing
from an object that never saw the pairing being made).

**A peer reconnects while its old socket is still half-open.** A suspended
machine's connection reads as open for as long as the network lets it. When a
connection arrives for a rendezvous that already has a live session, the relay
ends that session and lets the newcomer wait, and both old peers are closed with
`4002`. It does this because **it cannot tell the two peers apart** — they are
two anonymous connections that presented the same token, and there is no "side A"
to slot a reconnect into. Ending the session is the only answer that is right
whichever of them came back. The old pair then reconnects, and because the
newcomer is already waiting, they pair on the first try (`test/lifecycle.test.ts`,
"lets a returning peer take over a rendezvous its half-open predecessor still
holds", and "does not let a superseded peer evict the connection that replaced
it", which is the late close event arriving afterwards;
`test/workerd/pairing.workerd.test.ts`, "hands a returning peer its own
rendezvous back and displaces the pair holding it").

**Two peers race to pair.** Registration happens in one synchronous step, so
whichever hello is read first parks and the second pairs with it. Both get the
same session id and opposite `initiator` flags. There is no window in which two
peers both park (`test/lifecycle.test.ts`, "pairs two peers that greet in the
same instant", and "pairs many simultaneous rendezvous without crossing them",
which offers twelve pairs at once and checks the sessions are twelve).

**One peer arrives long before the other.** It parks, and stays parked. A parked
connection is kept alive and reaped promptly if it dies, and closed with `4006`
only once `RELAY_PAIR_TIMEOUT_MS` has gone by — ten minutes by default, after
which a client reconnects (`test/lifecycle.test.ts`, "lets a peer park until its
partner turns up", which takes it to within ten seconds of the budget first, and
"sends a peer away when nobody has joined it within the pairing budget";
`test/workerd/deadlines.workerd.test.ts`, "sends an unpaired peer away when
nobody ever joins it", where the deadline is the runtime's alarm rather than a
sweep this process drives). Set it to `0` to park indefinitely.

**A peer stops reading.** Its send queue grows. Past `RELAY_MAX_BUFFERED_BYTES`
it is closed with `4003` and its partner with `4001`. The relay does not buffer
without bound, does not silently drop frames from the middle of a stream, and
does not slow the sender down — a Noise stream with a hole in it is over anyway,
so ending it cleanly is better than any of those. A peer with no partner at all
is held to the same rule: the pongs it asked for are the relay's writes too, and
a peer that will not read its own answers is closed rather than queued for
(`test/limits.test.ts`, "drops a peer that cannot keep up rather than buffering
without bound", over a real socket that has stopped being read, and "closes a
peer that is not reading the answers it asked for"). On the Worker host neither
rule can fire; see the limits section above, which now says so with a test rather
than only in prose.

**A peer goes quiet but stays connected.** Nothing happens to it, as long as it
is still there. On the container host the relay pings it at the WebSocket layer
and cuts it only if two intervals pass with no answer (`test/lifecycle.test.ts`,
"keeps a peer that is quiet but still answering", and "cuts a peer whose socket is
open but no longer listening"). On the Worker host
liveness is Cloudflare's, and peers use the `{"t":"ping"}` control frame, which
the runtime answers without waking anything — and the object reads back the
timestamp of that answer when it next wakes, so a keepalive it never saw still
counts as a sign of life (`test/hibernation.test.ts`, "counts the keepalive the
runtime answered without waking it", which is twenty-two rounds of it with the
object thrown away between each one). Either way, a pair that is keeping itself
alive is left alone: `RELAY_IDLE_TIMEOUT_MS` reaps a session that has gone silent
altogether, not one that is merely not typing (`test/lifecycle.test.ts`, "keeps a
session that is still carrying content").

**Both peers go quiet at once and neither keepalives.** Both are closed with
`4005` after `RELAY_IDLE_TIMEOUT_MS`. Both, and with the same code: nothing
disconnected, so neither of them is told its partner did
(`test/lifecycle.test.ts`, "closes a paired session that has shown no sign of life
within the idle budget"; `test/workerd/deadlines.workerd.test.ts`, "reaps a silent
pair on the alarm and tells both halves the same true thing").

---

## Working on it

```sh
cd relay
npm install
npm test          # 139 tests, including the Worker under a real workerd
npm run typecheck # both hosts: Node types and Workers types
npm run build     # the container host's JavaScript, into dist/
npm run worker:dev # the Worker on localhost, under workerd, deploying nothing
```

Most of it runs in about two seconds and does not sleep: everything that is about
a deadline is driven by an injected clock, and everything else is awaited as a
condition on a real socket event, so a failure means a failure rather than a slow
machine. The exception is `test/workerd/`, which takes roughly a minute, for a
reason given below.

The container host is tested over **real WebSockets on a real port** — the splice
itself, every limit, and every awkward case above. `test/hosts.test.ts` is the odd
one out and does not open a socket at all: three of the promises in this file are
about files rather than about frames — that `wrangler.jsonc` carries only limits
the Worker can enforce, that `src/core` knows nothing about either host, and that
nothing is ever stored anywhere — and each of those is undone by an ordinary-
looking edit rather than by a bug, so they are asserted against the files.

The Durable Object host is tested twice, and it is worth knowing which is which.
`test/hibernation.test.ts` drives it against a narrow fake of the runtime that
does only what Cloudflare's documentation says the real one does, and **throws
the object away between every single frame**, which is the worst case hibernation
is allowed to put it in. It is instant and it can be made to fail on demand,
which is why it is still there. `test/workerd/` drives the same adapter through
`wrangler dev`, which is **`workerd`, the runtime Cloudflare actually runs, on
localhost**: nothing is deployed, no account is involved, no network resource is
created. If wrangler or its per-platform binary is not installed that suite skips
with a message saying so in as many words, rather than going quietly green.

Those tests wait on the wall clock, because the alarm and the eviction belong to
the runtime and neither takes instruction. An object has to be left alone for
about ten seconds before `workerd` throws it out of memory, and a test that says
it survived a hibernation wake checks that the eviction actually happened — by
watching the object's own log refs change — rather than trusting the number. That
is where the minute goes.

### What running it on workerd settled

Two assumptions the fake could only inherit from whoever wrote it were checked
against the real runtime. Both hold:

- **A socket's attachment can still be read inside `webSocketClose`.** It can,
  and the closing socket is still in `getWebSockets()` while that handler runs.
  This is the one that matters most: it is the whole of how a survivor gets told
  its partner has gone.
- **A `PairSocket` is one object for the whole of one event, after a hibernation
  wake.** The JavaScript wrapper is *not* the one the pairing opened on — a
  property set on it before the wake is gone afterwards — but within a single
  event the socket handed to the handler is identical to the one in
  `getWebSockets()`. That is the only thing the adapter relies on: it rebuilds
  its table for every event and keeps no socket in a field.

Two things the real runtime did that the fake could not show:

- **An alarm that re-arms unconditionally never lets the object go.** It was
  doing exactly that: every sweep armed the next one whether or not there was
  anything left to sweep, so one object for every rendezvous anybody had ever
  used would have stayed in memory waking itself every thirty seconds for as
  long as the account lasted — billed to whoever deployed it, which is a team
  rather than us. It now arms the next sweep only while it still holds a
  connection, and a peer that comes back arms it again on the way in. The fake
  could not have caught this: it clears the alarm itself between ticks.
- **A close the object starts is not always flushed at once.** For a socket that
  has never delivered a frame — the connection that opens and then says nothing,
  which is what the greeting deadline exists for — `workerd` sends the close
  handshake about ten seconds after the relay asks it to. The in-band
  `{"t":"closing"}` frame arrives on time, which is exactly why the protocol
  gives the reason in-band as well as in the close frame. Nothing is lost; the
  peer's socket simply lingers after it has been told.

What is still not exercised is a **deployed** Worker. All of the above is
`workerd` on localhost: the same runtime, but not the same network. The edge in
front of a real deployment — TLS termination, the `CF-Connecting-IP` header the
relay reads to group connections, and whatever it does to a WebSocket left idle
across the public internet — is not in the picture, and neither is the pricing.
The bundle is checked with `wrangler deploy --dry-run`; the first deploy is still
the first time any of that is met.

### How it is laid out

```
src/core/        every rule, portable, no host in it
  protocol.ts      the wire contract, close codes, hello parsing
  rendezvous.ts    the pairing table: who pairs, who is displaced, who is told
  peerSession.ts   one connection's state machine, the budgets, and the splice
  rateLimit.ts     token buckets, snapshot-able so they survive hibernation
  config.ts        environment to limits, with errors instead of guesses
  log.ts, clock.ts, random.ts

src/node/        the container host: an HTTP server, `ws`, one sweep timer
src/workers/     the Cloudflare host: a Worker that routes, a DO that holds a pair

teamree-relay    the one command at the top of this file: a shell wrapper
bin/             what it runs — writes the Worker project into a directory you
                 own and deploys it there. Plain JavaScript with no build step,
                 because a copy of it ships inside the installed app, where
                 there is nothing to build it with.
```

`src/core` imports nothing from Node and nothing from Cloudflare
(`test/hosts.test.ts`, "keeps every rule in a core that imports neither host").
That is not tidiness; it is the reason there are two hosts and one set of rules,
the reason a third would be a small adapter rather than a second implementation,
and the reason `wrangler.jsonc` needs no `nodejs_compat`. The only thing a host
must supply is a socket with `send`, `close` and a way to know whether it is open
— plus somewhere to call `sweep` on a timer.

Nothing is stored anywhere, on either host. A live pairing exists while both
sockets do; when the second one goes, so does it. There is no database to back
up, no migration to run and nothing on disk to leak. The Durable Object has a
storage API within reach and a SQLite backend behind it, so that is one line of
somebody's restraint away at all times: the only two members of it this package
names are when the next sweep is and when to set it for (`test/hosts.test.ts`,
"asks the Durable Object runtime for nothing but an alarm").
