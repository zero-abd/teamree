// A command from `.teamree/project.json` this Mac has not approved, for the pane it would run in:
// the command, Run and Skip. Nothing runs until Run is pressed.

export function SetupAsk({
  command,
  label = 'setup',
  onAnswer
}: {
  command: string
  /** The pane it would run in. */
  label?: string
  onAnswer: (run: boolean) => void
}): React.JSX.Element {
  return (
    <section className="setup-ask" aria-label={label === 'setup' ? 'Setup' : `Run ${label}`}>
      <span className="setup-ask__label">{label}</span>
      <code className="setup-ask__command">{command}</code>
      <button type="button" className="button button--primary button--tiny" onClick={() => onAnswer(true)}>
        Run
      </button>
      <button type="button" className="button button--ghost button--tiny" onClick={() => onAnswer(false)}>
        Skip
      </button>
    </section>
  )
}
