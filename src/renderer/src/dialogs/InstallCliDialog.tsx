// Putting the `teamree` command on PATH, in one button.
//
// The whole of the judgement is in cliInstallModel.ts; this shows it. What the
// panel will not do is press anything before it has said what will happen: the
// destination and the password are on the screen before the button is, because
// a password dialog nobody was expecting is how an app teaches people to say no
// to password dialogs.

import { useEffect } from 'react'
import { useWorkspaceStore } from '../state/workspaceStore'
import { cliOutcome, cliPanel } from './cliInstallModel'
import { Modal } from './Modal'

export function InstallCliDialog(): React.JSX.Element {
  const status = useWorkspaceStore((state) => state.cli)
  const pending = useWorkspaceStore((state) => state.cliPending)
  const install = useWorkspaceStore((state) => state.cliInstall)
  const error = useWorkspaceStore((state) => state.cliError)
  const loadCli = useWorkspaceStore((state) => state.loadCli)
  const installCli = useWorkspaceStore((state) => state.installCli)
  const closeDialog = useWorkspaceStore((state) => state.closeDialog)

  // Re-read on open: the answer was probed at startup, and a link somebody made
  // in a terminal since then is exactly the thing this dialog is about.
  useEffect(() => {
    void loadCli()
  }, [loadCli])

  const panel = cliPanel(status)

  return (
    <Modal
      title="Put teamree on your PATH"
      description="The app ships its own CLI. Everything this window can do it can do — which is how a coding agent drives teamree."
      onClose={closeDialog}
    >
      <div className="cli-install">
        <p className="cli-install__headline">{panel.headline}</p>
        {panel.detail ? <p className="cli-install__detail">{panel.detail}</p> : null}

        {panel.promise ? (
          <div className="cli-install__promise">
            <p>{panel.promise}</p>
            {panel.password ? <p className="cli-install__password">{panel.password}</p> : null}
          </div>
        ) : null}

        {panel.pathWarning ? <p className="cli-install__warning">{panel.pathWarning}</p> : null}

        {panel.manual ? (
          <pre className="cli-install__command">
            <code>{panel.manual}</code>
          </pre>
        ) : null}

        {/* The refusal, where the button that caused it is: a file in the way
            and a password not given are both things somebody is about to try
            again from here. */}
        {error ? <p className="cli-install__error">{error}</p> : null}
        {install && error === null ? <p className="cli-install__done">{cliOutcome(install)}</p> : null}

        <div className="form__actions">
          <button type="button" className="button button--ghost" onClick={closeDialog}>
            Close
          </button>
          {panel.action ? (
            <button
              type="button"
              className="button button--primary"
              disabled={pending}
              onClick={() => void installCli()}
            >
              {pending ? 'Linking…' : panel.action}
            </button>
          ) : null}
        </div>
      </div>
    </Modal>
  )
}
