// The order the sidebar lays worktrees out in, as a list two things can read.
//
// The sidebar draws a section per project and the worktrees of that project
// underneath it, so what somebody sees is projects in order and, within each,
// their worktrees in order. That is not the order the store holds worktrees in
// — that is one flat list in whatever order the runtime answered with, with two
// projects' worktrees interleaved through it.
//
// Which matters as soon as a chord walks the list. "Next worktree" that stepped
// through the store's own array would move the highlight down the sidebar,
// then jump to another project, then back, for no reason a reader could see. So
// the grouping is computed once here, the sidebar renders from it, and the
// chord walks the same thing flattened. One function, so the chord and the list
// cannot disagree about what "next" means.
//
// Generic over the row types rather than importing `Project` and `Worktree`,
// because the availability predicate in `workspaceCommands.ts` reads a
// structural slice of the store — an id and a project id is all either of these
// needs, and asking for the whole entity would make that slice import the whole
// entity.

export type ProjectLike = { id: string }
export type WorktreeLike = { projectId: string }

/** Each project with its own worktrees, in the order the sidebar draws them. */
export function worktreesByProject<P extends ProjectLike, W extends WorktreeLike>(
  projects: readonly P[],
  worktrees: readonly W[]
): { project: P; rows: W[] }[] {
  return projects.map((project) => ({
    project,
    rows: worktrees.filter((worktree) => worktree.projectId === project.id)
  }))
}

/**
 * Every worktree on screen, top to bottom.
 *
 * A worktree whose project is not in the list is not in this either, and that
 * is the honest answer rather than an oversight: the sidebar has nowhere to
 * draw such a row, so a chord that walked onto it would open a worktree the
 * list does not show.
 */
export function worktreeOrder<P extends ProjectLike, W extends WorktreeLike>(
  projects: readonly P[],
  worktrees: readonly W[]
): W[] {
  return worktreesByProject(projects, worktrees).flatMap((group) => group.rows)
}

/**
 * The worktree `step` places along from `currentId`, wrapping at both ends.
 *
 * Wrapping because the chord is for cycling: five worktrees and a chord that
 * stops at the bottom is a chord you have to know the length of the list to
 * use. From nothing open, forwards lands on the first and backwards on the
 * last, which is what those two directions mean against a list you are not in
 * yet.
 */
export function worktreeAfter<W extends { id: string }>(
  order: readonly W[],
  currentId: string | null,
  step: 1 | -1
): W | undefined {
  if (order.length === 0) return undefined
  const index = order.findIndex((worktree) => worktree.id === currentId)
  if (index === -1) return step === 1 ? order[0] : order[order.length - 1]
  return order[(index + step + order.length) % order.length]
}
