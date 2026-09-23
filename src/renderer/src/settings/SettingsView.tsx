// The settings page: machine-level facts (PATH, updates, text size, checkouts), so it takes the main
// area rather than a drawer. Colours and relays are read here and set where they already live.

import { useEffect, useRef, useState } from 'react'
import { agentLaunchCommand } from '@shared/agentLaunch'
import type { InstalledAgent, Project } from '@shared/entities'
import { cliOutcome } from '../dialogs/cliInstallModel'
import type { PlatformModifier } from '../keyboard/platformModifier'
import { shortcutHint } from '../keyboard/workspaceShortcuts'
import {
  NO_DEFAULT_AGENT,
  TERMINAL_FONT_MAX_PX,
  TERMINAL_FONT_MIN_PX,
  type AgentNoticePreference
} from '../state/preferences'
import { useNow } from '../state/useNow'
import { modalOnScreen } from '../dialogs/modalLayer'
import { useWorkspaceStore } from '../state/workspaceStore'
import { cliLine, relayPanel, updatePanel } from './settingsModel'

export function SettingsView({ modifier }: { modifier: PlatformModifier }): React.JSX.Element {
  const projects = useWorkspaceStore((state) => state.projects)
  const toggleSettings = useWorkspaceStore((state) => state.toggleSettings)
  const loadCli = useWorkspaceStore((state) => state.loadCli)
  const loadUpdate = useWorkspaceStore((state) => state.loadUpdate)

  // Read again on open: both are facts about the world outside this window that may have moved.
  useEffect(() => {
    void loadCli()
    void loadUpdate()
  }, [loadCli, loadUpdate])

  // Capture phase, so a focused pane cannot eat Escape first.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      // Anything modal on top owns Escape. `modalOnScreen`, not `dialog`: a remote-keystrokes
      // question is not in `dialog` and would otherwise have the page close under its scrim.
      if (modalOnScreen(useWorkspaceStore.getState())) return
      event.preventDefault()
      toggleSettings()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [toggleSettings])

  // Opened from a button elsewhere, so focus has to follow; the region, so the first Tab lands on
  // the first section and the page's name is read out.
  const region = useRef<HTMLElement>(null)
  useEffect(() => {
    region.current?.focus()
  }, [])

  // Opened at a section — the strip's "Agent settings…" — the page scrolls
  // there once and forgets the request, so the next plain open starts at the top.
  const section = useWorkspaceStore((state) => state.settingsSection)
  useEffect(() => {
    if (section === null) return
    document.getElementById(`settings-${section}`)?.scrollIntoView({ block: 'start' })
    useWorkspaceStore.setState({ settingsSection: null })
  }, [section])

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
          <AgentsSection />
          <AppearanceSection modifier={modifier} />
          <ProjectsSection projects={projects} />
        </div>
      </div>
    </main>
  )
}

/** The `teamree` command and whether a terminal can find it; the judgement is `cliInstallModel`'s. */
function CliSection(): React.JSX.Element {
  const status = useWorkspaceStore((state) => state.cli)
  const pending = useWorkspaceStore((state) => state.cliPending)
  const install = useWorkspaceStore((state) => state.cliInstall)
  const error = useWorkspaceStore((state) => state.cliError)
  const installCli = useWorkspaceStore((state) => state.installCli)

  const line = cliLine(status)

  return (
    <section className="settings-section" aria-labelledby="settings-cli">
      <h2 className="settings-section__title" id="settings-cli">
        teamree on your PATH
      </h2>
      <p className="settings-fact settings-fact--mono">{line.state}</p>

      {line.manual ? (
        <pre className="settings-command">
          <code>{line.manual}</code>
        </pre>
      ) : null}

      {/* The refusal stays where the button that caused it is: a file in the
          way and a password not given are both things somebody is about to try
          again from here. */}
      {error ? <p className="settings-error">{error}</p> : null}
      {install && error === null ? <p className="settings-done">{cliOutcome(install)}</p> : null}

      {line.action ? (
        <div className="settings-actions">
          <button
            type="button"
            className="button button--primary"
            disabled={pending}
            title={line.title ?? undefined}
            onClick={() => void installCli()}
          >
            {pending ? 'Linking…' : line.action}
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

  // "Last checked" changes while nothing happens, so the page re-renders itself.
  const now = useNow()
  const panel = updatePanel(update, now)

  return (
    <section className="settings-section" aria-labelledby="settings-updates">
      <h2 className="settings-section__title" id="settings-updates">
        Updates
      </h2>
      <p className="settings-fact">{panel.headline}</p>

      {panel.offersCheck ? (
        <>
          <label className="settings-check">
            <input
              type="checkbox"
              checked={update?.automatic ?? false}
              onChange={(event) => void setAutomaticUpdates(event.target.checked)}
            />
            {/* What this arms, for whoever reads the file rather than the page:
                the runtime makes its first check half a minute after startup
                and one every six hours after that, for as long as the window is
                open. That was the label once, and a label is not the place for
                a schedule — the checkbox is called what it does. */}
            <span>Check automatically</span>
          </label>

          <div className="settings-actions">
            <button
              type="button"
              className="button button--small"
              disabled={update?.checking ?? false}
              onClick={() => void checkForUpdates()}
            >
              {update?.checking ? 'Checking…' : 'Check for updates'}
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

/** What an agent that has stopped may do when you are not looking at the window. */
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
      {/* No line under the slider saying the size is remembered on this machine
          only. It is — see `state/preferences.ts` — and it is true of every
          other per-machine preference on this page as well, none of which says
          so either. */}
    </section>
  )
}

/**
 * Which agent you always use and what you pass it; per machine, shown only when the probe found one.
 * Nothing is seeded: no autonomy flag is pre-applied by default.
 */
function AgentsSection(): React.JSX.Element | null {
  const agents = useWorkspaceStore((state) => state.agents)
  const defaultAgent = useWorkspaceStore((state) => state.defaultAgent)
  const setDefaultAgent = useWorkspaceStore((state) => state.setDefaultAgent)

  if (agents.length === 0) return null

  return (
    <section className="settings-section" aria-labelledby="settings-agents">
      <h2 className="settings-section__title" id="settings-agents">
        Agents
      </h2>

      <div className="settings-field">
        <label className="settings-field__label" htmlFor="settings-default-agent">
          Default agent
        </label>
        <select
          id="settings-default-agent"
          className="settings-field__input settings-field__input--select"
          value={defaultAgent}
          onChange={(event) => setDefaultAgent(event.target.value)}
        >
          {/* The no-preference value is the rule that was here before there was
              a preference, named after what it does rather than left blank. */}
          <option value={NO_DEFAULT_AGENT}>First found</option>
          {agents.map((agent) => (
            <option key={agent.kind} value={agent.kind}>
              {agent.command}
            </option>
          ))}
        </select>
      </div>

      {agents.map((agent) => (
        <AgentArguments key={agent.kind} agent={agent} />
      ))}
    </section>
  )
}

/**
 * One agent's launch arguments, with the command `@shared/agentLaunch` builds from them shown underneath.
 * The runtime's session selector is left out: it is not what this field controls.
 */
function AgentArguments({ agent }: { agent: InstalledAgent }): React.JSX.Element {
  const stored = useWorkspaceStore((state) => state.agentArgs[agent.kind] ?? '')
  const setAgentArgs = useWorkspaceStore((state) => state.setAgentArgs)
  const [draft, setDraft] = useState(stored)

  // The stored value moving puts the trimmed spelling back, including when changed from elsewhere.
  useEffect(() => {
    setDraft(stored)
  }, [stored])

  const commit = (): void => {
    const next = draft.trim()
    if (next === stored) return
    setAgentArgs(agent.kind, next.length === 0 ? null : next)
  }

  const id = `settings-agent-args-${agent.kind}`

  return (
    <div className="settings-field">
      <label className="settings-field__label" htmlFor={id}>
        {agent.command}
      </label>
      <input
        id={id}
        className="settings-field__input"
        type="text"
        value={draft}
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
      <code className="settings-command">{agentLaunchCommand(agent.command, draft)}</code>
    </div>
  )
}

/** One row and a button to the existing colour editor; a second set of swatches would drift. */
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
          // No chord (⌘, is the settings page's) and no empty tooltip, which flickers open over nothing.
          title={shortcutHint('open-appearance', modifier) || undefined}
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

/** Which ref the New task dialog offers first; a draft written on blur, since half a ref resolves to nothing. */
function StartPoint({ project }: { project: Project }): React.JSX.Element {
  const stored = useWorkspaceStore((state) => state.startPointDefaults[project.id] ?? '')
  const setStartPointDefault = useWorkspaceStore((state) => state.setStartPointDefault)
  const [draft, setDraft] = useState(stored)

  // The stored value moving puts the trimmed spelling back, including when changed from elsewhere.
  useEffect(() => {
    setDraft(stored)
  }, [stored])

  const commit = (): void => {
    const next = draft.trim()
    if (next === stored) return
    // Null, not '': `withStartPoint` removes the entry on null, the only spelling of "use the base ref".
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
      {/* No caption. What this sets is what the New task dialog offers first,
          and the buttons above say so by naming the ref they would use; the
          repository's own base ref is untouched, which is `startPointModel.ts`'s
          business rather than a reassurance to print here. */}
    </div>
  )
}

/** What a new worktree of this project gets that the branch does not carry, and its setup command. */
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
      <SetupCommand project={project} />
    </>
  )
}

/** The one setup command a new worktree runs, stored and typed into the pane verbatim. */
function SetupCommand({ project }: { project: Project }): React.JSX.Element {
  const setProjectPaths = useWorkspaceStore((state) => state.setProjectPaths)
  const stored = project.setupCommand ?? ''
  const [draft, setDraft] = useState(stored)

  useEffect(() => {
    setDraft(stored)
  }, [stored])

  const commit = (): void => {
    const next = draft.trim()
    if (next === stored) return
    void setProjectPaths(project.id, { setupCommand: next })
  }

  const id = `settings-setup-${project.id}`

  return (
    <div className="settings-field">
      <label className="settings-field__label" htmlFor={id}>
        Setup command
      </label>
      <input
        id={id}
        className="settings-field__input"
        type="text"
        value={draft}
        placeholder="npm ci"
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
    </div>
  )
}

/** One path per line, written on blur: half a path is a path that does not exist. */
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
 * Which editor this project's checkouts open in, when teamree's own PATH search misses it.
 * A program name, not a command line: it is spawned without a shell, the checkout as one argument.
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
      {/* The field takes the name of one program, which teamree looks for on
          PATH and starts with the checkout as its only argument. It is not a
          command line: flags typed here are part of a name rather than flags.
          That is the field's contract and it belongs here rather than on the
          page — what is left on the page is the one thing the reader cannot
          work out from the control, which is what this machine actually has. */}
      <p className="settings-note">
        {editors === null
          ? 'Looking…'
          : found.length === 0
            ? 'None of code, cursor, zed, idea or subl on PATH'
            : `On PATH: ${found}`}
      </p>
    </div>
  )
}

/**
 * Where teamwork would dial, read only: setting a relay is a step in the teamwork flow (key, file, push).
 * Shows what is dialled, which of the two sources it came from, and whether the env beats the file.
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
