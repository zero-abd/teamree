// Whether closing a pane is worth stopping somebody over, and what to say.
//
// Kept apart from the dialog for the reason the other dialog models are: the
// interesting part is the wording, and wording is worth testing. But the harder
// half of this file is the predicate, because a confirmation that fires on
// every close is not a safeguard — it is a keystroke people learn to press
// through, and having learned it they press through the one that mattered too.
//
// So this asks only where the click destroys something. The store's own comment
// above `closeTerminal` already has the argument: the pane is the only way to
// reach a PTY and everything running under it, so taking it off screen before
// the process is gone strands an agent mid-task with no row, no pane and no way
// back short of quitting. Closing the pane *kills* that process, which is the
// same loss arrived at from the other side.
//
// Three facts decide it, and all three are already on the `Terminal` the window
// holds — no new question for the runtime to answer, and nothing added to the
// frozen contract in `src/shared/`:
//
//   `running`   false once the child has exited. There is nothing left to stop,
//               and a pane kept open over a finished command is a pane somebody
//               is reading rather than using. Never ask.
//
//   `draining`  the child has been reaped and the last of its output is still
//               arriving. `running` is still true across that window, which is
//               exactly the trap this field exists to close: asking here offers
//               to stop something that has already stopped.
//
//   `busy`      output is still arriving, which is the only honest signal this
//               app has that work is happening. A build, a test run, an agent
//               thinking.
//
// And then the case that is not covered by any of them, and is the expensive
// one: an agent pane that has gone quiet. Quiet does not mean finished — the
// pane board says so in as many words, because teamree watches a PTY and not an
// agent's protocol, so silence is "stopped saying things", which is what
// waiting for an answer looks like from outside. An agent holding a question is
// mid-task with a conversation behind it, and closing its pane is the most
// expensive click in this application. It gets asked about.
//
// A plain shell sitting at a prompt is none of these, and is the common case.
// It closes without a word.

import type { Terminal } from '@shared/entities'

export type ClosePaneWarning = {
  /** The question, as the dialog's title. */
  title: string
  /** What is actually there, and what pressing through will cost. */
  body: string
  /** The button that goes through with it. Names the act, never "OK". */
  confirm: string
}

/**
 * What to ask before closing this pane, or null to close it without asking.
 *
 * Null for an unknown terminal too. A pane the window has no record of is not a
 * pane it can describe, and a dialog that says "something may be running" is
 * the confirmation nobody reads.
 */
export function closePaneWarning(terminal: Terminal | undefined): ClosePaneWarning | null {
  if (terminal === undefined) return null
  if (!terminal.running || terminal.draining === true) return null

  const where = terminal.title.trim() === '' ? 'this pane' : `“${terminal.title.trim()}”`

  if (terminal.agent !== undefined) {
    return {
      title: 'Stop this agent?',
      // Two sentences and they say different things, because the two states an
      // agent pane can be in when somebody reaches for the × are different
      // losses. Working: the work in flight goes. Quiet: it is holding a
      // question, and this app cannot tell that from finished — so the sentence
      // says what silence does and does not prove rather than guessing.
      body: terminal.busy
        ? `${terminal.agent} is working in ${where}. Closing the pane kills it.`
        : `${terminal.agent} has gone quiet in ${where} — waiting for an answer, or finished. Closing the pane kills it.`,
      confirm: 'Stop it and close'
    }
  }

  if (terminal.busy) {
    return {
      title: 'Stop what is running here?',
      body: `Output is still arriving in ${where}. Closing the pane kills the process.`,
      confirm: 'Stop it and close'
    }
  }

  return null
}
