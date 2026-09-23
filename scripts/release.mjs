// Cuts a release from this machine and runs every gate first, stopping at the first that says no.
// `--dry-run` does all of it and stops before the tag and the release.
import { createHash } from 'node:crypto'
import {
  copyFileSync,
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

/** Every gate, cheapest failure first. The set is fixed; there is deliberately no flag to shorten it. */
export const GATES = [
  { name: 'typecheck', args: ['run', 'typecheck'] },
  // The root typecheck cannot see the relay's Worker entry point; only the relay's own tsc does.
  { name: 'relay typecheck', args: ['run', 'typecheck'], cwd: 'relay' },
  { name: 'format:check', args: ['run', 'format:check'] },
  { name: 'oxlint', args: ['run', 'lint'] },
  // The acceptance pass needs `out/cli/index.js`, which a clean clone does not have.
  { name: 'build:cli', args: ['run', 'build:cli'] },
  // Before the suite: the peer tests stat `relay/dist`, and `pretest` refuses a stale one.
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
  // A pre-release of a version is still that version: `v0.2.0-rc.1` releases 0.2.0.
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

/** Where the version's hand-written notes live; one file per version so the tag carries its own. */
export function highlightsPath(version) {
  return join('docs', 'release-notes', `${version}.md`)
}

/** The version's notes, or null when nobody has written them. */
export function readHighlights(version, root = REPO_ROOT) {
  const path = join(root, highlightsPath(version))
  if (!existsSync(path)) return null
  const text = readFileSync(path, 'utf8').trim()
  return text === '' ? null : text
}

/** Everything wrong with the repository, checked before any machine time is spent. */
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

  // A release with no notes looks complete on the page, so nobody notices; ask for them by name.
  if (state.highlights === null) {
    refusals.push(
      `nothing describes what is in ${state.version}. Write ${highlightsPath(state.version)} —\n` +
        '  what changed, for somebody who is going to download this and use it. It is the top of\n' +
        '  the release body and the text the app shows when it offers this version to a person\n' +
        '  still running an older one.'
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

  // Separate from authentication: one message for both sent people to `gh auth login` over a non-GitHub remote.
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

/**
 * The version-free second name of the `.dmg`. `releases/latest/download/<name>` looks up that exact
 * filename, so a versioned link 404s the day the next release ships.
 */
export const STABLE_DMG_NAME = 'teamree-mac-universal.dmg'

/** `shasum -a 256` output, byte for byte, so a reader can compare it as printed. */
export function checksumLine(hash, name) {
  return `${hash}  ${name}`
}

/**
 * The release body, generated from the bundle actually built so the signing paragraph cannot lie.
 * Highlights go on top: the update card cuts the body at a length.
 */
export function releaseNotes({ tag, repo, checksums, kind, highlights = null }) {
  const signed = isDistributable(kind)
  const lines = [`teamree \`${tag}\`, for macOS. One universal \`.dmg\`: Apple Silicon and Intel both.`, '']

  if (highlights !== null && highlights.trim() !== '') lines.push(highlights.trim(), '')

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
      // macOS 15+ wording. The body is the only text most people read before double-clicking,
      // so the "do not press Move to Trash" line has to be here, not in docs/install.md.
      'The first time you open it, macOS will refuse, with a dialog whose two buttons are',
      '**Move to Trash** and **Done**:',
      '',
      '> **"teamree" Not Opened**',
      '>',
      '> Apple could not verify "teamree" is free of malware that may harm your Mac or',
      '> compromise your privacy.',
      '',
      '**Do not press Move to Trash.** It is the prominent button and it is the wrong one; press',
      '**Done**. There is no "Open Anyway" button in that dialog — macOS 15 removed the',
      'Control-click route — so move the app to `/Applications` and then run once:',
      '',
      '```sh',
      'xattr -dr com.apple.quarantine /Applications/teamree.app',
      '```',
      '',
      'Open it normally after that and it will not ask again.',
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

/** The packaged-app check again, against the copy inside the mounted image that actually ships. */
function verifyInsideTheImage(dmg) {
  heading('--- package:verify (the copy inside the .dmg) ---')
  // realpath: /var is a symlink to /private/var, and through it the relay entry guard
  // (`argv[1]` vs `import.meta.url`) fails and exits 0 having done nothing.
  const mount = realpathSync(mkdtempSync(join(tmpdir(), 'teamree-dmg-')))
  // A known mount point instead of one guessed from the volume name.
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
  // Not the bare name: a same-named branch would answer, and an annotated tag gives the tag object.
  const localTagRef = git(['rev-parse', '-q', '--verify', `refs/tags/${tag}^{commit}`])
  const remote = git(['ls-remote', 'origin'])
  if (remote.status !== 0) {
    fail(`could not read origin: ${remote.err}`)
    return
  }
  const remoteRefs = remote.out.split('\n').map((line) => line.split('\t'))
  const remoteTagLine = remoteRefs.find(([, ref]) => ref === `refs/tags/${tag}`)

  // `gh repo view` fails both signed-out and with no GitHub remote, so auth is asked separately.
  const ghAuthenticated = spawnSync('gh', ['auth', 'status'], { encoding: 'utf8', cwd: REPO_ROOT }).status === 0
  // `GH_REPO` is gh's own override for a checkout with no GitHub remote.
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
    // By package version, so a candidate uses the notes of the version it is a candidate for.
    highlights: readHighlights(pkg.version),
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
  // The alias from an earlier run is not a second build.
  const dmgs = readdirSync(dist).filter((name) => name.endsWith('.dmg') && name !== STABLE_DMG_NAME)
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

  // A report when unsigned (the default), a gate when credentials are set: a signing run
  // that silently produced an unsigned build is the failure that reaches people.
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

  // Copied, not symlinked: upload reads the path.
  const stableDmg = join(dist, STABLE_DMG_NAME)
  copyFileSync(dmg, stableDmg)

  const checksums = `${checksumLine(hash, dmgs[0])}\n${checksumLine(hash, STABLE_DMG_NAME)}\n`
  const sumsPath = join(dist, 'SHA256SUMS.txt')
  writeFileSync(sumsPath, checksums)

  const notes = releaseNotes({ tag, repo: repoName, checksums, kind, highlights: state.highlights })
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
      stableDmg,
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
