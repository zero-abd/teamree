# Installing teamree

This is for somebody who has downloaded a build rather than cloned the
repository. If you want to run it from source, the README covers that in two
commands and none of this applies.

**There is one download: `teamree-<version>.dmg`**, plus a `SHA256SUMS.txt`
beside it. It is a universal build, so it runs on Apple Silicon and on Intel
and there is nothing to choose between. If you have wondered which Mac you
have, you do not need to find out.

**Releases are macOS only.** That is a decision rather than a gap: the Windows
and Linux packaging is still configured and the sections below still describe
what it would produce, but nobody builds or publishes either. On Windows or
Linux, run it from source — the README covers that in two commands, and it is
the same application.

## Nothing here is signed

Read this part before you download, because otherwise the first thing that
happens will be a warning, and warnings are much harder to think about once
they are on the screen.

teamree has no Apple Developer certificate behind it and no Windows
code-signing certificate. Those are commercial products — an Apple Developer
membership is an annual fee and an identity check, a Windows certificate is the
same from a different vendor — and this project has neither, deliberately. That
is not going to change, so what follows is the permanent answer rather than a
workaround for something being fixed later. macOS and Windows both notice, and
both say so.

It is worth being exact about what they are saying, because the wording is
alarming and the meaning is narrow. Neither system has examined teamree and
found something wrong with it. Neither is reporting a detection. What each one
is telling you is that **the file arrived without a certificate naming who
built it**, so the operating system cannot attach a name to it and has decided
to make you confirm that you meant to run it. That is a real thing to know. It
is not a verdict about the contents.

What it costs you is the one guarantee a signature actually provides: that the
file has not been altered between the machine that built it and yours. A
checksum gives you the same guarantee by a different route, which is why every
release publishes them. Before you install, compare:

```sh
shasum -a 256 teamree-0.1.0.dmg
```

against the matching line in `SHA256SUMS.txt` on the release. If they agree, the
file you have is the file the build produced. If they do not, stop — and that is
the case the signature would have caught too.

A checksum cannot tell you the build itself is trustworthy. Nothing on the
release page can; that judgement comes from the source, which is here, and from
whoever sent you the link.

## macOS

Open the `.dmg` and drag teamree to Applications, the way any Mac app installs.
Then, the first time you open it, macOS will refuse:

> **"teamree" cannot be opened because the developer cannot be verified.**

The reliable way past it is to clear the quarantine flag. Every file a browser
downloads gets an extended attribute called `com.apple.quarantine`; Gatekeeper
checks for that attribute, and for an app with no recognised signature it stops
there. Removing the attribute tells macOS this file is one you put there on
purpose:

```sh
xattr -dr com.apple.quarantine /Applications/teamree.app
```

Open it normally after that and it will not ask again.

`-r` because an app bundle is a directory tree, and how much of that tree gets
marked depends on how the app reached you. Dragging it out of the `.dmg` marks
the bundle; anything that unpacks it file by file — a re-zipped copy passed to a
colleague, an AirDrop — marks what is inside it too. Clearing only the bundle
would work for the download and leave those stopped, with no hint that the
command had done half its job. This is checked rather than asserted: CI
quarantines a real packaged build both ways and runs the command above, read out
of this file, so the instruction cannot rot into being wrong.

There is a route through the interface as well, but where it is depends on your
macOS version, which is worth knowing before you go hunting for it. Through
macOS 14 you could Control-click the app and choose **Open**, and get a dialog
with an Open button on it. macOS 15 removed that shortcut for apps in this
situation. On 15 and later you attempt to open it, let it fail, then go to
**System Settings → Privacy & Security**, scroll to the security section, and
use the **Open Anyway** button that has appeared there with teamree's name on
it. It will ask for your password.

One detail that explains a confusing failure mode: the macOS builds *are* signed,
but only ad-hoc — a signature with no identity attached. Apple Silicon will not
execute a Mach-O binary carrying no signature at all, so this is the floor
required to launch at all, and it is why teamree starts rather than being killed
on sight once you are past Gatekeeper. It is not a Developer ID and it does not
make the app distributable in Apple's sense. You will still see the warning
above.

## Windows

Nothing publishes this installer today; the section is kept because the
packaging is kept, and describes what it would produce. To run teamree on
Windows now, build from source.

Run `teamree-<version>-setup-x64.exe`. It installs per-user, into
`%LOCALAPPDATA%\Programs\teamree`, and asks no administrator password.

Two things will get in the way, in this order.

The download itself may be marked as blocked. If Windows says so, right-click
the `.exe`, choose **Properties**, and tick **Unblock** at the bottom of the
General tab.

Then SmartScreen will show a blue panel:

> **Windows protected your PC.** Microsoft Defender SmartScreen prevented an
> unrecognised app from starting.

The button that continues is hidden behind **More info** — click that, and
**Run anyway** appears below the file name. There is no way to avoid this panel
for an unsigned installer, and it is worth knowing why not, because it is not
purely about the missing certificate. SmartScreen scores files partly on
reputation: how many people have downloaded this exact file and run it without
trouble. A brand-new installer has no reputation whatever it is signed with, and
an unsigned one never accumulates any, because there is no stable identity to
accumulate it against. So this panel will appear for every release, for
everyone, indefinitely. It is not a sign that something has changed.

Being straight about the state of this platform: teamree's Windows packaging is
configured and has never been built or launched by anybody. The installer above
describes what the configuration produces, not something that has been seen to
work. `ROADMAP.md` keeps the honest account of what has and has not been run.

## Linux

Nothing publishes these packages today either, and the same applies: the
section describes the configured packaging, and building from source is the way
to run teamree on Linux now. Unlike Windows, this packaging has been built and
launched for real in CI.

Nothing warns you about anything here; neither of the mechanisms above exists.

On Debian and Ubuntu, install the `.deb` through `apt` rather than `dpkg`, so
that its dependencies come with it:

```sh
sudo apt install ./teamree_0.1.0_amd64.deb
```

It lands in `/opt/teamree` and adds a desktop entry, so it appears in the
applications menu like anything else. `git` is a hard dependency and will be
pulled in if it is somehow absent — an ADE without git is inert.

The AppImage is the option for everything else. It is a single file that needs
no installation and no root:

```sh
chmod +x teamree-0.1.0-x86_64.AppImage
./teamree-0.1.0-x86_64.AppImage
```

If it exits immediately complaining about `libfuse.so.2`, that is the one
genuinely confusing failure on Linux and it is not about teamree. An AppImage
mounts itself with FUSE 2, which Ubuntu 22.04 and later no longer install by
default. Either install it — `sudo apt install libfuse2` — or skip the mount
entirely:

```sh
./teamree-0.1.0-x86_64.AppImage --appimage-extract-and-run
```

## Putting the `teamree` CLI on PATH

The app ships its own CLI, under `resources/cli/`, and everything the window can
do the CLI can do — which is how a coding agent drives teamree. It runs under
the app's own Electron binary in plain-Node mode, so an installed app needs no
separate Node runtime.

**On macOS it is a button.** The first time you open an installed build whose
`teamree` command is not this app's — absent, or a link to another copy — the app
offers this by itself, once, in a card in the corner that takes no focus and
blocks nothing. Answering it either way is the end of it: teamree does not ask
again, and declining is a real answer rather than a postponement. After that the
sidebar offers **Put teamree on my PATH** while the command is not linked to this
build, and the command palette finds it by name at any time.

It stays quiet where a question would be useless: a link that already points
here, a build with no CLI in it, a source checkout, and a regular file or a
directory sitting at the destination — that last one is a thing to explain rather
than an offer to make, and the sidebar still carries you to the panel that
explains it.

It says what it will do before you press anything: link
`/usr/local/bin/teamree` to the CLI inside this app. That is where a Mac
developer expects a command to be and it is already on the PATH every login
shell is built with, so there is nothing to choose.

macOS asks for your administrator password if `/usr/local/bin` cannot be
written without one, and on a Mac bought in the last few years it cannot.
Homebrew took ownership of `/usr/local` on Intel Macs, which is where the
opposite idea comes from; on Apple Silicon it installs to `/opt/homebrew` and
leaves `/usr/local/bin` as `root:wheel`, so being asked is the ordinary case
rather than the exception. When it asks, the dialog is the system's own: the
password goes to macOS and never to teamree. The panel says which of the two is
about to happen before the button is pressed, and says what actually happened
afterwards, having resolved the link to check.

Three things it will not do, each of them said rather than hidden:

- A **regular file** at `/usr/local/bin/teamree` is left exactly where it is and
  named. It is somebody's program, quite possibly yours.
- A link to a **different copy of teamree** — an older build still in
  `~/Downloads`, say — is named too, because it is the one failure nobody
  diagnoses unaided: `teamree` runs, and it drives the other app, so nothing you
  do in this window ever seems to reach it. Pressing the button points the link
  here instead and leaves that copy alone.
- A link that already points at this app is success, not an error. The button is
  safe to press twice, and says so rather than inventing work.

Running from a source checkout, nothing offers itself: a link into a checkout
breaks the moment that checkout moves, and a question asked on every `npm run
dev` is a question nobody reads. The button and the command below do work
there — but only once the CLI has been built:

```sh
npm run build:cli
```

`resources/cli/teamree` is a launcher, and what it launches is
`out/cli/index.js`, which `npm run dev` does not build. Until that file exists
the panel says so and offers no button: linking the launcher would leave a
`teamree` on your PATH that exits with `Cannot find module`, and it would have
spent an administrator password to do it.

The same two things from a terminal, with the app running:

```sh
teamree cli status
teamree cli install
```

### Doing it yourself

The button is a convenience; what it does is no secret, and on Windows and Linux
it is all there is. Nothing published on those platforms today builds the app, so
this is what to run against a build from source.

**macOS**

```sh
sudo ln -sfn "/Applications/teamree.app/Contents/Resources/cli/teamree" /usr/local/bin/teamree
```

That is the button's own command, minus the `mkdir -p` it runs first for a Mac
that has never had anything installed into `/usr/local/bin`. `-n` so that a
destination which is itself a link to a directory is replaced rather than written
inside.

**Linux**, with the `.deb` installed:

```sh
sudo ln -sf /opt/teamree/resources/cli/teamree /usr/local/bin/teamree
```

There is a name collision here worth knowing about, because otherwise it looks
like the link did nothing. Installing the `.deb` already puts a `teamree` on
your PATH, at `/usr/bin/teamree` — but that one is the desktop application,
registered through `update-alternatives`, and running it starts the window. The
link above points at the CLI instead, and it wins because `/usr/local/bin` comes
before `/usr/bin` on every distribution that follows the filesystem standard. If
`teamree status` opens a window rather than printing status, that ordering is
what to check.

An AppImage has no fixed path — its contents exist only while it is mounted — so
use the `.deb` if you want the CLI, or unpack it with `--appimage-extract` and
link the `teamree` inside.

**Windows**, in PowerShell, no administrator needed:

```powershell
$cli = "$env:LOCALAPPDATA\Programs\teamree\resources\cli"
[Environment]::SetEnvironmentVariable(
  'Path', "$([Environment]::GetEnvironmentVariable('Path','User'));$cli", 'User')
```

Open a new terminal afterwards. `teamree.cmd` is what `cmd.exe` resolves and
`teamree.ps1` is what PowerShell resolves; both are in that directory.

Then, with the app running:

```sh
teamree status
```

If the app is not running the CLI says so and exits 3, rather than hanging.

## The first time you open it

teamree opens empty, because it has nothing to show until you give it a
repository. The window tells you so and offers the one action that matters:
**Add a repository**. Point it at a git checkout you already have.

From there the unit of work is a task, not a directory. Describing one creates a
worktree — its own checkout, off whatever base you choose — and starts a coding
agent inside it if you have one installed. teamree looks for agents on your
`PATH` at startup and offers what it finds; if it finds none it says so plainly
and makes the worktree on its own, which is still useful, and you can open a
terminal in it and type.

All of that is teamree on its own. The other half — the reason it exists — is
teamwork: a teammate's worktrees and panes in your sidebar, theirs to watch live
and to type into, over a relay your team stands up itself.
**[`docs/trying-teamwork.md`](trying-teamwork.md)** is the walkthrough, and it is
honest about the price of entry: two Macs, a relay somebody on the team hosts
(there is no default and nobody hosts one for you), and each person's public key
committed to a repository you can all push to — which is what lets them run
commands on your machine, deliberately.

## Uninstalling

Removing the app never removes your data, which is deliberate — a worktree is
somebody's afternoon. The checkouts teamree made are ordinary git worktrees in
whatever directory you chose and are untouched by any of this.

| Platform | The app | Its settings |
| --- | --- | --- |
| macOS | Drag `teamree.app` to the Trash | `~/Library/Application Support/teamree` |
| Windows | Settings → Apps → teamree → Uninstall | `%APPDATA%\teamree` |
| Linux (`.deb`) | `sudo apt remove teamree` | `~/.config/teamree` |
| Linux (AppImage) | Delete the file | `~/.config/teamree` |

That settings directory holds the list of projects, the worktrees teamree knows
about and your pane layouts. Deleting it makes the next launch look like a first
one; it does not touch a repository.

One thing no column above covers, because it is not the app and it is not the
app's settings: if you ever put the `teamree` command on your PATH — the card on
first run, the sidebar button, or the `ln -s` above typed by hand — that is a
symlink, and deleting the app leaves it behind pointing at nothing. Nothing
removes it for you:

```sh
sudo rm /usr/local/bin/teamree
```

If you never took that offer there is no such file and nothing to do.
`ls -l /usr/local/bin/teamree` says which of the two you are in.
