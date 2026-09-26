// Renderer code the smoke runs through `executeJavaScript`, kept apart from Electron so a test can run it.

/** Presses the sidebar row named `name`; false while the row says it cannot open. */
export function pressWorktreeRow(name) {
  return `(() => {
    const row = [...document.querySelectorAll('.worktree__open')].find(
      (node) => node.textContent?.includes(${JSON.stringify(name)})
    )
    // A row still being created says so with aria-disabled and swallows the click.
    if (!row || row.getAttribute('aria-disabled') === 'true') return false
    row.click()
    return true
  })()`
}

/** Whether the sidebar marks the row named `name` as the open worktree. */
export function worktreeRowIsOpen(name) {
  return `[...document.querySelectorAll('.worktree__open[aria-current="true"]')].some(
    (node) => node.textContent?.includes(${JSON.stringify(name)})
  )`
}
