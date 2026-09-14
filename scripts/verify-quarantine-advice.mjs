// Proves that the one command a first user is told to type actually works.
//
// `docs/install.md` tells somebody who has just downloaded a build to clear the
// quarantine flag, and gives them a command. That command is the entire
// difference between an app that opens and an app that macOS refuses, for every
// person who installs this — and until now it was prose. Nobody had run it
// against a real packaged bundle carrying a real quarantine attribute.
//
// The command is read out of the document rather than repeated here, for the
// same reason the pretest guard stats the path the peer tests stat: a copy is a
// thing that drifts, and a check that drifts from the instruction it is
// checking is worse than none, because it goes green while the instruction
// rots. Edit the doc and this runs the edit.
//
// Only meaningful on macOS, where quarantine and Gatekeeper exist at all.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { findPackagedApp } from './packaged-app.mjs'
import { releaseNotes } from './release.mjs'

// The document to read the advice out of. Overridable by argument for the same
// reason `verify-package.mjs` takes a path: the test that proves this script
// still refuses a document it should refuse has to be able to hand it one, and
// the alternative is a test that edits docs/install.md underneath a developer.
const DOC = process.argv[2] ?? 'docs/install.md'
// What the document tells the reader to install into, and therefore what the
// command it prints is written against. Asserted below rather than assumed: if
// the doc starts recommending somewhere else, the substitution this script does
// not do would silently test the wrong path.
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

/**
 * The shell command `docs/install.md` gives for clearing quarantine.
 *
 * Taken from the fenced block that mentions the attribute, so the thing that
 * runs below is the literal text a reader would copy.
 */
function documentedCommand() {
  const doc = readFileSync(DOC, 'utf8')
  // Any info string, not a list of the three this document happened to use.
  // The list was `sh|bash|console`, and `install.md` has since grown a
  // ```powershell block: an opening fence the pattern could not match, which
  // left its closing fence to be read as the next opening one and paired every
  // fence below it with the wrong partner. The half of the document under that
  // block was therefore being searched inside out, and a second, contradictory
  // quarantine command placed anywhere in it was invisible to the refusal two
  // dozen lines down that exists to catch exactly that.
  const blocks = [...doc.matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)].map((match) => match[1].trim())
  // Any `xattr` here is advice about this warning; there is nothing else in an
  // install document it could be for. Matched on the tool rather than on the
  // attribute name so that `xattr -cr`, which names no attribute and would
  // strip the ad-hoc signature along with the quarantine, is caught as the
  // second spelling it is.
  const matching = blocks.filter((block) => /\bxattr\b/.test(block))

  if (matching.length === 0) {
    fail(
      `${DOC} no longer gives a command for com.apple.quarantine.`,
      'Either the advice moved, or it was dropped and readers now have none.'
    )
  }
  // More than one would mean two spellings of the same advice, and this would
  // be checking whichever came first while a reader followed either.
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
  return command
}

const command = documentedCommand()
ok(`read the advice out of ${DOC}: ${command}`)

// The release notes print the same command, because somebody standing at a
// download page should not have to open a second document to get past a
// warning. Two copies of one instruction is exactly the arrangement where one
// gets fixed and the other does not, so they are required to agree.
function agreesWithReleaseNotes(documented) {
  const notes = 'scripts/release.mjs'
  // The notes themselves rather than the source that writes them. `npm run
  // release` generates them per build and chooses the Gatekeeper paragraph from
  // the signature on the bundle it is about to publish, so the only text worth
  // comparing is the text a reader would actually be shown — and the unsigned
  // build is the one this project has always produced and the only one that
  // carries the command at all.
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
  // Not a `return`. The notes losing the command is not the absence of a
  // disagreement, it is the rot this check exists to catch: a download page
  // that stops telling somebody how to get past Gatekeeper, while the check
  // that is supposed to keep the two copies in step goes green because it can
  // no longer find one of them. `documentedCommand()` fails loudly for the same
  // case in the other file, and the two should read the same way.
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

// Everything above is reading text, and is worth doing wherever this runs: the
// document and the notes can disagree on any machine, and that half of the
// check costs a millisecond and needs nothing built. What follows needs a real
// bundle, a real quarantine attribute and a real Gatekeeper, so it needs a Mac.
if (process.platform !== 'darwin') {
  console.log('verify-quarantine-advice: the documents agree. Running the command needs macOS; stopping here.')
  process.exit(0)
}

// -------------------------------------------------------------- the bundle --

// Newest first, not a fixed order — see scripts/packaged-app.mjs. Picking a
// stale single-architecture build here would install it at /Applications and
// report that the instructions work, having tested them against an app nobody
// is going to download.
const built = findPackagedApp()
if (!built) fail('no packaged macOS app found. Run `npm run package:mac` first.')
ok(`checking against ${built}`)

// ---------------------------------------------------------- the quarantine --

const QUARANTINE = 'com.apple.quarantine'
// LaunchServices' own format — type, timestamp, the agent that fetched it. The
// value matters less than its presence, which is the whole of what Gatekeeper
// keys on.
const FLAGS = '0081;00000000;Safari;'

// The two shapes an app arrives in, which are not marked the same way.
//
// Dragging one out of a mounted `.dmg` marks the bundle it copies. Anything
// that unpacks it file by file — a re-zipped copy handed to a colleague, an
// AirDrop — marks every file inside it. Only the first is what we publish, and
// that is exactly why the second is checked: whoever writes this instruction
// will test it the way they downloaded it, and an instruction that half works
// is worse than one that fails, because it fails silently.
const SHAPES = [
  { name: 'a .dmg dragged to Applications', recursive: false },
  { name: 'an unpacked copy, marked file by file', recursive: true }
]

/**
 * Puts the packaged app where the document says to put it.
 *
 * Installed at that exact path so the command can run verbatim — no path
 * substitution, and therefore nothing to get wrong between the instruction and
 * the test of it.
 */
function install() {
  if (existsSync(INSTALLED_PATH)) {
    const removed = run('rm', ['-rf', INSTALLED_PATH])
    if (removed.status !== 0) fail(`could not clear ${INSTALLED_PATH} before installing.`, removed.stderr)
  }
  const copied = run('cp', ['-R', built, INSTALLED_PATH])
  if (copied.status !== 0) fail(`could not install ${built} to ${INSTALLED_PATH}.`, copied.stderr)
}

/** Files under the bundle still carrying the attribute. */
function stillQuarantined() {
  // `xattr -r -p` prints a line per file that has it and complains on stderr
  // about every file that does not, so its exit status says nothing useful and
  // its stdout says everything. Counted rather than shelled through `find`,
  // whose `-exec ... \;` needs an escape a JavaScript string quietly eats.
  const listed = run('xattr', ['-r', '-p', QUARANTINE, INSTALLED_PATH])
  return (listed.stdout ?? '').split('\n').filter((line) => line.trim().length > 0).length
}

for (const shape of SHAPES) {
  install()

  const applied = run(
    'xattr',
    shape.recursive ? ['-w', '-r', QUARANTINE, FLAGS, INSTALLED_PATH] : ['-w', QUARANTINE, FLAGS, INSTALLED_PATH]
  )
  if (applied.status !== 0) fail(`could not quarantine the installed app as ${shape.name}.`, applied.stderr)
  if (run('xattr', ['-p', QUARANTINE, INSTALLED_PATH]).status !== 0) {
    fail(`the app is not quarantined as ${shape.name}, so this would prove nothing.`)
  }

  const cleared = run('/bin/sh', ['-c', command])
  // Exit status, not just effect. A reader watching this command print an error
  // has no way to know it worked anyway, and will go looking for a second
  // problem that is not there — so a command that complains is a broken
  // instruction even when the attribute is gone afterwards.
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

run('rm', ['-rf', INSTALLED_PATH])
console.log(
  'verify-quarantine-advice: PASS — the install instructions work on a real packaged app, for both artifacts.'
)
