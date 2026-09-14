# site

The landing page at <https://teamree.us>. One static HTML file with its CSS and
its JavaScript inline, a handful of images, and no build step — `public/` is
exactly what is served.

```
public/
  index.html     the page; CSS and JS inline, so the page itself is one request
  favicon.svg    the application mark, as SVG
  icon-256.png   the same mark as PNG, for apple-touch-icon and older browsers
  og.png         1200x630 social card, generated (see below)
  screenshot.png the window; the hero clip's fallback, not docs/screenshot.png
  demos/         showcase.* the hero tour, plus feature clips: <id>.webm,
                 <id>.mp4, <id>.jpg, manifest.json
  _headers       security headers and cache lifetimes
  _redirects     /download/mac and /download
og/
  card.html      source for og.png
  render.sh      rasterises it with headless Chrome
tools/
  sync-demos.mjs reconciles the page with demos/manifest.json
```

## Branding

**The mark is being redesigned.** A design agent owns `public/favicon.svg`,
`public/icon-256.png`, `public/og.png` and the header wordmark; they are
replaced in place under the same filenames, so nothing in the page needs to
change when they land. The mark also exists inline in two places that must be
updated with them: the `<symbol id="mark">` at the top of `public/index.html`,
and the same paths in `og/card.html`. What follows describes the mark as it
stands today.

The mark is the application icon — the trunk with two worktrees branching off
it, drawn by `scripts/make-icons.mjs` and reproduced here as SVG paths on the
same 1024 grid, so the dock, the installer, the favicon and the social card are
one mark rather than three. The palette and the spacing steps are the app's own
tokens from `src/renderer/src/styles/tokens.css`, including the accent the
wordmark's dot uses. Two values are tuned for the web and say so in a comment:
the muted foreground, which needs 4.5:1 against this background at body sizes,
and the type scale, because a page is read further away than an IDE chrome.

Regenerating the social card after an edit to `og/card.html`:

```sh
sh site/og/render.sh        # needs Google Chrome; CHROME=/path/to/chrome to override
```

## The feature clips

Four sections carry a short screen capture of the real application: `worktrees`,
`terminals`, `cli`, `teamwork`. Each ships as `<id>.webm`, `<id>.mp4` and an
`<id>.jpg` poster, listed in `public/demos/manifest.json` with a width, a height
and a caption. The hero carries a fifth, `showcase.*`, which is a tour rather than
one feature and is not in the manifest — `sync-demos.mjs` leaves it alone.

**Everything captured so far predates 0.2.0 and shows it.** `public/demos/showcase.mp4`,
`public/demos/showcase.webm`, its poster `public/demos/showcase.jpg` and the
still `public/screenshot.png` were all shot on 0.1.2: the window in them is the
old slate ground rather than the absolute black that now ships, the status rail
reads `Runtime ready 0.1.2`, the teamwork panel is the one that did not ask which
end you were on, and a teammate's pane is still the corner card it stopped being.
The prose beside them was corrected; they cannot be, from anywhere but a Mac.
Retaking them changes nothing else — the names carry no version — and the
`aria-label` and `alt` text describe what they show rather than how they look, so
those hold either way.

The page hard-codes each clip's dimensions and caption, because a `<video>`
without `width`/`height` shifts the layout while it loads, and the page's own
content-security-policy forbids fetching a manifest at runtime. Hard-coded
numbers rot, so they are not maintained by hand:

```sh
node site/tools/sync-demos.mjs          # rewrite the page from the manifest
node site/tools/sync-demos.mjs --check  # exit 1 if the page is out of date
```

**Until the clips exist the four `<video>` elements ship parked inside an HTML
comment**, so a visitor fires no 404s at a page whose clips have not landed.
`sync-demos.mjs` un-parks them the first time it runs against a real manifest.
The frames reserve their space either way, so dropping the clips in changes
nothing structural — the placeholder underneath is simply covered.

A clip that will not play is a real outcome, not an impossibility, and is handled
as one. The host does not answer byte-range requests — it returns the whole file
with a `200` where GitHub's asset host returns a `206` — and some browsers
decline to play media on that basis, which on a macOS-only page means Safari is
the one to check before trusting the clips. When a clip's sources are exhausted
the script removes the play control and leaves the `<video>` in place showing its
poster; if the poster is missing too, the placeholder underneath shows through.
The caption and the prose beside it already carry the meaning, so nothing is lost
but the motion.

Two things that failure path got wrong first time, both found by testing it with
deliberately broken sources rather than by reasoning about it:

- A `<video>` with `<source>` children does **not** fire `error` at itself when
  they all fail — the event goes to the last `<source>`, and the element is left
  with `networkState === NETWORK_NO_SOURCE`. A listener on the video alone never
  fires. The script listens on the sources and checks that state.
- Removing the failed `<video>` from the DOM hid the entire figure, caption and
  all. `.demo-figure:not(:has(video))` is what keeps the figures out of the page
  while the clips are parked, and `:has()` does not reliably re-evaluate when
  script changes the subtree. The element stays; only the control goes.

`preload` is `none` rather than `metadata`, and that is a consequence of the
host rather than a preference: it does not answer byte ranges, so a metadata
preload cannot be a partial fetch — it opens a connection per clip and discards
whatever arrives before the browser gives up. Nothing is fetched until a clip is
scrolled to. The poster covers the gap and the `width`/`height` attributes mean
the layout never depended on the metadata.

Playback, for anyone changing it: the markup carries native `controls` so the
page works with JavaScript off; the script removes them, fits a custom play
button, and plays a clip only while it is on screen. `prefers-reduced-motion`
suppresses autoplay entirely and leaves the poster and the button, and a change
to that preference while the page is open is honoured too.

## Where the download points

The button links to

```
https://github.com/zero-abd/teamree/releases/latest/download/teamree-mac-universal.dmg
```

The file name carries no version, which is the point: `latest` resolves the
release but **not** the asset name, so a versioned name would 404 the day the
next release ships rather than falling back. Verified resolving 302 → 302 → 200
at 201,721,718 bytes.

Every release since v0.1.0 carries the same `.dmg` **twice**, as
`teamree-<version>.dmg` and as `teamree-mac-universal.dmg`. Both resolve, and
since v0.1.1 `SHA256SUMS.txt` lists the one digest under both names — so a reader
who downloaded the version-free file does find the line that matches it. The page
says exactly that, and prints no digest and no file size of its own: there is now
nothing on it that a release bump has to touch, which is the point of having none.
The earlier arrangement, where the page carried v0.1.0's digest and a "192 MiB"
next to it, is gone; do not put either back.

## Claims the page makes

Every factual claim on the page was checked against the repository rather than
written from memory, and three were cut because they did not survive it:

- **"open source"** as a phrase is still not used, and does not need to be. The
  page says "free" and "the source is on GitHub" and now links the licence, which
  is the thing a sceptical reader actually wanted. Those three stay true under any
  licence, so nothing has to change if the choice changes. The claim was cut
  originally because there was no `LICENSE` at all, and published source with no
  licence is all-rights-reserved.

  MIT landed on `main` in #36 after that check, so the footer nav now carries a
  **MIT licence** link to `blob/main/LICENSE` (verified 200). That link is
  deliberately the only place on the page that would name a licence. The
  PR's own framing is that MIT is an assumption — conventional for a developer
  tool, and matching what the site already promised — rather than a decision
  anybody has stated, so the owner may well pick something else. The whole blast
  radius if they do is five places: the `LICENSE` file itself, the `license`
  field in `package.json`, the same field in `relay/package.json`, one line in
  the root `README.md`, and the footer link above. Nothing else on this page
  names a licence, and "free" and "the source is on GitHub" are true under any
  of them.
- **"runs whatever agent is on your PATH"** was cut. Agent support is a closed
  catalogue of five — `claude`, `codex`, `gemini`, `opencode`, `droid`
  (`src/main/terminals/agent-command.ts`) — and the page now names them.
- **"Windows comes later"** was cut. `ROADMAP.md` is explicit that macOS-only is
  a decision rather than a gap waiting to close, and that the Windows packaging
  has never been built or launched by anybody.

One claim went the other way — it stayed true of the page for longer than it was
true of the application, which is the worse failure of the two. Through 0.1.x a
teammate's keystroke landed immediately and the owner's only recourse was a mute
after the fact, and the page said so. 0.2.0 reversed it: the keystroke is held
until the owner has read it and allowed it, once, for the session, or always, per
teammate per pane. The teamwork section was corrected when that shipped, but the
hero, the `<meta name="description">` and the section's own opening sentence were
not, and went on promising a reader they could type into a colleague's pane with
no mention of being asked — a page understating its own protection, which is the
one direction a security claim must never be wrong in. All four now say the same
thing, and say the same thing `docs/teamwork.md` does about the limit: the prompt
is a guard against accident and inattention, not against a teammate who means
harm, who can be allowed once and then type anything. If the consent model
changes again, those are the four places, plus the `aria-label` on the parked
`teamwork` clip.

What on the install path has actually been observed, as opposed to read off a
string table, is stated on the page itself in the caption under the System
Settings paragraph. Short version: the `xattr` command was run against this
build and watched to work; the dialog was quoted off the screen; **Done** was
pressed on it and dismissed it. The System Settings → Privacy & Security route
has still never been clicked through — an attempt was made and defeated by other
agents driving the same display — so it stays marked as the unverified one. If
anyone ever walks that pane for real, the caption can shrink to a sentence.

The Gatekeeper section quotes the macOS 26 dialog — **"teamree" Not Opened** /
*Apple could not verify "teamree" is free of malware…*, buttons **Move to Trash**
and **Done** — read live off a real first launch of the published v0.1.0. The
older string, "cannot be opened because the developer cannot be verified", does
not exist on macOS 15 or later and is not used anywhere on the page. The page and
`docs/install.md` were written to agree; if one changes, change both.

The single highest-risk line on the page is the one telling a reader **not** to
press Move to Trash. It is the prominent button in that dialog, it deletes the
app they just downloaded, and a cautious person reaches for it. It appears twice
on purpose: once in the hero, for anyone who double-clicks before reading, and
once in the callout.

`docs/install.md`, which the page links to, was brought into line with the
published release and the real dialog wording in commit `397bf90`.

## Deploying

One command, from the repository root:

```sh
npm run site:deploy
```

That uploads `public/` and promotes it. It is a **Worker with static assets**
named `teamree-site` in the `Dev Abd` account — not a Pages project. Cloudflare
serves the directory directly; there is no build step, so what is in `public/`
is what ships. The configuration is `site/wrangler.jsonc` and it is committed,
so the deploy takes no flags and no arguments.

Three hostnames serve the result, all of them live:

| URL | What it is |
| --- | --- |
| <https://teamree.us> | the site |
| <https://www.teamree.us> | same content, same certificate |
| <https://teamree-site.almahmud-zero.workers.dev> | the origin, useful for checking a deploy landed before DNS caches catch up |

### Rolling back

Deploys are versioned, and the previous version is still there:

```sh
npm run site:versions     # lists version IDs, newest last
npm run site:rollback     # roll back to the previous version
```

`site:rollback` prompts for the version to roll back to and asks for
confirmation. To go to a specific one, pass its ID:

```sh
npx wrangler rollback <version-id> --cwd site
```

A rollback restores the previous *deployment*, assets included, so it is the
right move when a bad page is live and you want it gone now. It does not touch
`public/` on disk — fix the files and run `npm run site:deploy` to move forward
again.

### Checking a deploy actually worked

Wrangler printing "Success" only means the upload succeeded. What matters is
what the edge returns:

```sh
curl -sSI https://teamree.us/ | head -3          # 200, and the etag should change after a deploy
curl -sS -o /dev/null -w '%{http_code}\n' https://teamree.us/no-such-page   # 404, not 200
curl -sSI https://teamree.us/download/mac | grep -E '^(HTTP|location|cache-control)'
```

Two things that are easy to get wrong and worth re-checking after any change to
`_headers` or `_redirects`:

- the download redirects must come back `cache-control: no-store`. They point at
  GitHub's `releases/latest`, and caching that redirect would pin it to whichever
  release was current when it was cached.
- the images must **not** get a long `max-age`. They are not content-hashed, so
  a stale copy cannot be busted except by renaming the file.

If `curl` says `Could not resolve host: www.teamree.us` on a Mac that resolved it
before, that is the macOS resolver holding a negative answer, not an outage —
`dig www.teamree.us` will disagree with it. Flush it with
`sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder`, or test with
`curl --resolve www.teamree.us:443:104.21.71.87 https://www.teamree.us/`.

### Two things still needing a click in the dashboard

Neither can be done from this repo, because both are zone settings rather than
deploy artefacts. Both are at <https://dash.cloudflare.com> → **Dev Abd** →
**teamree.us**.

1. **`http://teamree.us/` serves the page over plaintext with a `200` and no
   redirect.** The HSTS header is sent, but a browser ignores HSTS delivered
   over HTTP, so it protects nobody on a first visit. That matters more here
   than on most sites: the download is unsigned and the page's answer is "verify
   the SHA-256", which an attacker on the network path defeats by rewriting the
   binary and the published hash together. Fix: **SSL/TLS → Edge Certificates →
   Always Use HTTPS → On**.

2. **`www.teamree.us` serves the page rather than redirecting to the apex.**
   Both hostnames return `200` with identical content. `index.html` carries
   `<link rel="canonical" href="https://teamree.us/">` so crawlers consolidate
   correctly and nothing is broken, but one canonical hostname is cleaner. A
   Pages-style `_redirects` file **cannot** do this — domain-level redirects are
   explicitly unsupported there. It needs **Rules → Redirect Rules → Create
   rule**, matching `(http.host eq "www.teamree.us")`, with a dynamic target of
   `concat("https://teamree.us", http.request.uri)` and status `301`.

### Unresolved: byte ranges on the demo clips

A `Range` request against a static asset comes back `200` with the whole file,
not `206`. Measured on both this Worker and on a Pages project built to compare,
using ~100 KB test clips; GitHub's asset host returns `206` and `content-range`
for the same request. It may be that only small assets are served whole. It is
not proof that a multi-megabyte clip will behave the same, so re-check once real
clips land in `public/demos/`:

```sh
curl -sS -r 0-1023 -o /dev/null -D- https://teamree.us/demos/<clip>.mp4
```

Expect `HTTP/2 206` with a `content-range`. Without it Safari will not seek and
may refuse to start playback.
