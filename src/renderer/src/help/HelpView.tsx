// What the keys do, what a worktree is, and where the rest is written. It takes the main area because
// help is read beside the thing it describes, which a modal's scrim would cover.

import { useEffect } from 'react'
import { formatChord, type PlatformModifier } from '../keyboard/platformModifier'
import { shortcutHint } from '../keyboard/workspaceShortcuts'
import { useWorkspaceStore } from '../state/workspaceStore'
import { PageFrame } from '../workspace/PageFrame'
import {
  CLI_SETTINGS_BUTTON,
  CLI_TITLE,
  cliHelp,
  HELP_TITLE,
  paneNumberRows,
  README_DOCUMENT,
  shortcutGroups,
  TEAMWORK_DOCUMENT,
  WORKTREE_PARAGRAPHS,
  WORKTREE_TITLE
} from './helpTopics'

export function HelpView({ modifier }: { modifier: PlatformModifier }): React.JSX.Element {
  const cli = useWorkspaceStore((state) => state.cli)
  const toggleHelp = useWorkspaceStore((state) => state.toggleHelp)
  const toggleSettings = useWorkspaceStore((state) => state.toggleSettings)
  const loadCli = useWorkspaceStore((state) => state.loadCli)

  // Asked on arrival: a terminal in this window may have linked the CLI since the last look.
  useEffect(() => {
    void loadCli()
  }, [loadCli])

  const groups = shortcutGroups()
  const cliSection = cliHelp(cli)

  return (
    <PageFrame
      label="Help"
      title={HELP_TITLE}
      onClose={toggleHelp}
      closeTitle={`Back to the panes · ${shortcutHint('open-help', modifier)}`}
    >
      <div className="help__body">
        {/* The chords, and every one of them comes from the table the key
            handler reads. There is no list of keys in this file to go stale. */}
        <section className="help__section" aria-labelledby="help-keys">
          <h2 className="help__heading" id="help-keys">
            Keyboard
          </h2>

          {groups.map((group) => (
            <div className="help-group" key={group.id}>
              <h3 className="help-group__title">{group.title}</h3>
              {group.blurb === null ? null : <p className="help-group__blurb">{group.blurb}</p>}
              <ul className="help-keys">
                {group.shortcuts.map((shortcut) => (
                  <li className="help-key" key={shortcut.command}>
                    <span className="help-key__what">{shortcut.title}</span>
                    {/* Always there: `shortcutGroups` lists the bindings, and a
                        command the table binds to nothing is not one. */}
                    <kbd className="help-key__chord">{shortcut.chord ? formatChord(shortcut.chord, modifier) : ''}</kbd>
                  </li>
                ))}
                {group.id === 'panes'
                  ? paneNumberRows(modifier).map((row) => (
                      <li className="help-key" key={row.title}>
                        <span className="help-key__what">{row.title}</span>
                        <kbd className="help-key__chord">{row.chord}</kbd>
                      </li>
                    ))
                  : null}
              </ul>
            </div>
          ))}
        </section>

        <section className="help__section" aria-labelledby="help-worktree">
          <h2 className="help__heading" id="help-worktree">
            {WORKTREE_TITLE}
          </h2>
          {WORKTREE_PARAGRAPHS.map((paragraph) => (
            <p className="help__prose" key={paragraph.slice(0, 32)}>
              {paragraph}
            </p>
          ))}
        </section>

        <section className="help__section" aria-labelledby="help-cli">
          <h2 className="help__heading" id="help-cli">
            {CLI_TITLE}
          </h2>
          {/* What is true on this machine, in the install panel's own words, so
              the two surfaces cannot come to disagree about one link. */}
          <p className="help__state">{cliSection.headline}</p>

          {cliSection.command === null ? null : <p className="help__prose">{cliSection.command}</p>}

          {cliSection.caveat === null ? null : <p className="help__caveat">{cliSection.caveat}</p>}

          {cliSection.settings === null ? null : (
            <p className="help__prose">
              {cliSection.settings}{' '}
              <button type="button" className="button button--ghost button--small" onClick={toggleSettings}>
                {CLI_SETTINGS_BUTTON}
              </button>
            </p>
          )}

          {/* Addresses rather than a copy of the prose. The main process sends
              an external link to the browser and keeps this window on the page
              it already has, so these leave without taking the app with them. */}
          <p className="help__prose">
            <a className="help__link" href={README_DOCUMENT} target="_blank" rel="noreferrer">
              README
            </a>
            {' · '}
            <a className="help__link" href={TEAMWORK_DOCUMENT} target="_blank" rel="noreferrer">
              docs/teamwork.md
            </a>
          </p>
        </section>
      </div>
    </PageFrame>
  )
}
