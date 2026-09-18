// The commands that stand up a relay, from any directory on any machine.
//
// The failure this exists to prevent is real and was hit by the first person to
// follow the old instructions. They said "cd relay; npm install; npm run
// deploy", which is true only inside a clone of the teamree repository — and
// somebody who installed the .dmg has no clone. What they get instead is
// `ENOENT: no such file or directory, open '.../relay/package.json'`, which
// names npm's problem rather than theirs.
//
// So there is no `cd` into a clone any more. This script carries the relay's
// sources beside it — in a clone, `relay/src`; in an installed app, the same
// tree under `Contents/Resources/relay` — writes them into a directory the
// person owns, and works there. Everything it can refuse, it refuses with one
// sentence that names the command that fixes it.
//
// There are three commands, because there are three honest answers to "where
// does our relay live":
//
//   deploy   a Cloudflare Worker on your own account, reachable from anywhere
//   serve    the Node host, on this machine, reachable by whoever can already
//            reach this machine — which is not everybody, and serve says so in
//            as many words before it starts
//   check    dial a relay URL and say what answered, so the line that goes into
//            .teamree/relay is one somebody has actually proved
//
// `serve` does run `npm install`, and that is not the failure above coming
// back: it runs it inside the project it has just written into a directory the
// person owns, which has a package.json because this wrote one. Nothing is ever
// installed, built or run inside the app bundle — /Applications is code-signed,
// may be read-only, and is not where somebody's relay should live.
//
// Node is required and is not something this can paper over: Wrangler is a Node
// program and so is the relay itself. The shell wrapper beside this file says
// so when there is no node.
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
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
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { homedir, networkInterfaces } from 'node:os'
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

/**
 * The Node relay project, as relative paths inside the relay package.
 *
 * `src/node/index.ts` is the entry point, and it reaches into `src/core` and
 * nowhere else — the Node host must not import the Worker's half any more than
 * the Worker may import this one. The same test that guards `TEMPLATE_DIRS`
 * walks this graph, so a new file the host needs cannot be forgotten here and
 * discovered by somebody's failed build.
 *
 * `wrangler.jsonc` is absent on purpose: nothing here is deployed to anybody.
 */
export const SERVE_TEMPLATE_DIRS = ['src/core', 'src/node']

/** Where `serve` writes when nobody says otherwise. Beside ~/${DEFAULT_DIR}, and not the same directory: the two are different projects. */
export const SERVE_DEFAULT_DIR = 'teamree-relay-server'

/** What `serve` binds when nobody says otherwise, matching the relay's own defaults so the two never disagree. */
export const SERVE_DEFAULT_PORT = 8787
export const SERVE_DEFAULT_HOST = '0.0.0.0'

/** How long `check` waits for an answer before calling it a timeout rather than hanging on somebody's dropped packets. */
export const CHECK_TIMEOUT_MS = 10_000

/** Written fresh into the project rather than copied, because none of them exist in the package. */
export const GENERATED_FILES = ['package.json', 'tsconfig.json', '.gitignore', 'README.md']

const USAGE = `teamree-relay — run or deploy the relay two teamree peers meet on

  teamree-relay deploy [directory]   write the Worker project and deploy it to
                                     Cloudflare (defaults to ~/${DEFAULT_DIR})
  teamree-relay serve [directory]    write the Node relay project, build it and
                                     run it here (defaults to ~/${SERVE_DEFAULT_DIR})
  teamree-relay check <url>          dial a ws:// or wss:// relay and say what answered

deploy
  --here          deploy the project in the current directory instead of writing one
  --dry-run       build and check the Worker without deploying it; needs no account
  --write-only    write the project and stop, deploying nothing
  --name <name>   Worker name to deploy under (default: the one in wrangler.jsonc)

serve
  --here          run the project in the current directory instead of writing one
  --write-only    write the project and stop, running nothing
  --port <n>      port to listen on (default ${SERVE_DEFAULT_PORT})
  --host <addr>   address to bind (default ${SERVE_DEFAULT_HOST})

  --help          this

The relay endpoint these print is what goes into .teamree/relay in your project.
Nobody hosts a relay for you: deploy puts one in your own Cloudflare account,
serve runs one on your own machine, and check tells you whether it answers.`

// --------------------------------------------------------------- arguments --

/** @returns {{command: string, dir: string | null, url: string | null, here: boolean, dryRun: boolean, writeOnly: boolean, name: string | null, port: number | null, host: string | null, help: boolean, error: string | null}} */
export function parseArgs(argv) {
  const parsed = {
    command: '',
    dir: null,
    url: null,
    here: false,
    dryRun: false,
    writeOnly: false,
    name: null,
    port: null,
    host: null,
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
    } else if (arg === '--port') {
      i += 1
      const value = argv[i]
      if (value === undefined) return { ...parsed, error: '--port needs a port number after it.' }
      // Refused rather than coerced. `--port 8O87` with a letter O in it parses
      // as 8 under Number-ish reading, and a relay listening on 8 while its
      // operator believes it is on 8087 is a whole evening.
      if (!/^\d+$/.test(value) || Number(value) > 65535) {
        return { ...parsed, error: `--port needs a port number between 0 and 65535, not ${value}.` }
      }
      parsed.port = Number(value)
    } else if (arg === '--host') {
      i += 1
      const value = argv[i]
      if (value === undefined) return { ...parsed, error: '--host needs an address after it.' }
      parsed.host = value
    } else if (arg.startsWith('-')) {
      return { ...parsed, error: `Unknown option ${arg}. Run teamree-relay --help for the whole of it.` }
    } else if (parsed.command === '') parsed.command = arg
    else if (parsed.dir === null) parsed.dir = arg
    else return { ...parsed, error: `Unexpected extra argument ${arg}.` }
  }
  if (parsed.here && parsed.dir !== null) {
    return { ...parsed, error: '--here uses the project in this directory, so it takes no directory argument.' }
  }
  // `check` has one argument and it is a URL, not a directory. It shares the
  // positional slot because there is only ever one of them, and it is moved out
  // of `dir` here so that nothing downstream can resolve a URL against a path.
  if (parsed.command === 'check') {
    parsed.url = parsed.dir
    parsed.dir = null
    if (parsed.url === null && !parsed.help) {
      return {
        ...parsed,
        error: 'check needs a relay URL after it:  teamree-relay check wss://your-relay.example/v1/relay'
      }
    }
  }
  return parsed
}

// ---------------------------------------------------------- the template --

/** The relay package this script is part of: `relay/` in a clone, `Contents/Resources/relay` in an installed app. */
export function templateRoot(scriptUrl = import.meta.url) {
  return dirname(dirname(fileURLToPath(scriptUrl)))
}

/**
 * Every template path that is not where it should be, so a pruned package says
 * what it lost.
 *
 * The two template lists are arguments with the Worker's as the default,
 * because `serve` carries a different half of the same package and the check is
 * the same check. A caller that says nothing still asks about the Worker.
 */
export function missingTemplatePaths(root, dirs = TEMPLATE_DIRS, files = TEMPLATE_FILES) {
  const missing = []
  for (const file of files) if (!existsSync(join(root, file))) missing.push(file)
  for (const dir of dirs) {
    const full = join(root, dir)
    if (!existsSync(full) || !statSync(full).isDirectory() || readdirSync(full).length === 0) missing.push(dir)
  }
  return missing
}

/** Template path -> project path, as the pairs that would be copied. */
export function templatePlan(root, dirs = TEMPLATE_DIRS, files = TEMPLATE_FILES) {
  const plan = []
  for (const file of files) plan.push({ from: join(root, file), to: file })
  for (const dir of dirs) {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      if (entry.isFile()) plan.push({ from: join(root, dir, entry.name), to: `${dir}/${entry.name}` })
    }
  }
  return plan
}

/** The Node relay project's files, as the pairs that would be copied. */
export function serveTemplatePlan(root) {
  return templatePlan(root, SERVE_TEMPLATE_DIRS, [])
}

/** Every path `serve` needs that is not where it should be. */
export function missingServeTemplatePaths(root) {
  return missingTemplatePaths(root, SERVE_TEMPLATE_DIRS, [])
}

// ------------------------------------------------------ the written project --

/**
 * The relay's path when nothing has changed it.
 *
 * This is a fallback and a last resort, not the source of truth: both readers
 * below go to the file that actually decides, and land here only when that file
 * is unreadable or has been rewritten past recognition. The test suite pins it
 * to `src/core/config.ts`, so the day somebody moves the endpoint this constant
 * fails rather than quietly disagreeing.
 */
export const FALLBACK_RELAY_PATH = '/v1/relay'

/** The one value in wrangler.jsonc this script has to agree with, read from the file rather than repeated. */
export function relayPathFrom(wranglerConfig) {
  const match = /"RELAY_PATH"\s*:\s*"([^"]*)"/.exec(wranglerConfig)
  return match ? match[1] : FALLBACK_RELAY_PATH
}

/**
 * The Node relay's own default path, read out of `src/core/config.ts`.
 *
 * Read by regex rather than imported, and that is a deliberate trade. This file
 * is plain JavaScript that ships inside the app and runs with no build step, so
 * it cannot import a `.ts` at all — the alternatives were a third hard-coded
 * copy of `/v1/relay` or a build step between the repository and what runs, and
 * both are worse than a five-character pattern over one line. `relayPathFrom`
 * already reads `wrangler.jsonc` the same way, so this is the precedent rather
 * than a new idea.
 *
 * Anchored to the start of a line so it matches the one entry in
 * `defaultConfig` and not the type declaration or any prose above it.
 */
export function relayDefaultPath(root) {
  try {
    const source = readFileSync(join(root, 'src', 'core', 'config.ts'), 'utf8')
    const match = /^\s*path:\s*'([^']*)'/m.exec(source)
    return match ? match[1] : FALLBACK_RELAY_PATH
  } catch {
    return FALLBACK_RELAY_PATH
  }
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

// ------------------------------------------- the project `serve` writes --

/**
 * The Node host's package.json.
 *
 * `ws` is the one dependency and it is a real one: the relay's server speaks
 * WebSockets and does not implement the framing itself. Everything else is the
 * TypeScript needed to turn the copied `src/` into the `dist/` that `start`
 * runs, which is why they are devDependencies — a person who only ever runs
 * `npm start` after one build needs none of them again.
 */
export function generatedServePackageJson() {
  return `${JSON.stringify(
    {
      name: 'teamree-relay-server',
      version: '0.1.0',
      private: true,
      description: 'A teamree relay, run as a Node server on a machine you own',
      type: 'module',
      scripts: { build: 'tsc -p tsconfig.json', start: 'node dist/node/index.js' },
      dependencies: { ws: '^8.18.0' },
      devDependencies: { '@types/node': '^24.0.0', '@types/ws': '^8.5.0', typescript: '^5.7.0' }
    },
    null,
    2
  )}\n`
}

/**
 * The Node host's tsconfig, which is the relay package's own with nothing
 * loosened.
 *
 * The copied sources were written and typechecked under exactly these options —
 * `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` in particular
 * change what compiles rather than only what is reported — so a project that
 * relaxed any of them would be compiling different code from the one this
 * repository tests. The `exclude` of the Worker's entry point is gone because
 * `serve` never copies it.
 */
export function generatedServeTsconfig() {
  return `${JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2023',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        lib: ['ES2023'],
        types: ['node'],
        strict: true,
        noUncheckedIndexedAccess: true,
        noImplicitOverride: true,
        exactOptionalPropertyTypes: true,
        isolatedModules: true,
        verbatimModuleSyntax: true,
        sourceMap: true,
        outDir: 'dist',
        rootDir: 'src',
        skipLibCheck: true
      },
      include: ['src/**/*.ts']
    },
    null,
    2
  )}\n`
}

export function generatedServeGitignore() {
  return 'dist/\nnode_modules/\n'
}

export function generatedServeReadme(relayPath) {
  return `# Your teamree relay, on your own machine

This directory is a Node server: the relay two teamree peers dial out to so they
can reach each other. It was written here by \`teamree-relay serve\`, and it is
yours — commit it, edit it, keep it.

## Run it again

    npm start

Run that from this directory. \`npm install && npm run build\` first, if you have
not built it here yet; \`teamree-relay serve\` does all three for you.

## Who can actually reach it

Everybody who can already reach *this machine*, and nobody else. Two laptops on
two different home networks cannot meet here: neither router will let the other
in. On one office network or one flat's wifi it is the whole answer, and beyond
that you need either a tunnel in front of this, or a relay somewhere both sides
can already reach — which is what \`teamree-relay deploy\` writes.

## The address your team needs

    ws://<this machine's address>:<port>${relayPath}

\`teamree-relay serve\` prints that line, with the addresses this machine
actually has on it. Behind a TLS-terminating tunnel it is \`wss://\` and the
tunnel's host instead. Either way it is the line that goes in
\`.teamree/relay\` in your project, and teamree refuses an \`https://\` URL
rather than guessing at the rest of it.

Check it from another machine before you trust it:

    teamree-relay check ws://<this machine's address>:<port>${relayPath}

## Changing it

Every limit is an environment variable, read at startup and listed with its
default in \`src/core/config.ts\`. \`RELAY_HOST\` and \`RELAY_PORT\` are the two
\`teamree-relay serve\` sets for you. A value the relay cannot parse stops it
starting rather than being quietly ignored.

\`src/\` is the relay itself, copied from the teamree repository. The
authoritative documentation — what the relay can and cannot see, how the
rendezvous is derived, what the operator learns — is \`relay/README.md\` there.
`
}

/** The generated files for the Node relay project, by project path. */
export function generatedServeProject(relayPath) {
  return {
    'package.json': generatedServePackageJson(),
    'tsconfig.json': generatedServeTsconfig(),
    '.gitignore': generatedServeGitignore(),
    'README.md': generatedServeReadme(relayPath)
  }
}

// ------------------------------------------------------- where it may write --

/** Whether a directory holds a relay project this command could deploy, or why it does not. */
export function projectFault(dir) {
  if (!existsSync(join(dir, 'wrangler.jsonc'))) return 'there is no wrangler.jsonc here'
  if (!existsSync(join(dir, 'src', 'workers', 'worker.ts'))) return 'there is no src/workers/worker.ts here'
  return null
}

/** Whether a directory holds a Node relay project this command could run, or why it does not. */
export function serveProjectFault(dir) {
  if (!existsSync(join(dir, 'package.json'))) return 'there is no package.json here'
  if (!existsSync(join(dir, 'src', 'node', 'index.ts'))) return 'there is no src/node/index.ts here'
  return null
}

/**
 * Whether a directory is empty enough to be written into, treating a previous
 * run's project as ours.
 *
 * Which kind of project counts as ours is the caller's to say, because `serve`
 * and `deploy` write two different ones and neither should be told that the
 * other's directory is somebody else's files in the way.
 */
export function occupiedBy(dir, fault = projectFault) {
  if (!existsSync(dir)) return null
  const entries = readdirSync(dir).filter((name) => name !== '.DS_Store')
  if (entries.length === 0) return null
  if (fault(dir) === null) return null
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
  const placed = placeInto(target, templatePlan(root))

  // Read back rather than read from the package, because the file that decides
  // is the one now sitting in the project — which on a second run is whatever
  // this person edited, not what shipped.
  const config = readFileSync(join(target, 'wrangler.jsonc'), 'utf8')
  placed.generate(generatedProject(config))

  return placed.result
}

/** The same, for the Node relay project: copied sources, then the four files written fresh beside them. */
export function writeServeProject(root, target) {
  const placed = placeInto(target, serveTemplatePlan(root))
  placed.generate(generatedServeProject(relayDefaultPath(root)))
  return placed.result
}

/** The copying half of both, so the never-overwrite rule is written once and cannot drift between them. */
function placeInto(target, plan) {
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
  for (const { from, to } of plan) place(to, (full) => copyFileSync(from, full))

  return {
    result: { written, kept },
    generate: (files) => {
      for (const [name, contents] of Object.entries(files)) place(name, (full) => writeFileSync(full, contents))
    }
  }
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

/** The same sentence for `serve`, naming the other project so two runs in one terminal are telling apart. */
export function describeServeWrite(where, written, kept) {
  if (written.length === 0)
    return `teamree-relay: the project in ${where} is already there, and is left exactly as it is`
  if (kept.length === 0) return `teamree-relay: wrote the relay server project into ${where} (${written.length} files)`
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
export function relayEndpointFrom(output, relayPath = FALLBACK_RELAY_PATH) {
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

// --------------------------------------------------------------- serving it --

/**
 * The sentence that has to be read before the relay starts, and the reason this
 * command is not simply the easy answer to "where does our relay live".
 *
 * A relay on your laptop is reachable by whoever can already reach your laptop.
 * On one office network that is the whole team; across two home internet
 * connections it is nobody, and the failure looks exactly like a relay that is
 * broken rather than one that is doing what it was asked. Said before the
 * addresses rather than after, because after is where somebody has already
 * copied the URL.
 */
export const SERVE_LIMITATION =
  'teamree-relay: this relay runs on this machine. Only machines that can already reach this one will meet on ' +
  'it — two laptops on two different home networks cannot. Put a tunnel in front of it, or run ' +
  ' teamree-relay deploy  instead.'

/**
 * What being reachable actually costs, said once, next to the addresses.
 *
 * A relay authenticates nobody, and somebody about to publish one of these URLs
 * is entitled to know what that does and does not mean before they do. It is
 * three facts and they are not interchangeable: anyone who can reach the address
 * can open a connection, which is real and is a capacity cost; they cannot join
 * a pairing, because the rendezvous is derived from two members' keys; and they
 * cannot read anything, because the peers are end-to-end encrypted and the relay
 * splices ciphertext. `relay/README.md` says all three at length. This says them
 * to the one person who is about to hand the address out.
 */
export const SERVE_TRUST =
  'teamree-relay: it authenticates nobody. Anyone who can reach that address can open a connection and use up ' +
  'its capacity — but not join your pairing, and not read a byte of what crosses it.'

/**
 * Every address this machine has that somebody else could dial.
 *
 * IPv4 and not internal: the loopback addresses are printed separately and
 * under their own label, and an IPv6 link-local address in a "give this to your
 * team" line is a URL nobody will successfully paste. Takes the interfaces as
 * an argument so a test can hand it a machine that has no network at all, which
 * is the case worth getting right and the hardest one to arrange for real.
 */
export function lanAddresses(interfaces = networkInterfaces()) {
  const found = []
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue
      if (entry.family !== 'IPv4') continue
      found.push(entry.address)
    }
  }
  return found
}

/**
 * The block printed immediately before the relay starts listening.
 *
 * Two things about it are load-bearing rather than cosmetic. The limitation is
 * first, because it is the thing somebody has to know before they act on any of
 * the addresses below it. And the team's URL is last — the app's setup panel
 * reads the final ws:// or wss:// URL out of this pane's scrollback and offers
 * it as the one to write into the project, so anything printed after it that
 * happens to contain a URL would be the one offered instead. Nothing goes
 * between this and the relay's own first log line, and the two sentences about
 * what this relay is come before the addresses rather than after them, because
 * after is where somebody has already copied one.
 *
 * When there is more than one network address, all of them are named and the
 * first is the one offered. That is a guess: this cannot tell a wifi address
 * from a VPN's or a container bridge's, and the order the OS lists them in is
 * not a ranking. It is still better than no guess — every address is printed
 * above, so somebody who knows their own network can take a different one, and
 * somebody who does not now has something to try rather than a list to choose
 * from with no basis.
 */
export function serveAnnouncement({ port, path, addresses }) {
  const lines = [SERVE_LIMITATION, SERVE_TRUST]
  const loopback = `ws://127.0.0.1:${port}${path}`
  lines.push(`teamree-relay: on this Mac        ${loopback}`)
  for (const address of addresses) lines.push(`teamree-relay: on this network    ws://${address}:${port}${path}`)
  const team = addresses[0] === undefined ? loopback : `ws://${addresses[0]}:${port}${path}`
  lines.push(`teamree-relay: the URL to give your team:  ${team}`)
  return lines
}

/** npm, spelled the way this platform can spawn it: on Windows it is a shim script and not an executable. */
export function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

/** Runs npm in the project, with its output going straight to the terminal — an install is worth watching. */
function runNpm(target, args) {
  return new Promise((done) => {
    const child = spawn(npmCommand(), args, { cwd: target, stdio: 'inherit' })
    child.on('error', (error) => done({ code: 1, error }))
    child.on('close', (code) => done({ code: code ?? 1, error: null }))
  })
}

/**
 * Runs the built relay, and waits for it.
 *
 * `process.execPath` rather than `node`: this script is already running under a
 * Node that was found once, by the shell wrapper or by whoever typed `node`, and
 * looking it up a second time is a second chance to find a different one.
 *
 * Signals are deliberately not forwarded. The child is in this process's group,
 * so a Ctrl-C in the terminal reaches it directly and it shuts its sessions down
 * politely; sending it one as well would arrive as a *second* signal, which the
 * relay reads as an operator out of patience and answers by exiting 1
 * mid-shutdown. What this does instead is decline to die first, so the prompt
 * comes back after the relay has actually finished closing rather than before.
 * The cost is a `kill` aimed at this PID alone, which the child never hears —
 * a trade taken because nothing types that and every terminal sends the other.
 */
function runRelay(target, env) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [join('dist', 'node', 'index.js')], {
      cwd: target,
      env: { ...process.env, ...env },
      stdio: 'inherit'
    })
    const ignore = () => {}
    process.on('SIGINT', ignore)
    process.on('SIGTERM', ignore)
    child.on('error', (error) => done({ code: 1, error }))
    child.on('close', (code) => done({ code: code ?? 1, error: null }))
  })
}

// --------------------------------------------------------------- checking it --

/**
 * Why this URL cannot be dialled at all, or null.
 *
 * The same grammar the app applies to what somebody types into the relay field,
 * said the same way on purpose: a person who is refused here and then refused
 * again in the window should be reading one sentence, not two that disagree
 * about what is wrong. The app's copy is `src/shared/relayUrl.ts`; this one
 * cannot import it, because this file is plain JavaScript that ships with no
 * build step.
 */
export function checkTargetFault(url, relayPath = FALLBACK_RELAY_PATH) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    return `${url} is not a URL — a relay is dialled at  teamree-relay check wss://your-relay.example${relayPath}`
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    const scheme = parsed.protocol.replace(':', '')
    // http and https have an obvious WebSocket spelling and everything else does
    // not, so only those two are offered a corrected URL rather than a shape.
    const websocket =
      parsed.protocol === 'http:' || parsed.protocol === 'https:'
        ? `${
            parsed.protocol === 'https:' ? 'wss' : 'ws'
          }://${parsed.host}${parsed.pathname.replace(/\/+$/, '') || relayPath}`
        : `wss://your-relay.example${relayPath}`
    return `the scheme is "${scheme}", not ws or wss — try  teamree-relay check ${websocket}`
  }
  if (parsed.pathname.replace(/\/+$/, '') === '') {
    return (
      `${url} has no path, and a relay is served under one — ` +
      `try  teamree-relay check ws${parsed.protocol === 'wss:' ? 's' : ''}://${parsed.host}${relayPath}`
    )
  }
  return null
}

/**
 * What happened, as the two sentences a person gets: what answered, and what to
 * do about it.
 *
 * Pure, and separate from the dialling, because every one of these sentences is
 * a claim about somebody's network that has to be right and none of them can be
 * exercised on demand — there is no reliable way to arrange a real 503 or a real
 * EHOSTUNREACH in a test suite. So the classification is tested directly against
 * the wording, and the socket work below only has to produce the right status or
 * errno.
 *
 * `outcome` is `{status}` for an HTTP answer and `{code}` for a connection that
 * never got one.
 */
export function describeCheck(url, outcome, relayPath = FALLBACK_RELAY_PATH) {
  if (outcome.status === 101) {
    return {
      ok: true,
      headline: `teamree-relay: ${url} answered the WebSocket upgrade. A relay is listening there.`,
      // The honest limit of what was just proved. A relay that answers from
      // this machine and is unreachable from a teammate's is the single most
      // likely way this command misleads somebody, and it is exactly the case
      // `serve` produces, so the pass says so rather than leaving it implied.
      advice:
        'teamree-relay: that proves a WebSocket endpoint answered at that address from this machine. ' +
        'It does not prove a teammate on another network can reach it — run this there too.'
    }
  }
  if (outcome.status !== undefined) {
    const headline = `teamree-relay: ${url} answered HTTP ${outcome.status}, which is not an upgrade.`
    if (outcome.status === 404) {
      return {
        ok: false,
        headline,
        advice:
          `teamree-relay: something is listening, but it serves no relay at that path — ` +
          `the relay's own default path is ${relayPath}.`
      }
    }
    if (outcome.status === 401 || outcome.status === 403) {
      return {
        ok: false,
        headline,
        advice: 'teamree-relay: something in front of the relay is refusing the connection before the relay sees it.'
      }
    }
    if (outcome.status === 429 || outcome.status === 503) {
      return {
        ok: false,
        headline,
        advice: 'teamree-relay: a relay that is at capacity or shutting down answers this, so try it again.'
      }
    }
    return {
      ok: false,
      headline,
      advice: 'teamree-relay: whatever is listening there is not a relay, or something in front of it answered first.'
    }
  }

  const headline = `teamree-relay: nothing answered at ${url} (${outcome.code}).`
  if (outcome.code === 'ECONNREFUSED') {
    return { ok: false, headline, advice: 'teamree-relay: nothing is listening on that port on that host.' }
  }
  if (outcome.code === 'ENOTFOUND') {
    return { ok: false, headline, advice: 'teamree-relay: that host name does not resolve from this machine.' }
  }
  if (outcome.code === 'ETIMEDOUT' || outcome.code === 'EHOSTUNREACH') {
    return {
      ok: false,
      headline,
      advice:
        'teamree-relay: the name resolves but nothing answered, which is what a firewall or the wrong network looks like.'
    }
  }
  return { ok: false, headline, advice: 'teamree-relay: the connection failed before any relay could answer.' }
}

/**
 * Dials the URL and performs the WebSocket opening handshake by hand.
 *
 * By hand, and with `node:http`, because the alternative is a dependency. This
 * command ships inside the app and runs from a .dmg with nothing installed, so
 * `ws` would have to be either vendored into the bundle or fetched at the moment
 * somebody is already trying to work out why their relay is unreachable. The
 * handshake itself is a GET with four headers and a 101 to look for.
 *
 * The socket is destroyed the instant there is an answer. The relay would close
 * a peer that says nothing on its own hello timeout, so leaving it open costs
 * nothing permanent — but it does hold one of that address's connection slots
 * for ten seconds, and a person debugging reachability runs this more than once.
 */
export function checkRelay(url, { timeoutMs = CHECK_TIMEOUT_MS } = {}) {
  const parsed = new URL(url)
  const secure = parsed.protocol === 'wss:'
  const request = (secure ? httpsRequest : httpRequest)({
    protocol: secure ? 'https:' : 'http:',
    host: parsed.hostname,
    port: parsed.port === '' ? (secure ? 443 : 80) : Number(parsed.port),
    path: `${parsed.pathname}${parsed.search}`,
    headers: {
      Host: parsed.host,
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      // Random per dial, as the protocol asks. Nothing here verifies the accept
      // value that comes back: a 101 from something that got the digest wrong is
      // still a server that answered, and this command reports what answered.
      'Sec-WebSocket-Key': randomBytes(16).toString('base64')
    }
  })

  return new Promise((done) => {
    let settled = false
    const finish = (outcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      request.destroy()
      done(outcome)
    }
    const timer = setTimeout(() => finish({ code: 'ETIMEDOUT' }), timeoutMs)

    request.on('upgrade', (_response, socket) => {
      socket.destroy()
      finish({ status: 101 })
    })
    request.on('response', (response) => {
      response.destroy()
      finish({ status: response.statusCode ?? 0 })
    })
    request.on('error', (error) => finish({ code: error.code ?? error.message }))
    request.end()
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

/** Writes the Node relay project where somebody owns it, installs it, builds it, and runs it until it is stopped. */
async function serve(options, { cwd, root }) {
  let target
  if (options.here) {
    target = cwd
    const fault = serveProjectFault(target)
    if (fault !== null) {
      fail(
        `${fault}, so there is no relay in ${tilde(target)} to run — ` +
          `run  teamree-relay serve  with no --here to write one into ~/${SERVE_DEFAULT_DIR} first.`
      )
    }
  } else {
    target = resolve(cwd, options.dir ?? join(homedir(), SERVE_DEFAULT_DIR))
    const missing = missingServeTemplatePaths(root)
    if (missing.length > 0) {
      fail(`this copy of the relay is incomplete — ${missing.join(', ')} is not in ${root}.`)
    }
    const occupied = occupiedBy(target, serveProjectFault)
    if (occupied !== null) {
      fail(
        `${tilde(target)} already holds something else (${occupied}), and this will not write over it — ` +
          `name an empty directory instead:  teamree-relay serve ~/some-other-relay`
      )
    }
    const { written, kept } = writeServeProject(root, target)
    console.log(describeServeWrite(tilde(target), written, kept))
  }

  const port = options.port ?? SERVE_DEFAULT_PORT
  const host = options.host ?? SERVE_DEFAULT_HOST
  // Read out of the project about to be run rather than out of the package that
  // wrote it, because with --here they are not the same file, and the one that
  // decides where the relay serves is the one that is going to be compiled.
  // RELAY_PATH wins over both: it is what the relay itself reads at startup.
  const path = process.env.RELAY_PATH ?? relayDefaultPath(target)

  if (options.writeOnly) {
    console.log(
      `teamree-relay: stopping there, as --write-only asks. ` +
        `Build and run it with:  cd ${tilde(target)} && npm install && npm run build && npm start`
    )
    return
  }

  if (existsSync(join(target, 'node_modules'))) {
    console.log(`teamree-relay: node_modules is already in ${tilde(target)}, so nothing is being installed`)
  } else {
    console.log('teamree-relay: installing the one dependency it has, ws — this needs the network, once')
    const installed = await runNpm(target, ['install'])
    if (installed.error !== null) {
      fail(
        `could not run ${npmCommand()} (${installed.error.message}). ` +
          'npm comes with Node: install Node 20 or newer from https://nodejs.org and run this again.'
      )
    }
    if (installed.code !== 0) {
      fail(`npm install exited ${installed.code}. The project is at ${tilde(target)}; nothing here has been lost.`)
    }
  }

  console.log('teamree-relay: building it')
  const built = await runNpm(target, ['run', 'build'])
  if (built.error !== null) fail(`could not run ${npmCommand()} (${built.error.message}).`)
  if (built.code !== 0) {
    fail(`the build exited ${built.code}. The project is at ${tilde(target)}; nothing here has been lost.`)
  }

  console.log('')
  for (const line of serveAnnouncement({ port, path, addresses: lanAddresses() })) console.log(line)
  console.log('')

  const { code, error } = await runRelay(target, { RELAY_HOST: host, RELAY_PORT: String(port) })
  if (error !== null) {
    fail(`could not start the relay (${error.message}). The project is at ${tilde(target)}.`)
  }
  if (code !== 0) {
    // Not `fail`: the relay distinguishes a bad configuration (2) from a failed
    // start (1), and flattening that to 1 here would throw away the one thing
    // the exit code was carrying.
    console.error(`teamree-relay: the relay exited ${code}. Its own last log line above says why.`)
    process.exit(code)
  }
}

/** Dials a relay URL and says what answered, which is the only way to know before two people try to work. */
async function check(options, { root }) {
  const relayPath = relayDefaultPath(root)
  const url = options.url
  const fault = checkTargetFault(url, relayPath)
  if (fault !== null) fail(fault)

  console.log(`teamree-relay: dialling ${url}`)
  const outcome = await checkRelay(url)
  const { ok, headline, advice } = describeCheck(url, outcome, relayPath)
  console.log(headline)
  console.log(advice)
  if (!ok) process.exit(1)
}

export async function main(argv, { cwd = process.cwd(), root = templateRoot() } = {}) {
  const options = parseArgs(argv)
  if (options.error !== null) fail(options.error)
  if (options.help || options.command === '') {
    console.log(USAGE)
    return
  }
  if (options.command === 'serve') return await serve(options, { cwd, root })
  if (options.command === 'check') return await check(options, { root })
  if (options.command !== 'deploy') {
    fail(
      `there is no "${options.command}" command; the commands are:  ` +
        'teamree-relay deploy, teamree-relay serve, teamree-relay check'
    )
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
