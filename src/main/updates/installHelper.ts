// The shell script that replaces the bundle once the app has exited: a running app cannot
// rename itself away safely, so a detached `sh` does it and then opens the result.

import { spawn } from 'node:child_process'

export type HelperOptions = {
  /** The app's own pid; nothing moves until it has exited. */
  pid: number
  /** The running bundle, e.g. /Applications/teamree.app. */
  target: string
  /** The verified bundle waiting in the profile. */
  staged: string
  log: string
  version: string
  /** A person clicked Restart to Update; otherwise the relaunch stays behind other windows. */
  foreground: boolean
  /** `/usr/bin/open`; tests name a stand-in. */
  opener: string
  /** Passed to the relaunch with `open --env`, so a throwaway profile comes back as itself. */
  env?: Record<string, string>
}

/** How long the helper waits for the app to exit, in tenths of a second. */
const WAIT_TENTHS = 3000

/** `value` as one sh word, whatever it contains. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

// Every way out goes through `finish`, which never ends with nothing whole at TARGET while any
// copy it made (OLD, NEW, the staged one, a copy that would not open) is still whole.
export function helperScript(options: HelperOptions): string {
  const q = shellQuote
  const env = Object.entries(options.env ?? {}).map(([name, value]) => ` --env ${q(`${name}=${value}`)}`)
  return `#!/bin/sh
# Written by teamree to swap in ${options.version} after it quits.
PATH=/usr/bin:/bin:/usr/sbin:/sbin
PID=${Math.trunc(options.pid)}
TARGET=${q(options.target)}
STAGED=${q(options.staged)}
LOG=${q(options.log)}
OPEN=${q(options.opener)}
VERSION=${q(options.version)}
DIR=$(dirname "$TARGET")
NEW="$DIR/.teamree-update-$$.app"
OLD="$DIR/.teamree-previous-$$.app"
FAILED="$DIR/.teamree-failed-$$.app"
BROKEN="$DIR/.teamree-broken-$$.app"

log() { printf '%s %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG"; }
launch() { "$OPEN"${options.foreground ? '' : ' -g'}${env.join('')} "$1"; }
# An Info.plist naming an executable that is there.
whole() {
  exe=$(plutil -extract CFBundleExecutable raw -o - "$1/Contents/Info.plist" 2>/dev/null) &&
    [ -n "$exe" ] && [ -x "$1/Contents/MacOS/$exe" ]
}
settle() {
  whole "$TARGET" && return 0
  for copy in "$OLD" "$NEW" "$STAGED" "$FAILED"; do
    whole "$copy" || continue
    if [ -e "$TARGET" ] && ! mv "$TARGET" "$BROKEN"; then log "could not move the incomplete $TARGET aside"; return 1; fi
    if mv "$copy" "$TARGET"; then log "put $copy at $TARGET"; rm -rf "$BROKEN"; return 0; fi
    log "could not put $copy at $TARGET"
    [ -e "$BROKEN" ] && mv "$BROKEN" "$TARGET"
  done
  log "no whole copy left to put at $TARGET"
  return 1
}
finish() {
  if settle; then
    # The update stays staged for the next restart; copies that are not whole are dropped.
    [ -e "$NEW" ] && { [ -e "$STAGED" ] || ! mv "$NEW" "$STAGED"; } && rm -rf "$NEW"
    whole "$OLD" || rm -rf "$OLD"
    rm -rf "$FAILED"
    launch "$TARGET" || log "could not open $TARGET"
  fi
  whole "$TARGET" && log "kept $TARGET" || log "LOST: $TARGET is not a whole app"
  exit "$1"
}

n=0
while kill -0 "$PID" 2>/dev/null; do
  n=$((n + 1))
  if [ "$n" -gt ${WAIT_TENTHS} ]; then log "gave up: $PID is still running"; exit 1; fi
  sleep 0.1
done

if ! whole "$STAGED"; then log "$STAGED is not a whole app"; finish 1; fi
# Beside the target first, so a copy across volumes happens before anything is moved aside.
if ! mv "$STAGED" "$NEW"; then log "could not move $STAGED beside $TARGET"; finish 1; fi
if [ ! -e "$TARGET" ]; then
  log "$TARGET was missing; installing $VERSION there"
elif ! mv "$TARGET" "$OLD"; then
  log "could not move $TARGET aside"; finish 1
fi
if ! mv "$NEW" "$TARGET"; then log "could not move $VERSION into place"; finish 1; fi
xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null

if launch "$TARGET"; then
  rm -rf "$OLD"
  rmdir "$(dirname "$STAGED")" 2>/dev/null
  log "installed $VERSION"
  exit 0
fi

log "could not open $VERSION; putting the previous copy back"
whole "$OLD" && mv "$TARGET" "$FAILED" && mv "$OLD" "$TARGET"
finish 1
`
}

/** Starts the script detached, so it outlives the app; NODE_USE_SYSTEM_CA is left out of its environment. */
export function launchHelper(script: string): void {
  const env = { ...process.env }
  delete env['NODE_USE_SYSTEM_CA']
  const child = spawn('/bin/sh', [script], { detached: true, stdio: 'ignore', env })
  child.unref()
}
