/** One thing the runtime lets go of on the way out, named for the report when it will not. */
export type Release = { name: string; release: () => void | Promise<void> }

/**
 * Runs each release after the last. One that throws, or is still going after
 * `graceMs`, is reported and left behind: the next still runs.
 */
export async function releaseInTurn(
  releases: readonly Release[],
  options: { graceMs: number; onProblem: (error: unknown) => void }
): Promise<void> {
  for (const { name, release } of releases) {
    let expiry: ReturnType<typeof setTimeout> | undefined
    try {
      const overdue = new Promise<'overdue'>((resolve) => {
        expiry = setTimeout(() => resolve('overdue'), options.graceMs)
      })
      const outcome = await Promise.race([Promise.resolve().then(release), overdue])
      if (outcome === 'overdue') {
        options.onProblem(new Error(`${name} was still letting go after ${options.graceMs}ms; quitting without it`))
      }
    } catch (error) {
      options.onProblem(error)
    } finally {
      clearTimeout(expiry)
    }
  }
}
