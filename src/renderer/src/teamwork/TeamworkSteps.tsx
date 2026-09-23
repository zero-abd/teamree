// Setting teamwork up, as five steps instead of a document. Every step is a
// button; nothing acts silently, nothing is enabled that cannot work, and
// teamree still runs no relay.

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
  setupOutcome,
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
  type SetupOutcome,
  type StartTeamworkRead,
  type StartTeamworkReadErrors,
  type StartTeamworkStep,
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

/** A glyph for the eye; `MARK_WORDS` is what is actually read out. */
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
    path: props.path
  })
  const outcome = setupOutcome({
    list: props.list,
    relay: props.relay,
    status: props.status,
    publish: props.publish.result
  })
  // Somebody already connected is not asked what they came here to do.
  const asking = props.path === null && outcome?.done !== true

  return (
    <div className="steps">
      {flow.blocker === null ? null : (
        <div className="steps__blocker">
          <p className="steps__blocker-lead">
            <strong>{flow.blocker}</strong>
          </p>
          {teamworkFacts(props.status)?.origin.ok === false ? (
            <OriginFix origin={props.origin} onSetOrigin={props.onSetOrigin} />
          ) : null}
        </div>
      )}
      {asking ? (
        <PathChoice list={props.list} relay={props.relay} onChoose={props.onChoosePath} />
      ) : (
        <>
          {props.path === null ? null : <ChosenPath path={props.path} onChange={() => props.onChoosePath(null)} />}
          <ol className="steps__list">
            {flow.steps.map((step, index) => (
              <li
                key={step.id}
                className={`step step--${step.mark}${step.id === flow.currentId ? ' step--current' : ''}`}
              >
                <div className="step__head">
                  <span className="step__mark" aria-hidden="true">
                    {MARK_GLYPHS[step.mark]}
                  </span>
                  <h3 className="step__title">
                    {index + 1}. {step.title}
                  </h3>
                  <span className="step__state">{MARK_WORDS[step.mark]}</span>
                </div>
                <p className="step__summary">{step.summary}</p>
                <StepBody step={step} {...props} />
              </li>
            ))}
          </ol>
          <Outcome outcome={outcome} {...props} />
        </>
      )}
    </div>
  )
}

/** Which of the two jobs this is. The one the repository points at is marked and put first — marked, not taken. */
function PathChoice({
  list,
  relay,
  onChoose
}: {
  list: MemberList | undefined
  relay: RelaySetting | undefined
  onChoose: (path: TeamworkPath) => void
}): React.JSX.Element {
  const suggestion = suggestedPath(list, relay)
  const order = [...TEAMWORK_PATHS].sort((a, b) => (a.id === suggestion?.id ? -1 : b.id === suggestion?.id ? 1 : 0))
  return (
    <div className="path-choice">
      <h2 className="path-choice__head">Which of these are you doing?</h2>
      <ul className="path-choice__list">
        {order.map((option) => (
          <li key={option.id} className={`path-option${option.id === suggestion?.id ? ' path-option--suggested' : ''}`}>
            <button
              type="button"
              className="button button--primary path-option__button"
              onClick={() => onChoose(option.id)}
            >
              {option.title}
            </button>
            {option.id === suggestion?.id && suggestion.because !== null ? (
              <p className="path-option__because">{suggestion.because}</p>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** The answer, kept on screen and changeable. Quoted as the button said it: the titles are imperatives. */
function ChosenPath({ path, onChange }: { path: TeamworkPath; onChange: () => void }): React.JSX.Element {
  const chosen = TEAMWORK_PATHS.find((option) => option.id === path) as (typeof TEAMWORK_PATHS)[number]
  return (
    <div className="chosen-path">
      <p className="chosen-path__line">
        <span className="chosen-path__label">{chosen.title}</span>
      </p>
      <button type="button" className="button button--small" onClick={onChange}>
        Not that
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
        Try again
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
        {origin.pending ? 'Adding…' : 'Add origin'}
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
 * The relay: deploy and serve buttons, the field that writes one down, the check, and every other
 * way folded away. Serve is wrong for two laptops behind two routers, and says so beside its button.
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
  const [draft, setDraft] = useState('')
  const check = checkRelayDraft(draft)

  const submit = (event: React.FormEvent): void => {
    event.preventDefault()
    if (check.state === 'ok') onSet(check.url)
  }

  return (
    <div className="step__body">
      {/* A joiner who finds no relay is ahead of whoever invited them; standing a second one up is the wrong answer. */}
      {path === 'join' && relay.onDisk.url === null ? (
        <p className="relay-waiting">{relay.file} not pushed yet · pull again soon</p>
      ) : null}
      {/* An unreadable override, said first: every other sentence here is about a relay the app will not dial. */}
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
          {/* The same control as the one beside the paste field, on the URL this project will actually dial. */}
          <RelayCheck url={relay.url} relay={relay} pane={pane} onStart={onStartRelayPane} />
        </>
      )}
      {options ? (
        <>
          {/* Side by side and equally weighted: they answer different questions. */}
          <RelayDeploy relay={relay} pane={pane} onStart={onStartRelayPane} />
          <RelayServe relay={relay} pane={pane} onStart={onStartRelayPane} />
        </>
      ) : null}
      {pane === undefined ? null : (
        <RelayPaneBlock pane={pane} pending={pending} onUse={onSet} onClose={onClosePane} render={renderRelayPane} />
      )}
      <form className="members__relay" onSubmit={submit}>
        <label className="field">
          <span className="field__label">
            {relay.onDisk.url === null ? 'Or paste a relay URL' : 'Change the relay for this project'}
          </span>
          <input
            className="field__input field__input--mono"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="wss://your-relay.example/v1/relay"
            autoComplete="off"
            spellCheck={false}
          />
          <span className="field__hint">
            {relay.onDisk.url === null ? 'Writes' : 'Replaces'} <code>{relay.file}</code>
          </span>
        </label>
        {check.state === 'bad' ? <RelayRefusal check={check} onUse={setDraft} /> : null}
        {error === null ? null : <p className="members__relay-error">{error}</p>}
        <div className="relay-draft__controls">
          <button type="submit" className="button" disabled={pending || check.state !== 'ok'}>
            {pending ? 'Writing…' : 'Write relay file'}
          </button>
          {/* Checking before it is written: cheaper than a dead address in everybody's repository. */}
          <RelayCheck
            url={check.state === 'ok' ? check.url : null}
            label={RELAY_CHECK.draftButton}
            relay={relay}
            pane={pane}
            onStart={onStartRelayPane}
          />
        </div>
      </form>
      {options ? <RelayOptions /> : null}
      <Override relay={relay} />
    </div>
  )
}

/**
 * The deploy as a button. Never enabled without a relay in the build, never hides the command, and
 * never writes the printed URL on its own: a relay is a team-wide fact. The pane is `RelayPaneBlock`.
 */
function RelayDeploy({
  relay,
  pane,
  onStart
}: {
  relay: RelaySetting
  pane: RelayPaneState | undefined
  onStart: (kind: RelayPaneKind) => void
}): React.JSX.Element {
  const blocked = launcherBlocked(relay, relay.deploy.command, pane)
  return (
    <div className="relay-deploy">
      <button
        type="button"
        className="button button--primary"
        disabled={blocked !== null}
        onClick={() => onStart('deploy')}
      >
        {RELAY_DEPLOY.button}
      </button>
      {/* Why it cannot be pressed, always beside it. */}
      {blocked === null ? null : <p className="relay-deploy__blocked">{blocked}</p>}
      <p className="relay-deploy__note">{pane?.kind === 'deploy' ? RELAY_DEPLOY.watching : RELAY_DEPLOY.browser}</p>
      {relay.deploy.command === null ? null : (
        <details className="relay-deploy__manual">
          <summary>{RELAY_DEPLOY.manual}</summary>
          <pre className="relay-option__commands">{relay.deploy.command}</pre>
        </details>
      )}
    </div>
  )
}

/**
 * A relay on this Mac: fastest for one network, a dead end for two home networks, and teamree cannot
 * see which. The limit sits above the button, the one moment where reading it changes what somebody does.
 */
function RelayServe({
  relay,
  pane,
  onStart
}: {
  relay: RelaySetting
  pane: RelayPaneState | undefined
  onStart: (kind: RelayPaneKind) => void
}): React.JSX.Element {
  const command = relay.deploy.command === null ? null : relayLauncherCommand(relay.deploy.command, 'serve')
  const blocked = launcherBlocked(relay, command, pane)
  return (
    <div className="relay-deploy relay-deploy--serve">
      {/* Above the button: a limitation met after the relay is running is a wasted evening. */}
      <p className="relay-deploy__limit">{RELAY_SERVE.limit}</p>
      <button type="button" className="button" disabled={blocked !== null} onClick={() => onStart('serve')}>
        {RELAY_SERVE.button}
      </button>
      {blocked === null ? null : <p className="relay-deploy__blocked">{blocked}</p>}
      {pane?.kind === 'serve' ? <p className="relay-deploy__note">{RELAY_SERVE.watching}</p> : null}
      {command === null ? null : (
        <details className="relay-deploy__manual">
          <summary>{RELAY_SERVE.manual}</summary>
          <pre className="relay-option__commands">{command}</pre>
        </details>
      )}
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
  // Nothing to dial outranks every other reason: the fix is in the field above.
  const blocked = url === null ? RELAY_CHECK.nothing : launcherBlocked(relay, command, pane)
  return (
    <span className="relay-check">
      <button
        type="button"
        className="button button--small"
        disabled={blocked !== null}
        onClick={() => onStart('check', url as string)}
      >
        {label}
      </button>
      {blocked === null ? (
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
        {pane.running ? 'Stop and close this pane' : 'Close this pane'}
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

/**
 * Every other way to get a relay, behind one button. `aria-expanded` rather than `details`: the
 * contents are not rendered until asked for, so nothing can read out or tab into an unopened option.
 */
function RelayOptions(): React.JSX.Element {
  const [showMore, setShowMore] = useState(false)
  return (
    <div className="relay-options">
      <div className="relay-options__more">
        <button
          type="button"
          className="button button--small"
          aria-expanded={showMore}
          onClick={() => setShowMore((open) => !open)}
        >
          <span className="disclosure__caret" aria-hidden="true">
            {showMore ? '▾' : '▸'}
          </span>
          {MORE_RELAYS_BUTTON}
        </button>
        {showMore ? (
          <>
            <p className="relay-options__lead">{MORE_RELAYS_LEAD}</p>
            <ul className="relay-options__list">
              {RELAY_OPTIONS.map((option) => (
                <RelayOptionCard key={option.id} option={option} />
              ))}
            </ul>
          </>
        ) : null}
      </div>
    </div>
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

/**
 * What the environment said. The disclosure for the absence of an override answers "I set
 * TEAMREE_RELAY_URL and nothing happened": on macOS an app opened from Finder inherits no shell environment.
 */
function Override({ relay }: { relay: RelaySetting }): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  // An unreadable override is already said in full at the top of the step; what is below is written for one that is winning.
  if (brokenRelayOverride(relay) !== null) return null
  if (relay.override.value === null) {
    return (
      <div className="disclosure">
        <button
          type="button"
          className="button button--small"
          aria-expanded={open}
          onClick={() => setOpen((shown) => !shown)}
        >
          <span className="disclosure__caret" aria-hidden="true">
            {open ? '▾' : '▸'}
          </span>
          I set {relay.override.name} and nothing happened
        </button>
        {open ? (
          <p className="disclosure__body">
            <code>{relay.override.name}</code> not in this app’s environment · Finder launches do not inherit your
            shell’s
          </p>
        ) : null}
      </div>
    )
  }
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
          <summary>Run it yourself</summary>
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
 * Where this ended up, as four separate verdicts: "did that work" is usually "partly", and one
 * overall tick would have to be wrong about something.
 */
function Outcome({
  outcome,
  ...props
}: TeamworkStepsProps & { outcome: SetupOutcome | null }): React.JSX.Element | null {
  if (outcome === null) return null
  // Nothing to name the repository with until the origin has been read.
  const origin = teamworkFacts(props.status)?.origin
  const invite = inviteText({
    originUrl: origin?.ok === true ? origin.url : null,
    relayUrl: props.relay?.url ?? null,
    projectName: props.projectName,
    handle: props.list?.self.handle ?? null
  })
  return (
    <section className={`outcome${outcome.done ? ' outcome--done' : ''}`}>
      <h2 className="outcome__head">{outcome.head}</h2>
      <ul className="outcome__facts">
        {outcome.facts.map((fact) => (
          <li key={fact.label} className={`outcome__fact outcome__fact--${fact.state}`}>
            <span className="outcome__mark" aria-hidden="true">
              {fact.state === 'yes' ? '✓' : fact.state === 'no' ? '○' : '—'}
            </span>
            <span className="outcome__label">{fact.label}</span>
            <span className="outcome__state">
              {fact.state === 'yes' ? 'yes' : fact.state === 'no' ? 'not yet' : 'teamree cannot check this'}
            </span>
            <span className="outcome__detail">{fact.detail}</span>
          </li>
        ))}
      </ul>
      {outcome.next === null ? null : <p className="outcome__next">{outcome.next}</p>}
      {invite === null ? null : <Invite invite={invite} onCopy={props.onCopy} />}
    </section>
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
        <h3 className="invite__title">Invite somebody</h3>
        <button
          type="button"
          className="button button--primary button--small"
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
