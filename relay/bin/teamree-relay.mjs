// One command that stands up a relay, from any directory on any machine.
//
// The failure this exists to prevent is real and was hit by the first person to
// follow the old instructions. They said "cd relay; npm install; npm run
// deploy", which is true only inside a clone of the teamree repository — and
// somebody who installed the .dmg has no clone. What they get instead is
// `ENOENT: no such file or directory, open '.../relay/package.json'`, which
// names npm's problem rather than theirs.
//
// So there is no `cd` and no `npm install` any more. This script carries the
// Worker's sources beside it — in a clone, `relay/src`; in an installed app,
// the same tree under `Contents/Resources/relay` — writes them into a directory
// the person owns, and runs Wrangler there. Everything it can refuse, it
// refuses with one sentence that names the command that fixes it.
//
// Node is required and is not something this can paper over: Wrangler is a Node
// program. The shell wrapper beside this file says so when there is no node.
import { spawn } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** Wrangler is fetched on demand rather than vendored; a major is pinned so a 5.x cannot arrive unannounced. */
export const WRANGLER_SPEC = 'wrangler@4'

/** Where a project goes when nobody says otherwise. Under $HOME, so it does not depend on where this was run. */
export const DEFAULT_DIR = 'teamree-relay'

/**
 * The Worker project, as relative paths inside the relay package.
 *
 * `wrangler.jsonc` names `src/workers/worker.ts` as its entry point, and that
 * file imports only from `src/workers` and `src/core` — deliberately, because
 * the Worker must not reach into the Node host's half. The test suite asserts
 * that every import resolves inside this list, so a new file that the Worker
 * needs cannot be forgotten here and discovered by somebody's failed deploy.
 *
 * `src/node` is absent on purpose: it is the container host, which this command
 * does not deploy.
 */
export const TEMPLATE_DIRS = ['src/core', 'src/workers']
export const TEMPLATE_FILES = ['wrangler.jsonc']

/** Written fresh into the project rather than copied, because none of them exist in the package. */
export const GENERATED_FILES = ['package.json', 'tsconfig.json', '.gitignore', 'README.md']

const USAGE = `teamree-relay — deploy the teamree relay as a Cloudflare Worker

  teamree-relay deploy [directory]   write the Worker project and deploy it
                                     (directory defaults to ~/${DEFAULT_DIR})

  --here          deploy the project in the current directory instead of writing one
  --dry-run       build and check the Worker without deploying it; needs no account
  --write-only    write the project and stop, deploying nothing
  --name <name>   Worker name to deploy under (default: the one in wrangler.jsonc)
  --help          this

The relay endpoint this prints is what goes into .teamree/relay in your project.
Nobody hosts a relay for you; this deploys one to your own Cloudflare account.`

// --------------------------------------------------------------- arguments --

/** @returns {{command: string, dir: string | null, here: boolean, dryRun: boolean, writeOnly: boolean, name: string | null, help: boolean, error: string | null}} */
export function parseArgs(argv) {
  const parsed = {
    command: '',
    dir: null,
    here: false,
    dryRun: false,
    writeOnly: false,
    name: null,
    help: false,
    error: null
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') parsed.help = true
    else if (arg === '--here') parsed.here = true
    else if (arg === '--dry-run') parsed.dryRun = true
    else if (arg === '--write-only') parsed.writeOnly = true
    else if (arg === '--name') {
      i += 1
      const value = argv[i]
      if (value === undefined) return { ...parsed, error: '--name needs a Worker name after it.' }
      parsed.name = value
    } else if (arg.startsWith('-')) {
      return { ...parsed, error: `Unknown option ${arg}. Run teamree-relay --help for the whole of it.` }
    } else if (parsed.command === '') parsed.command = arg
    else if (parsed.dir === null) parsed.dir = arg
    else return { ...parsed, error: `Unexpected extra argument ${arg}.` }
  }
  if (parsed.here && parsed.dir !== null) {
    return { ...parsed, error: '--here deploys the project in this directory, so it takes no directory argument.' }
  }
  return parsed
}

// ---------------------------------------------------------- the template --

/** The relay package this script is part of: `relay/` in a clone, `Contents/Resources/relay` in an installed app. */
export function templateRoot(scriptUrl = import.meta.url) {
  return dirname(dirname(fileURLToPath(scriptUrl)))
}

/** Every template path that is not where it should be, so a pruned package says what it lost. */
export function missingTemplatePaths(root) {
  const missing = []
  for (const file of TEMPLATE_FILES) if (!existsSync(join(root, file))) missing.push(file)
  for (const dir of TEMPLATE_DIRS) {
    const full = join(root, dir)
    if (!existsSync(full) || !statSync(full).isDirectory() || readdirSync(full).length === 0) missing.push(dir)
  }
  return missing
}

/** Template path -> project path, as the pairs that would be copied. */
export function templatePlan(root) {
  const plan = []
  for (const file of TEMPLATE_FILES) plan.push({ from: join(root, file), to: file })
  for (const dir of TEMPLATE_DIRS) {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (entry.isFile()) plan.push({ from: join(root, dir, entry.name), to: `${dir}/${entry.name}` })
    }
  }
  return plan
}

// ------------------------------------------------------ the written project --

/** The one value in wrangler.jsonc this script has to agree with, read from the file rather than repeated. */
export function relayPathFrom(wranglerConfig) {
  const match = /"RELAY_PATH"\s*:\s*"([^"]*)"/.exec(wranglerConfig)
  return match ? match[1] : '/v1/relay'
}

export function generatedPackageJson() {
  return `${JSON.stringify(
    {
      name: 'teamree-relay-worker',
      version: '0.1.0',
      private: true,
      description: 'A teamree relay, deployed as a Cloudflare Worker',
      type: 'module',
      scripts: { deploy: 'wrangler deploy', tail: 'wrangler tail' },
      devDependencies: { '@cloudflare/workers-types': '^5.20260911.1', wrangler: '^4.131.1' }
    },
    null,
    2
  )}\n`
}

export function generatedTsconfig() {
  return `${JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2023',
        module: 'ESNext',
        moduleResolution: 'Bundler',
        lib: ['ES2023'],
        types: ['@cloudflare/workers-types'],
        strict: true,
        noEmit: true,
        skipLibCheck: true
      },
      include: ['src/**/*.ts']
    },
    null,
    2
  )}\n`
}

export function generatedGitignore() {
  return '.wrangler/\nnode_modules/\n'
}

export function generatedReadme(relayPath) {
  return `# Your teamree relay

This directory is a Cloudflare Worker: the relay two teamree peers dial out to
so they can reach each other from behind two routers. It was written here by
\`teamree-relay deploy\`, and it is yours — commit it, edit it, keep it.

## Deploy it again

    npx ${WRANGLER_SPEC} deploy

Run that from this directory. It is what \`teamree-relay deploy\` ran for you,
and it is the whole of a redeploy: there are no resource ids to fill in and no
secrets to set.

## The address your team needs

Wrangler prints an \`https://\` host. The relay endpoint is that host with
\`${relayPath}\` on the end, spoken as \`wss://\`:

    wss://<the host wrangler printed>${relayPath}

That is the line that goes in \`.teamree/relay\` in your project, and teamree
refuses an \`https://\` URL rather than guessing at the rest of it.

## Changing it

\`wrangler.jsonc\` holds the Worker's name and the relay's limits, under
\`vars\`. Edit one and deploy again. A value the relay cannot parse stops the
Worker starting rather than being quietly ignored.

\`src/\` is the relay itself, copied from the teamree repository. The
authoritative documentation — what the relay can and cannot see, how the
rendezvous is derived, what the operator learns — is \`relay/README.md\` there.
`
}

/** The generated files, by project path, given the wrangler config that will sit beside them. */
export function generatedProject(wranglerConfig) {
  return {
    'package.json': generatedPackageJson(),
    'tsconfig.json': generatedTsconfig(),
    '.gitignore': generatedGitignore(),
    'README.md': generatedReadme(relayPathFrom(wranglerConfig))
  }
}

// ------------------------------------------------------- where it may write --

/** Whether a directory holds a relay project this command could deploy, or why it does not. */
export function projectFault(dir) {
  if (!existsSync(join(dir, 'wrangler.jsonc'))) return 'there is no wrangler.jsonc here'
  if (!existsSync(join(dir, 'src', 'workers', 'worker.ts'))) return 'there is no src/workers/worker.ts here'
  return null
}

/** Whether a directory is empty enough to be written into, treating a previous run's project as ours. */
export function occupiedBy(dir) {
  if (!existsSync(dir)) return null
  const entries = readdirSync(dir).filter((name) => name !== '.DS_Store')
  if (entries.length === 0) return null
  if (projectFault(dir) === null) return null
  return entries.slice(0, 4).join(', ')
}

/**
 * Writes the project, and never overwrites a file that is already there.
 *
 * The second run of this command on the same directory is the interesting one:
 * somebody has edited `wrangler.jsonc` to change a limit or the Worker's name,
 * and copying over it would silently undo that. So an existing file is kept and
 * reported, and only what is missing is added.
 *
 * @returns {{written: string[], kept: string[]}}
 */
export function writeProject(root, target) {
  const written = []
  const kept = []

  const place = (relativePath, write) => {
    const full = join(target, relativePath)
    if (existsSync(full)) {
      kept.push(relativePath)
      return
    }
    mkdirSync(dirname(full), { recursive: true })
    write(full)
    written.push(relativePath)
  }

  mkdirSync(target, { recursive: true })
  for (const { from, to } of templatePlan(root)) place(to, (full) => copyFileSync(from, full))

  const config = readFileSync(join(target, 'wrangler.jsonc'), 'utf8')
  for (const [name, contents] of Object.entries(generatedProject(config))) {
    place(name, (full) => writeFileSync(full, contents))
  }

  return { written, kept }
}

/**
 * What the write did, in one line, so a second run is obviously a second run.
 *
 * The interesting case is the one where nothing was written: that is somebody
 * deploying again, and telling them "wrote 0 files" reads like a failure.
 */
export function describeWrite(where, written, kept) {
  if (written.length === 0)
    return `teamree-relay: the project in ${where} is already there, and is left exactly as it is`
  if (kept.length === 0) return `teamree-relay: wrote the Worker project into ${where} (${written.length} files)`
  return (
    `teamree-relay: added ${written.length} missing files to the project in ${where}, ` +
    `and kept the ${kept.length} already there`
  )
}

// ------------------------------------------------------------- deploying it --

/**
 * The relay endpoint, from whatever Wrangler printed.
 *
 * Wrangler names the deployment's URL last, after any documentation link it
 * happened to print, so the final host wins — with Cloudflare's own sites
 * excluded, because a login prompt or a docs link is not where the relay is.
 */
export function relayEndpointFrom(output, relayPath = '/v1/relay') {
  const ignored = /^(dash|developers|workers|www)\.cloudflare\.com$/
  let host = null
  for (const match of output.matchAll(/https:\/\/([a-z0-9.-]+\.[a-z]{2,})(?![a-z])/gi)) {
    if (!ignored.test(match[1])) host = match[1]
  }
  return host === null ? null : `wss://${host}${relayPath}`
}

/** Wrangler as this project can run it: the one it installed, or one npx fetches. */
export function wranglerCommand(target) {
  const local = join(target, 'node_modules', '.bin', 'wrangler')
  if (existsSync(local)) return { command: local, args: [] }
  return { command: 'npx', args: ['--yes', WRANGLER_SPEC] }
}

function runWrangler(target, args) {
  const { command, args: prefix } = wranglerCommand(target)
  return new Promise((done) => {
    const child = spawn(command, [...prefix, ...args], { cwd: target, stdio: ['inherit', 'pipe', 'inherit'] })
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += chunk
      process.stdout.write(chunk)
    })
    child.on('error', (error) => done({ code: 1, output, error }))
    child.on('close', (code) => done({ code: code ?? 1, output, error: null }))
  })
}

// -------------------------------------------------------------------- main --

function fail(message) {
  console.error(`teamree-relay: ${message}`)
  process.exit(1)
}

/** `~/x` for a path under the home directory, so what is printed is what a person would type. */
function tilde(path) {
  const home = homedir()
  return path === home || path.startsWith(`${home}/`) ? `~/${relative(home, path)}` : path
}

export async function main(argv, { cwd = process.cwd(), root = templateRoot() } = {}) {
  const options = parseArgs(argv)
  if (options.error !== null) fail(options.error)
  if (options.help || options.command === '') {
    console.log(USAGE)
    return
  }
  if (options.command !== 'deploy') {
    fail(`there is no "${options.command}" command; the one command is:  teamree-relay deploy`)
  }

  let target
  if (options.here) {
    target = cwd
    const fault = projectFault(target)
    if (fault !== null) {
      fail(
        `${fault}, so there is no relay in ${tilde(target)} to deploy — ` +
          `run  teamree-relay deploy  with no --here to write one into ~/${DEFAULT_DIR} first.`
      )
    }
  } else {
    target = resolve(cwd, options.dir ?? join(homedir(), DEFAULT_DIR))
    const missing = missingTemplatePaths(root)
    if (missing.length > 0) {
      fail(`this copy of the relay is incomplete — ${missing.join(', ')} is not in ${root}.`)
    }
    const occupied = occupiedBy(target)
    if (occupied !== null) {
      fail(
        `${tilde(target)} already holds something else (${occupied}), and this will not write over it — ` +
          `name an empty directory instead:  teamree-relay deploy ~/some-other-relay`
      )
    }
    const { written, kept } = writeProject(root, target)
    console.log(describeWrite(tilde(target), written, kept))
  }

  if (options.writeOnly) {
    console.log(
      `teamree-relay: stopping there, as --write-only asks. ` +
        `Deploy it with:  cd ${tilde(target)} && npx ${WRANGLER_SPEC} deploy`
    )
    return
  }

  const args = ['deploy']
  if (options.dryRun) args.push('--dry-run')
  if (options.name !== null) args.push('--name', options.name)

  console.log(
    options.dryRun
      ? 'teamree-relay: building the Worker without deploying it (--dry-run), which needs no account'
      : 'teamree-relay: deploying to your Cloudflare account — a browser opens once if you are not logged in'
  )

  const { code, output, error } = await runWrangler(target, args)
  if (error !== null) {
    fail(
      `could not run ${wranglerCommand(target).command} (${error.message}). ` +
        'Wrangler is a Node program: install Node 20 or newer from https://nodejs.org and run this again.'
    )
  }
  if (code !== 0) {
    fail(`wrangler exited ${code}. The project is at ${tilde(target)}; nothing here has been lost.`)
  }
  if (options.dryRun) {
    console.log('\nteamree-relay: the Worker builds. Nothing was deployed — drop --dry-run to deploy it.')
    return
  }

  const relayPath = relayPathFrom(readFileSync(join(target, 'wrangler.jsonc'), 'utf8'))
  const endpoint = relayEndpointFrom(output, relayPath)
  console.log('')
  if (endpoint === null) {
    console.log(
      `teamree-relay: deployed. The relay endpoint is the https:// host above with ${relayPath} on the end, as wss://.`
    )
  } else {
    console.log(`teamree-relay: deployed. Your relay endpoint is\n\n    ${endpoint}\n`)
    console.log('Paste that into teamree — Teamwork, "Set the relay for this project" — and commit .teamree/relay.')
  }
}

// Both sides are resolved through symlinks before comparing. `import.meta.url`
// is already resolved and `process.argv[1]` is not, so comparing them raw made
// this program a no-op whenever it was reached through a link — which includes
// anything under a macOS temp directory, since /var is itself a symlink.
function isThisModule(entry) {
  if (entry === undefined) return false
  try {
    return pathToFileURL(realpathSync(entry)).href === pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href
  } catch {
    return pathToFileURL(entry).href === import.meta.url
  }
}

if (isThisModule(process.argv[1])) {
  await main(process.argv.slice(2))
}
