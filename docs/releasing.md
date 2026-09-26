# Cutting a release

This is the maintainer's document. If you have downloaded a build and want to
install it, [`install.md`](install.md) is the one to read.

Everything here is what the release command does. What it cannot do is in
[`mac-checks.md`](mac-checks.md): the four things that have to be true before
0.3.0 can be cut at all, the checks to run in the app afterwards, and the gates
whose failing path only exists on a Mac. Read that one first — some of its
prerequisites are refusals that arrive fifteen minutes into a packaging run.

## Why this is a script and not a workflow

Releases are cut from a maintainer's Mac, by one command. The artifact is a
universal macOS `.dmg`, and the check that matters is that the packaged app opens
a real terminal — `node-pty` has to survive packaging, with its native binary
outside the asar and an executable `spawn-helper` beside it. Proving that means
launching the app on the platform it was built for.

`scripts/release.mjs` runs typecheck, lint, format, the relay build, the full
suite, the build, the smoke test, the package, and then the packaged app twice —
unpacked, and the copy inside the mounted `.dmg` — refusing at the first failure.

CI ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)) runs the Linux
half of that on every pull request and every push to `main`: typecheck, lint,
format and the suite, on a free public-repo runner. The macOS gate, the smoke
test and packaging stay local and release-only, because macOS runners cost ten
times as much and a full run packages a 190 MB app. `npm run release:dry-run`
runs everything and creates nothing; run it when a change touches packaging.

## The command

```sh
npm run release:dry-run      # everything except the tag and the release
npm run release              # the same, and then publishes
```

Both default to the tag that matches `package.json` — `v0.3.1` today. To cut a
candidate, or any other tag, name it:

```sh
npm run release -- v0.2.0-rc.1
```

A tag containing `-` is published as a pre-release, so a team trying a candidate
is not told it is the release.

### What it refuses, before it spends a minute on anything

All of these are decided in about a second, before the first gate runs, and all
of them are reported at once rather than one per attempt:

- **the working tree is not clean** — a release built from uncommitted changes
  cannot be rebuilt by anybody, including you.
- **the tag does not name the version in `package.json`** — `v0.2.0` against a
  package that says `0.1.0` is refused. `v0.2.0-rc.1` against `0.2.0` is fine: a
  candidate is a candidate *for* that version.
- **the tag is not a release tag** — `0.1.0`, `latest`, `release-1` are all
  refused.
- **nothing describes the version** — `docs/release-notes/<version>.md` has to
  exist and say what changed. A release nobody wrote notes for looks exactly
  like one somebody did: the body still explains Gatekeeper and still carries
  the checksums, and there is no gap on the page for anybody to notice.
- **`relay/node_modules` is missing** — the relay would not build, and the peer
  tests would skip. Run `cd relay && npm ci`.
- **`gh` is not authenticated** — checked up front, and on a dry run too. It is
  the step most likely to fail, and a rehearsal that skipped it would not be
  rehearsing it.
- **no GitHub repository can be worked out** — a separate refusal from the one
  above, because a signed-in maintainer whose remote is not GitHub was being sent
  to `gh auth login`, which would not have helped. `GH_REPO=owner/name` names it.
- **a release with that tag already exists** — publishing over it would replace
  files somebody may already have downloaded.
- **the tag exists here or on `origin` pointing at some other commit.**
- **`HEAD` is not the tip of any branch on `origin`** — push first. A release
  tag on a commit nobody else has is a download whose source cannot be read.

### What it then runs

In this order, stopping at the first failure:

`typecheck` · `format:check` · `oxlint` · `build:cli` · the relay build · the
full suite · `build` · `smoke` · `package:mac` · `package:verify` ·
`package:verify` again against the copy inside the mounted `.dmg` ·
`verify-signing` · the `.zip` unpacked with `ditto -x -k`, which must hold one
`teamree.app` at the package version whose `codesign --verify --deep --strict`
passes

`build:cli` and the relay build are there because the suite needs both and says
so by failing: the acceptance pass drives `out/cli/index.js` as a real
executable, and `pretest` refuses to start at all when `relay/dist` is stale. A
developer's checkout usually has both lying around from an earlier build, which
is why their absence only shows up somewhere clean.

The last two are the ones worth understanding. `package:verify` launches the
packaged app, drives it through the CLI it ships and spawns a real PTY inside
it — the only check that can tell a package that built from a package that
works. Everything before it has looked at `dist/mac-universal/teamree.app`, a
directory; what a person downloads is the `.dmg`, built afterwards out of that
tree through `hdiutil`, an HFS+ image and a compressor. So the image is mounted
and the copy inside it is put through the same check.

`verify-signing` is the report on what a Mac that *downloaded* the file would
say, which is the one thing the building machine cannot find out by opening it:
a local build carries no `com.apple.quarantine` attribute, so Gatekeeper never
looks at it here.

### The notes

A release body is two things joined. Most of it is generated from what was
actually built — the Gatekeeper paragraph is chosen by reading the signature off
the bundle about to be published, and the checksums are of the file that will be
uploaded — so a release cannot claim to be signed because the last one was, or
apologise for being unsigned after somebody has signed it.

The part no machine can write is what changed, and that is a file:
`docs/release-notes/<version>.md`, keyed by the version in `package.json`. One
file per version rather than one growing changelog, because what the release
body carries is the file *at that tag*, and a link into a changelog would send
somebody who downloaded 0.2.0 to the section about whatever shipped later. A
candidate uses the notes of the version it is a candidate for: `v0.2.0-rc.1`
reads `0.2.0.md`.

Write it for somebody who is going to download the build and use it — what is
different for them, in sentences. It goes above the signing section, and that
order is not cosmetic: the update card in the window renders the body as text
and cuts it at four thousand characters, so the top of this file is what a
person still running the old build actually reads, and the Gatekeeper paragraph
is in every release and in [`install.md`](install.md) besides.

Keep it small: at most about eight bullets, one line each, no sections, the
headline change first. The card shows three lines and links the release for
the rest, so anything longer is read by nobody.

Two things ask for it, deliberately at different distances. `npm test` fails
when the version in `package.json` has no notes, which is what keeps the bump
and the notes in the same change; `npm run release` refuses for the same reason,
which is what catches a version bumped somewhere the suite was not run.

### Then it says what it is about to do

The plan — repository, tag, commit, file, size, SHA-256, and what the signature
on it is — is printed in full, along with the exact notes the release would
carry. A dry run stops there. A real run asks you to type the tag before it
creates anything (`--yes` skips the prompt, for a script).

Publishing is three steps, in this order, and each is announced:

```
git tag -a v0.1.0 -m "teamree v0.1.0"
git push origin v0.1.0
gh release create v0.1.0 teamree-0.1.0.dmg teamree-mac-universal.dmg \
  teamree-0.1.0.zip teamree-mac.json SHA256SUMS.txt ...
```

A dry run prints that line with the real file names.

If `gh release create` fails after the tag is pushed, re-running the command
uses the existing tag rather than making another.

### How the app updates itself from it

`package:mac` builds a universal `.zip` of the app beside the `.dmg`, and the
release carries both plus `teamree-mac.json`:

```json
{ "version": "0.1.0", "file": "teamree-0.1.0.zip", "size": 201761957, "sha256": "…" }
```

A running teamree checks `releases/latest` on launch, every hour, on waking
from sleep, and when the window regains focus after 30 or more minutes away —
no two automatic checks inside 10 minutes, so GitHub's unauthenticated rate
limit (60 requests/hour per IP) is never in reach. When it is older, it
fetches the manifest, then the zip, and refuses unless the size
and SHA-256 match the manifest (and GitHub's own digest, when it gives one). It
unpacks into `~/Library/Application Support/teamree/updates` and refuses unless
the app there has teamree's identifier, the manifest's version and a signature
that verifies — from the same Team ID when the running copy has a Developer ID.
Restart to Update quits through the normal quit, and a script left in that
folder waits for the process to exit, moves the old bundle aside, moves the new
one into its place, clears quarantine, opens it, and only then deletes the old
one; if the new one will not open, the old one goes back and is opened.
Every way out of the script ends by checking that a whole app (an Info.plist
naming an executable that is there) sits at the old path, putting back the
old copy, the new one or the staged one when it does not; a copy found missing
is replaced by the new one. `update.log` in the same folder records each step.

Before quitting, Restart to Update makes and renames a folder beside the app
and writes a file inside it, undoing both; if macOS refuses (App Management
answers `EPERM`), nothing quits and the card offers Open Settings. An ad-hoc
copy launched through LaunchServices replaced itself on macOS 26 with no prompt: App
Management never evaluated it (no `kTCCServiceSystemPolicyAppBundles` request).

It never installs an older version or, on a stable build, a pre-release. A
candidate (`v0.2.0-rc.1`) is not installed in place either: its manifest names
the tag's version and the app inside says `0.2.0`. A copy running from the
disk image, translocated, or from a folder it cannot write gets the `.dmg`.

### One check that is deliberately not a gate

```sh
npm run install:verify
```

This installs the packaged bundle at `/Applications/teamree.app`, quarantines it
both ways a download arrives, and runs the `xattr` command read out of
`install.md` itself — so the one instruction every first-time user is given
cannot rot into being wrong. It is not in the release sequence because it writes
into `/Applications` and would replace whatever copy of teamree is already
installed there. Run it by hand when `install.md` changes, or before a release
that anybody new will follow.

### What a dry run leaves behind

`dist/SHA256SUMS.txt`, `dist/teamree-mac.json` and `dist/RELEASE_NOTES.md`,
all inside gitignored `dist/`, plus whatever the packaging step built. Nothing
else, anywhere.

---

## Signing and notarization

Everything above works today and produces an **unsigned** build. This section is
what turns it into one somebody can download without being stopped. It is a
filled-in blank rather than a plan — but read
[what is unverified](#what-here-has-not-been-verified) at the end before
trusting any of it, because nobody has run it with a certificate.

### 1. What to get from Apple

1. **An Apple Developer Program membership.** Paid, annual, with an identity
   check. An individual membership is enough; there is no free tier that issues
   the certificate below.
2. **A Developer ID Application certificate.** Created from the Apple Developer
   site (Certificates, Identifiers & Profiles) or from Xcode's Accounts pane.
   This is the *Developer ID Application* type specifically — an *Apple
   Development* or *Apple Distribution* certificate signs, but produces a build
   Gatekeeper still refuses, which is the failure that looks like success.
   Its full name is what you will set as `APPLE_SIGNING_IDENTITY`:

   ```sh
   security find-identity -v -p codesigning
   # 1) ABCD…  "Developer ID Application: Your Name (AB12CD34EF)"
   ```

3. **Credentials for the notary service**, one of two forms:
   - *Recommended:* an **App Store Connect API key** — App Store Connect →
     Users and Access → Integrations → Keys. Download the `.p8` once (it cannot
     be downloaded twice), and note the Key ID and the Issuer ID.
   - *Or:* your **Apple ID**, an **app-specific password** generated at
     [appleid.apple.com](https://appleid.apple.com), and your **Team ID**.

### 2. What to set in the environment

Nothing in the repository changes. `npm run package:mac` reads these:

| Variable | Required | What it is |
| --- | --- | --- |
| `APPLE_SIGNING_IDENTITY` | always, to sign | The identity, in either spelling — `Developer ID Application: Your Name (AB12CD34EF)` as `security find-identity` prints it, or `Your Name (AB12CD34EF)` |
| `CSC_LINK` | unless the certificate is in your login keychain | The `.p12`, as a file path or base64 |
| `CSC_KEY_PASSWORD` | with `CSC_LINK` | The password the `.p12` was exported with |
| `APPLE_API_KEY` | API-key form | Path to the `.p8` |
| `APPLE_API_KEY_ID` | API-key form | The Key ID |
| `APPLE_API_ISSUER` | API-key form | The Issuer ID |
| `APPLE_ID` | Apple-ID form | The Apple ID email |
| `APPLE_APP_SPECIFIC_PASSWORD` | Apple-ID form | The app-specific password |
| `APPLE_TEAM_ID` | Apple-ID form | The ten-character Team ID |
| `TEAMREE_SKIP_NOTARIZE` | never, to publish | `1` signs without notarizing. For testing the signing half alone: the result is still refused on any Mac that downloaded it |

On a Mac whose login keychain already holds the certificate, the shortest
complete set is four variables:

```sh
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (AB12CD34EF)"
export APPLE_API_KEY="$HOME/private_keys/AuthKey_ABC123.p8"
export APPLE_API_KEY_ID="ABC123"
export APPLE_API_ISSUER="11111111-2222-3333-4444-555555555555"
```

Two things about `APPLE_SIGNING_IDENTITY` that cost a build each to find out,
and are handled for you:

- electron-builder refuses the prefixed spelling — *"Please remove prefix
  "Developer ID Application:" from the specified name"* — several minutes in,
  after the app has been assembled. Since the prefixed spelling is exactly what
  `security find-identity` prints, both are accepted here and the prefix is
  removed before electron-builder sees it.
- electron-builder does **not** fail when the identity it was given is not in
  the keychain. It logs *"skipped macOS application code signing"*, ad-hoc signs
  the app, and exits 0. A typo in the identity would otherwise produce an
  unsigned build from a run that said it was signing. So `npm run package:mac`
  reads the signature back off the bundle afterwards and fails if it is not a
  Developer ID.

**Half a set is refused, not ignored.** `scripts/mac-signing.mjs` treats any one
of these being set as an intention to sign, and names what is missing before the
build starts. The alternative — falling back to unsigned — is the one behaviour
that could publish an unsigned build under the belief that it was signed.

None of these belong in a file in this repository. They are environment
variables for exactly that reason.

### 3. The command that produces a signed, notarized `.dmg`

The same one as before:

```sh
npm run package:mac
```

`npm run package:mac` is the signing path, and the only one: `npm run package`
(whatever the host platform is) still calls electron-builder directly and will
produce an unsigned build even with every variable set. The release script uses
`package:mac`.

It prints which identity it is signing as and whether it is notarizing, before
electron-builder starts. Under the hood it adds three overrides to the
`electron-builder.yml` defaults:

```
-c.mac.identity="Your Name (AB12CD34EF)"   # the prefix removed, see above
-c.mac.hardenedRuntime=true
-c.mac.notarize=true
```

The hardened runtime and notarization move together because Apple's notary
service rejects a submission without the hardened runtime.
`build/entitlements.mac.plist` is already written for it.

Notarization adds several minutes to the build: electron-builder uploads the
signed artifact, waits for Apple's verdict, and staples the ticket to it.

To cut a signed release, set the variables and run the release command as
normal — it will then *require* a Developer ID signature rather than merely
reporting one, and the release notes it writes will say the build is signed
instead of explaining Gatekeeper:

```sh
npm run release
```

### 4. How to check the result

```sh
npm run sign:verify
```

That runs five commands against the packaged app and the `.dmg` and prints each
one's output. What it is asking, and what a correct answer looks like:

| Command | On a signed, notarized build | On this project's unsigned build (verified) |
| --- | --- | --- |
| `codesign -dv --verbose=4 <app>` | an `Authority=Developer ID Application: …` line | `Signature=adhoc` |
| `codesign --verify --deep --strict <app>` | exit 0 | **exit 0** — see below |
| `spctl --assess -t exec -vv <app>` | exit 0, `accepted` | exit 3, `rejected` |
| `spctl --assess -t open --context context:primary-signature -v <dmg>` | exit 0, `accepted` | exit 3, `rejected`, `source=no usable signature` |
| `xcrun stapler validate <app>` and `<dmg>` | exit 0 | exit 65, `does not have a ticket stapled to it` |

The second row is the trap and the reason this script exists. `codesign
--verify --deep --strict` **exits 0 on this project's unsigned build** — an
ad-hoc signature is structurally valid, it is simply nobody's. A checklist that
stopped at `codesign --verify` would pass a build no one can open. What
separates them is the identity line from `codesign -dv`, and the three
Gatekeeper answers below it.

By hand, the same thing:

```sh
codesign --verify --deep --strict --verbose=2 dist/mac-universal/teamree.app
spctl --assess -t exec -vv dist/mac-universal/teamree.app
spctl --assess -t open --context context:primary-signature -v dist/teamree-0.1.0.dmg
xcrun stapler validate dist/teamree-0.1.0.dmg
```

The most convincing check is not on this list, because it cannot be run here at
all: download the `.dmg` from the release, on a different Mac, through a
browser, and open it. That is the only way the quarantine attribute is set, and
therefore the only way Gatekeeper is really asked.

### What here has *not* been verified

Stated plainly, because this project has twice shipped documentation asserting
things nobody had checked.

**Verified**, by running it on this machine against a real `npm run package:mac`
build:

- the unsigned column of the table above — all five exit codes and their output.
- that `scripts/package-mac.mjs` with no credentials in the environment runs
  exactly the `electron-builder --mac --publish never` that `package:mac` ran
  before, producing the same unsigned build.
- that a complete set of variables produces those three `-c.mac.*` overrides,
  that half a set is refused by name, and that no partial set silently falls
  back to unsigned — covered by `tests/release/mac-signing.test.ts`.
- that electron-builder receives the `APPLE_SIGNING_IDENTITY` override and acts
  on it rather than on the `identity: '-'` in `electron-builder.yml`. Checked by
  pointing it at an identity that does not exist: it reports
  `Identity name is specified, but no valid identity with this name in the
  keychain identity=No Such Person (ZZ99YY88XX)`.
- that electron-builder rejects the prefixed identity spelling, and that it
  ad-hoc signs and exits 0 when it cannot find the identity. Both were seen from
  this repository against electron-builder 26.15.3, and both are the reason
  `scripts/package-mac.mjs` normalises the identity and reads the signature back
  afterwards — which was itself checked, by watching that build exit 1.

**Not verified — nobody involved has a Developer ID certificate:**

- that electron-builder imports a real `CSC_LINK`/`CSC_KEY_PASSWORD` pair and
  signs with it.
- that `-c.mac.hardenedRuntime=true` produces a bundle Apple's notary service
  accepts, and that `build/entitlements.mac.plist` is sufficient for it. The
  entitlements file was written for a hardened-runtime build and has never been
  submitted.
- that notarization succeeds, that the ticket is stapled, and that
  `xcrun stapler validate` then exits 0.
- every "on a signed, notarized build" cell in the table above. Those are what
  the commands are documented to return, not observations.
- that a downloaded, quarantined copy of a signed build opens without a warning.
- that a signed build's in-place update keeps the Team ID check honest against a
  real Developer ID bundle, and that the swapped app opens without a Gatekeeper
  prompt.

**Not verified until a release carries the zip and manifest** — the flow is
tested end to end against a small ad-hoc-signed app, a local server and a
temporary Applications folder, but not against:

- electron-builder's own `.zip` of the 190 MB universal app surviving
  `ditto -x -k` with a verifying signature on another Mac (the release script
  checks it on the building Mac).
- GitHub's asset URLs and redirects to its storage for the zip and the
  manifest, and the `digest` it reports for them.
- the real swap of `/Applications/teamree.app` and the relaunch through
  `/usr/bin/open`, with sessions restored, from one published version to the
  next.

The first signed build is therefore also the first test of all of that. Cut it
as a pre-release (`npm run release -- v0.2.0-rc.1`), download it on another Mac
through a browser, and open it before cutting the real one.
