/** What a teamree pane exports to its shell, plus TEAMREE_RUNTIME_FILE: each points a CLI at a running app. */
export const PANE_ENV = [
  'TEAMREE_TERMINAL_ID',
  'TEAMREE_WORKTREE_ID',
  'TEAMREE_PROJECT_ID',
  'TEAMREE_ENDPOINT',
  'TEAMREE_CLI',
  'TEAMREE_USER_ZDOTDIR',
  'TEAMREE_USER_BASH_ENV',
  'TEAMREE_RUNTIME_FILE'
]

/** Strips `env` in place of NODE_USE_SYSTEM_CA (a keychain read per node child) and of the pane it runs in. */
export function isolate(env) {
  delete env.NODE_USE_SYSTEM_CA
  // A pane's BASH_ENV is ours; the user's own waits in TEAMREE_USER_BASH_ENV.
  if (env.TEAMREE_USER_BASH_ENV !== undefined) {
    if (env.TEAMREE_USER_BASH_ENV) env.BASH_ENV = env.TEAMREE_USER_BASH_ENV
    else delete env.BASH_ENV
  }
  for (const name of PANE_ENV) delete env[name]
  return env
}

/** A copy of `env` for a gate or test child, so it can reach no app but the one it starts. */
export function childEnv(env) {
  return isolate({ ...env })
}
