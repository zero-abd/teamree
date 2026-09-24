// The setup pane for a command from `.teamree/project.json` this Mac has not approved:
// the command, Run and Skip. Nothing runs until Run is pressed.

export function SetupAsk({
  command,
  onAnswer
}: {
  command: string
  onAnswer: (run: boolean) => void
}): React.JSX.Element {
  return (
    <section className="setup-ask" aria-label="Setup">
      <span className="setup-ask__label">setup</span>
      <code className="setup-ask__command">{command}</code>
      <button type="button" className="button button--primary button--small" onClick={() => onAnswer(true)}>
        Run
      </button>
      <button type="button" className="button button--small" onClick={() => onAnswer(false)}>
        Skip
      </button>
    </section>
  )
}
