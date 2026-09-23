import { resolve } from 'node:path'

/** What a launch tells the instance already holding the single-instance lock. */
export type LaunchData = { background: boolean }

/** The profile TEAMREE_USER_DATA_DIR names, made absolute; undefined keeps Electron's default. */
export function userDataOverride(env: NodeJS.ProcessEnv, cwd: string): string | undefined {
  const dir = env['TEAMREE_USER_DATA_DIR']
  return dir ? resolve(cwd, dir) : undefined
}

/** A background launch never shows or fronts a window. */
export function isBackgroundLaunch(env: NodeJS.ProcessEnv): boolean {
  return env['TEAMREE_BACKGROUND_LAUNCH'] === '1'
}

export function launchData(env: NodeJS.ProcessEnv): LaunchData {
  return { background: isBackgroundLaunch(env) }
}

/** Whether a second launch should restore and focus this instance's window. */
export function frontsExistingWindow(env: NodeJS.ProcessEnv, knocking: unknown): boolean {
  if (isBackgroundLaunch(env)) return false
  return !(typeof knocking === 'object' && knocking !== null && (knocking as Partial<LaunchData>).background === true)
}
