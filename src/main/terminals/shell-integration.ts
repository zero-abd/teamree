// Startup files that run the user's own and then put this build's CLI first on
// PATH, so a login shell that rebuilds PATH (path_helper, a profile) still finds it.
// zsh through ZDOTDIR, handed back once startup ends; bash through --init-file and BASH_ENV.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { shellName, type ShellCommand } from './shell-environment'

/** The user's own ZDOTDIR while ours stands in; absent when theirs is unset. */
export const USER_ZDOTDIR_ENV = 'TEAMREE_USER_ZDOTDIR'
export const USER_BASH_ENV_ENV = 'TEAMREE_USER_BASH_ENV'

/** Each file, and when it is the last one this shell reads: there ZDOTDIR goes back to the user's. */
const ZSH_FILES = {
  '.zshenv': '[[ ! -o rcs ]] || [[ ! -o login && ! -o interactive ]]',
  '.zprofile': 'false',
  '.zshrc': '[[ ! -o login ]]',
  '.zlogin': 'true'
} as const

const ZSH_PREPEND = '[[ -n $TEAMREE_CLI ]] && path=("${TEAMREE_CLI:h}" "${(@)path:#${TEAMREE_CLI:h}}")'

// Top level, not a function: a user's `typeset` inside a sourced file would otherwise turn local.
// Set and unset are kept apart: an unset ZDOTDIR means $HOME, and tools test which it is.
function zshFile(name: keyof typeof ZSH_FILES): string {
  // macOS's /etc/zshrc points HISTFILE at ${ZDOTDIR:-$HOME}, which is ours by then.
  const history =
    name === '.zshrc'
      ? '[[ $HISTFILE == $__teamree_zdotdir/.zsh_history ]] && HISTFILE=${TEAMREE_USER_ZDOTDIR:-$HOME}/.zsh_history\n'
      : ''
  return `# teamree: the user's own ${name}, then this build's CLI first on PATH.
__teamree_zdotdir=$ZDOTDIR
${history}if (( \${+TEAMREE_USER_ZDOTDIR} )); then ZDOTDIR=$TEAMREE_USER_ZDOTDIR; else unset ZDOTDIR; fi
if [[ \${ZDOTDIR:-$HOME} != $__teamree_zdotdir && -r \${ZDOTDIR:-$HOME}/${name} ]]; then
  source "\${ZDOTDIR:-$HOME}/${name}"
fi
if (( \${+ZDOTDIR} )); then export TEAMREE_USER_ZDOTDIR=$ZDOTDIR; else unset TEAMREE_USER_ZDOTDIR; fi
${ZSH_PREPEND}
if ${ZSH_FILES[name]}; then
  if (( \${+TEAMREE_USER_ZDOTDIR} )); then export ZDOTDIR=$TEAMREE_USER_ZDOTDIR; else unset ZDOTDIR; fi
  unset TEAMREE_USER_ZDOTDIR
else
  export ZDOTDIR=$__teamree_zdotdir
fi
unset __teamree_zdotdir
`
}

const BASH_PREPEND = `if [ -n "$TEAMREE_CLI" ]; then
  __teamree_dir=\${TEAMREE_CLI%/*}
  __teamree_path=:$PATH:
  while [[ $__teamree_path == *":$__teamree_dir:"* ]]; do __teamree_path=\${__teamree_path/":$__teamree_dir:"/:}; done
  __teamree_path=\${__teamree_path#:}
  __teamree_path=\${__teamree_path%:}
  export PATH=$__teamree_dir\${__teamree_path:+:$__teamree_path}
  unset __teamree_dir __teamree_path
fi
`

// --init-file makes an interactive non-login shell, so the login files are read here instead.
const BASH_INIT = `# teamree: a login shell's startup files, then this build's CLI first on PATH.
if [ -r /etc/profile ]; then . /etc/profile; fi
for __teamree_profile in ~/.bash_profile ~/.bash_login ~/.profile; do
  if [ -r "$__teamree_profile" ]; then . "$__teamree_profile"; break; fi
done
unset __teamree_profile
${BASH_PREPEND}`

const BASH_ENV_FILE = `# teamree: the user's own BASH_ENV, then this build's CLI first on PATH.
if [ -n "$TEAMREE_USER_BASH_ENV" ] && [ -r "$TEAMREE_USER_BASH_ENV" ]; then . "$TEAMREE_USER_BASH_ENV"; fi
${BASH_PREPEND}`

function files(dir: string): Array<[string, string]> {
  return [
    ...Object.keys(ZSH_FILES).map((name): [string, string] => [
      join(dir, 'zsh', name),
      zshFile(name as keyof typeof ZSH_FILES)
    ]),
    [join(dir, 'bash', 'init.bash'), BASH_INIT],
    [join(dir, 'bash', 'env.bash'), BASH_ENV_FILE]
  ]
}

/** Writes the startup files under `dir`, leaving current ones alone; false when they could not be written. */
export function writeShellIntegration(dir: string): boolean {
  try {
    for (const [path, text] of files(dir)) {
      if (readOrNothing(path) === text) continue
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, text, 'utf8')
    }
    return true
  } catch {
    return false
  }
}

function readOrNothing(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

/** The pane's argv and environment with the startup files of `dir` standing in for the user's. */
export function integrateShell(
  command: ShellCommand,
  env: Record<string, string>,
  dir: string,
  platform: NodeJS.Platform = process.platform
): ShellCommand & { env: Record<string, string> } {
  if (platform === 'win32') return { ...command, env }
  const next = { ...env }
  delete next[USER_ZDOTDIR_ENV]
  if (env.ZDOTDIR !== undefined) next[USER_ZDOTDIR_ENV] = env.ZDOTDIR
  next.ZDOTDIR = join(dir, 'zsh')
  next[USER_BASH_ENV_ENV] = env[USER_BASH_ENV_ENV] ?? env.BASH_ENV ?? ''
  next.BASH_ENV = join(dir, 'bash', 'env.bash')

  const interactiveBash =
    shellName(command.file, platform) === 'bash' &&
    Array.isArray(command.args) &&
    command.args.length === 1 &&
    command.args[0] === '-l'
  const args = interactiveBash ? ['--init-file', join(dir, 'bash', 'init.bash')] : command.args
  return { file: command.file, args, env: next }
}
