// The rail's icon for sleep, filled while it holds the machine awake, and the three ways to change it.

import { useCallback, useRef, useState } from 'react'
import { KEEP_AWAKE_MODES, type KeepAwakeMode } from '../state/preferences'
import { useWorkspaceStore } from '../state/workspaceStore'
import { anyAgentBusy, holdsAwake } from './keepAwake'
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
  const holding = useWorkspaceStore((state) => holdsAwake(state.keepAwake, anyAgentBusy(state.terminals)))
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
        className={`statusbar__item statusbar__button${open ? ' statusbar__button--on' : ''}${
          holding ? ' statusbar__icon--on' : ''
        }`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Keep awake, ${MODE_NAME[mode].toLowerCase()}`}
        title={`Keep awake · ${MODE_NAME[mode]}`}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <svg className="statusbar__icon" viewBox="0 0 14 14" aria-hidden="true">
          <path
            className="statusbar__icon-fill"
            d="M2.5 5.5 H10 V9 A2.5 2.5 0 0 1 7.5 11.5 H5 A2.5 2.5 0 0 1 2.5 9 Z"
          />
          <path d="M10 6.5 H11 A1.5 1.5 0 0 1 11 9.5 H10 M5 1.5 V3.5 M7.5 1.5 V3.5" />
        </svg>
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
