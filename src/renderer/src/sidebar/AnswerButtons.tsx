// An asking pane's answers as buttons, on the rows that list it: the board's and the sidebar's, at rest.
// A click sends nothing the runtime has not just seen on the pane's screen; see `answerPane`.

import type { ScreenChoice } from '@shared/screenOpinion'
import { useWorkspaceStore } from '../state/workspaceStore'

export type AnswerChoice = { label: string; title?: string }

/** Answers as tiny buttons on a line that wraps: a pane's menu, or a task's question for you. */
export function AnswerChoices({
  choices,
  onChoose,
  className,
  tabbable = true
}: {
  choices: readonly AnswerChoice[]
  onChoose: (index: number) => void
  className: string
  /** False keeps them out of the Tab order, for a tree that is one Tab stop. */
  tabbable?: boolean
}): React.JSX.Element {
  return (
    <span className={`answers ${className}`} role="group" aria-label="Answer">
      {choices.map((choice, index) => (
        <button
          key={choice.label}
          type="button"
          className="button button--tiny answers__choice"
          title={choice.title}
          tabIndex={tabbable ? undefined : -1}
          onClick={() => onChoose(index)}
        >
          {choice.label}
        </button>
      ))}
    </span>
  )
}

export function AnswerButtons({
  terminalId,
  choices,
  className,
  tabbable = true
}: {
  terminalId: string
  choices: readonly ScreenChoice[]
  className: string
  tabbable?: boolean
}): React.JSX.Element {
  const answerPane = useWorkspaceStore((state) => state.answerPane)
  return (
    <AnswerChoices
      choices={choices.map((choice) => ({ label: shortAnswer(choice.label), title: choice.label }))}
      onChoose={(index) => {
        const choice = choices[index]
        if (choice) void answerPane(terminalId, choice)
      }}
      className={className}
      tabbable={tabbable}
    />
  )
}

/** `Yes, Always` as `Always`: beside a `Yes`, the rest says it. */
function shortAnswer(label: string): string {
  return label.replace(/^Yes, /u, '')
}
