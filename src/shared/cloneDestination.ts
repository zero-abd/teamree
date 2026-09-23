/** Where `project.clone` puts a repository when no destination is named, before the repo's name. */
export const DEFAULT_CLONE_PARENT = '~/code'

/** The folder name `git clone` would pick for this URL: the last segment, `.git` dropped. */
export function repositoryNameFromUrl(url: string): string {
  const trimmed = url.trim().replace(/[/\\]+$/, '')
  const last = trimmed.split(/[/\\:]/).pop() ?? ''
  return last.replace(/\.git$/i, '')
}
