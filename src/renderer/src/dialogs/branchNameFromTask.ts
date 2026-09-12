// The branch preview shown while typing a task name. The runtime decides the
// real name; this only has to match the shape closely enough to be useful.

export const BRANCH_PREFIX = 'task/'

export function branchNameFromTask(task: string): string {
  const slug = task
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '')
  return `${BRANCH_PREFIX}${slug || 'untitled'}`
}
