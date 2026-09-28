/** @vitest-environment jsdom */

// Every shared primitive, rendered in each of its states, with the classes the stylesheets draw.

import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Button, IconButton, buttonClass } from './Button'
import { Badge, Chip } from './Chip'
import { Card, SectionHeader } from './Card'
import { EmptyState } from './EmptyState'
import { Input, Textarea } from './Input'
import { Kbd } from './Kbd'
import { ListRow } from './ListRow'
import { PageHeader } from './PageHeader'
import { Segmented } from './Segmented'
import { Select } from './Select'
import { StatusDot, StatusPill, type PaneState } from './StatusPill'
import { Stepper } from './Stepper'
import { Switch } from './Switch'
import { Tabs } from './Tabs'
import { Toast, type ToastTone } from './Toast'
import { TOOLTIP_DELAY_MS, Tooltip } from './Tooltip'

afterEach(() => {
  vi.useRealTimers()
})

describe('Button', () => {
  it.each([
    ['primary', 'sm', 'button button--primary button--small'],
    ['secondary', 'md', 'button button--secondary'],
    ['ghost', 'lg', 'button button--ghost button--lg'],
    ['danger', 'md', 'button button--danger']
  ] as const)('draws a %s %s button', (variant, size, classes) => {
    render(
      <Button variant={variant} size={size}>
        Go
      </Button>
    )
    expect(screen.getByRole('button', { name: 'Go' }).className).toBe(classes)
  })

  it('spins while loading, holds its label and takes no press', () => {
    const press = vi.fn()
    render(
      <Button variant="primary" icon="play" loading onClick={press}>
        Start Task
      </Button>
    )
    const button = screen.getByRole('button', { name: 'Start Task' })
    expect(button.className).toContain('button--loading')
    expect(button.getAttribute('aria-busy')).toBe('true')
    expect(buttonClass('primary', 'md', true)).toBe('button button--primary button--loading')
  })

  it('keeps a primary that cannot go yet filled and says so', () => {
    render(
      <Button variant="primary" aria-disabled="true">
        Start Task
      </Button>
    )
    const button = screen.getByRole('button', { name: 'Start Task' })
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(button.className).toContain('button--primary')
  })

  it('names an icon button and shows its label only after a beat', () => {
    vi.useFakeTimers()
    render(<IconButton icon="plus" label="New Tab" />)
    const button = screen.getByRole('button', { name: 'New Tab' })
    expect(button.className).toBe('button button--icon')
    fireEvent.pointerEnter(button)
    expect(screen.queryByRole('tooltip')).toBeNull()
    act(() => {
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS)
    })
    expect(screen.getByRole('tooltip').textContent).toBe('New Tab')
    fireEvent.pointerLeave(button)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })
})

describe('Tooltip', () => {
  it('shows on focus and leaves on blur, keeping the child’s own handlers', () => {
    vi.useFakeTimers()
    const focus = vi.fn()
    render(
      <Tooltip label="Split Right">
        <button type="button" onFocus={focus}>
          ⊟
        </button>
      </Tooltip>
    )
    const button = screen.getByRole('button')
    fireEvent.focus(button)
    act(() => {
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS)
    })
    expect(focus).toHaveBeenCalled()
    expect(screen.getByRole('tooltip').textContent).toBe('Split Right')
    fireEvent.blur(button)
    expect(screen.queryByRole('tooltip')).toBeNull()
  })
})

describe('fields', () => {
  it('draws a field, a mono one, an invalid one and a textarea', () => {
    render(
      <>
        <Input aria-label="Branch" mono invalid defaultValue="session-v2" />
        <Input aria-label="Name" />
        <Textarea aria-label="Task" />
      </>
    )
    const branch = screen.getByRole('textbox', { name: 'Branch' })
    expect(branch.className).toBe('input input--mono')
    expect(branch.getAttribute('aria-invalid')).toBe('true')
    expect(screen.getByRole('textbox', { name: 'Name' }).getAttribute('aria-invalid')).toBeNull()
    expect(screen.getByRole('textbox', { name: 'Task' }).className).toBe('textarea')
  })

  it('draws the select with its chevron', () => {
    render(
      <Select aria-label="Project" defaultValue="shop">
        <option value="shop">shop</option>
      </Select>
    )
    expect(screen.getByRole('combobox', { name: 'Project' }).className).toBe('select__input')
  })
})

describe('Switch', () => {
  it.each([true, false])('reports a press when %s, and not when disabled', (checked) => {
    const change = vi.fn()
    const { rerender } = render(<Switch label="Keep awake" checked={checked} onChange={change} />)
    const control = screen.getByRole('switch', { name: 'Keep awake' }) as HTMLInputElement
    expect(control.className).toBe('switch')
    expect(control.checked).toBe(checked)
    fireEvent.click(control)
    expect(change).toHaveBeenCalledWith(!checked)
    rerender(<Switch label="Keep awake" checked={checked} disabled onChange={change} />)
    expect(control.disabled).toBe(true)
  })
})

describe('Segmented', () => {
  it('raises the chosen item and reports another', () => {
    const change = vi.fn()
    render(
      <Segmented
        label="Mode"
        value="default"
        onChange={change}
        options={[
          { value: 'default', label: 'Default' },
          { value: 'auto', label: 'Auto' },
          { value: 'bypass', label: 'Bypass' }
        ]}
      />
    )
    expect(screen.getByRole('group', { name: 'Mode' }).className).toBe('segmented')
    expect(screen.getByRole('button', { name: 'Default' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByRole('button', { name: 'Auto' }).getAttribute('aria-pressed')).toBe('false')
    fireEvent.click(screen.getByRole('button', { name: 'Bypass' }))
    expect(change).toHaveBeenCalledWith('bypass')
  })
})

describe('Stepper', () => {
  it('steps within its bounds, and stops at them', () => {
    const change = vi.fn()
    render(<Stepper label="Codex" value={0} max={2} onChange={change} />)
    expect((screen.getByRole('button', { name: 'Fewer Codex' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'More Codex' }))
    expect(change).toHaveBeenCalledWith(1)
  })
})

describe('chips and pills', () => {
  it('draws a chip and a badge from the one chip rule', () => {
    render(
      <>
        <Chip>store.ts</Chip>
        <Badge>3 changes</Badge>
      </>
    )
    expect(screen.getByText('store.ts').className).toBe('chip')
    expect(screen.getByText('3 changes').className).toBe('chip badge')
  })

  it.each(['starting', 'working', 'asking', 'ready', 'ended', 'failed', 'restored'] satisfies PaneState[])(
    'names the %s state by its dot and word',
    (state) => {
      const { container } = render(
        <>
          <StatusPill state={state} />
          <StatusDot state={state} />
        </>
      )
      expect(container.querySelector('.status-pill')?.className).toBe(`chip status-pill status--${state}`)
      expect(screen.getByRole('img', { name: state }).className).toBe(`status-dot status--${state}`)
    }
  )

  it('lets a pill say more than its state', () => {
    render(<StatusPill state="failed" label="exit 1" />)
    expect(screen.getByText('exit 1')).toBeTruthy()
  })
})

describe('Kbd', () => {
  it('draws each key of a chord as a cap', () => {
    const { container } = render(<Kbd keys={['⌘', '↵']} label="Command Return" />)
    expect([...container.querySelectorAll('kbd.kbd')].map((key) => key.textContent)).toEqual(['⌘', '↵'])
  })
})

describe('ListRow', () => {
  it('marks a selected row and a current one, and carries its meta', () => {
    const open = vi.fn()
    render(
      <>
        <ListRow icon="team" label="Teamwork" meta="2 online" current onClick={open} />
        <ListRow icon="all-panes" label="All Panes" selected />
      </>
    )
    const team = screen.getByRole('button', { name: /Teamwork/ })
    expect(team.getAttribute('aria-current')).toBe('page')
    expect(team.textContent).toContain('2 online')
    fireEvent.click(team)
    expect(open).toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /All Panes/ }).getAttribute('aria-selected')).toBe('true')
  })
})

describe('Card and SectionHeader', () => {
  it('draws a titled card, an elevated one, and a section head with its summary', () => {
    const { container } = render(
      <>
        <SectionHeader title="Terminal" summary="SF Mono 13" />
        <Card title="Keep awake" actions={<Button size="sm">Change</Button>}>
          body
        </Card>
        <Card elevated>floating</Card>
      </>
    )
    expect(screen.getByRole('heading', { name: 'Terminal' }).className).toBe('section-head__title')
    expect(screen.getByText('SF Mono 13').className).toBe('section-head__summary')
    const cards = container.querySelectorAll('.card')
    expect(cards[0]?.querySelector('.card__title')?.textContent).toBe('Keep awake')
    expect(cards[1]?.className).toBe('card card--elevated')
    expect(cards[1]?.querySelector('.card__header')).toBeNull()
  })
})

describe('Tabs', () => {
  it('underlines the current tab, counts inline, and moves with the arrows', () => {
    const change = vi.fn()
    render(
      <Tabs
        label="Right panel"
        value="changes"
        onChange={change}
        tabs={[
          { id: 'files', label: 'Files' },
          { id: 'changes', label: 'Changes', count: 3 },
          { id: 'search', label: 'Search' }
        ]}
      />
    )
    const current = screen.getByRole('tab', { selected: true })
    expect(current.textContent).toBe('Changes3')
    expect(current.tabIndex).toBe(0)
    fireEvent.keyDown(current, { key: 'ArrowRight' })
    expect(change).toHaveBeenCalledWith('search')
    fireEvent.keyDown(current, { key: 'ArrowLeft' })
    expect(change).toHaveBeenCalledWith('files')
  })
})

describe('Toast', () => {
  it.each(['neutral', 'info', 'asking', 'success', 'error'] satisfies ToastTone[])(
    'edges a %s notice in its tone',
    (tone) => {
      const { container } = render(
        <Toast
          tone={tone}
          title="payment retries needs you"
          detail="Allow npm test?"
          actions={<Button size="sm">Open</Button>}
        />
      )
      expect(container.firstElementChild?.className).toBe(`toast toast--${tone}`)
      expect(screen.getByText('Allow npm test?').className).toBe('toast__text')
    }
  )

  it('interrupts only for asking and errors', () => {
    render(<Toast tone="asking" title="Permission needed" />)
    expect(screen.getByRole('alert').textContent).toContain('Permission needed')
  })
})

describe('EmptyState', () => {
  it('draws the mark, the title, a hint and one primary', () => {
    const { container } = render(
      <EmptyState title="No worktrees yet" hint="shop" actions={<Button variant="primary">New Task</Button>} />
    )
    expect(container.querySelector('.empty-state__motif svg')?.getAttribute('width')).toBe('56')
    expect(screen.getByRole('heading', { name: 'No worktrees yet' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'New Task' }).className).toContain('button--primary')
  })

  // A panel or a list is not a page: the same mark and title, a step smaller.
  it('draws smaller inside a panel', () => {
    const { container } = render(<EmptyState title="No changes" compact />)
    expect(container.querySelector('.empty-state')?.className).toContain('empty-state--compact')
    expect(container.querySelector('.empty-state__motif svg')?.getAttribute('width')).toBe('32')
  })
})

describe('PageHeader', () => {
  it('draws the tile, the title over its meta, the trailing actions and the close', () => {
    const close = vi.fn()
    const { container } = render(
      <PageHeader
        title="Appearance"
        icon="appearance"
        lede="Dark · Violet · SF Mono 13"
        trailing={<Button variant="primary">Copy Invitation</Button>}
        onClose={close}
      />
    )
    expect(container.querySelector('.page__tile [data-icon="appearance"]')?.getAttribute('width')).toBe('20')
    expect(screen.getByRole('heading', { level: 1, name: 'Appearance' })).toBeTruthy()
    expect(screen.getByText('Dark · Violet · SF Mono 13').className).toBe('page__lede')
    expect(screen.getByRole('button', { name: 'Copy Invitation' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Back to the panes' }))
    expect(close).toHaveBeenCalled()
  })

  it('leaves the tile out when there is no icon', () => {
    const { container } = render(<PageHeader title="Help" onClose={() => {}} />)
    expect(container.querySelector('.page__tile')).toBeNull()
  })
})
