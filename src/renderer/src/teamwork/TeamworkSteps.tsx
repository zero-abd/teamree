// Setting teamwork up, as five one-line steps with only the next one open. Nothing
// acts silently, nothing is enabled that cannot work, and teamree still runs no relay.

import { useEffect, useId, useRef, useState } from 'react'
import {
  teamworkFacts,
  type Member,
  type MemberList,
  type PeerLink,
  type PushFailureKind,
  type RelaySetting,
  type TeamworkPublish,
  type TeamworkPublishPlan,
  type TeamworkStatus
} from '@shared/entities'
import {
  ADD_KEY_BUTTON,
  brokenRelayOverride,
  CANCEL_PUBLISH_BUTTON,
  checkOriginDraft,
  checkRelayDraft,
  COPY_INVITE_BUTTON,
  formatElapsed,
  inviteText,
  KEY_GRANT_WARNING,
  memberFilePreview,
  MORE_RELAYS_BUTTON,
  MORE_RELAYS_LEAD,
  ORIGIN_DETAIL,
  PASTE_RELAY_BUTTON,
  PUBLISH_BUTTON,
  publishActivity,
  pushPlan,
  RELAY_CHECK,
  RELAY_DEPLOY,
  RELAY_LAUNCHER_UNKNOWN,
  RELAY_OPTIONS,
  RELAY_PANE_NO_URL,
  RELAY_PANE_TITLES,
  RELAY_SERVE,
  RELAY_SERVE_STOPPED,
  relayLauncherCommand,
  relayPaneBusy,
  RETRY_PUBLISH_BUTTON,
  retryHint,
  shortKey,
  startTeamworkFlow,
  suggestedPath,
  TEAMWORK_PATHS,
  type OriginState,
  type PublishState,
  type RelayDraftCheck,
  type RelayOption,
  type RelayPaneKind,
  type RelayPaneState,
  type StartTeamworkRead,
  type StartTeamworkReadErrors,
  type StartTeamworkStep,
  type StepId,
  type StepMark,
  type TeamworkPath
} from './startTeamwork'

export type TeamworkStepsProps = {
  /** Primary checkout, so step 4's commands run where `.teamree` is; undefined leaves the `cd` off. */
  projectPath: string | undefined
  list: MemberList | undefined
  relay: RelaySetting | undefined
  status: TeamworkStatus | undefined
  membersPending: boolean
  /** Why the last attempt to add this machine's key was refused, or null. */
  membersError: string | null
  relayPending: boolean
  relayError: string | null
  /** Why each of the three reads behind this panel failed, for the ones that did. */
  readErrors: StartTeamworkReadErrors
  onJoin: (handle?: string) => void
  /** Called on the keystroke that answers a refusal, so it stops being shown. */
  onClearMembersError: () => void
  onSetRelay: (url: string) => void
  /** Asks for one of the three reads again, from the step that reported it. */
  onRetry: (read: StartTeamworkRead) => void

  /** Whether the origin button is busy, and what git last said when it refused. */
  origin: OriginState
  /** Points this checkout's `origin` at a URL. Validated before it is called. */
  onSetOrigin: (url: string) => void

  /** The relay command running in a pane in this window; one slot shared by all three verbs. */
  pane: RelayPaneState | undefined
  /**
   * Runs a launcher verb in a pane. Disabled, with a sentence beside it, when the build carries no
   * relay (`relay.deploy.command` is null), the command is not a swappable shape, or a pane is open.
   */
  onStartRelayPane: (kind: RelayPaneKind, argument?: string) => void
  /** Closes the pane. */
  onClosePane: () => void
  /** Renders the pane. A slot, because the component is xterm and this file must render in a test without a canvas. */
  renderRelayPane: (terminalId: string) => React.ReactNode

  /** What the commit-and-push button would do, is doing, and last did. */
  publish: PublishState
  onPublish: () => void
  /** Stops a push that is running. Always offered while one is. */
  onCancelPublish: () => void

  /** Which of the two jobs this is, or null while nobody has said. */
  path: TeamworkPath | null
  onChoosePath: (path: TeamworkPath | null) => void
  /** The project's name, for the invitation to say what it is an invitation to. */
  projectName: string
  /** Puts text on the clipboard. A prop, so the file renders in a test without the browser's permission model. */
  onCopy: (text: string) => void
  /** Now, as the panel measures it. Passed in so a test can assert the durations. */
  now?: number
}

/** A glyph for the eye; `MARK_WORDS` is what is read out. */
const MARK_GLYPHS: Record<StepMark, string> = { done: '✓', 'this-run': '✓', todo: '○', unchecked: '—', blocked: '!' }

const MARK_WORDS: Record<StepMark, string> = {
  done: 'done',
  // A tick with a caveat: the override the tunnel option recommends is not committed.
  'this-run': 'done for this run',
  todo: 'not done yet',
  // Never a tick nor a cross: teamree cannot see a commit.
  unchecked: 'yours to do — teamree does not check this',
  blocked: 'blocked'
}

/** The steps, apart from the dialog that wires them to the store, so every state can be rendered in a test. */
export function TeamworkSteps(props: TeamworkStepsProps): React.JSX.Element {
  const flow = startTeamworkFlow({
    list: props.list,
    relay: props.relay,
    status: props.status,
    failedReads: props.readErrors,
    path: props.path,
    publish: props.publish.result
  })
  // Undefined until a step is clicked: then the next step to do, or Connected once a teammate is.
  const [opened, setOpened] = useState<StepId | null | undefined>(undefined)
  const open = opened === undefined ? (flow.currentId ?? 'connected') : opened
  // Somebody already connected is not asked what they came here to do.
  const asking = props.path === null && flow.currentId !== null
  const origin = teamworkFacts(props.status)?.origin
  const invite = inviteText({
    originUrl: origin?.ok === true ? origin.url : null,
    relayUrl: props.relay?.url ?? null,
    projectName: props.projectName,
    handle: props.list?.self.handle ?? null
  })

  return (
    <div className="steps">
      {flow.blocker === null ? null : (
        <div className="steps__blocker">
          <p className="steps__blocker-lead">
            <strong>{flow.blocker}</strong>
          </p>
          {origin?.ok === false ? <OriginFix origin={props.origin} onSetOrigin={props.onSetOrigin} /> : null}
        </div>
      )}
      {asking ? (
        <PathChoice list={props.list} relay={props.relay} onChoose={props.onChoosePath} />
      ) : (
        <>
          {props.path === null ? null : <ChosenPath path={props.path} onChange={() => props.onChoosePath(null)} />}
          <ol className="steps__list">
            {flow.steps.map((step) => {
              const expanded = step.id === open
              return (
                <li
                  key={step.id}
                  className={`step step--${step.mark}${expanded ? ' step--open' : ''}`}
                  data-step={step.id}
                >
                  <h3 className="step__head">
                    <button
                      type="button"
                      className="step__toggle"
                      aria-expanded={expanded}
                      onClick={() => setOpened(expanded ? null : step.id)}
                    >
                      <span className="step__mark" role="img" aria-label={MARK_WORDS[step.mark]}>
                        {MARK_GLYPHS[step.mark]}
                      </span>
                      <span className="step__title">{step.title}</span>
                    </button>
                  </h3>
                  {expanded ? (
                    <>
                      <p className="step__summary">{step.summary}</p>
                      <StepBody step={step} {...props} />
                    </>
                  ) : null}
                </li>
              )
            })}
          </ol>
          {/* Once this machine is on the roster there is something to invite somebody to. */}
          {invite === null || props.path === 'join' || props.list?.enrolled !== true ? null : (
            <Invite invite={invite} onCopy={props.onCopy} />
          )}
        </>
      )}
    </div>
  )
}

/** Which of the two jobs this is: two buttons, the one the repository points at primary, and taken by neither. */
function PathChoice({
  list,
  relay,
  onChoose
}: {
  list: MemberList | undefined
  relay: RelaySetting | undefined
  onChoose: (path: TeamworkPath) => void
}): React.JSX.Element {
  const suggestion = suggestedPath(list, relay) ?? { id: 'start', because: null }
  return (
    <div className="path-choice">
      <div className="path-choice__buttons">
        {TEAMWORK_PATHS.map((option) => (
          <button
            key={option.id}
            type="button"
            className={option.id === suggestion.id ? 'button button--primary' : 'button'}
            onClick={() => onChoose(option.id)}
          >
            {option.button}
          </button>
        ))}
      </div>
      {suggestion.because === null ? null : <p className="path-choice__because">{suggestion.because}</p>}
    </div>
  )
}

/** The answer, kept on screen and changeable. */
function ChosenPath({ path, onChange }: { path: TeamworkPath; onChange: () => void }): React.JSX.Element {
  const chosen = TEAMWORK_PATHS.find((option) => option.id === path) as (typeof TEAMWORK_PATHS)[number]
  return (
    <div className="chosen-path">
      <p className="chosen-path__line">
        <span className="chosen-path__label">{chosen.title}</span>
      </p>
      <button type="button" className="button button--small" onClick={onChange}>
        Back
      </button>
    </div>
  )
}

function StepBody({ step, ...props }: TeamworkStepsProps & { step: StartTeamworkStep }): React.JSX.Element | null {
  switch (step.id) {
    case 'identity':
      if (props.list === undefined) {
        return props.readErrors.list === undefined ? null : <ReadFailure onRetry={() => props.onRetry('list')} />
      }
      return <IdentityBody list={props.list} />
    case 'key':
      // No retry here: it is the same read as step 1's.
      return step.mark === 'done' || props.list === undefined ? null : (
        <JoinBody
          list={props.list}
          pending={props.membersPending}
          error={props.membersError}
          onJoin={props.onJoin}
          onClearError={props.onClearMembersError}
        />
      )
    case 'relay':
      if (props.relay === undefined) {
        return props.readErrors.relay === undefined ? null : <ReadFailure onRetry={() => props.onRetry('relay')} />
      }
      return (
        <RelayBody
          path={props.path}
          relay={props.relay}
          // A relay already chosen is the decision taken; the options are not offered again.
          options={step.mark !== 'done' && step.mark !== 'this-run'}
          pending={props.relayPending}
          error={props.relayError}
          onSet={props.onSetRelay}
          pane={props.pane}
          onStartRelayPane={props.onStartRelayPane}
          onClosePane={props.onClosePane}
          renderRelayPane={props.renderRelayPane}
        />
      )
    case 'push':
      return (
        <PushBody
          list={props.list}
          relay={props.relay}
          projectPath={props.projectPath}
          publish={props.publish}
          onPublish={props.onPublish}
          onCancelPublish={props.onCancelPublish}
          now={props.now ?? Date.now()}
        />
      )
    case 'connected':
      if (props.status === undefined && props.readErrors.status !== undefined) {
        return <ReadFailure onRetry={() => props.onRetry('status')} />
      }
      return <ConnectedBody list={props.list} status={props.status} />
  }
}

/** The way out of a read that threw. What failed is already the step's summary, so this is only the button. */
function ReadFailure({ onRetry }: { onRetry: () => void }): React.JSX.Element {
  return (
    <div className="step__body">
      <button type="button" className="button" onClick={onRetry}>
        Try Again
      </button>
    </div>
  )
}

/** The identity itself: a name on a file, and the key that is the real one. */
function IdentityBody({ list }: { list: MemberList }): React.JSX.Element {
  return (
    <p className="step__identity">
      <span className="step__identity-handle">{list.self.handle ?? 'no handle yet'}</span>
      <code className="member__key" title={list.self.publicKey}>
        {shortKey(list.self.publicKey)}
      </code>
    </p>
  )
}

/** What a key grants, then the button that grants it: `docs/teamwork.md` calls this remote code execution by design. */
function JoinBody({
  list,
  pending,
  error,
  onJoin,
  onClearError
}: {
  list: MemberList
  pending: boolean
  error: string | null
  onJoin: (handle?: string) => void
  onClearError: () => void
}): React.JSX.Element {
  const [handle, setHandle] = useState('')
  const chosen = handle.trim() || list.self.handle
  // The runtime files this under a different name: `Ada Lovelace` becomes `ada-lovelace.pub`.
  const file = memberFilePreview(list, handle)

  const submit = (event: React.FormEvent): void => {
    event.preventDefault()
    onJoin(handle.trim() || undefined)
  }

  return (
    <div className="step__body">
      <p className="grant">{KEY_GRANT_WARNING}</p>
      <form className="members__self members__self--join" onSubmit={submit}>
        <label className="field">
          <span className="field__label">Handle</span>
          <input
            className="field__input field__input--mono"
            value={handle}
            onChange={(event) => {
              setHandle(event.target.value)
              // The refusal named this box; answering it is what makes it stale.
              onClearError()
            }}
            placeholder={list.self.handle ?? 'pick a name'}
            aria-invalid={error !== null}
            autoComplete="off"
            spellCheck={false}
          />
          <span className="field__hint">{hintFor(list, handle, file)}</span>
        </label>
        {/* Under the field: every refusal here ends in "choose another handle". */}
        {error === null ? null : <p className="field__error">{error}</p>}
        <button type="submit" className="button button--primary" disabled={pending || chosen === null}>
          {pending ? 'Writing…' : ADD_KEY_BUTTON}
        </button>
      </form>
    </div>
  )
}

/** What the field says it will do, for each of the three things it can be told. */
function hintFor(list: MemberList, typed: string, file: string | null): string {
  if (file !== null) return `Writes ${file}`
  return typed.trim() === ''
    ? 'No git user.email · lowercase, [a-z0-9._-]'
    : 'Not a valid handle · lowercase, [a-z0-9._-]'
}

/**
 * The remote everybody shares, as a field and a button. A path origin is accepted and told what
 * the other Mac must match while the string is still on screen: nothing can check that afterwards.
 */
function OriginFix({ origin, onSetOrigin }: { origin: OriginState; onSetOrigin: (url: string) => void }) {
  const [draft, setDraft] = useState('')
  const [why, setWhy] = useState(false)
  // Aimed at the refusal, so a screen reader hears why a URL was rejected rather than a button description on every focus.
  const hint = useId()
  const check = checkOriginDraft(draft)
  // What the field refused beats what git last said: the older message is about a URL no longer in the box.
  const refusal = check.state === 'bad' ? check.reason : draft.trim() === '' ? origin.error : null

  const submit = (event: React.FormEvent): void => {
    event.preventDefault()
    if (check.state === 'ok') onSetOrigin(check.url)
  }

  return (
    <form className="origin-fix" onSubmit={submit}>
      <label className="field">
        <span className="field__label">Origin</span>
        <input
          className="field__input field__input--mono"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="git@github.com:org/repo.git"
          aria-invalid={refusal !== null}
          aria-describedby={refusal === null ? undefined : hint}
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      {refusal === null ? null : (
        <p className="field__error" id={hint}>
          {refusal}
        </p>
      )}
      {/* A note, not a refusal: this origin works, on terms. */}
      {check.state === 'ok' && check.note !== null ? <p className="field__note">{check.note}</p> : null}
      <button type="submit" className="button button--primary" disabled={origin.pending || check.state !== 'ok'}>
        {origin.pending ? 'Adding…' : 'Add Origin'}
      </button>
      <div className="disclosure">
        <button
          type="button"
          className="button button--small"
          aria-expanded={why}
          onClick={() => setWhy((open) => !open)}
        >
          <span className="disclosure__caret" aria-hidden="true">
            {why ? '▾' : '▸'}
          </span>
          Requirements
        </button>
        {why ? <p className="disclosure__body">{ORIGIN_DETAIL}</p> : null}
      </div>
    </form>
  )
}

/** Why a launcher button cannot be pressed, or null: no relay in this build, an unswappable command, or a pane already open. */
function launcherBlocked(relay: RelaySetting, derived: string | null, pane: RelayPaneState | undefined): string | null {
  if (relay.deploy.command === null) return relay.deploy.reason
  if (derived === null) return RELAY_LAUNCHER_UNKNOWN
  if (pane !== undefined) return relayPaneBusy(pane.kind)
  return null
}

/**
 * The relay: Deploy a Relay, Paste URL… and More, which holds running one here, the commands and
 * every other way. A relay already chosen is shown with its check and none of the options.
 */
function RelayBody({
  path,
  relay,
  options,
  pending,
  error,
  onSet,
  pane,
  onStartRelayPane,
  onClosePane,
  renderRelayPane
}: {
  path: TeamworkPath | null
  relay: RelaySetting
  /** Whether the other ways to get a relay are still a decision to make. */
  options: boolean
  pending: boolean
  error: string | null
  onSet: (url: string) => void
  pane: RelayPaneState | undefined
  onStartRelayPane: (kind: RelayPaneKind, argument?: string) => void
  onClosePane: () => void
  renderRelayPane: (terminalId: string) => React.ReactNode
}): React.JSX.Element {
  const [pasting, setPasting] = useState(false)
  const [more, setMore] = useState(false)
  const deployBlocked = launcherBlocked(relay, relay.deploy.command, pane)

  return (
    <div className="step__body">
      {/* A joiner who finds no relay is ahead of whoever invited them; standing a second one up is the wrong answer. */}
      {path === 'join' && relay.onDisk.url === null ? (
        <p className="relay-waiting">{relay.file} not pushed yet · pull again soon</p>
      ) : null}
      {/* An unreadable override, said first: everything else here is about a relay the app will not dial. */}
      {brokenRelayOverride(relay) === null ? null : (
        <p className="relay-broken-override">{brokenRelayOverride(relay)}</p>
      )}
      {relay.url === null ? null : (
        <>
          <p className="members__relay-current">
            <code>{relay.url}</code>
            <span className="members__relay-source">
              {relay.source === 'environment' ? `from ${relay.override.name}` : `from ${relay.file}`}
            </span>
          </p>
          <RelayCheck url={relay.url} relay={relay} pane={pane} onStart={onStartRelayPane} />
        </>
      )}
      <div className="relay-actions">
        {options ? (
          <button
            type="button"
            className="button button--primary"
            disabled={deployBlocked !== null}
            title={RELAY_DEPLOY.browser}
            onClick={() => onStartRelayPane('deploy')}
          >
            {RELAY_DEPLOY.button}
          </button>
        ) : null}
        <button type="button" className="button" aria-expanded={pasting} onClick={() => setPasting((shown) => !shown)}>
          {PASTE_RELAY_BUTTON}
        </button>
        {options ? (
          <button
            type="button"
            className="button button--ghost"
            aria-expanded={more}
            onClick={() => setMore((shown) => !shown)}
          >
            {MORE_RELAYS_BUTTON}
          </button>
        ) : null}
      </div>
      {/* Why Deploy cannot be pressed, beside it. */}
      {options && deployBlocked !== null ? <p className="relay-deploy__blocked">{deployBlocked}</p> : null}
      {pane?.kind === 'deploy' && pane.url === null ? (
        <p className="relay-deploy__note">{RELAY_DEPLOY.watching}</p>
      ) : null}
      {pane === undefined ? null : (
        <RelayPaneBlock pane={pane} pending={pending} onUse={onSet} onClose={onClosePane} render={renderRelayPane} />
      )}
      {pasting ? (
        <RelayDraft
          relay={relay}
          pending={pending}
          error={error}
          onSet={onSet}
          pane={pane}
          onStart={onStartRelayPane}
        />
      ) : null}
      {options && more ? <RelayMore relay={relay} pane={pane} onStart={onStartRelayPane} /> : null}
      <Override relay={relay} />
    </div>
  )
}

/** The field that writes a relay down, and the check that dials what was typed before it is written. */
function RelayDraft({
  relay,
  pending,
  error,
  onSet,
  pane,
  onStart
}: {
  relay: RelaySetting
  pending: boolean
  error: string | null
  onSet: (url: string) => void
  pane: RelayPaneState | undefined
  onStart: (kind: RelayPaneKind, argument?: string) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const check = checkRelayDraft(draft)

  const submit = (event: React.FormEvent): void => {
    event.preventDefault()
    if (check.state === 'ok') onSet(check.url)
  }

  return (
    <form className="members__relay" onSubmit={submit}>
      <label className="field">
        <span className="field__label">Relay URL</span>
        <input
          className="field__input field__input--mono"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="wss://your-relay.example/v1/relay"
          autoComplete="off"
          spellCheck={false}
          autoFocus
        />
        <span className="field__hint">
          {relay.onDisk.url === null ? 'Writes' : 'Replaces'} <code>{relay.file}</code>
        </span>
      </label>
      {check.state === 'bad' ? <RelayRefusal check={check} onUse={setDraft} /> : null}
      {error === null ? null : <p className="members__relay-error">{error}</p>}
      <div className="relay-draft__controls">
        <button type="submit" className="button" disabled={pending || check.state !== 'ok'}>
          {pending ? 'Writing…' : 'Write Relay File'}
        </button>
        {/* Checking before it is written: cheaper than a dead address in everybody's repository. */}
        <RelayCheck
          url={check.state === 'ok' ? check.url : null}
          label={RELAY_CHECK.draftButton}
          relay={relay}
          pane={pane}
          onStart={onStart}
        />
      </div>
    </form>
  )
}

/**
 * Behind More: a relay on this Mac (its limit beside the button), the commands this build runs, and
 * the ways that need a clone or a machine of your own.
 */
function RelayMore({
  relay,
  pane,
  onStart
}: {
  relay: RelaySetting
  pane: RelayPaneState | undefined
  onStart: (kind: RelayPaneKind) => void
}): React.JSX.Element {
  const serve = relay.deploy.command === null ? null : relayLauncherCommand(relay.deploy.command, 'serve')
  const blocked = launcherBlocked(relay, serve, pane)
  return (
    <div className="relay-more">
      <div className="relay-serve">
        <button type="button" className="button" disabled={blocked !== null} onClick={() => onStart('serve')}>
          {RELAY_SERVE.button}
        </button>
        <span className="relay-serve__limit">{RELAY_SERVE.limit}</span>
      </div>
      {blocked === null ? null : <p className="relay-deploy__blocked">{blocked}</p>}
      {pane?.kind === 'serve' ? <p className="relay-deploy__note">{RELAY_SERVE.watching}</p> : null}
      {relay.deploy.command === null ? null : (
        <pre className="relay-option__commands">{[relay.deploy.command, serve].filter(Boolean).join('\n')}</pre>
      )}
      <p className="relay-options__lead">{MORE_RELAYS_LEAD}</p>
      <ul className="relay-options__list">
        {RELAY_OPTIONS.map((option) => (
          <RelayOptionCard key={option.id} option={option} />
        ))}
      </ul>
      {relay.override.value === null ? (
        <p className="relay-more__env">
          <code>{relay.override.name}</code> not in this app’s environment · Finder launches do not inherit your shell’s
        </p>
      ) : null}
    </div>
  )
}

/**
 * Dials a relay and says what answered. Offered beside the configured URL and beside the typed one.
 * A pass is a fact about this Mac's network only, and the note beside the button says so.
 */
function RelayCheck({
  url,
  label = RELAY_CHECK.button,
  relay,
  pane,
  onStart
}: {
  /** The URL to dial, or null when there is nothing typed or configured yet. */
  url: string | null
  /** Its name. Two can be on screen dialling different addresses, so they may not share one. */
  label?: string
  relay: RelaySetting
  pane: RelayPaneState | undefined
  onStart: (kind: RelayPaneKind, argument?: string) => void
}): React.JSX.Element {
  const command =
    relay.deploy.command === null || url === null ? null : relayLauncherCommand(relay.deploy.command, 'check', url)
  const blocked = url === null ? null : launcherBlocked(relay, command, pane)
  return (
    <span className="relay-check">
      <button
        type="button"
        className="button button--small"
        disabled={url === null || blocked !== null}
        onClick={() => onStart('check', url as string)}
      >
        {label}
      </button>
      {/* Nothing typed is not a fault: the button is grey and says nothing more. */}
      {url === null ? null : blocked === null ? (
        <span className="relay-check__note">{RELAY_CHECK.proves}</span>
      ) : (
        <span className="relay-check__blocked">{blocked}</span>
      )}
    </span>
  )
}

/**
 * The one pane, whatever is in it. A URL is offered out of it for a deploy, and for a serve only while
 * it runs: an exited serve is a closed port, and a check echoes its own input (its scrollback contains
 * `teamree-relay: dialling ws://…`, so this refuses it even though the store never scrapes a check).
 */
function RelayPaneBlock({
  pane,
  pending,
  onUse,
  onClose,
  render
}: {
  pane: RelayPaneState
  pending: boolean
  onUse: (url: string) => void
  onClose: () => void
  render: (terminalId: string) => React.ReactNode
}): React.JSX.Element {
  const live = pane.kind !== 'check' && (pane.kind !== 'serve' || pane.running)
  const url = live ? pane.url : null
  // Every other address this Mac printed, for the person who knows which one teammates can reach.
  // Serve only: a second URL in a deploy pane is a second deploy.
  const alternatives = pane.kind === 'serve' && url !== null ? pane.urls.filter((other) => other !== url) : []
  return (
    <div className="relay-deploy__pane">
      <p className="relay-pane__title">{RELAY_PANE_TITLES[pane.kind]}</p>
      {url === null ? null : (
        <>
          <p className="relay-deploy__found">
            {pane.kind === 'deploy' ? 'Deployed at' : 'Relay at'} <code>{url}</code>{' '}
            <button
              type="button"
              className="button button--primary button--small"
              disabled={pending}
              onClick={() => onUse(url)}
            >
              {pane.kind === 'deploy' ? RELAY_DEPLOY.use : RELAY_SERVE.use}
            </button>
          </p>
          {alternatives.length === 0 ? null : (
            <div className="relay-deploy__addresses">
              <p className="relay-deploy__limit">{RELAY_SERVE.choice}</p>
              <ul className="relay-deploy__address-list">
                {alternatives.map((other) => (
                  <li key={other}>
                    <code>{other}</code>{' '}
                    <button
                      type="button"
                      className="button button--small"
                      disabled={pending}
                      onClick={() => onUse(other)}
                    >
                      Use {other}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {/* Not a refusal: a private address is right for a team all on that network, and only the reader knows. */}
          {pane.kind === 'serve' ? <p className="relay-deploy__limit">{RELAY_SERVE.committing}</p> : null}
        </>
      )}
      {url !== null || pane.running || pane.kind === 'check' ? null : (
        <p className="relay-deploy__limit">
          {pane.kind === 'serve' && pane.url !== null ? RELAY_SERVE_STOPPED : RELAY_PANE_NO_URL}
        </p>
      )}
      <div className="relay-deploy__terminal">{render(pane.terminalId)}</div>
      <button type="button" className="button button--small" onClick={onClose}>
        {pane.running ? 'Stop and Close' : 'Close'}
      </button>
    </div>
  )
}

/**
 * Why the typed address was refused, or the corrected one as a button rather than substituted:
 * host-plus-path is a guess, and wrong on the one deployment whose relay is not at the root.
 */
function RelayRefusal({
  check,
  onUse
}: {
  check: Extract<RelayDraftCheck, { state: 'bad' }>
  onUse: (url: string) => void
}): React.JSX.Element {
  const { suggestion } = check
  return (
    <p className="members__relay-error">
      {/* The button names the fix; the reason would say it twice. */}
      {suggestion === null ? (
        check.reason
      ) : (
        <button type="button" className="button button--ghost" onClick={() => onUse(suggestion)}>
          Use {suggestion}
        </button>
      )}
    </p>
  )
}

/** One way to get a relay, with what it costs and where its address belongs. */
function RelayOptionCard({ option }: { option: RelayOption }): React.JSX.Element {
  return (
    <li className={`relay-option relay-option--${option.tier}`}>
      <p className="relay-option__name">{option.name}</p>
      <p className="relay-option__what">{option.what}</p>
      <pre className="relay-option__commands">{option.commands}</pre>
      <dl className="relay-option__costs">
        <div>
          <dt>Effort</dt>
          <dd>{option.effort}</dd>
        </div>
        <div>
          <dt>Money</dt>
          <dd>{option.money}</dd>
        </div>
        <div>
          <dt>Address</dt>
          <dd>{option.address}</dd>
        </div>
      </dl>
      <p className={`relay-option__keep relay-option__keep--${option.keep}`}>
        {option.keep === 'commit' ? 'Commit it: paste it above' : 'Too short-lived to commit · use TEAMREE_RELAY_URL'}
      </p>
    </li>
  )
}

/** The environment beating the file, for this run. An unreadable override is said at the top of the step instead. */
function Override({ relay }: { relay: RelaySetting }): React.JSX.Element | null {
  if (relay.override.value === null || brokenRelayOverride(relay) !== null) return null
  return (
    <p className="members__relay-note">
      <code>{relay.override.name}</code>=<code>{relay.override.value}</code> overrides{' '}
      {relay.onDisk.url === null ? <code>{relay.file}</code> : <code>{relay.onDisk.url}</code>} for this run
    </p>
  )
}

/**
 * The commit that makes both files the team's, said in full first: files, message, remote, branch,
 * upstream. The runtime answers all five, because branch and upstream are git's facts.
 */
function PushBody({
  list,
  relay,
  projectPath,
  publish,
  onPublish,
  onCancelPublish,
  now
}: {
  list: MemberList | undefined
  relay: RelaySetting | undefined
  projectPath: string | undefined
  publish: PublishState
  onPublish: () => void
  onCancelPublish: () => void
  now: number
}): React.JSX.Element | null {
  const local = pushPlan(list, relay, projectPath)
  const { plan } = publish
  // Files come from disk and the plan supplies what only git knows; the one that can be a moment
  // behind must not decide whether this step has anything in it.
  const files = local?.files ?? plan?.files ?? []
  if (files.length === 0) return null
  const activity = publishActivity(publish.progress, now)
  const failed = publish.result?.push.ok === false ? publish.result.push : null

  return (
    <div className="step__body">
      {plan === undefined ? (
        <p className="push__plan">Reading what this would commit…</p>
      ) : (
        <PublishPlan plan={plan} files={files} />
      )}
      {plan?.blocker == null ? null : <p className="push__blocked">{plan.blocker}</p>}
      <div className="push__controls">
        <button
          type="button"
          className="button button--primary"
          disabled={publish.pending || plan === undefined || plan.blocker !== null}
          onClick={onPublish}
        >
          {publish.pending ? 'Pushing…' : failed === null ? PUBLISH_BUTTON : RETRY_PUBLISH_BUTTON}
        </button>
        {/* Beside the button: a push can wait ten minutes on something nobody can answer. */}
        {publish.pending ? (
          <button type="button" className="button" onClick={onCancelPublish} disabled={activity?.cancelling === true}>
            {activity?.cancelling === true ? 'Stopping…' : CANCEL_PUBLISH_BUTTON}
          </button>
        ) : null}
      </div>
      {publish.pending && activity !== null ? <PublishProgress activity={activity} /> : null}
      {failed === null ? null : <RetryHint kind={failed.kind} />}
      {publish.error === null ? null : <p className="push__error">{publish.error}</p>}
      {publish.result === undefined ? null : (
        <PublishResult result={publish.result} took={activity?.running === false ? activity.elapsedMs : null} />
      )}
      {local === null ? null : (
        <details className="push__manual">
          <summary>Commands</summary>
          <pre className="members__push-commands">{local.commands}</pre>
        </details>
      )}
    </div>
  )
}

/**
 * The push while it runs. `aria-live="polite"`: the one part of the panel that changes on its own,
 * and "it appears stuck" was worst for the reader who cannot see the lines move.
 */
function PublishProgress({ activity }: { activity: ReturnType<typeof publishActivity> }): React.JSX.Element | null {
  if (activity === null) return null
  return (
    <div className="push__progress" aria-live="polite">
      <p className="push__progress-head">
        <span className="push__progress-doing">{activity.doing}</span>
        <span className="push__progress-elapsed">{formatElapsed(activity.elapsedMs)}</span>
      </p>
      {activity.lastLine === null ? (
        <p className="push__progress-line push__progress-line--quiet">No output yet</p>
      ) : (
        <pre className="push__progress-line">{activity.lastLine}</pre>
      )}
      {activity.quiet === null ? null : <p className="push__stalled">{activity.quiet}</p>}
    </div>
  )
}

/** What to do before pressing the button again, when there is something. */
function RetryHint({ kind }: { kind: PushFailureKind }): React.JSX.Element | null {
  const hint = retryHint(kind)
  return hint === null ? null : <p className="push__retry-hint">{hint}</p>
}

/** Exactly what the button will do, in the four facts it is made of. */
function PublishPlan({ plan, files }: { plan: TeamworkPublishPlan; files: string[] }): React.JSX.Element {
  return (
    <dl className="push__plan">
      <div>
        <dt>Files</dt>
        <dd>
          <ul className="push__files">
            {files.map((file) => (
              <li key={file}>
                <code>{file}</code>
              </li>
            ))}
          </ul>
        </dd>
      </div>
      <div>
        <dt>Commit message</dt>
        <dd>{plan.message}</dd>
      </div>
      <div>
        <dt>Branch</dt>
        <dd>{plan.branch ?? 'none (detached HEAD)'}</dd>
      </div>
      <div>
        <dt>Pushes to</dt>
        <dd>
          {plan.remote}
          {plan.upstream === null ? ' (sets upstream)' : ` (${plan.upstream})`}
        </dd>
      </div>
      {plan.committed ? (
        <div>
          <dt>Already committed</dt>
          <dd>Nothing new to commit</dd>
        </div>
      ) : null}
    </dl>
  )
}

/** What happened, in both halves. Git's own words are printed whole: the paraphrase is not what anybody can search for. */
function PublishResult({ result, took }: { result: TeamworkPublish; took: number | null }): React.JSX.Element {
  return (
    <div className="push__result">
      <p>
        {result.commit === null
          ? 'Nothing new to commit'
          : `Committed ${result.commit.shortSha} “${result.commit.message}”`}
        {/* How long it took answers "was that normal?". */}
        {took === null ? '' : ` · ${formatElapsed(took)}`}
      </p>
      {result.push.ok ? (
        <p>
          {result.push.alreadyUpToDate
            ? `${result.remote} already had ${result.branch}`
            : `Pushed ${result.branch} to ${result.remote}`}
          {result.push.setUpstream ? ` · tracks ${result.push.upstream}` : ''}
        </p>
      ) : (
        <>
          {/* Only when it adds something: for a refusal teamree has no opinion about, the advice is git's first line. */}
          {result.push.advice === firstLineOf(result.push.error) ? null : (
            <p className="push__error">{result.push.advice}</p>
          )}
          <pre className="push__git">{result.push.error}</pre>
        </>
      )}
    </div>
  )
}

/** The first line git actually said, ignoring the `To <url>` banner around it. */
function firstLineOf(text: string): string {
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith('To ')) ?? ''
  )
}

/**
 * The thing to send somebody, copyable in one press. Shown rather than hidden behind the button:
 * it goes out under this person's name, and nobody should send words they have not read.
 */
function Invite({ invite, onCopy }: { invite: string; onCopy: (text: string) => void }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  // Cleared on the way out, so a panel closed mid-flash cannot set state on a component that has gone.
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  return (
    <div className="invite">
      <div className="invite__head">
        <h3 className="invite__title">Invite</h3>
        <button
          type="button"
          className="button button--small"
          onClick={() => {
            onCopy(invite)
            setCopied(true)
            clearTimeout(timer.current)
            timer.current = setTimeout(() => setCopied(false), 2_000)
          }}
        >
          {copied ? 'Copied' : COPY_INVITE_BUTTON}
        </button>
      </div>
      <pre className="invite__text">{invite}</pre>
    </div>
  )
}

/** Who is on the roster, which links are up, and what is checkable when one is not. */
function ConnectedBody({
  list,
  status
}: {
  list: MemberList | undefined
  status: TeamworkStatus | undefined
}): React.JSX.Element | null {
  if (list === undefined && status === undefined) return null
  // No link rows until teamwork has read this project; the step's summary says so in words.
  const links = teamworkFacts(status)?.links ?? []
  return (
    <div className="step__body">
      {list === undefined ? null : (
        <>
          <MemberRoster list={list} />
          <Problems list={list} />
          <Freshness list={list} />
        </>
      )}
      {links.length === 0 ? null : (
        <ul className="links">
          {links.map((link) => (
            <LinkRow key={link.publicKey} link={link} />
          ))}
        </ul>
      )}
    </div>
  )
}

/** One teammate and how this machine is getting on with reaching them; the detail is the runtime's own. */
function LinkRow({ link }: { link: PeerLink }): React.JSX.Element {
  return (
    <li className={`link link--${link.phase}`}>
      <span className="link__handle">{link.handle}</span>
      <span className="link__phase">{PHASE_WORDS[link.phase]}</span>
      {link.detail === undefined ? null : <span className="link__detail">{link.detail}</span>}
    </li>
  )
}

const PHASE_WORDS: Record<PeerLink['phase'], string> = {
  connecting: 'reaching the relay',
  waiting: 'not connected',
  connected: 'connected',
  refused: 'refused',
  unreachable: 'relay unreachable',
  stopped: 'stopped'
}

function MemberRoster({ list }: { list: MemberList }): React.JSX.Element {
  if (list.members.length === 0) {
    return <p className="members__empty">No keys yet</p>
  }
  return (
    <ul className="members__list">
      {list.members.map((member) => (
        <MemberRow key={member.file} member={member} />
      ))}
    </ul>
  )
}

function MemberRow({ member }: { member: Member }): React.JSX.Element {
  return (
    <li className={`member${member.isSelf ? ' member--self' : ''}`}>
      <div className="member__line">
        <span className="member__handle">{member.handle}</span>
        {member.isSelf ? <span className="member__you">you</span> : null}
        <span className="member__added">added {member.addedAt}</span>
      </div>
      {/* Shown short: a key is read to compare two of them, never to be typed. */}
      <code className="member__key" title={member.publicKey}>
        {shortKey(member.publicKey)}
      </code>
    </li>
  )
}

/** Files in the directory that are not members, named rather than counted: the useful version has the path in it. */
function Problems({ list }: { list: MemberList }): React.JSX.Element | null {
  if (list.problems.length === 0) return null
  return (
    <div className="members__problems">
      <p className="members__problems-head">
        {list.problems.length} file{list.problems.length === 1 ? '' : 's'} skipped
      </p>
      <ul>
        {list.problems.map((problem) => (
          <li key={problem.file}>
            <code>{problem.file}</code> — {problem.reason}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Said only when the list will not stay true on its own: nothing is watching the file. */
function Freshness({ list }: { list: MemberList }): React.JSX.Element | null {
  if (list.watched) return null
  return <p className="members__stale">Not watching · may be stale</p>
}
