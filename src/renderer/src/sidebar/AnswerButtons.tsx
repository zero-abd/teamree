// An asking pane's answers as buttons, on the rows that list it: the board's, and the sidebar's on hover.
// A click sends nothing the runtime has not just seen on the pane's screen; see `answerPane`.

import type { ScreenChoice } from '@shared/screenOpinion'
import { useWorkspaceStore } from '../state/workspaceStore'

export function AnswerButtons({
  terminalId,
  choices,
  className
}: {
  terminalId: string
  choices: readonly ScreenChoice[]
  className: string
}): React.JSX.Element {
  const answerPane = useWorkspaceStore((state) => state.answerPane)
  return (
    <span className={`answers ${className}`} role="group" aria-label="Answer">
      {choices.map((choice) => (
        <button
          key={choice.label}
          type="button"
          className="button button--tiny answers__choice"
          onClick={() => void answerPane(terminalId, choice)}
        >
          {choice.label}
        </button>
      ))}
    </span>
  )
}
