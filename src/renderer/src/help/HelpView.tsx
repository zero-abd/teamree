// What the keys do, what a worktree is, and where the rest of it is written.
//
// It takes the whole main area, the way the pane board and teamwork's setup do,
// and for this view the reason is stronger than it is for either of them. Help
// is read while doing the thing it describes: somebody reading the sentence
// about panes is looking for the pane it is about, and somebody reading about a
// worktree has one open two inches away. A modal would put a scrim over exactly
// the part of the window the sentence is pointing at, and the reader would be
// left closing the help to look at the thing the help was explaining, then
// opening it again to read the next line.
//
// It is also somewhere you pass through rather than somewhere you work, which
// is why it toggles on its own chord and why Escape leaves: two ways out, both
// of which people try without being told.
//
// Nothing is unmounted that was costing anything. The PTYs live in the runtime,
// so every pane keeps running and keeps its scrollback while this is up.

import { useEffect, useRef } from 'react'
import { formatChord, type PlatformModifier } from '../keyboard/platformModifier'
import { shortcutHint } from '../keyboard/workspaceShortcuts'
import { modalOnScreen } from '../dialogs/modalLayer'
import { useWorkspaceStore } from '../state/workspaceStore'
import {
  CLI_SETTINGS_BUTTON,
  CLI_TITLE,
  cliHelp,
  HELP_TITLE,
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

  // Asked for on arrival rather than relied on from whenever something else
  // last looked. The state this section describes is a fact about the machine
  // that a terminal in this very window can change — somebody can link the CLI
  // by hand between one visit and the next — and a page telling them the
  // command is missing when they have just installed it is worse than one that
  // takes a moment to say so.
  useEffect(() => {
    void loadCli()
  }, [loadCli])

  // Escape is what every reader tries first on a view they opened to look at
  // something. Capture, for the same reason the chords are captured: a focused
  // pane must not eat it first.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // Anything modal on top owns Escape. Dismissing the palette and this
      // page with one press would take away more than the reader asked for.
      //
      // `modalOnScreen` rather than `dialog`, because half of what can be on
      // top is not in `dialog` at all: a question about a teammate's keystrokes
      // is raised by another machine, is the one modal here that refuses to be
      // dismissed, and would otherwise have this page close underneath a scrim
      // the reader cannot see through. `modalLayer.ts` exists because every
      // surface that had to stand aside had learned only the half it was
      // written beside.
      if (modalOnScreen(useWorkspaceStore.getState())) return
      event.preventDefault()
      toggleHelp()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [toggleHelp])

  // Focus goes to the region rather than to a control in it. This is a page to
  // read from the top, not a list to act on, so putting the focus on the first
  // button would start the reader in the middle of it — and without this the
  // keyboard stays wherever it was, which after a chord is a pane that is no
  // longer on screen.
  const region = useRef<HTMLElement>(null)
  useEffect(() => {
    region.current?.focus()
  }, [])

  const groups = shortcutGroups()
  const cliSection = cliHelp(cli)

  return (
    <main className="workspace help" aria-label="Help" tabIndex={-1} ref={region}>
      <header className="help__head">
        <div className="help__identity">
          <h1 className="help__title">{HELP_TITLE}</h1>
        </div>

        <button
          type="button"
          className="help__close"
          title={`Back to the panes · ${shortcutHint('open-help', modifier)}`}
          aria-label="Back to the panes"
          onClick={toggleHelp}
        >
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M3 3 L9 9 M9 3 L3 9" />
          </svg>
        </button>
      </header>

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
    </main>
  )
}
