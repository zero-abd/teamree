/** @vitest-environment jsdom */

// Where F6 and the Focus items land, and where the focus goes when the sidebar or panel comes or goes.

import { beforeEach, describe, expect, it } from 'vitest'
import { focusRegion, regionAfter, regionAfterToggle, regionLanding, regionOf } from './regions'

function draw(html: string): void {
  document.body.innerHTML = html
}

const WINDOW = `
  <div data-region="sidebar">
    <button id="hide">Hide sidebar</button>
    <div role="tree">
      <button role="treeitem" id="p1" tabindex="-1">pager</button>
      <button role="treeitem" id="w1" tabindex="-1" aria-current="true">Rewrite</button>
      <button role="treeitem" id="w2" tabindex="0">Fix</button>
    </div>
  </div>
  <div data-region="panes">
    <div data-region="strip">
      <button role="tab" id="t1" aria-selected="false">zsh</button>
      <button role="tab" id="t2" aria-selected="true">claude</button>
    </div>
    <section class="pane"><button id="close1">×</button><textarea class="xterm-helper-textarea" id="x1"></textarea></section>
    <section class="pane pane--focused"><button id="close2">×</button><textarea class="xterm-helper-textarea" id="x2"></textarea></section>
    <aside data-region="panel">
      <button role="tab" id="files" aria-selected="true">Files</button>
      <button role="tab" id="changes" aria-selected="false">Changes</button>
    </aside>
  </div>
`

const id = (element: Element | null): string | undefined => element?.id

beforeEach(() => draw(WINDOW))

describe('the regions', () => {
  it('are read from the nearest marked ancestor', () => {
    expect(regionOf(document.getElementById('w1'))).toBe('sidebar')
    expect(regionOf(document.getElementById('t1'))).toBe('strip')
    expect(regionOf(document.getElementById('x2'))).toBe('panes')
    expect(regionOf(document.getElementById('changes'))).toBe('panel')
    expect(regionOf(document.body)).toBeNull()
  })

  it('land on the tree’s one stop, the shown tab, the focused pane’s input and the panel’s tab', () => {
    expect(id(regionLanding('sidebar'))).toBe('w2')
    expect(id(regionLanding('strip'))).toBe('t2')
    expect(id(regionLanding('panes'))).toBe('x2')
    expect(id(regionLanding('panel'))).toBe('files')
  })

  it('fall back to the open worktree, then to the first control', () => {
    document.getElementById('w2')?.setAttribute('tabindex', '-1')
    expect(id(regionLanding('sidebar'))).toBe('w1')
    draw('<div data-region="sidebar"><button id="search">Search</button><p>No projects yet</p></div>')
    expect(id(regionLanding('sidebar'))).toBe('search')
  })

  it('skip what is hidden', () => {
    draw(`<div data-region="panes">
      <div hidden><section class="pane pane--focused"><textarea class="xterm-helper-textarea" id="gone"></textarea></section></div>
      <button id="start">New terminal</button>
    </div>`)
    expect(id(regionLanding('panes'))).toBe('start')
  })

  it('focus the landing', () => {
    expect(focusRegion('panel')).toBe(true)
    expect(document.activeElement?.id).toBe('files')
  })
})

describe('F6', () => {
  it('walks sidebar, strip, panes, panel and round again', () => {
    expect(regionAfter('sidebar', 1)).toBe('strip')
    expect(regionAfter('strip', 1)).toBe('panes')
    expect(regionAfter('panes', 1)).toBe('panel')
    expect(regionAfter('panel', 1)).toBe('sidebar')
    expect(regionAfter('sidebar', -1)).toBe('panel')
    expect(regionAfter('panes', -1)).toBe('strip')
  })

  it('starts at either end from the page itself', () => {
    expect(regionAfter(null, 1)).toBe('sidebar')
    expect(regionAfter(null, -1)).toBe('panel')
  })

  it('passes over a region that is not drawn', () => {
    document.querySelector('[data-region="sidebar"]')?.remove()
    expect(regionAfter('panel', 1)).toBe('strip')
    expect(regionAfter('strip', -1)).toBe('panel')
  })
})

describe('putting a region away', () => {
  const both = { sidebarVisible: true, rightPanelOpen: true }

  it('moves into a region as it is shown', () => {
    expect(regionAfterToggle(both, { ...both, sidebarVisible: false }, 'panes')).toBe('sidebar')
    expect(regionAfterToggle(both, { ...both, rightPanelOpen: false }, 'panes')).toBe('panel')
  })

  it('hands the focus to the panes when the region leaving held it', () => {
    expect(regionAfterToggle({ ...both, sidebarVisible: false }, both, 'sidebar')).toBe('panes')
    expect(regionAfterToggle({ ...both, rightPanelOpen: false }, both, 'panel')).toBe('panes')
  })

  it('leaves it alone otherwise', () => {
    expect(regionAfterToggle({ ...both, sidebarVisible: false }, both, 'panes')).toBeNull()
    expect(regionAfterToggle({ ...both, rightPanelOpen: false }, both, 'sidebar')).toBeNull()
    expect(regionAfterToggle(both, both, 'sidebar')).toBeNull()
  })
})
