// An asking pane's answers as buttons, on the rows that list it: the board's and the sidebar's, at rest.
// A click sends nothing the runtime has not just seen on the pane's screen; see `answerPane`.

import type { ReactNode } from 'react'
import type { ScreenChoice } from '@shared/screenOpinion'
import { Button } from '../ui/Button'
import { useWorkspaceStore } from '../state/workspaceStore'

export type AnswerChoice = { label: string; title?: string }

/** Answers as tiny buttons on a line that wraps: a pane's menu, or a task's question for you, whose Reply… is `children`. */
export function AnswerChoices({
  choices,
  onChoose,
  className,
  tabbable = true,
  disabled = false,
  children
}: {
  choices: readonly AnswerChoice[]
  onChoose: (index: number) => void
  className?: string
  /** False keeps them out of the Tab order, for a tree that is one Tab stop. */
  tabbable?: boolean
  disabled?: boolean
  children?: ReactNode
}): React.JSX.Element {
  return (
    <span className={className === undefined ? 'answers' : `answers ${className}`} role="group" aria-label="Answer">
      {choices.map((choice, index) => (
        <button
          key={choice.label}
          type="button"
          className="button button--tiny answers__choice"
          title={choice.title}
          tabIndex={tabbable ? undefined : -1}
          disabled={disabled}
          onClick={() => onChoose(index)}
        >
          {choice.label}
        </button>
      ))}
      {children}
    </span>
  )
}

export function AnswerButtons({
  terminalId,
  choices,
  className,
  tabbable = true,
  onChoose
}: {
  terminalId: string
  choices: readonly ScreenChoice[]
  className: string
  tabbable?: boolean
  /** Instead of answering this machine's pane: a teammate's goes through their consent. */
  onChoose?: (choice: ScreenChoice) => void
}): React.JSX.Element {
  const answerPane = useWorkspaceStore((state) => state.answerPane)
  return (
    <AnswerChoices
      choices={choices.map((choice) => ({ label: shortAnswer(choice.label), title: choice.label }))}
      onChoose={(index) => {
        const choice = choices[index]
        if (choice === undefined) return
        if (onChoose) onChoose(choice)
        else void answerPane(terminalId, choice)
      }}
      className={className}
      tabbable={tabbable}
    />
  )
}

/** A sidebar ask's two buttons: Allow sends the menu's first answer; Open goes to the pane, where the others are. */
export function AllowOpen({
  terminalId,
  choices,
  onOpen,
  tabbable = true,
  onChoose
}: {
  terminalId: string
  /** Empty leaves Allow out: Open alone. */
  choices: readonly ScreenChoice[]
  onOpen: () => void
  tabbable?: boolean
  /** Instead of answering this machine's pane: a teammate's goes through their consent. */
  onChoose?: (choice: ScreenChoice) => void
}): React.JSX.Element {
  const answerPane = useWorkspaceStore((state) => state.answerPane)
  const first = choices[0]
  const tabIndex = tabbable ? undefined : -1
  return (
    <span className="answers pane-item__answers" role="group" aria-label="Answer">
      {first === undefined ? null : (
        <Button
          variant="primary"
          size="sm"
          className="answers__choice"
          title={first.label}
          tabIndex={tabIndex}
          onClick={() => (onChoose ? onChoose(first) : void answerPane(terminalId, first))}
        >
          Allow
        </Button>
      )}
      <Button variant="ghost" size="sm" className="answers__open" tabIndex={tabIndex} onClick={onOpen}>
        Open
      </Button>
    </span>
  )
}

/** `Yes, Always` as `Always`: beside a `Yes`, the rest says it. */
function shortAnswer(label: string): string {
  return label.replace(/^Yes, /u, '')
}
