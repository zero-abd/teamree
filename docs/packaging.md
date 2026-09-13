# Packaging

How a build is made, what each platform's packaging actually produces, and what
signing does and does not do. If you only want to install a release, read
[`install.md`](install.md) instead.

Packaging is electron-builder, configured in `electron-builder.yml`. Every
command rebuilds the app first, so a package is never made from stale output.

## The commands

| Platform | Command | Artifacts in `dist/` |
| --- | --- | --- |
| macOS | `npm run package:mac` | `teamree-<version>.dmg`, universal (Apple Silicon and Intel in one file) |
| Windows | `npm run package:win` | none — the build fails; see below |
| Linux | `npm run package:linux` | `teamree-<version>-x86_64.AppImage`, `teamree_<version>_amd64.deb` |
| The one you are on | `npm run package` | as above, for the host platform |

Two more, for working on packaging itself:

- `npm run package:dir` — unpacked app only, no installers. Much faster.
- `npm run package:verify` — launches the packaged app against a throwaway
  profile, drives it through the CLI the app ships, opens a real PTY in it and
  reads the output back. This is the check that matters: `node-pty` needs its
  native binary outside the asar, plus an executable `spawn-helper` on macOS and
  two backends and a ConPTY sidecar on Windows, and only spawning a shell proves
  all of that survived packaging. It takes a path, so it can be pointed at an app
  anywhere. `npm run release` points it at the copy inside the mounted `.dmg` as
  well as at the unpacked one, because the image is what leaves here and
  everything upstream of it has only looked at a directory.

  On a universal build it also checks both architectures' `node-pty` binaries
  statically — present, executable, and a Mach-O for the architecture whose
  directory they are in. It can only *run* one of them, which is whichever the
  machine is. The Intel half of a universal build has never been executed by
  anything; closing that needs an Intel Mac, or an Apple Silicon one with Rosetta
  and the app launched under `arch -x86_64`.

Each platform's artifact must be built on that platform. `node-pty` publishes
prebuilt binaries for macOS and Windows but none for Linux, where `npm install`
compiles one — so a Linux package built anywhere else would contain no working
terminal at all.

The app icon is generated, not drawn by hand: `npm run icons` rewrites
`build/icon.png`, `build/icon.icns`, `build/icon.ico` and `build/icons/`.

## Only macOS is released

The other two targets are kept configured and are described here as what the
configuration produces, not as something that has been seen to work lately.
[`../ROADMAP.md`](../ROADMAP.md) is exact about which of them has ever been
launched.

The Linux packaging was built and launched for real before the build matrix
narrowed to macOS. The Windows packaging never has been, and
`npm run package:win` cannot succeed as configured. It fails in the `afterPack`
hook, and would on any machine: the Windows prebuilds are excluded at the *top
level* of `files` in `electron-builder.yml`, so they are excluded for every
platform including Windows; `scripts/afterpack.mjs` then looks for `pty.node` in
`prebuilds/win32-x64` or in `build/Release`, and on Windows node-pty's own
prebuild script exits successfully because the source prebuilds exist, so
`build/Release` is never created either. The hook throws, which is what it is
for — a Windows package with no PTY in it builds cleanly and then opens no
terminal. Reviving Windows starts with deleting the two exclusion lines that
comment names.

On Linux, run both the smoke test and `package:verify` under a virtual display:
`xvfb-run --auto-servernum npm run package:verify`. Electron also refuses to
start as root unless the sandbox is switched off; the scripts detect that and
pass `--no-sandbox` themselves, so a container needs no special invocation.

## Signing

Builds are **unsigned** unless a certificate is in the environment. macOS builds
are ad-hoc signed, which is the minimum Apple Silicon needs to launch a binary at
all; another machine still sees an unidentified developer, and Windows still
shows SmartScreen. That is the state of every release published so far, and
[`install.md`](install.md) is written for the person who meets the warning.

Switching it on is an environment, not a diff. `npm run package:mac` reads a
documented set of variables and, when a complete set is there, signs with a
Developer ID and notarizes; with none of them it produces exactly the unsigned
build it always did; with half of them it refuses by name rather than quietly
handing back an unsigned artifact.

[`releasing.md`](releasing.md) is the checklist — what to obtain from Apple,
every variable, the command, and how to verify the result. It is also explicit
about which of those steps nobody has been able to verify, because nobody
involved has a Developer ID certificate.

## The `teamree` CLI inside a packaged install

The CLI ships inside the app, at `resources/cli/` next to a launcher per
platform. The launcher runs the bundled CLI under the app's own Electron binary
in plain-Node mode, so an installed app needs no separate Node runtime. It finds
the running app the same way it always does, through the discovery file the
runtime writes, so the CLI and the GUI stay in step.

On macOS, putting it on `PATH` is a button: an installed build offers it once on
first run, and the sidebar and the command palette both carry **Put teamree on my
PATH** until the link is made. Everywhere else it is one command per platform.
Both live in [`install.md`](install.md) with the rest of what an installed copy
needs — including the reason a `.deb` install already has a `teamree` on `PATH`
that is the application rather than the CLI.

The relay's deployable project ships beside it, so standing a relay up needs no
clone of this repository. [`../relay/README.md`](../relay/README.md) covers that.
