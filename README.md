# teamree

An ADE built for teamwork.

## Status

Early development. Not yet runnable.

## Scope

A desktop agentic development environment. The first milestone is single-user:

- Parallel git worktrees, one per task
- Split terminals
- A CLI so agents can drive the app
- The GUI tying them together

Team features come after that works.

## Packaged builds

Packaging is electron-builder, configured in `electron-builder.yml`. Every command
rebuilds the app first, so a package is never made from stale output.

| Platform | Command | Artifacts in `dist/` |
| --- | --- | --- |
| macOS | `npm run package:mac` | `teamree-<version>-arm64.dmg`, `-x64.dmg`, and a `.zip` per architecture |
| Windows | `npm run package:win` | `teamree-<version>-setup-x64.exe` (NSIS) |
| Linux | `npm run package:linux` | `teamree-<version>-x64.AppImage`, `teamree_<version>_amd64.deb` |
| The one you are on | `npm run package` | as above, for the host platform |

Two more, for working on packaging itself:

- `npm run package:dir` — unpacked app only, no installers. Much faster.
- `npm run package:verify` — launches the packaged app against a throwaway
  profile, drives it through the CLI the app ships, opens a real PTY in it and
  reads the output back. This is the check that matters: `node-pty` needs its
  native binary and its `spawn-helper` outside the asar with the executable bit
  intact, and only spawning a shell proves that survived packaging.

Each platform's artifact must be built on that platform. `node-pty` publishes
prebuilt binaries for macOS and Windows but none for Linux, where `npm install`
compiles one — so a Linux package built anywhere else would contain no working
terminal at all. `.github/workflows/package.yml` runs the three builds on three
runners for that reason.

The app icon is generated, not drawn by hand: `npm run icons` rewrites
`build/icon.png`, `build/icon.icns`, `build/icon.ico` and `build/icons/`.

### Signing

Local builds are **unsigned**, and the configuration says so deliberately rather
than half-configuring it. macOS builds are ad-hoc signed, which is the minimum
Apple Silicon needs to launch a binary at all; other machines will still see an
unidentified developer, and Windows will still show SmartScreen.

To produce distributable builds, a maintainer supplies their own credentials —
a Developer ID certificate and an App Store Connect key for macOS, a
code-signing certificate for Windows. The exact environment variables and the
one-line flag change are written down in `electron-builder.yml`, next to the
settings they switch on; `build/entitlements.mac.plist` is already filled in for
a hardened-runtime, notarized build.

## The `teamree` CLI from a packaged install

The CLI ships inside the app, at `resources/cli/` next to a launcher per
platform. The launcher runs the bundled CLI under the app's own Electron binary
in plain-Node mode, so an installed app needs no separate Node runtime. It finds
the running app the same way it always does, through the discovery file the
runtime writes, so the CLI and the GUI stay in step.

Put it on `PATH` once, after installing:

**macOS**

```sh
sudo ln -sf "/Applications/teamree.app/Contents/Resources/cli/teamree" /usr/local/bin/teamree
```

**Linux** (the `.deb` installs to `/opt/teamree`)

```sh
sudo ln -sf /opt/teamree/resources/cli/teamree /usr/local/bin/teamree
```

An AppImage has no fixed install path — its contents only exist while it is
mounted — so use the `.deb` if you want the CLI, or extract the AppImage with
`--appimage-extract` and link the `teamree` inside it.

**Windows** (PowerShell, no admin needed; the default install location is
per-user)

```powershell
$cli = "$env:LOCALAPPDATA\Programs\teamree\resources\cli"
[Environment]::SetEnvironmentVariable(
  'Path', "$([Environment]::GetEnvironmentVariable('Path','User'));$cli", 'User')
```

Open a new terminal afterwards. `teamree.cmd` is what `cmd.exe` resolves and
`teamree.ps1` is what PowerShell resolves; both are in that directory.

Then, with the app running:

```
$ teamree status
```

If the app is not running, the CLI says so and exits 3 rather than hanging.
