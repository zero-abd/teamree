// Cuts a release from this machine, because nothing else can cut one.
//
// `.github/workflows/release.yml` was written to do this and has never run. It
// cannot: every Actions run in this repository ends in six or seven seconds
// with no steps and the annotation "The job was not started because recent
// account payments have failed or your spending limit needs to be increased."
// No runner is provisioned, so no step of that workflow has ever executed. A
// tag pushed today produces nothing and reports a failure next to the release.
//
// What that workflow was for is still needed, though, and it is not the
// building — it is the refusing. A release is the one artifact nobody re-runs
// the tests on, so the checks have to be attached to the act of publishing
// rather than remembered next to it. So this runs every gate the workflow ran,
// in one sequence, and stops at the first that says no:
//
//   typecheck, format, lint, the relay build, the full suite, the app build,
//   the smoke test, the macOS package, the packaged-app check against the
//   unpacked tree, the same check against the copy inside the mounted .dmg,
//   and a report on what a Mac that downloaded the .dmg would say about it.
//
// The last two are the ones worth keeping when something has to give. The
// packaged-app check is the only one that can tell a package that built from a
// package that works, and the copy inside the image is the file that actually
// leaves here — everything upstream of it has only ever looked at a directory.
//
// `--dry-run` does all of that and stops before the tag and the release, so the
// rehearsal is the performance minus its last two steps rather than a different
// sequence that shares a name with it.
import { createHash } from 'node:crypto'
import {
  createReadStream,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline/promises'
import { resolveMacSigning } from './mac-signing.mjs'
import { findPackagedApp } from './packaged-app.mjs'
import { isDistributable, readSignatureKind } from './verify-signing.mjs'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Every gate, in the order a failure is cheapest to read.
 *
 * Typecheck, format and lint are seconds and catch the things most likely to be
 * wrong in a tree somebody just finished editing; the packaging steps are
 * minutes each and go last. The order is the only thing here that is a
 * preference — the set is not, and there is deliberately no flag to shorten it.
 */
export const GATES = [
  { name: 'typecheck', args: ['run', 'typecheck'] },
  { name: 'format:check', args: ['run', 'format:check'] },
  { name: 'oxlint', args: ['run', 'lint'] },
  // The acceptance pass drives the CLI as a real executable and throws
  // "run `npm run build:cli` before the acceptance suite" when `out/cli/index.js`
  // is absent. A developer's checkout usually has one lying around from an
  // earlier build, which is why this is invisible until the sequence runs
  // somewhere clean — as it did the first time this script was rehearsed in a
  // fresh clone, where it stopped the run at `test`.
  { name: 'build:cli', args: ['run', 'build:cli'] },
  // Before the suite, not beside it: `relay/dist` is gitignored per-machine
  // state, the peer tests stat it before deciding whether to run, and `pretest`
  // refuses to start a suite whose relay is stale. Building it here is what CI
  // did in its own step for the same reason.
  { name: 'relay build', args: ['run', 'build'], cwd: 'relay' },
  { name: 'test', args: ['test'] },
  { name: 'build', args: ['run', 'build'] },
  { name: 'smoke', args: ['run', 'smoke'] },
  { name: 'package:mac', args: ['run', 'package:mac'] },
  { name: 'package:verify', args: ['run', 'package:verify'] }
]

/** The tag a given package version must be released under. */
export function expectedTag(version) {
  return `v${version}`
}

/** Why a tag cannot be used for this package version, or null when it can. */
export function tagAgreement(tag, version) {
  if (!/^v\d+\.\d+\.\d+(?:[-+].+)?$/.test(tag)) {
    return `"${tag}" is not a release tag. They are \`v\` followed by the version, e.g. ${expectedTag(version)}.`
  }
  const expected = expectedTag(version)
  if (tag === expected) return null
  // A pre-release of a version is still that version: `v0.2.0-rc.1` releases
  // package version 0.2.0, and refusing it would mean bumping package.json to
  // something that is not a version to cut a candidate.
  if (tag.startsWith(`${expected}-`)) return null
  return (
    `the tag says ${tag} and package.json says ${version}.\n` +
    `  A release named after a version it does not contain is the one mistake nobody catches\n` +
    `  afterwards. Either tag ${expected}, or change the version in package.json first.`
  )
}

/** Whether GitHub should mark this release as a pre-release. */
export function isPrerelease(tag) {
  return tag.includes('-')
}

/**
 * Everything wrong with the repository, before a minute of machine time is
 * spent on it.
 *
 * All of it is knowable in a second, and all of it would otherwise be found
 * after the build — which is where `release.yml` put its one guard, and why it
 * grew a `guard` job in front of the build.
 */
export function preflightRefusals(state) {
  const refusals = []

  const disagreement = tagAgreement(state.tag, state.version)
  if (disagreement) refusals.push(disagreement)

  if (state.dirty.trim() !== '') {
    refusals.push(
      'the working tree is not clean, so what would be published is not what is committed:\n' +
        state.dirty
          .trim()
          .split('\n')
          .map((line) => `    ${line}`)
          .join('\n') +
        '\n  Commit or stash it. A release built from uncommitted changes cannot be rebuilt by anybody.'
    )
  }

  if (!state.relayInstalled) {
    refusals.push(
      'relay/node_modules is missing, so the relay cannot be built and the peer tests would\n' +
        '  skip. Run `cd relay && npm ci`.'
    )
  }

  if (!state.ghAuthenticated) {
    refusals.push(
      'the GitHub CLI is not authenticated, so the release could not be created. Run `gh auth login`.\n' +
        '  Checked now rather than after the build, including on a dry run — a rehearsal that\n' +
        '  skipped it would not be rehearsing the step most likely to fail.'
    )
  }

  // Separate from authentication, because they fail for different reasons and
  // one message for both sent a signed-in maintainer to `gh auth login` over a
  // remote that simply was not GitHub.
  if (!state.repo) {
    refusals.push(
      'could not work out which GitHub repository to publish to. `gh repo view` found none —\n' +
        '  no remote here points at a GitHub host. Name it with GH_REPO=owner/name.'
    )
  }

  if (state.releaseExists) {
    refusals.push(
      `a release named ${state.tag} already exists. Delete it, or pick another tag.\n` +
        '  Publishing over it would replace files somebody may already have downloaded.'
    )
  }

  if (state.localTag && state.localTag !== state.head) {
    refusals.push(
      `the tag ${state.tag} already exists here and points at ${short(state.localTag)}, not at HEAD ` +
        `(${short(state.head)}).`
    )
  }

  if (state.remoteTag && state.remoteTag !== state.head) {
    refusals.push(
      `the tag ${state.tag} exists on origin at ${short(state.remoteTag)}, not at HEAD (${short(state.head)}).\n` +
        '  Somebody else cut it, or it was moved. Nothing here will overwrite a published tag.'
    )
  }

  if (!state.remoteHeads.includes(state.head)) {
    refusals.push(
      `HEAD (${short(state.head)}) is not the tip of any branch on origin.\n` +
        '  Push it first. A release tag on a commit nobody else has is a download whose source\n' +
        '  cannot be read, and the commit disappears if this checkout does.'
    )
  }

  return refusals
}

function short(sha) {
  return sha.slice(0, 7)
}

/** `shasum -a 256` output, byte for byte, so a reader can compare it as printed. */
export function checksumLine(hash, name) {
  return `${hash}  ${name}`
}

/**
 * The notes the release carries.
 *
 * They are generated from what was actually built rather than written once and
 * copied forward: the signing paragraph is chosen by looking at the signature on
 * the bundle that is about to be published, so a release cannot claim to be
 * signed because the last one was, or apologise for being unsigned after
 * somebody has gone to the trouble of signing it.
 */
export function releaseNotes({ tag, repo, checksums, kind }) {
  const signed = isDistributable(kind)
  const lines = [`teamree \`${tag}\`, for macOS. One universal \`.dmg\`: Apple Silicon and Intel both.`, '']

  if (signed) {
    lines.push(
      '## Signed and notarized',
      '',
      'This build is signed with a Developer ID certificate and carries a notarization ticket',
      'from Apple, so macOS opens it without a warning. Drag it to Applications and open it.',
      ''
    )
  } else {
    lines.push(
      '## Nothing here is signed',
      '',
      'There is no Apple Developer certificate behind this build. macOS will say so, in wording',
      'that sounds worse than what it means: the complaint is that nobody has paid a vendor to',
      'vouch for the file, not that anything was found wrong with it. It has not inspected the',
      'app, and it is not telling you the app is harmful.',
      '',
      'What a signature would have told you, a checksum tells you too. Compare the file you',
      'downloaded against `SHA256SUMS.txt` below and you know it is the one this build produced.',
      'It cannot tell you the build is trustworthy — only that what reached you is what left here.',
      '',
      'macOS will say teamree "cannot be opened because the developer cannot be verified". Move',
      'the app to `/Applications`, then run once:',
      '',
      '```sh',
      'xattr -dr com.apple.quarantine /Applications/teamree.app',
      '```',
      ''
    )
  }

  lines.push(
    'The full story — what each warning means, how to put the `teamree` CLI on PATH, and how to',
    `uninstall — is in [docs/install.md](https://github.com/${repo}/blob/${tag}/docs/install.md).`,
    '',
    '## Checksums',
    '',
    '```',
    checksums.trim(),
    '```',
    ''
  )

  return lines.join('\n')
}

/** What is about to happen, said in full before anything irreversible starts. */
export function planLines({ tag, repo, head, branch, dmg, size, hash, kind, dryRun }) {
  return [
    '',
    '================================================================',
    dryRun ? '  DRY RUN — nothing below will be created' : '  About to publish',
    '================================================================',
    `  repository   ${repo}`,
    `  tag          ${tag}${isPrerelease(tag) ? '  (marked as a pre-release)' : ''}`,
    `  commit       ${head}  on ${branch}`,
    `  file         ${dmg}  (${(size / 1024 / 1024).toFixed(1)} MiB)`,
    `  sha256       ${hash}`,
    `  signature    ${kind}${isDistributable(kind) ? '' : ' — a Mac that downloads this will refuse it until'}`,
    ...(isDistributable(kind) ? [] : ['               the quarantine attribute is cleared by hand.']),
    '  also         SHA256SUMS.txt',
    '================================================================',
    ''
  ]
}

/** The argument shapes this accepts, and the one it refuses. */
export function parseReleaseArgs(argv) {
  const parsed = { tag: null, dryRun: false, yes: false, error: null }
  for (const argument of argv) {
    if (argument === '--dry-run') parsed.dryRun = true
    else if (argument === '--yes') parsed.yes = true
    else if (argument.startsWith('-')) parsed.error = `unknown option ${argument}`
    else if (parsed.tag === null) parsed.tag = argument
    else parsed.error = `two tags given: ${parsed.tag} and ${argument}`
  }
  return parsed
}

// ---------------------------------------------------------------- the run --

function git(args) {
  const result = spawnSync('git', args, { encoding: 'utf8', cwd: REPO_ROOT })
  return { status: result.status, out: (result.stdout ?? '').trim(), err: (result.stderr ?? '').trim() }
}

function sha256(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
  })
}

function heading(text) {
  console.log('')
  console.log(`release: ${text}`)
}

function fail(message) {
  console.error(`release: ${message}`)
  process.exitCode = 1
}

function runGate(gate) {
  const started = Date.now()
  heading(`--- ${gate.name} ---`)
  const result = spawnSync('npm', gate.args, {
    stdio: 'inherit',
    cwd: gate.cwd ? join(REPO_ROOT, gate.cwd) : REPO_ROOT
  })
  const seconds = ((Date.now() - started) / 1000).toFixed(0)
  if (result.status === 0) {
    console.log(`release: ${gate.name} passed in ${seconds}s`)
    return true
  }
  console.error(`release: ${gate.name} FAILED after ${seconds}s (exit ${result.status ?? result.signal})`)
  return false
}

/**
 * The packaged-app check again, against the copy inside the image.
 *
 * Everything above it has looked at `dist/mac-universal/teamree.app` — a
 * directory. What a person downloads is the `.dmg`, built afterwards out of
 * that tree but through hdiutil, an HFS+ image and a compressor, none of which
 * anything here had ever opened. An image that would not mount, or that carried
 * a short copy of the app, would have been found first by whoever downloaded it.
 */
function verifyInsideTheImage(dmg) {
  heading('--- package:verify (the copy inside the .dmg) ---')
  // `realpathSync`, and this is not cosmetic. On macOS `os.tmpdir()` is under
  // `/var/folders/...`, and `/var` is a symlink to `/private/var` — so a bundle
  // reached through that path is reached through a symlink. The relay command
  // inside the app guards its entry point with
  // `pathToFileURL(process.argv[1]).href === import.meta.url`, and
  // `import.meta.url` is resolved while `process.argv[1]` is not: through a
  // symlinked path the two differ, the guard fails, and the command exits 0
  // having done nothing at all. `package:verify` then reports that the shipped
  // relay wrote no project — a true statement about a path artefact rather than
  // about the `.dmg`. Found exactly that way, the first time this ran.
  //
  // A real download does not take this path (`/Volumes` and `/Applications` are
  // both real directories), so it is the mount that is fixed here rather than
  // the guard. The fragility is real and is recorded in ROADMAP.md.
  const mount = realpathSync(mkdtempSync(join(tmpdir(), 'teamree-dmg-')))
  // Mounted where we say rather than wherever /Volumes puts it, so the path
  // below is known instead of guessed from the volume name.
  const attached = spawnSync('hdiutil', ['attach', dmg, '-nobrowse', '-readonly', '-mountpoint', mount], {
    stdio: 'inherit'
  })
  if (attached.status !== 0) {
    console.error(`release: could not mount ${dmg}.`)
    rmSync(mount, { recursive: true, force: true })
    return false
  }
  try {
    const verifier = join(REPO_ROOT, 'scripts', 'verify-package.mjs')
    const verified = spawnSync(process.execPath, [verifier, join(mount, 'teamree.app')], {
      stdio: 'inherit',
      cwd: REPO_ROOT
    })
    return verified.status === 0
  } finally {
    spawnSync('hdiutil', ['detach', mount, '-quiet'], { stdio: 'inherit' })
    rmSync(mount, { recursive: true, force: true })
  }
}

async function confirm(tag) {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const typed = await rl.question(`Type the tag to publish it, or anything else to stop: `)
    return typed.trim() === tag
  } finally {
    rl.close()
  }
}

async function main(argv) {
  const parsed = parseReleaseArgs(argv)
  if (parsed.error) {
    fail(`${parsed.error}.\n  Usage: npm run release -- [vX.Y.Z] [--dry-run] [--yes]`)
    return
  }

  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
  const tag = parsed.tag ?? expectedTag(pkg.version)

  const head = git(['rev-parse', 'HEAD']).out
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).out
  // `refs/tags/<tag>^{commit}` rather than the bare name: a branch sharing the
  // name would otherwise answer for the tag, and an annotated tag would answer
  // with the tag object rather than the commit it points at.
  const localTagRef = git(['rev-parse', '-q', '--verify', `refs/tags/${tag}^{commit}`])
  const remote = git(['ls-remote', 'origin'])
  if (remote.status !== 0) {
    fail(`could not read origin: ${remote.err}`)
    return
  }
  const remoteRefs = remote.out.split('\n').map((line) => line.split('\t'))
  const remoteTagLine = remoteRefs.find(([, ref]) => ref === `refs/tags/${tag}`)

  // Authentication and repository are asked separately: `gh repo view` fails
  // both when nobody is signed in and when no remote points at GitHub, and one
  // message for the two sent a signed-in maintainer to `gh auth login`.
  const ghAuthenticated = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8', cwd: REPO_ROOT }).status === 0
  // `GH_REPO` is gh's own override, honoured for the same reason gh honours it:
  // a checkout can be perfectly valid and have no GitHub remote on it.
  const named = spawnSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], {
    encoding: 'utf8',
    cwd: REPO_ROOT
  })
  const repoName = process.env.GH_REPO?.trim() || (named.status === 0 ? named.stdout.trim() : '') || null

  const state = {
    tag,
    version: pkg.version,
    head,
    dirty: git(['status', '--porcelain']).out,
    relayInstalled: existsSync(join(REPO_ROOT, 'relay', 'node_modules')),
    ghAuthenticated,
    repo: repoName,
    releaseExists:
      ghAuthenticated &&
      repoName !== null &&
      spawnSync('gh', ['release', 'view', tag, '--repo', repoName], { encoding: 'utf8', cwd: REPO_ROOT }).status === 0,
    localTag: localTagRef.status === 0 ? localTagRef.out : null,
    remoteTag: remoteTagLine ? remoteTagLine[0] : null,
    remoteHeads: remoteRefs.filter(([, ref]) => ref?.startsWith('refs/heads/')).map(([sha]) => sha)
  }

  const refusals = preflightRefusals(state)
  if (refusals.length > 0) {
    console.error(`release: refusing to cut ${tag}.`)
    for (const refusal of refusals) console.error(`- ${refusal}`)
    process.exitCode = 1
    return
  }

  console.log(`release: ${tag} from ${short(head)} on ${branch}, into ${repoName}.`)
  console.log(`release: ${GATES.length + 2} gates to pass; every one of them can stop this.`)

  for (const gate of GATES) {
    if (!runGate(gate)) {
      fail(`stopped at ${gate.name}. Nothing was published.`)
      return
    }
  }

  const dist = join(REPO_ROOT, 'dist')
  const dmgs = readdirSync(dist).filter((name) => name.endsWith('.dmg'))
  if (dmgs.length !== 1) {
    fail(
      dmgs.length === 0
        ? 'the packaging produced no .dmg.'
        : `dist/ holds ${dmgs.length} .dmg files (${dmgs.join(', ')}). dist/ is not cleaned between ` +
            'builds; delete the ones that are not this build.'
    )
    return
  }
  const dmg = join(dist, dmgs[0])

  if (!verifyInsideTheImage(dmg)) {
    fail('the app inside the .dmg did not verify. Nothing was published.')
    return
  }
  console.log('release: package:verify (the copy inside the .dmg) passed')

  // What a downloader's Mac would say. A report rather than a gate when no
  // credentials are set — unsigned is this project's default and refusing it
  // would refuse every release it has ever been able to make — and a gate when
  // they are, because a signing run that silently produced an unsigned build is
  // the failure that reaches people.
  heading('--- verify-signing ---')
  const signing = resolveMacSigning(process.env)
  const signingResult = spawnSync(
    process.execPath,
    [join(REPO_ROOT, 'scripts', 'verify-signing.mjs'), ...(signing.mode === 'signed' ? ['--require-signed'] : [])],
    { stdio: 'inherit', cwd: REPO_ROOT }
  )
  if (signingResult.status !== 0) {
    fail('the signature on the packaged app is not what this run asked for. Nothing was published.')
    return
  }

  const kind = readSignatureKind(findPackagedApp())

  const hash = await sha256(dmg)
  const checksums = `${checksumLine(hash, dmgs[0])}\n`
  const sumsPath = join(dist, 'SHA256SUMS.txt')
  writeFileSync(sumsPath, checksums)

  const notes = releaseNotes({ tag, repo: repoName, checksums, kind })
  const notesPath = join(dist, 'RELEASE_NOTES.md')
  writeFileSync(notesPath, notes)

  for (const line of planLines({
    tag,
    repo: repoName,
    head,
    branch,
    dmg: dmgs[0],
    size: statSync(dmg).size,
    hash,
    kind,
    dryRun: parsed.dryRun
  })) {
    console.log(line)
  }

  console.log('The notes this would carry:')
  console.log('----------------------------------------------------------------')
  console.log(notes)
  console.log('----------------------------------------------------------------')
  console.log(`Written to ${sumsPath} and ${notesPath}; both are inside gitignored dist/.`)

  if (parsed.dryRun) {
    console.log('')
    console.log('release: DRY RUN — every gate passed and nothing was created.')
    console.log(`release: the real run is the same command without --dry-run. It would then`)
    console.log(`release:   git tag -a ${tag} -m "teamree ${tag}"`)
    console.log(`release:   git push origin ${tag}`)
    console.log(`release:   gh release create ${tag} <the two files above>`)
    return
  }

  if (!parsed.yes) {
    if (!process.stdin.isTTY) {
      fail('refusing to publish unprompted. Re-run with --yes, or from a terminal.')
      return
    }
    if (!(await confirm(tag))) {
      fail('not confirmed. Nothing was published.')
      return
    }
  }

  if (!state.localTag) {
    heading(`tagging ${tag}`)
    const tagged = git(['tag', '-a', tag, '-m', `teamree ${tag}`])
    if (tagged.status !== 0) {
      fail(`could not create the tag: ${tagged.err}`)
      return
    }
  }
  if (!state.remoteTag) {
    heading(`pushing ${tag}`)
    const pushed = spawnSync('git', ['push', 'origin', tag], { stdio: 'inherit', cwd: REPO_ROOT })
    if (pushed.status !== 0) {
      fail('could not push the tag. Nothing was published.')
      return
    }
  }

  heading(`creating the release`)
  const created = spawnSync(
    'gh',
    [
      'release',
      'create',
      tag,
      dmg,
      sumsPath,
      '--repo',
      repoName,
      '--title',
      `teamree ${tag}`,
      '--notes-file',
      notesPath,
      ...(isPrerelease(tag) ? ['--prerelease'] : [])
    ],
    { stdio: 'inherit', cwd: REPO_ROOT }
  )
  if (created.status !== 0) {
    fail(
      `gh release create failed. The tag ${tag} is pushed; re-running this command will use it\n` +
        '  rather than making another.'
    )
    return
  }
  console.log(`release: published ${tag}.`)
}

if (process.argv[1] && process.argv[1].endsWith('release.mjs')) {
  await main(process.argv.slice(2))
}
