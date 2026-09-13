# The teamree relay

Two laptops behind two routers cannot reach each other. So neither tries: each
opens an **outbound** WebSocket to a relay, and the relay splices the two
streams together. Outbound-only means no port forwarding, no STUN, no public
address on either machine, and no difference between an office, a café and a
phone tether.

The relay is a dumb pipe. It has no database, no accounts and no user records,
and **it is never trusted with content**: the two peers run a Noise `IK` session
over the spliced connection, keyed from the public keys already committed to
your repository, and everything after that handshake is ciphertext. A relay that
was compromised — or simply run by someone you would rather not read your
terminal — cannot read a byte of it.

What it can do is get in the way. It can drop frames, delay them, refuse to
pair, end a session, or claim a rendezvous itself and keep two teammates apart.
It also holds two things worth naming: the rendezvous token, which is the whole
of what a peer presents to be paired, and a copy of every frame that has passed
through it, the handshake's included. Whether holding those is enough for it to
pass for one of you, rather than only to stand in your way, is a property of the
peer handshake and not of this program — it is being settled there, in the
transport above this relay. So read this as: **the relay cannot read your
terminals, and it can deny and disrupt.** Do not read it as a bound on
impersonation, because this program is not where that bound lives.

Your team runs this. We do not run one for you, and there is nothing to sign up
for.

---

## Pick one of these two

|  | Cloudflare Worker | Container |
| --- | --- | --- |
| Setup | `npx wrangler deploy`, once | `docker run`, plus a way to be reached |
| Works from anywhere | Yes | Only if the box is reachable |
| Money | Free plan is enough for a team; see below | Whatever the box costs |
| Stays up | Yes, nothing to babysit | As long as the box does |
| Needs an account | A Cloudflare one | None |

**Take the Worker unless you have a reason not to.** It is one command, it keeps
working, and it does not care where anyone is. The container is for teams who
will not use Cloudflare, or who are all on one network anyway.

---

## Path 1 — deploy the Worker

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
further operations of that type fail until 00:00 UTC. A handful of people
holding pairwise sessions is well inside them; a large team that lives in this
all day should look at the current numbers on that page before assuming. **We
have not verified today's exact free-tier figures** — they change — so read them
there rather than from here.

### Deploy it

```sh
cd relay
npm install
npx wrangler login      # opens a browser once
npm run deploy
```

That is the whole of it. There are no resource ids to fill in, nothing to click
in the dashboard, and no secrets to set. The Durable Object namespace and its
migration are declared in `wrangler.jsonc`, and Wrangler creates them on first
deploy.

Wrangler prints the URL it deployed to, of the form
`https://teamree-relay.<your-subdomain>.workers.dev`. The relay endpoint is that
host with `/v1/relay` on the end, spoken as `wss://`:

```
wss://teamree-relay.<your-subdomain>.workers.dev/v1/relay
```

Give that to everyone on the team. If you want a different name, change `name`
in `wrangler.jsonc` before deploying; if you want it on your own domain, add a
[custom domain
route](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/).

To change a limit, edit the matching entry under `vars` in `wrangler.jsonc` and
deploy again. A value the relay cannot parse stops the Worker starting rather
than being quietly ignored. Only the limits this host can actually enforce are
listed there, and the ones missing from it are named below rather than left for
you to notice.

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
- **Concurrency: 32,768 WebSockets per Durable Object.** An object here refuses
  the fourth: it holds one pairing, which is two peers plus room for the one
  arriving to displace them. Cloudflare's ceiling is irrelevant by four orders
  of magnitude; the object's own is the one that matters, and the next section
  says why.
- **Hibernation is the reason this is cheap.** A pair that sits quiet overnight
  has its object evicted from memory while both sockets stay connected, and it
  is rebuilt on the next frame. That is why nothing is kept in a field anywhere
  in `src/workers/`, and why the tests throw the object away between every single
  frame. Against `workerd` locally an object is evicted after about ten seconds
  of being left alone, and an object whose last connection has gone stops waking
  itself at all — which it did not always do, and the section on testing says
  how that was found.

### Two things this host does not do

Both are real, and neither is a reason to prefer the container. They are here so
that nobody reads the limits table further down as a description of this host.

**There is no connection cap, no per-address cap and no connection-rate cap.**
`RELAY_MAX_CONNECTIONS`, `RELAY_MAX_CONNECTIONS_PER_ADDRESS` and
`RELAY_MAX_CONNECTIONS_PER_ADDRESS_PER_MINUTE` are counts across a whole process,
and a Worker has no process to count across. They are not in `wrangler.jsonc`
and setting them there would do nothing. What bounds this host instead is that
**one Durable Object takes three sockets and refuses the fourth** with a `503`.
That matters because the object's name in the URL is a hash anybody may compute
or simply invent — it carries no token and proves nothing — so without a refusal
a single client could aim every socket it can open at one object, and every
frame that object then handled would cost work in proportion to how many were
attached. Three is the number because two is what a pairing is and the third is
the peer arriving to displace a stale one, which is how a laptop that slept gets
its session back. Cloudflare's own per-account and per-request limits are what
stand between you and a flood of objects; the relay's job is to make each one
cheap and bounded, and that it does.

**The slow-consumer rule cannot fire.** The runtime does not expose a send-queue
depth to a Durable Object, so the relay has nothing to measure and never closes
a peer for not reading. Cloudflare owns that queue instead. The frame-rate and
byte-rate budgets still apply and are what bound the work. On the container host,
where the depth is visible, the rule is enforced and tested.

Neither makes this a bad fit. It is close to the shape Durable Objects were built
for.

---

## Path 2 — run the container

```sh
cd relay
docker build -t teamree-relay .
docker run -d --name teamree-relay -p 8787:8787 --restart unless-stopped teamree-relay
```

Check it:

```sh
curl -s localhost:8787/healthz
# {"status":"ok","uptimeMs":1200,"connections":{"total":0,"greeting":0,"waiting":0},"sessions":0}
```

The relay endpoint is `ws://<host>:8787/v1/relay`, or `wss://` once there is TLS
in front of it.

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
  with path 1, which needs the same account and less work.
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
busy client. Leave it at `0` and the socket address is used, which is the only
value a client cannot forge — so `0` is the right answer whenever nothing
trustworthy is adding `X-Forwarded-For`.

### Stopping it

`docker stop` sends `SIGTERM`. The relay stops accepting connections, closes
every live session with a `1001 going away`, waits for the closing handshakes and
exits. Peers see an ordinary "come back in a moment", not a dropped socket.

---

## What the operator learns, and what they do not

This matters more on path 2 than path 1, because there the operator is a
colleague rather than a company. It is the same answer either way.

**Whoever runs the relay cannot read anyone's terminals.** Not with effort, not
by changing the code, not by keeping the logs. The two peers complete a Noise
`IK` handshake through the splice before any content moves, and the relay only
ever sees ciphertext going one way and ciphertext coming back. It has no key
material and no way to acquire any: `IK` authenticates both static keys, so a
relay that substituted its own would fail the handshake rather than sit in the
middle of it. Hosting buys no visibility at all. There are tests for the
observable half of this — that no payload byte and no rendezvous token reaches a
log or the health endpoint, on both hosts — but the load-bearing part is the
encryption, which is not this program's to get wrong.

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
  default; `RELAY_LOG_CLIENT_ADDRESS=1` turns that on for debugging. On path 1,
  Cloudflare sees them regardless.
- **Timing and volume.** Frame sizes and when they arrive. Noise does not pad,
  so an idle session looks idle and a burst of typing looks like a burst of
  typing. Padding would be the peers' to add, not the relay's.
- **Nothing else.** No repository name, no branch, no handle, no pane, no file
  path, no command, no output.

Logs are JSON lines on stdout. They contain no payload bytes in any form, and no
rendezvous token: a token is a shared secret, and an operator holding a log of
them could displace any pairing in it. Correlation still works, through refs —
short labels derived under a key generated at start-up and discarded at exit. A
ref names a pairing within one run of the process and is meaningless outside it.

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

The token is what a peer presents in its hello, and it **rotates hourly**.

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

The relay itself knows none of this. To it, a rendezvous is 32 opaque bytes, and
its entire job is to notice that two connections presented the same ones. That is
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
frame arrives. The container host has no use for it and ignores it.

The hash is not nothing, though, and on the Worker host it is worth being exact:
because it names an object and an object takes three sockets, whoever holds the
hash can hold those three open and keep the real pair from being admitted, until
the greeting deadline reaps them. That is denial of service against one pairing
for as long as they keep it up — weaker than what the token itself buys, and no
more than what anyone able to see the URL could already do by refusing to carry
traffic. Nobody sees that URL but the two peers and the relay.

Neither host checks that the hash and the token agree. Neither needs to: a peer
that sends a hint for one pairing and a token for another simply lands where its
partner is not, which costs only that peer.

### What this hides, and what it does not

Hides:

- **The repository.** Nothing derived from its name, remote or contents is sent.
- **Who the peers are.** No handle, no key, no email, no account. The token is
  256 bits that look like any other 256 bits.
- **Any link between pairs.** Each pair's token is independent of every other
  pair's, so the relay cannot tell one team's full mesh from a set of strangers.
- **Long-lived identity.** Hourly rotation means no stable identifier for the
  operator to accumulate against.

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
   Unknown fields are ignored. Anything else, or nothing at all within the
   greeting deadline, and the connection is closed with `4000`.
3. The relay replies with a text frame — `{"t":"waiting"}` if the partner has not
   arrived, and `{"t":"paired","session":"…","initiator":true|false}` when it
   has. Both sides get `paired`; exactly one gets `initiator: true`, which is the
   side that should open the Noise handshake. Two sides opening one at once
   simply fails, so the relay breaks the tie.
4. From then on every **binary** frame is forwarded verbatim to the partner, and
   nothing else happens to it.

Control is text and content is binary, in both directions, with no exceptions.
That is what makes "the relay does not touch payloads" checkable rather than
claimed: there is one line that writes a binary frame, and it writes the bytes it
was given.

A peer may send `{"t":"ping"}` at any time after its hello and will get
`{"t":"pong"}` back. On the Worker host the runtime answers it without waking
anything, which is what keeps a quiet pair cheap; the relay learns of it from a
timestamp the runtime kept, not from the frame. Either way it counts: send one
more often than `RELAY_IDLE_TIMEOUT_MS` and a session that is otherwise silent
stays up. On the Worker host this is the only keepalive a peer has, because a
Durable Object is not given the WebSocket protocol's own ping.

Control frames from the relay are advisory. A relay that lied in one could, at
worst, tear a session down — which it could do anyway by hanging up.

### Close codes

| Code | Meaning | What a client should do |
| --- | --- | --- |
| `4000` | Hello absent, late, malformed, or a version it does not speak | Fix the client |
| `4001` | Your partner disconnected | Reconnect now |
| `4002` | A newer connection claimed this rendezvous | Back off, then reconnect |
| `4003` | You stopped reading and the relay will not queue for you | Reconnect |
| `4004` | Over the frame or byte budget | Slow down, then reconnect |
| `4005` | The session showed no sign of life past the idle budget. Both halves get this | Reconnect, and keepalive more often than `RELAY_IDLE_TIMEOUT_MS` |
| `4006` | Nobody joined you within the pairing budget | Reconnect |
| `4007` | The relay is at capacity | Back off |
| `4008` | You sent something the protocol does not allow there | Fix the client |
| `1001` | The relay is going away | Reconnect shortly |
| `1009` | Frame over the size cap | Fix the client |

`4001` and `4002` are deliberately different. A pair that treated being
superseded as a partner leaving would reconnect immediately, displace each other,
and do it again for as long as both were running.

`4005` goes to both halves for the same reason. Nobody disconnected — the two of
them were quiet and both are being reaped for it — so telling either one its
partner left would be false, and would send it into an immediate reconnect for a
fault that did not happen.

---

## Limits, and why each one is where it is

Every one is an environment variable. All of them have a default that is safe to
deploy unchanged, and a value that cannot be parsed stops the relay starting.

This table is the **container host**. Ten of its eighteen rows have nowhere to
apply on the Worker, and the "Where" column says which: `both` means the limit is
enforced on either host, `container` means the Worker has nothing to enforce it
with and setting the variable there would do nothing at all. The section on path
1 above says the same in longer form, and `wrangler.jsonc` carries only the rows
marked `both`.

| Variable | Default | Where | Why |
| --- | --- | --- | --- |
| `RELAY_HOST` | `0.0.0.0` | container | Bind address. `127.0.0.1` if a proxy on the same box is the only client. |
| `RELAY_PORT` | `8787` | container | Listen port. `0` picks a free one. |
| `RELAY_PATH` | `/v1/relay` | both | The only upgradable path. Everything else is a 404. |
| `RELAY_MAX_CONNECTIONS` | `512` | container | 256 concurrent pairs. Far past any team, and a bound on the memory one process can be asked for. A Worker has no process to count across. |
| `RELAY_MAX_CONNECTIONS_PER_ADDRESS` | `32` | container | A team behind one office NAT shares an address; 32 leaves room for that without letting one address take the whole relay. |
| `RELAY_MAX_CONNECTIONS_PER_ADDRESS_PER_MINUTE` | `60` | container | Makes a reconnect loop cost the looper rather than the relay. |
| `RELAY_MAX_FRAME_BYTES` | `262144` | both | Noise caps a message at 65535 bytes, so 256 KiB carries several batched and still refuses anything designed to make the relay allocate. |
| `RELAY_MAX_FRAMES_PER_SECOND` | `200` | both | A terminal at full tilt is tens of frames a second. 200 is generous for typing and streaming, and stops a peer spending the relay's event loop. |
| `RELAY_MAX_BYTES_PER_SECOND` | `4194304` | both | 4 MiB/s per connection — more than a terminal produces, less than a peer needs to saturate a host. |
| `RELAY_MAX_BUFFERED_BYTES` | `4194304` | container | The memory bound that matters. Past it the peer that stopped reading is closed; the relay never queues without limit. The Worker runtime owns that queue and does not show its depth. |
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
is closed.

`/healthz` reports aggregate counts only — connections, how many are waiting, how
many sessions. There is nothing per-peer in it. Keep it off the public internet
anyway, or set `RELAY_HEALTH_TOKEN`. The Worker's version is thinner still
(`{"status":"ok"}`), because a Worker has no global view and manufacturing one
would mean collecting the thing this relay exists not to collect.

---

## The awkward cases, and what happens

These are not edge cases. They are what two laptops do.

**A peer vanishes mid-session.** The socket dies without a close frame. The
survivor is closed with `4001` and the pairing is forgotten. There is nothing to
preserve: a Noise session cannot outlive its transport, so the pair rebuilds from
scratch.

**A peer reconnects while its old socket is still half-open.** A suspended
machine's connection reads as open for as long as the network lets it. When a
connection arrives for a rendezvous that already has a live session, the relay
ends that session and lets the newcomer wait, and both old peers are closed with
`4002`. It does this because **it cannot tell the two peers apart** — they are
two anonymous connections that presented the same token, and there is no "side A"
to slot a reconnect into. Ending the session is the only answer that is right
whichever of them came back. The old pair then reconnects, and because the
newcomer is already waiting, they pair on the first try.

**Two peers race to pair.** Registration happens in one synchronous step, so
whichever hello is read first parks and the second pairs with it. Both get the
same session id and opposite `initiator` flags. There is no window in which two
peers both park.

**One peer arrives long before the other.** It parks, and stays parked. A parked
connection is kept alive and reaped promptly if it dies, and closed with `4006`
only once `RELAY_PAIR_TIMEOUT_MS` has gone by — ten minutes by default, after
which a client reconnects. Set it to `0` to park indefinitely.

**A peer stops reading.** Its send queue grows. Past `RELAY_MAX_BUFFERED_BYTES`
it is closed with `4003` and its partner with `4001`. The relay does not buffer
without bound, does not silently drop frames from the middle of a stream, and
does not slow the sender down — a Noise stream with a hole in it is over anyway,
so ending it cleanly is better than any of those. (On the Worker host this rule
cannot fire; see the limits section above.)

**A peer goes quiet but stays connected.** Nothing happens to it, as long as it
is still there. On the container host the relay pings it at the WebSocket layer
and cuts it only if two intervals pass with no answer. On the Worker host
liveness is Cloudflare's, and peers use the `{"t":"ping"}` control frame, which
the runtime answers without waking anything — and the object reads back the
timestamp of that answer when it next wakes, so a keepalive it never saw still
counts as a sign of life. Either way, a pair that is keeping itself alive is left
alone: `RELAY_IDLE_TIMEOUT_MS` reaps a session that has gone silent altogether,
not one that is merely not typing.

**Both peers go quiet at once and neither keepalives.** Both are closed with
`4005` after `RELAY_IDLE_TIMEOUT_MS`. Both, and with the same code: nothing
disconnected, so neither of them is told its partner did.

---

## Working on it

```sh
cd relay
npm install
npm test          # 84 tests, including the Worker under a real workerd
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
itself, every limit, and every awkward case above.

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
```

`src/core` imports nothing from Node and nothing from Cloudflare. That is not
tidiness; it is the reason there are two hosts and one set of rules, and the
reason a third would be a small adapter rather than a second implementation. The
only thing a host must supply is a socket with `send`, `close` and a way to know
whether it is open — plus somewhere to call `sweep` on a timer.

Nothing is stored anywhere, on either host. A live pairing exists while both
sockets do; when the second one goes, so does it. There is no database to back
up, no migration to run and nothing on disk to leak.
