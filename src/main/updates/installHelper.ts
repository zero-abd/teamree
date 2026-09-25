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
}

/** How long the helper waits for the app to exit, in tenths of a second. */
const WAIT_TENTHS = 3000

/** `value` as one sh word, whatever it contains. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

export function helperScript(options: HelperOptions): string {
  const q = shellQuote
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

log() { printf '%s %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG"; }
launch() { ${options.foreground ? '"$OPEN" "$1"' : '"$OPEN" -g "$1"'}; }

n=0
while kill -0 "$PID" 2>/dev/null; do
  n=$((n + 1))
  if [ "$n" -gt ${WAIT_TENTHS} ]; then log "gave up: $PID is still running"; exit 1; fi
  sleep 0.1
done

# Beside the target first, so a copy across volumes happens before anything is moved aside.
if ! mv "$STAGED" "$NEW"; then
  log "could not move $STAGED beside $TARGET"; rm -rf "$NEW"; launch "$TARGET"; exit 1
fi
if ! mv "$TARGET" "$OLD"; then
  log "could not move $TARGET aside"; rm -rf "$NEW"; launch "$TARGET"; exit 1
fi
if ! mv "$NEW" "$TARGET"; then
  log "could not move $VERSION into place"; mv "$OLD" "$TARGET"; rm -rf "$NEW"; launch "$TARGET"; exit 1
fi
xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null

if launch "$TARGET"; then
  rm -rf "$OLD"
  rmdir "$(dirname "$STAGED")" 2>/dev/null
  log "installed $VERSION"
  exit 0
fi

log "could not open $VERSION; putting the previous copy back"
mv "$TARGET" "$FAILED" && mv "$OLD" "$TARGET" && rm -rf "$FAILED"
launch "$TARGET"
exit 1
`
}

/** Starts the script detached, so it outlives the app; NODE_USE_SYSTEM_CA is left out of its environment. */
export function launchHelper(script: string): void {
  const env = { ...process.env }
  delete env['NODE_USE_SYSTEM_CA']
  const child = spawn('/bin/sh', [script], { detached: true, stdio: 'ignore', env })
  child.unref()
}
