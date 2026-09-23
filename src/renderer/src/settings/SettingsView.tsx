// Everything this copy of teamree is configured to do, on one page.
//
// It takes the whole main area for the reason the pane board and teamwork's
// setup do, and the reason is in what is on it rather than in how big it is.
// Every section here is about the machine — what is on its PATH, whether it
// looks for releases, how big the text in its panes is, where its checkouts
// are — and not one of them is about the worktree whose tab happens to be open.
// A drawer beside the panes would frame all of it with a tab that has nothing
// to do with it, and a modal would put a scrim over the panes whose text size
// somebody is here to change. `WorkspaceArea` gives it the area ahead of the
// empty state for the other half of the same thought: a window with nothing
// open is exactly where people go looking for settings.
//
// Two things this page deliberately is not. It is not a second colour editor:
// Appearance is one row and a button that opens the editor that already exists,
// because two places to set one colour is how the two come to disagree. And it
// is not a second place to set a relay: the relay block reads, names where the
// URL came from, and sends you to the teamwork page, which is where setting one
// is a step in a flow that also writes a key and pushes both files.
//
// Nothing here is unmounted that was costing anything, the same as the board:
// the PTYs live in the runtime, so every pane keeps running and keeps its
// scrollback while this is up — which is what makes the text-size control
// honest, since the panes it resizes are still there behind the page.

import { useEffect, useRef, useState } from 'react'
import type { Project } from '@shared/entities'
import { cliOutcome, cliPanel } from '../dialogs/cliInstallModel'
import type { PlatformModifier } from '../keyboard/platformModifier'
import { shortcutHint } from '../keyboard/workspaceShortcuts'
import { TERMINAL_FONT_MAX_PX, TERMINAL_FONT_MIN_PX, type AgentNoticePreference } from '../state/preferences'
import { useNow } from '../state/useNow'
import { modalOnScreen } from '../dialogs/modalLayer'
import { useWorkspaceStore } from '../state/workspaceStore'
import { relayPanel, updatePanel } from './settingsModel'

export function SettingsView({ modifier }: { modifier: PlatformModifier }): React.JSX.Element {
  const projects = useWorkspaceStore((state) => state.projects)
  const toggleSettings = useWorkspaceStore((state) => state.toggleSettings)
  const loadCli = useWorkspaceStore((state) => state.loadCli)
  const loadUpdate = useWorkspaceStore((state) => state.loadUpdate)

  // Both are read again on open rather than trusted from startup, and for the
  // same reason: each is a fact about the world outside this window that can
  // have moved since. A link somebody made in a terminal and a check that ran
  // an hour ago are exactly what this page is being opened to look at.
  useEffect(() => {
    void loadCli()
    void loadUpdate()
  }, [loadCli, loadUpdate])

  // Escape is what every reader tries first on a view they opened to look at
  // something. Capture, for the same reason the chords are captured: a focused
  // pane must not eat it first.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // Anything modal on top owns Escape. Dismissing the appearance editor —
      // which this page's own Appearance row opens — and this page with one
      // press would take away more than the reader asked for.
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
      toggleSettings()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [toggleSettings])

  // Reached from a button elsewhere in the window, so the keyboard has to come
  // with it: without this, Tab carries on through whatever the reader was in
  // before, while the page that just opened is unreachable. The region rather
  // than a control inside it, so the first Tab lands on the first section's own
  // button and the page's name is read out on arrival.
  const region = useRef<HTMLElement>(null)
  useEffect(() => {
    region.current?.focus()
  }, [])

  return (
    <main className="workspace settings" aria-label="Settings" tabIndex={-1} ref={region}>
      <header className="settings__head">
        <div className="settings__column settings__head-row">
          <div className="settings__identity">
            <h1 className="settings__title">Settings</h1>
          </div>
          <button
            type="button"
            className="settings__close"
            title="Back to the panes"
            aria-label="Back to the panes"
            onClick={toggleSettings}
          >
            <svg viewBox="0 0 12 12" aria-hidden="true">
              <path d="M3 3 L9 9 M9 3 L3 9" />
            </svg>
          </button>
        </div>
      </header>

      <div className="settings__body">
        <div className="settings__column">
          <CliSection />
          <UpdatesSection />
          <NoticesSection />
          <PanesSection />
          <AppearanceSection modifier={modifier} />
          <ProjectsSection projects={projects} />
        </div>
      </div>
    </main>
  )
}

/**
 * The `teamree` command, and whether a terminal can find it.
 *
 * The whole of the judgement is `cliInstallModel`'s, exactly as it is for the
 * dialog: the same `cliPanel` and the same `cliOutcome`, shown as a section
 * rather than in a box. Rewriting any of those sentences here would be the
 * drift the model's own header warns about — two surfaces describing one link
 * in two ways, one of which is wrong about the password.
 */
function CliSection(): React.JSX.Element {
  const status = useWorkspaceStore((state) => state.cli)
  const pending = useWorkspaceStore((state) => state.cliPending)
  const install = useWorkspaceStore((state) => state.cliInstall)
  const error = useWorkspaceStore((state) => state.cliError)
  const installCli = useWorkspaceStore((state) => state.installCli)

  const panel = cliPanel(status)

  return (
    <section className="settings-section" aria-labelledby="settings-cli">
      <h2 className="settings-section__title" id="settings-cli">
        teamree on your PATH
      </h2>
      <p className="settings-fact">{panel.headline}</p>
      {panel.detail ? <p className="settings-note">{panel.detail}</p> : null}

      {/* What the button will do, and what will ask for a password, penned off
          above the button rather than left to be discovered by pressing it. */}
      {panel.promise ? (
        <div className="settings-promise">
          <p>{panel.promise}</p>
          {panel.password ? <p className="settings-promise__password">{panel.password}</p> : null}
        </div>
      ) : null}

      {panel.pathWarning ? <p className="settings-warning">{panel.pathWarning}</p> : null}

      {panel.manual ? (
        <pre className="settings-command">
          <code>{panel.manual}</code>
        </pre>
      ) : null}

      {/* The refusal stays where the button that caused it is: a file in the
          way and a password not given are both things somebody is about to try
          again from here. */}
      {error ? <p className="settings-error">{error}</p> : null}
      {install && error === null ? <p className="settings-done">{cliOutcome(install)}</p> : null}

      {panel.action ? (
        <div className="settings-actions">
          <button type="button" className="button button--primary" disabled={pending} onClick={() => void installCli()}>
            {pending ? 'Linking…' : panel.action}
          </button>
        </div>
      ) : null}
    </section>
  )
}

/** Whether teamree goes looking for a newer release, and what it found last time. */
function UpdatesSection(): React.JSX.Element {
  const update = useWorkspaceStore((state) => state.update)
  const checkForUpdates = useWorkspaceStore((state) => state.checkForUpdates)
  const setAutomaticUpdates = useWorkspaceStore((state) => state.setAutomaticUpdates)

  // The "last checked" line is the one number on this page that changes while
  // nothing happens, so the page has to re-render itself for it to stay true.
  const now = useNow()
  const panel = updatePanel(update, now)

  return (
    <section className="settings-section" aria-labelledby="settings-updates">
      <h2 className="settings-section__title" id="settings-updates">
        Updates
      </h2>
      <p className="settings-fact">{panel.headline}</p>
      <p className="settings-note">{panel.detail}</p>

      {panel.offersCheck ? (
        <>
          <label className="settings-check">
            <input
              type="checkbox"
              checked={update?.automatic ?? false}
              onChange={(event) => void setAutomaticUpdates(event.target.checked)}
            />
            {/* What the preference actually arms, rather than "check
                automatically": the runtime makes its first check half a minute
                after startup and one every six hours after that, and a label
                that said "on launch" would be describing a check that has not
                happened yet at the moment somebody reads it. */}
            <span>Check shortly after launch, and every few hours while teamree is open</span>
          </label>

          <div className="settings-actions">
            <button
              type="button"
              className="button button--small"
              disabled={update?.checking ?? false}
              onClick={() => void checkForUpdates()}
            >
              {update?.checking ? 'Checking…' : 'Check now'}
            </button>
            {panel.lastChecked ? <span className="settings-aside">{panel.lastChecked}</span> : null}
          </div>
        </>
      ) : null}

      {/* Kept rather than raised, the way the store keeps it: a check that could
          not reach GitHub is not something the reader has to do anything about,
          and it belongs beside the button that tried. */}
      {panel.problem ? <p className="settings-warning">{panel.problem}</p> : null}
    </section>
  )
}

/**
 * What an agent that has stopped may do when you are not looking at the window.
 *
 * One row and no paragraph under it. Everything else on this page explains
 * something that cannot be worked out by reading the control — what a link on
 * the PATH is for, what "automatically" means in hours, which of two places a
 * relay came from. The three words in this select are the whole of what this
 * setting does.
 */
function NoticesSection(): React.JSX.Element {
  const agentNotices = useWorkspaceStore((state) => state.agentNotices)
  const setAgentNotices = useWorkspaceStore((state) => state.setAgentNotices)

  return (
    <section className="settings-section" aria-labelledby="settings-notices">
      <h2 className="settings-section__title" id="settings-notices">
        Notifications
      </h2>

      <div className="settings-field">
        <label className="settings-field__label" htmlFor="settings-agent-notices">
          When an agent stops
        </label>
        <select
          id="settings-agent-notices"
          className="settings-field__select"
          value={agentNotices}
          onChange={(event) => setAgentNotices(event.target.value as AgentNoticePreference)}
        >
          <option value="off">Nothing</option>
          <option value="notify">Notify</option>
          <option value="sound">Notify with sound</option>
        </select>
      </div>
    </section>
  )
}

/** The one thing about a pane that is a preference rather than a layout. */
function PanesSection(): React.JSX.Element {
  const terminalFontSize = useWorkspaceStore((state) => state.terminalFontSize)
  const setTerminalFontSize = useWorkspaceStore((state) => state.setTerminalFontSize)

  return (
    <section className="settings-section" aria-labelledby="settings-panes">
      <h2 className="settings-section__title" id="settings-panes">
        Panes
      </h2>
      <div className="settings-size">
        <label className="settings-size__label" htmlFor="settings-font-size">
          Terminal text size
        </label>
        <input
          id="settings-font-size"
          className="settings-size__range"
          type="range"
          min={TERMINAL_FONT_MIN_PX}
          max={TERMINAL_FONT_MAX_PX}
          step={1}
          value={terminalFontSize}
          onChange={(event) => setTerminalFontSize(Number(event.target.value))}
        />
        {/* The number beside the slider, not a tooltip on it: "how big is it
            now" is the question a slider with no scale cannot answer, and it is
            the one somebody asks when comparing this window with another. */}
        <output className="settings-size__value" htmlFor="settings-font-size">
          {terminalFontSize}px
        </output>
      </div>

      <p className="settings-note">Remembered on this machine only.</p>
    </section>
  )
}

/**
 * One row, and it opens something else.
 *
 * There is a colour editor already, reached by a chord and by the sidebar's
 * rail, and it is the only thing in the app that writes an appearance. A second
 * set of swatches here would be a second answer to one question, which is the
 * failure the comments around this codebase keep naming — so this row is a
 * sentence saying what is over there and a button that goes there.
 */
function AppearanceSection({ modifier }: { modifier: PlatformModifier }): React.JSX.Element {
  const openDialog = useWorkspaceStore((state) => state.openDialog)

  return (
    <section className="settings-section" aria-labelledby="settings-appearance">
      <h2 className="settings-section__title" id="settings-appearance">
        Appearance
      </h2>
      <div className="settings-actions">
        <button
          type="button"
          className="button button--small"
          title={shortcutHint('open-appearance', modifier)}
          onClick={() => openDialog({ kind: 'appearance' })}
        >
          Open the appearance panel
        </button>
      </div>
    </section>
  )
}

function ProjectsSection({ projects }: { projects: readonly Project[] }): React.JSX.Element {
  return (
    <section className="settings-section" aria-labelledby="settings-projects">
      <h2 className="settings-section__title" id="settings-projects">
        Projects
      </h2>
      {projects.length === 0 ? (
        <p className="settings-note">No repositories yet.</p>
      ) : (
        projects.map((project) => <ProjectBlock key={project.id} project={project} />)
      )}
    </section>
  )
}

function ProjectBlock({ project }: { project: Project }): React.JSX.Element {
  const revealInFinder = useWorkspaceStore((state) => state.revealInFinder)

  return (
    <article className="settings-project">
      <h3 className="settings-project__name">{project.name}</h3>

      <div className="settings-row">
        <p className="settings-project__path">{project.path}</p>
        <div className="settings-actions">
          <button
            type="button"
            className="button button--small"
            onClick={() => void revealInFinder(project.path, `the ${project.name} repository`)}
          >
            Reveal in Finder
          </button>
        </div>
      </div>

      <StartPoint project={project} />
      <CarriedPaths project={project} />
      <EditorCommand project={project} />
      <RelayBlock project={project} />
    </article>
  )
}

/**
 * Which ref the New task dialog offers first, for this project.
 *
 * Held as a draft and written on blur or Enter rather than on every keystroke.
 * A ref is typed a character at a time and half of one is a ref that does not
 * exist, so a field that wrote through as it went would spend most of its life
 * storing a preference nothing can resolve — and `withStartPoint` would be
 * clearing and re-setting the entry on the way past the empty string.
 */
function StartPoint({ project }: { project: Project }): React.JSX.Element {
  const stored = useWorkspaceStore((state) => state.startPointDefaults[project.id] ?? '')
  const setStartPointDefault = useWorkspaceStore((state) => state.setStartPointDefault)
  const [draft, setDraft] = useState(stored)

  // The stored value moving is what puts the trimmed, stored spelling back in
  // the box after a commit — and it is also what keeps this field right when
  // the preference is changed from somewhere else in the window.
  useEffect(() => {
    setDraft(stored)
  }, [stored])

  const commit = (): void => {
    const next = draft.trim()
    if (next === stored) return
    // Null rather than the empty string, because the store's `withStartPoint`
    // treats them differently on purpose: null removes the entry, which is the
    // only spelling of "use the base ref" anything else checks for.
    setStartPointDefault(project.id, next.length === 0 ? null : next)
  }

  const id = `settings-start-point-${project.id}`

  return (
    <div className="settings-field">
      <label className="settings-field__label" htmlFor={id}>
        Start new worktrees from
      </label>
      <div className="settings-field__row">
        <input
          id={id}
          className="settings-field__input"
          type="text"
          value={draft}
          placeholder={project.baseRef}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              commit()
            }
          }}
        />
        <button
          type="button"
          className="button button--small"
          disabled={stored.length === 0}
          onClick={() => setStartPointDefault(project.id, null)}
        >
          Use {project.baseRef}
        </button>
      </div>
      <p className="settings-note">
        What the New task dialog offers first; the repository&rsquo;s base ref is unchanged.
      </p>
    </div>
  )
}

/**
 * What a new worktree of this project gets that the branch does not carry.
 *
 * Two fields and two labels, and no paragraph under them: the reader is a
 * developer looking at a box that says it symlinks `node_modules`, and a
 * paragraph explaining why a worktree has no `node_modules` is a paragraph
 * they will read once. What the lists refuse — a tracked path, a path that is
 * not ignored, a copy too large to be a copy — is said at the moment it is
 * refused, on the row that failed, where it is about a specific path.
 */
function CarriedPaths({ project }: { project: Project }): React.JSX.Element {
  const setProjectPaths = useWorkspaceStore((state) => state.setProjectPaths)

  return (
    <>
      <PathList
        project={project}
        id="linked"
        label="Symlink into every new worktree"
        placeholder={'node_modules\n.venv'}
        paths={project.linkedPaths}
        save={(linkedPaths) => void setProjectPaths(project.id, { linkedPaths })}
      />
      <PathList
        project={project}
        id="copied"
        label="Copy into every new worktree"
        placeholder={'.env\n.env.local'}
        paths={project.copiedPaths}
        save={(copiedPaths) => void setProjectPaths(project.id, { copiedPaths })}
      />
    </>
  )
}

/**
 * One path per line, written on blur.
 *
 * A draft rather than a write per keystroke, for the reason the start-point
 * field keeps one: half a path is a path that does not exist, and a field that
 * wrote through as it went would spend most of its life storing one.
 */
function PathList({
  project,
  id,
  label,
  placeholder,
  paths,
  save
}: {
  project: Project
  id: string
  label: string
  placeholder: string
  paths: readonly string[] | undefined
  save: (paths: string[]) => void
}): React.JSX.Element {
  const stored = (paths ?? []).join('\n')
  const [draft, setDraft] = useState(stored)

  useEffect(() => {
    setDraft(stored)
  }, [stored])

  const commit = (): void => {
    const next = draft
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
    if (next.join('\n') === stored) return
    save(next)
  }

  const fieldId = `settings-${id}-paths-${project.id}`

  return (
    <div className="settings-field">
      <label className="settings-field__label" htmlFor={fieldId}>
        {label}
      </label>
      <textarea
        id={fieldId}
        className="settings-field__input settings-field__input--lines"
        rows={3}
        value={draft}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
      />
    </div>
  )
}

/**
 * Which editor this project's checkouts open in.
 *
 * Held and committed exactly the way the start point above is, and left empty
 * by almost everybody: teamree looks for a short list of editors on PATH by
 * itself, and this field is for the one it has never heard of.
 *
 * It names a program, not a command line. The main process resolves it on PATH
 * and spawns it with the checkout as a single argument, so flags in here are
 * part of a program name that does not exist rather than flags — which is the
 * deliberate half of the bargain: there is no shell anywhere in that path, and
 * a checkout is a directory somebody else may have named.
 */
function EditorCommand({ project }: { project: Project }): React.JSX.Element {
  const stored = useWorkspaceStore((state) => state.editorCommands[project.id] ?? '')
  const editors = useWorkspaceStore((state) => state.editors)
  const setEditorCommand = useWorkspaceStore((state) => state.setEditorCommand)
  const [draft, setDraft] = useState(stored)

  useEffect(() => {
    setDraft(stored)
  }, [stored])

  const commit = (): void => {
    const next = draft.trim()
    if (next === stored) return
    setEditorCommand(project.id, next.length === 0 ? null : next)
  }

  const id = `settings-editor-${project.id}`
  const found = editors?.map((editor) => editor.command).join(', ') ?? ''

  return (
    <div className="settings-field">
      <label className="settings-field__label" htmlFor={id}>
        Open checkouts in
      </label>
      <div className="settings-field__row">
        <input
          id={id}
          className="settings-field__input"
          type="text"
          value={draft}
          placeholder={editors?.[0]?.command ?? 'code'}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              commit()
            }
          }}
        />
        <button
          type="button"
          className="button button--small"
          disabled={stored.length === 0}
          onClick={() => setEditorCommand(project.id, null)}
        >
          Use what is on PATH
        </button>
      </div>
      <p className="settings-note">
        The name of one program, which teamree looks for on PATH and starts with the checkout as its only argument — not
        a command line, so flags here are part of a name rather than flags.{' '}
        {editors === null
          ? 'teamree has not looked yet.'
          : found.length === 0
            ? 'teamree found none of code, cursor, zed, idea or subl on PATH.'
            : `Left empty, teamree uses the first it found: ${found}.`}
      </p>
    </div>
  )
}

/**
 * Where teamwork would dial, read and not written.
 *
 * Setting a relay is a step in the teamwork page's flow, and the flow is the
 * point: it writes a key, writes the relay file, and pushes both, because a
 * relay in a file nobody has pulled is a team meeting in two places. A field
 * here would let somebody do a third of that and believe they were done, so
 * this shows the three facts worth knowing from here — what is being dialled,
 * which of the two places it came from, and whether the environment is beating
 * the file — and then points at the page that can change it.
 */
function RelayBlock({ project }: { project: Project }): React.JSX.Element {
  const relay = useWorkspaceStore((state) => state.relays[project.id])
  const loadRelay = useWorkspaceStore((state) => state.loadRelay)
  const openTeamwork = useWorkspaceStore((state) => state.openTeamwork)

  useEffect(() => {
    void loadRelay(project.id)
  }, [loadRelay, project.id])

  const panel = relayPanel(relay)

  return (
    <div className="settings-relay">
      <h4 className="settings-relay__title">Relay</h4>
      <p className="settings-fact">{panel.headline}</p>
      {panel.detail ? <p className="settings-note">{panel.detail}</p> : null}
      {panel.override ? <p className="settings-warning">{panel.override}</p> : null}
      <div className="settings-actions">
        <button type="button" className="button button--small" onClick={() => openTeamwork(project.id)}>
          Open teamwork for {project.name}
        </button>
      </div>
    </div>
  )
}
