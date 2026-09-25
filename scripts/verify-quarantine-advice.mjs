// Proves the quarantine-clearing command docs/install.md gives actually works on a packaged bundle.
// The command is read out of the document, so editing the doc runs the edit. macOS only.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findPackagedApp } from './packaged-app.mjs'
import { releaseNotes } from './release.mjs'

// Overridable so the test can hand it a document it should refuse.
const DOC = process.argv[2] ?? 'docs/install.md'
// Where the doc says to install; asserted below. The command runs against a scratch copy with
// this path swapped for the copy's, so the owner's installed app is never touched.
const INSTALLED_PATH = '/Applications/teamree.app'

function fail(message, detail) {
  console.error(`verify-quarantine-advice: FAIL ${message}`)
  if (detail) console.error(detail)
  process.exit(1)
}

function ok(message) {
  console.log(`verify-quarantine-advice: ok — ${message}`)
}

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', ...options })
}

// ------------------------------------------------------- the advice itself --

/** The shell command `docs/install.md` gives for clearing quarantine, as a reader would copy it. */
function documentedCommand() {
  const doc = readFileSync(DOC, 'utf8')
  // Any info string: a ```powershell block once desynchronised a fixed list and paired every fence
  // below it with the wrong partner.
  const blocks = [...doc.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)].map((match) => match[1].trim())
  // Matched on the tool, not the attribute, so `xattr -cr` (which also strips the signature) is caught.
  const matching = blocks.filter((block) => /\bxattr\b/.test(block))

  if (matching.length === 0) {
    fail(
      `${DOC} no longer gives a command for com.apple.quarantine.`,
      'Either the advice moved, or it was dropped and readers now have none.'
    )
  }
  // Two spellings of the advice would check one while a reader follows either.
  if (matching.length > 1) {
    fail(`${DOC} gives ${matching.length} different quarantine commands.`, matching.join('\n---\n'))
  }

  const command = matching[0]
  if (!command.includes(INSTALLED_PATH)) {
    fail(
      `the documented command does not name ${INSTALLED_PATH}.`,
      `This script installs there so it can run the command verbatim.\nGot: ${command}`
    )
  }
  refuseAnythingButXattr(command)
  return command
}

/** One `xattr` invocation's alphabet; every shell metacharacter falls outside it. */
const ONE_PLAIN_COMMAND = /^[A-Za-z0-9 ._/-]+$/

/**
 * Refuses to hand `/bin/sh` anything that is not the advice: the doc is reviewed as prose, and
 * `... && curl | sh` would otherwise pass every other test here.
 */
function refuseAnythingButXattr(command) {
  const [first] = command.split(' ')
  if (first !== 'xattr' || !ONE_PLAIN_COMMAND.test(command)) {
    fail(
      'the documented command is not a single plain xattr invocation, and this script runs it through a shell.',
      'Whatever is in that block is executed verbatim on this machine, so it has to be provably one command: ' +
        `"xattr", then flags, an attribute name and ${INSTALLED_PATH}, with no shell operators and no second ` +
        `line.\nGot: ${JSON.stringify(command)}`
    )
  }
}

const command = documentedCommand()
ok(`read the advice out of ${DOC}: ${command}`)

// The release notes print the same command, so the two copies are required to agree.
function agreesWithReleaseNotes(documented) {
  const notes = 'scripts/release.mjs'
  // The generated notes, not their source: the unsigned build is the one that carries the command.
  const body = releaseNotes({
    tag: 'v0.0.0',
    repo: 'owner/name',
    checksums: '',
    kind: 'adhoc'
  })
  const mentions = body
    .split('\n')
    .filter((line) => line.includes('com.apple.quarantine'))
    .map((line) => line.trim())
  // Not a `return`: notes losing the command is the rot this check exists to catch.
  if (mentions.length === 0) {
    fail(
      `${notes} no longer prints a quarantine command.`,
      `${DOC} still gives one, and the release notes are where somebody standing at the download page reads it:\n${documented}`
    )
  }
  const disagreeing = mentions.filter((line) => !line.includes(documented))
  if (disagreeing.length > 0) {
    fail(
      `${notes} prints a different quarantine command from ${DOC}.`,
      `${DOC}: ${documented}\n${notes}: ${disagreeing.join('\n')}`
    )
  }
  ok(`the release notes print the same command as ${DOC}`)
}

agreesWithReleaseNotes(command)

// Everything above is text and runs anywhere; what follows needs a real bundle and Gatekeeper.
if (process.platform !== 'darwin') {
  console.log('verify-quarantine-advice: the documents agree. Running the command needs macOS; stopping here.')
  process.exit(0)
}

// -------------------------------------------------------------- the bundle --

// Newest first (see packaged-app.mjs): a stale single-arch build would test an app nobody downloads.
const built = findPackagedApp()
if (!built) fail('no packaged macOS app found. Run `npm run package:mac` first.')
ok(`checking against ${built}`)

// ---------------------------------------------------------- the quarantine --

const QUARANTINE = 'com.apple.quarantine'
// LaunchServices' own format; Gatekeeper keys on presence.
const FLAGS = '0081;00000000;Safari;'

// Two shapes: dragged from a .dmg marks the bundle; unpacked file by file marks every file.
// Both are checked, since an instruction that half works fails silently.
const SHAPES = [
  { name: 'a .dmg dragged to Applications', recursive: false },
  { name: 'an unpacked copy, marked file by file', recursive: true }
]

const scratch = mkdtempSync(join(tmpdir(), 'teamree-quarantine-'))
const COPY = join(scratch, 'teamree.app')
// The documented command, aimed at the copy: the doc's path was checked above, and nothing here may write it.
const commandOnCopy = command.replace(INSTALLED_PATH, COPY)
if (commandOnCopy.includes('/Applications')) fail('refusing to run the advice against /Applications.', commandOnCopy)

/** A fresh copy of the packaged app in the scratch folder. */
function install() {
  rmSync(COPY, { recursive: true, force: true })
  const copied = run('cp', ['-R', built, COPY])
  if (copied.status !== 0) fail(`could not copy ${built} to ${COPY}.`, copied.stderr)
}

/** Files under the bundle still carrying the attribute. */
function stillQuarantined() {
  // `xattr -r -p` exits uselessly and prints per file, so stdout is counted; `find -exec \;` would need an escape.
  const listed = run('xattr', ['-r', '-p', QUARANTINE, COPY])
  return (listed.stdout ?? '').split('\n').filter((line) => line.trim().length > 0).length
}

for (const shape of SHAPES) {
  install()

  const applied = run(
    'xattr',
    shape.recursive ? ['-w', '-r', QUARANTINE, FLAGS, COPY] : ['-w', QUARANTINE, FLAGS, COPY]
  )
  if (applied.status !== 0) fail(`could not quarantine the installed app as ${shape.name}.`, applied.stderr)
  if (run('xattr', ['-p', QUARANTINE, COPY]).status !== 0) {
    fail(`the app is not quarantined as ${shape.name}, so this would prove nothing.`)
  }

  const cleared = run('/bin/sh', ['-c', commandOnCopy])
  // Exit status too: a command that prints an error is a broken instruction even if it worked.
  if (cleared.status !== 0) {
    fail(
      `the documented command failed against ${shape.name}.`,
      `Somebody following ${DOC} would see this and have nowhere to go.\n\n$ ${command}\n${cleared.stdout}${cleared.stderr}`
    )
  }

  const left = stillQuarantined()
  if (left > 0) {
    fail(
      `${left} file(s) are still quarantined after the documented command, for ${shape.name}.`,
      'The advice clears the bundle directory and leaves what is inside it. A reader would follow it exactly and still be stopped.'
    )
  }

  ok(`${shape.name}: cleared cleanly, nothing left quarantined`)
}

rmSync(scratch, { recursive: true, force: true })
// Narrowly: the command removes a hand-written quarantine from a real bundle both ways. The first-launch
// dialog is a person looking at a screen, recorded in docs/mac-checks.md.
console.log(
  'verify-quarantine-advice: PASS — the documented command clears a real quarantine attribute from a real ' +
    'packaged app, for both artifacts. It does not launch the app or consult Gatekeeper.'
)
