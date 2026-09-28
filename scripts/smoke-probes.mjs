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

/** The narrowest sidebar and the default one, as `src/renderer/src/shell/sidebarWidth.ts` has them. */
export const SIDEBAR_WIDTHS_CHECKED = [208, 272]

const LONG_PROJECT_NAME = 'abd-intern-apps-teamree'
const LONG_BASE_REF = 'from origin/release/2026-q4-intern-apps-integration'

/** A long name and base ref on the first project's head and, with `team`, a cue and faces drawn as `TeamFaces` draws them. */
export function stageProjectHead(team) {
  return `(() => {
    const head = document.querySelector('.project__head')
    if (!head) return false
    const face = (initials, hue) =>
      '<button type="button" class="project__face" data-staged tabindex="-1"><span class="avatar avatar--sm avatar--online" style="--avatar-hue:' +
      hue + '" aria-hidden="true">' + initials + '<span class="avatar__presence"></span></span></button>'
    const name = head.querySelector('.project__name')
    const base = head.querySelector('.project__base')
    name.dataset.was ??= name.textContent
    base.dataset.was ??= base.textContent
    name.textContent = ${JSON.stringify(LONG_PROJECT_NAME)}
    base.textContent = ${JSON.stringify(LONG_BASE_REF)}
    head.querySelectorAll('[data-staged]').forEach((node) => node.remove())
    if (${JSON.stringify(team)}) {
      head.querySelector('.project__team').insertAdjacentHTML(
        'beforeend',
        '<span class="project__cues" data-staged><button type="button" class="project__cue project__cue--asking" tabindex="-1"><span class="project__cue-text">asking</span></button></span>' +
          '<span class="project__faces" data-staged>' + face('Pr', 270) + face('Jo', 205) + face('Mi', 330) + '</span>'
      )
    }
    return true
  })()`
}

/** Undoes `stageProjectHead`. */
export function restoreProjectHead() {
  return `(() => {
    const head = document.querySelector('.project__head')
    if (!head) return
    head.querySelectorAll('[data-staged]').forEach((node) => node.remove())
    for (const node of head.querySelectorAll('[data-was]')) {
      node.textContent = node.dataset.was
      delete node.dataset.was
    }
  })()`
}

/** Sets the sidebar to `px` at once and says whether it took. */
export function setSidebarWidth(px) {
  return `(() => {
    const shell = document.querySelector('.shell')
    if (!shell) return false
    shell.style.transition = 'none'
    shell.style.setProperty('--sidebar-width', '${px}px')
    return Math.round(document.querySelector('.sidebar').getBoundingClientRect().width) === ${px}
  })()`
}

/**
 * What in each project head is drawn over something else or past its edge, as sentences; `[]` when
 * nothing is. Measured where the eye sees it: each box cut by the ancestors that clip it.
 */
export function projectHeadCollisions() {
  return `(() => {
    const seen = (node, head) => {
      let box = node.getBoundingClientRect()
      box = { left: box.left, right: box.right, top: box.top, bottom: box.bottom }
      for (let up = node.parentElement; up && up !== head.parentElement; up = up.parentElement) {
        if (getComputedStyle(up).overflowX === 'visible' && getComputedStyle(up).overflowY === 'visible') continue
        const clip = up.getBoundingClientRect()
        box = {
          left: Math.max(box.left, clip.left),
          right: Math.min(box.right, clip.right),
          top: Math.max(box.top, clip.top),
          bottom: Math.min(box.bottom, clip.bottom)
        }
      }
      if (getComputedStyle(node).opacity === '0' && !node.matches('.project__more')) return null
      return box.right - box.left > 0.5 && box.bottom - box.top > 0.5 ? box : null
    }
    const meets = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5
    const found = []
    for (const head of document.querySelectorAll('.project__head')) {
      const edge = head.getBoundingClientRect()
      const name = head.querySelector('.project__name')
      const words = [...head.querySelectorAll('.project__name, .project__base, .project__fresh, .project__unpushed')]
      const actions = [
        ...head.querySelectorAll('.project__cue, .project__face, .project__teamwork'),
        ...[...head.querySelectorAll('button')].filter((button) => button.matches('.button--icon'))
      ]
      const said = (node) => (node.getAttribute('aria-label') ?? node.textContent).trim()
      for (const button of head.querySelectorAll('.button--icon')) {
        const width = button.getBoundingClientRect().width
        if (width < 21.5) found.push(said(button) + ' is squeezed to ' + Math.round(width) + 'px')
      }
      for (const word of words) {
        const box = seen(word, head)
        if (!box) continue
        for (const action of actions) {
          const other = seen(action, head)
          if (other && meets(box, other)) found.push('"' + word.textContent + '" is under ' + said(action))
        }
      }
      for (const node of [...words, ...actions]) {
        const box = seen(node, head)
        if (box && box.right > edge.right + 0.5) found.push(said(node) + ' runs past the head')
      }
      const base = head.querySelector('.project__base')
      if (base && seen(base, head) && name.scrollWidth > name.clientWidth) {
        found.push('"' + name.textContent + '" is cut while the base ref shows')
      }
      if (!seen(name, head)) found.push('the name "' + name.textContent + '" is not on screen')
    }
    return JSON.stringify(found)
  })()`
}

/** The widths Settings is measured at, all on the icon rail: from its widest down to a phone's. */
export const SETTINGS_WIDTHS_CHECKED = [900, 760, 560, 420]

/** Types `query` into Settings' search as a person would, so React sees it. */
export function typeSettingsQuery(query) {
  return `(() => {
    const input = document.querySelector('.settings-search__input')
    if (!input) return false
    input.focus()
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(query)})
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return input.value === ${JSON.stringify(query)}
  })()`
}

/** What Settings' search is drawn over, squeezed to or pushed past, as sentences; `[]` when nothing is. */
export function settingsSearchCollisions() {
  return `(() => {
    const search = document.querySelector('.settings-search')
    const page = document.querySelector('.page--side')
    if (!search || !page) return JSON.stringify(['Settings is not on screen'])
    const box = search.getBoundingClientRect()
    const meets = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5
    const found = []
    const parts = page.querySelectorAll('.page__tile, .page__title, .page__lede, .page__trailing, .page__close, .settings-nav__item')
    for (const part of parts) {
      const other = part.getBoundingClientRect()
      if (other.width > 0.5 && other.height > 0.5 && meets(box, other)) {
        found.push('the search is over ' + (part.getAttribute('aria-label') ?? (part.textContent.trim() || part.className)))
      }
    }
    const input = search.querySelector('.settings-search__input')
    const open = input.value !== '' || document.activeElement === input
    const room = input.getBoundingClientRect().width
    if (open && room < 120) found.push('the search is squeezed to ' + Math.round(room) + 'px')
    if (box.right > page.getBoundingClientRect().right + 0.5) found.push('the search runs past the page')
    return JSON.stringify(found)
  })()`
}
