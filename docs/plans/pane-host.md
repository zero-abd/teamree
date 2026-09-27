# Panes that outlive the app

Today every pane is a node-pty child of the app's main process. A crash, `kill -9`, Quit or
Restart to Update ends every agent mid-turn; the relaunch restores the records and starts the
agents again. The first slice (shipped) asks before a Quit or Restart to Update while agents are
working, and offers Restart When Idle. This plan is the second: a pane host that keeps the PTYs
alive across the app's death, behind an experimental setting, off by default.

`scripts/pane-host-spike.mjs` proves the core: a detached host owns a pty, the app that started it
is killed with SIGKILL, and a second app reattaches over the host's socket to the same pid, with
the scrollback replayed and live output following.

## What the reference app does, in behaviour

- Its terminals run in a separate host process, started by the app, not a child it waits on.
- After `kill -9` of the main process the stand-in agent kept running: same pid, its elapsed
  counter went on (17 s, then 35 s).
- On relaunch the pane reattached live: the spinner's counter continued (45 s to 62 s), nothing
  restarted, no task repeated.
- The host, a crash handler, a login zsh and the agent all outlived the main process until killed.

## Process model

- **Host.** One per profile: `process.execPath` with `ELECTRON_RUN_AS_NODE=1` running
  `out/main/paneHost.js`, spawned `detached: true`, `stdio: 'ignore'` (its log goes to
  `<userData>/pane-host.log`), then `unref()`. Detached puts it in its own session, so a signal
  to the app's process group does not reach it. It owns every node-pty and nothing else: no
  store, no git, no window.
- **Main process.** Keeps everything it has now (`SessionManager`, `PtySession`, title and screen
  readings, agent hooks, the scrollback archive). The seam is `IPty`: `PtySession` holds an `IPty`
  and uses only `pid`, `onData`, `onExit`, `write`, `resize`, `kill`, and `process` (the foreground
  name). With the setting on, `startChild` returns a `RemotePty` that implements that subset over
  the host socket instead of calling `node-pty` in process. `close()` already kills by process
  tree from the pid, which works across processes. Off, nothing changes: `startChild`
  calls `spawn` as today and no host is started.
- **Why not a utility process.** Electron's `utilityProcess` dies with the app; a plain detached
  child does not.

## Protocol

Newline-delimited JSON over one unix socket per profile, the same framing as the CLI socket. Every
message carries a `v` (protocol version).

| From | Message | Meaning |
| --- | --- | --- |
| app | `hello {token, v, appVersion}` | First message; anything else, or a wrong token, closes the socket. |
| host | `welcome {v, hostVersion, hostPid, sessions: [{id, pid, cols, rows, exited?}]}` | What is alive. |
| app | `spawn {id, file, args, cwd, env, cols, rows}` | Start a pty under the app's terminal id. |
| app | `attach {id, since?}` | Stream a session; `since` is the byte offset the app already has. |
| host | `replay {id, offset, data}` | The ring buffer from `since` (or its start), before any live data. |
| host | `data {id, offset, data}` | Live output; `offset` lets the app drop a duplicate after a reconnect. |
| host | `exit {id, exitCode, signal}` | Kept until an app acknowledges it with `forget {id}`. |
| app | `write {id, data}` / `resize {id, cols, rows}` / `kill {id, signal?}` | As `IPty`. |
| app | `foreground {id}` → host `foreground {id, name}` | The pty's foreground process, for agent detection. |
| app | `shutdown` | Kill every pty and exit (Quit with the setting off, or `--no-keep`). |

- **Buffer.** Per session a ring of the last 4 MB (`SCROLLBACK_CAP_BYTES`), with a running
  byte offset. Output is buffered whether or not an app is attached.
- **Backpressure.** The host stops reading a pty (`pause()`) while a client's socket buffer is over
  1 MB, so a stuck app cannot grow the host without bound.
- **One app at a time.** A second `hello` takes over; the first socket is closed. Two copies of the
  app on one profile are already prevented by the single-instance lock.

## Lifecycle

- **Launch.** Before `restoreSessions()`: connect to the host socket. If no host answers, start
  one only when the setting is on. From `welcome`, each live session whose id is a stored terminal
  record is reattached (`attach`, with the archive's byte count as `since`), and is not restored.
  Records with no live session restore as today (resume or stopped). A live session with no
  record (the record was lost) is killed.
- **Quit, setting off.** As today: every pty is killed by the app. No host exists.
- **Quit, setting on.** The app detaches (closes the socket) after writing the scrollback archive.
  The quit question does not ask about working agents, since nothing is killed. `teamree quit
  --keep-agents` does the same for one quit with the setting off; `teamree quit` stops them.
- **Crash or `kill -9`.** The socket closes; the host keeps running and buffering. The next launch
  reattaches.
- **Idle host.** With no app attached and no live session for 10 minutes, the host exits and
  removes its socket.
- **A pane closed in the app** sends `kill` then `forget`.
- **Turning the setting off** while panes run in the host: they stay there until they exit; new
  panes start in process. The host exits when its last session does.
- **Turning the setting on** while panes run in process: a pty cannot move between processes, so
  they still end with the app, and Settings › Panes says how many. An idle shell (a shell in the
  foreground, no agent, no command) can be started again in the host; an agent never is.
- **Seeing and stopping it.** Settings › Panes shows `Host running · N panes` with Stop Host;
  `teamree host status` and `teamree host stop` do the same through the app, or straight to the
  host socket once the app has gone (a second app connection would take the host over).

## Update and upgrade

- **Restart to Update.** The host is a separate file in the bundle; the swap replaces the bundle
  under a running host. On macOS the running host keeps its mapped code (the old inode), so it
  goes on serving; the new app connects to the old host.
- **Versions.** `hello` and `welcome` carry `v`. The app speaks every protocol version it has
  shipped a host for; a host newer than the app (a downgrade) is refused and left running, and the
  app runs panes in process. A host older than the app's minimum is drained: new panes go to a
  fresh host on a second socket name (`pane-host-<v>.sock`), the old one exits with its last pane.
- **node-pty ABI.** The host runs on the bundled Electron in node mode, so it uses the same
  node-pty build as the app, and an update ships both together.

## Security of the socket

- The socket lives in `<userData>/pane-host/`, created `0700`; the socket itself is `chmod 0600`.
  Only the same OS user can connect.
- sun_path is 104 bytes on macOS; a long profile path falls back as `resolveEndpoint` does
  (`$TMPDIR`, then `/tmp`), with the same per-profile hash in the name. In `/tmp` the directory
  `0700` is what protects it.
- A 32-byte random token is written to `<userData>/pane-host/token` (`0600`) when the host starts;
  `hello` must carry it. This stops another local program running as the same user from driving
  panes by guessing the path (the CLI socket is a different, documented surface).
- The host takes `file`, `args`, `env` only from `spawn` over this socket; it never reads the
  workspace or runs anything on its own.
- Agents in panes already have `TEAMREE_ENDPOINT` (the CLI socket), never the host socket or token.

## The setting

Settings › Panes: `Keep Agents Running When teamree Quits` (experimental), off by default. Stored in
runtime settings as `keepPanesRunning?: boolean` (additive). Off must mean: no host is started, no
socket is created, `startChild` calls node-pty in process, and Quit kills every pty as today.

## Tests the wired version needs

- `RemotePty` against an in-process host over a socket in a temp dir: spawn, write, resize, exit
  status, `kill`.
- Lifecycle: host starts only with the setting on; app killed (child process `SIGKILL`), host and
  pty survive; relaunch reattaches the same pid with the replay before live data, no duplicate
  bytes across the join.
- No effect when off: `restoreSessions()` with the setting off never connects or spawns a host (a
  spawn spy), and Quit kills in process as the existing session-manager tests assert.
- Wrong token and a second app are refused and taken over, respectively.
- Version mismatch: an older host is drained, a newer one refused.
- Background run: a stand-in agent's turn, `kill -9` the app, relaunch, the same pid streams into
  the same pane.

## What is left

Everything under the setting: `RemotePty`, the host entry and its build target, the reattach path in
`restoreSessions()`, the setting and its row, `--keep-agents`, and the tests above.
