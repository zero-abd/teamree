// The rail's word on sleep, and the three ways to change it.

import { useCallback, useRef, useState } from 'react'
import { KEEP_AWAKE_MODES, type KeepAwakeMode } from '../state/preferences'
import { useWorkspaceStore } from '../state/workspaceStore'
import { keepAwakeLabel } from './keepAwake'
import { StatusPopover } from './StatusPopover'

const MODE_NAME: Record<KeepAwakeMode, string> = { on: 'On', agent: 'Agent', off: 'Off' }

/** Under six words, and only where the name alone does not say it. */
const MODE_NOTE: Record<KeepAwakeMode, string> = {
  on: 'while the app runs',
  agent: 'while an agent is busy',
  off: 'the system decides'
}

export function KeepAwakeControl(): React.JSX.Element {
  const mode = useWorkspaceStore((state) => state.keepAwake)
  const setKeepAwake = useWorkspaceStore((state) => state.setKeepAwake)
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement | null>(null)

  const close = useCallback(() => {
    setOpen(false)
    button.current?.focus()
  }, [])

  const choose = (next: KeepAwakeMode): void => {
    setKeepAwake(next)
    close()
  }

  // Arrows move between the rows the way they do in a native radio group, so
  // the panel is one tab stop and not three.
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const index = KEEP_AWAKE_MODES.indexOf(mode)
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      event.preventDefault()
      setKeepAwake(KEEP_AWAKE_MODES[(index + 1) % KEEP_AWAKE_MODES.length] as KeepAwakeMode)
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      event.preventDefault()
      setKeepAwake(KEEP_AWAKE_MODES[(index + KEEP_AWAKE_MODES.length - 1) % KEEP_AWAKE_MODES.length] as KeepAwakeMode)
    }
  }

  return (
    <>
      <button
        ref={button}
        type="button"
        className={`statusbar__item statusbar__button${open ? ' statusbar__button--on' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Keep awake, ${MODE_NAME[mode].toLowerCase()}`}
        title="Keep awake"
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span className={`statusbar__dot statusbar__dot--awake-${mode}`} aria-hidden="true" />
        {keepAwakeLabel(mode)}
      </button>
      {open ? (
        <StatusPopover label="Keep awake" anchor={button.current} onClose={close}>
          <div className="statusbar__radios" role="radiogroup" aria-label="Keep awake" onKeyDown={onKeyDown}>
            {KEEP_AWAKE_MODES.map((option) => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={option === mode}
                className={`statusbar__radio${option === mode ? ' statusbar__radio--on' : ''}`}
                tabIndex={option === mode ? 0 : -1}
                autoFocus={option === mode}
                onClick={() => choose(option)}
              >
                <span className="statusbar__radio-mark" aria-hidden="true" />
                <span className="statusbar__radio-name">{MODE_NAME[option]}</span>
                <span className="statusbar__radio-note">{MODE_NOTE[option]}</span>
              </button>
            ))}
          </div>
        </StatusPopover>
      ) : null}
    </>
  )
}
