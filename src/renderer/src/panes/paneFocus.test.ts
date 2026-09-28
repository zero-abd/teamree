/** @vitest-environment jsdom */

import { afterEach, expect, it, vi } from 'vitest'
import { focusWhenFree } from './paneFocus'

const turn = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function add(html: string): HTMLElement {
  const holder = document.createElement('div')
  holder.innerHTML = html
  const node = holder.firstElementChild as HTMLElement
  document.body.appendChild(node)
  return node
}

afterEach(() => {
  ;(document.activeElement as HTMLElement | null)?.blur()
  document.body.innerHTML = ''
})

it('takes the keyboard at once when nothing else holds it', () => {
  const take = vi.fn()
  focusWhenFree(take)
  expect(take).toHaveBeenCalledTimes(1)
})

it('takes it from another pane', () => {
  add('<div class="pane"><textarea aria-label="Terminal input"></textarea></div>').querySelector('textarea')!.focus()
  const take = vi.fn()
  focusWhenFree(take)
  expect(take).toHaveBeenCalledTimes(1)
})

it('waits while a dialog is open, and takes it once the dialog goes', async () => {
  const dialog = add('<div role="dialog" aria-modal="true"><textarea></textarea></div>')
  dialog.querySelector('textarea')!.focus()
  const take = vi.fn()
  focusWhenFree(take)
  await turn()
  expect(take).not.toHaveBeenCalled()
  dialog.remove()
  await turn()
  await turn()
  expect(take).toHaveBeenCalledTimes(1)
})

it('waits on a modal dialog even when a click left the focus on nothing', async () => {
  add('<div role="dialog" aria-modal="true"><p>New Task</p></div>')
  const take = vi.fn()
  focusWhenFree(take)
  await turn()
  expect(take).not.toHaveBeenCalled()
})

it('waits while a menu holds the focus', async () => {
  const menu = add('<div role="menu"><button role="menuitem">Copy</button></div>')
  menu.querySelector('button')!.focus()
  const take = vi.fn()
  focusWhenFree(take)
  await turn()
  expect(take).not.toHaveBeenCalled()
  menu.remove()
  await turn()
  await turn()
  expect(take).toHaveBeenCalledTimes(1)
})

it('never takes it from a text field outside the panes', async () => {
  const field = add('<input type="search" aria-label="Filter worktrees" />') as HTMLInputElement
  field.focus()
  const take = vi.fn()
  focusWhenFree(take)
  field.blur()
  await turn()
  expect(take).not.toHaveBeenCalled()
})

it('gives up when the closing dialog hands the focus back to a text field', async () => {
  const field = add('<input type="text" />') as HTMLInputElement
  const dialog = add('<div role="dialog" aria-modal="true"><button>Start Task</button></div>')
  dialog.querySelector('button')!.focus()
  const take = vi.fn()
  focusWhenFree(take)
  dialog.remove()
  field.focus()
  await turn()
  await turn()
  expect(take).not.toHaveBeenCalled()
})

it('does nothing after it is cancelled', async () => {
  const dialog = add('<div role="dialog" aria-modal="true"><textarea></textarea></div>')
  const take = vi.fn()
  const cancel = focusWhenFree(take)
  cancel()
  dialog.remove()
  await turn()
  await turn()
  expect(take).not.toHaveBeenCalled()
})
