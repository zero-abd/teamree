#!/usr/bin/env node
// Turns examples/ledger into a real git repository somewhere you can point
// teamree at.
//
// The example cannot simply *be* a git repository in this tree: a repository
// inside a repository is either a submodule, which is a thing to maintain, or an
// ignored directory, which is a thing nobody reviews. So the files are tracked
// here as ordinary files, and this script assembles them into a checkout with a
// history worth looking at.
//
//   node examples/init-example-repo.mjs ~/teamree-example
//   node examples/init-example-repo.mjs ~/teamree-example --with-origin
//
// `--with-origin` also creates a bare repository beside it and pushes to it,
// which is what the two-peer harness needs: something both peers can clone and
// push to without a git host in between.

import { execFileSync } from 'node:child_process'
import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SOURCE = fileURLToPath(new URL('./ledger/', import.meta.url))

/**
 * The history, as a list of commits over the files copied in. Each commit is a
 * step that leaves the suite passing, so `git checkout` of any of them is a
 * working project rather than a half-applied patch — which is the difference
 * between a fixture somebody can bisect and one they cannot.
 */
const HISTORY = [
  {
    message: 'Start a ledger that splits a shared bill',
    paths: ['package.json', '.gitignore', 'src/parse.js', 'test/parse.test.js']
  },
  { message: 'Work out who owes whom', paths: ['src/settle.js', 'test/settle.test.js'] },
  { message: 'Print it in a way a person can read', paths: ['src/format.js', 'test/format.test.js'] },
  {
    message: 'Add the command line, and a weekend to try it on',
    paths: ['bin/ledger.js', 'fixtures/trip.ledger', 'fixtures/broken.ledger', 'test/cli.test.js']
  },
  { message: 'Write down what is left to do', paths: ['README.md', 'TASKS.md'] }
]

/**
 * A sketch left on a branch, so the start-from picker has a real branch in it
 * and a teammate has something half-finished to look at. It lives here rather
 * than in `ledger/` because it must exist on that branch only.
 */
const SPIKE_BRANCH = 'spike/json-output'
const SPIKE_NOTE = `# Sketch: machine-readable output

Started, not finished. The shape I had in mind:

    ledger --json fixtures/trip.ledger

prints one object and nothing else, with amounts in cents rather than decimal
strings — the caller is a program, and handing it "18.10" to parse back is
handing it the floating-point bug this codebase was built to avoid.

Unresolved: whether \`--json\` should suppress the exit code 70 self-check, or
report it as a field. Probably report it. Nothing is implemented yet.

See TASKS.md, task 1.
`

/** Written so that `.teamree/members/` exists before anybody adds a key to it. */
const TEAMREE_NOTE = `# .teamree

\`members/\` holds one file per person on this team: their X25519 public key, at
\`members/<handle>.pub\`.

That directory is the whole membership list. There is nothing else to keep in
step with it, because push access to this repository already decides who is on
the team: if you can add your key here, you are on it, and if you are removed
from the repository you can no longer change it.

Adding yourself is in the runbook.
`

function git(args, cwd) {
  // -c rather than `git config`: a fresh machine, and every container, has no
  // global identity, and `git commit` refusing for that reason is a confusing
  // way for a fixture script to fail.
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=teamree example',
      '-c',
      'user.email=example@teamree.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args
    ],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  )
}

async function isEmptyish(path) {
  try {
    return (await readdir(path)).length === 0
  } catch (error) {
    if (error.code === 'ENOENT') return true
    throw error
  }
}

/**
 * Creates the example repository at `destination`.
 *
 * @param {object} options
 * @param {string} options.destination Where the checkout goes.
 * @param {boolean} [options.withOrigin] Also create `<destination>.git` and push to it.
 * @param {boolean} [options.force] Replace an existing directory.
 * @param {(line: string) => void} [options.log]
 * @returns {Promise<{ path: string, origin?: string, branches: string[] }>}
 */
export async function createExampleRepo(options) {
  const destination = resolve(options.destination)
  const log = options.log ?? (() => {})

  if (!(await isEmptyish(destination))) {
    if (!options.force) {
      throw new Error(`${destination} already exists and is not empty; pass --force to replace it`)
    }
    await rm(destination, { recursive: true, force: true })
  }

  await mkdir(dirname(destination), { recursive: true })
  await cp(SOURCE, destination, { recursive: true })
  await mkdir(join(destination, '.teamree', 'members'), { recursive: true })
  await writeFile(join(destination, '.teamree', 'README.md'), TEAMREE_NOTE)
  // git will not track an empty directory, and `.teamree/members/` needs to
  // survive a clone so the first person to add a key is not also creating it.
  await writeFile(join(destination, '.teamree', 'members', '.gitkeep'), '')

  git(['init', '-b', 'main', '--quiet', destination], dirname(destination))
  for (const commit of HISTORY) {
    git(['add', '--', ...commit.paths], destination)
    git(['commit', '--quiet', '-m', commit.message], destination)
  }
  git(['add', '--', '.teamree'], destination)
  git(['commit', '--quiet', '-m', "Make room for the team's public keys"], destination)

  git(['checkout', '--quiet', '-b', SPIKE_BRANCH], destination)
  await mkdir(join(destination, 'notes'), { recursive: true })
  await writeFile(join(destination, 'notes', 'json-output.md'), SPIKE_NOTE)
  git(['add', '--', 'notes/json-output.md'], destination)
  git(['commit', '--quiet', '-m', 'Sketch what machine-readable output would look like'], destination)
  git(['checkout', '--quiet', 'main'], destination)

  const branches = ['main', SPIKE_BRANCH]
  let origin

  if (options.withOrigin) {
    origin = `${destination}.git`
    await rm(origin, { recursive: true, force: true })
    // --initial-branch matters even though nothing is ever committed here
    // directly. A bare repository's HEAD is what `git clone` checks out, and a
    // HEAD left pointing at a branch that was never pushed gives every clone an
    // empty working directory and an upstream that does not exist — which looks
    // like a broken fixture long before it looks like a default.
    git(['init', '--bare', '--quiet', '--initial-branch=main', origin], dirname(destination))
    git(['remote', 'add', 'origin', origin], destination)
    git(['push', '--quiet', '--set-upstream', 'origin', ...branches], destination)
  }

  log(`Created ${destination}`)
  log(`  ${HISTORY.length + 1} commits on main, plus the ${SPIKE_BRANCH} branch`)
  if (origin) log(`  pushed to ${origin}`)

  return { path: destination, origin, branches }
}

function parseArgv(argv) {
  const positional = argv.filter((argument) => !argument.startsWith('--'))
  const flags = new Set(argv.filter((argument) => argument.startsWith('--')))
  const unknown = [...flags].find((flag) => flag !== '--with-origin' && flag !== '--force')
  if (unknown) throw new Error(`unknown option ${unknown}`)
  if (positional.length !== 1) throw new Error('expected exactly one destination directory')
  return { destination: positional[0], withOrigin: flags.has('--with-origin'), force: flags.has('--force') }
}

const USAGE = `usage: node examples/init-example-repo.mjs <destination> [--with-origin] [--force]

  --with-origin   also create <destination>.git and push main and ${SPIKE_BRANCH} to it
  --force         replace <destination> if it already exists`

// Only when run directly, so the two-peer harness can import createExampleRepo.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${USAGE}\n`)
    process.exit(0)
  }
  try {
    const result = await createExampleRepo({ ...parseArgv(argv), log: (line) => process.stdout.write(`${line}\n`) })
    process.stdout.write(`\nNext: add ${result.path} to teamree as a project, or follow docs/trying-teamwork.md\n`)
  } catch (error) {
    process.stderr.write(`init-example-repo: ${error.message}\n\n${USAGE}\n`)
    process.exit(1)
  }
}
