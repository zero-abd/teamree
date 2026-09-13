// Setting teamwork up, as five steps instead of a document.
//
// Every piece of this already worked and every piece already had a method
// behind it. What did not exist was one place that says where you are and what
// the next thing is, so doing it meant following `docs/trying-teamwork.md` with
// a terminal in the other hand. The steps here are that runbook's 3, 4 and 5.
//
// Every step here is a button now, and that is the change. It used to hand out
// shell commands: `git remote add origin <url>` to run somewhere else, a deploy
// to paste into Terminal.app, and a `git add && git commit && git push` block
// to copy. An app that runs PTYs for a living and owns git should not be doing
// that, and somebody said so.
//
// What that does *not* change is consent, so each of the three is built the
// same way:
//
// **Nothing acts silently.** The origin field says what URL it will set; the
// deploy runs in a pane in this window where it can be watched; the push names
// the files, the message, the remote and the branch before it is pressed, and
// then reports what git said in git's own words.
//
// **Nothing is enabled that cannot work.** A missing relay in this build, a
// detached HEAD, a repository with no origin, a git with no identity: each is a
// disabled control and one sentence naming the fix, rather than a button that
// fails when it is pressed.
//
// **teamree still runs no relay.** It runs the deploy that puts one on the
// team's own Cloudflare account, and it says so. There is no hosted relay and
// this project deliberately has none.
//
// Three things arrived later, all from one report: that setting a team up
// worked and was confusing, and that it appeared to hang on the push.
//
// **It asks which of the two jobs this is, before anything else.** The five
// steps are the same five for both, and what they mean is not: one person
// chooses a relay and invites, the other pulls one and answers. A panel that
// could not tell them apart had to write every sentence for both at once, and
// the reader had to work out which half was theirs.
//
// **Every step says what the other machine sees.** This is a two-sided
// protocol whose ordinary failure is two people each waiting for the other, and
// nothing in the window used to say what the far end was waiting for.
//
// **The push reports itself while it runs.** It streams git's own progress,
// counts the wait, says so when git has gone quiet for long enough to mean
// something, and has a Stop beside it — and afterwards a Try again, because
// "somebody pushed first" is the ordinary outcome and it is fixed in two steps
// rather than by starting over.

import { useEffect, useId, useRef, useState } from 'react'
import {
  UNWATCHED_TEAMREE_LAG,
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
  RELAY_DEPLOY,
  RELAY_LEAD,
  RELAY_OPTIONS,
  RETRY_PUBLISH_BUTTON,
  retryHint,
  setupOutcome,
  shortKey,
  startTeamworkFlow,
  suggestedPath,
  TEAMWORK_PATHS,
  type OriginState,
  type PublishState,
  type RelayDeployState,
  type RelayDraftCheck,
  type RelayOption,
  type SetupOutcome,
  type StartTeamworkRead,
  type StartTeamworkReadErrors,
  type StartTeamworkStep,
  type StepMark,
  type TeamworkPath
} from './startTeamwork'

export type TeamworkStepsProps = {
  /**
   * Absolute path to the primary checkout, for the commands in step 4 to start
   * with. `.teamree` is there and a pane is never there, so the commands
   * without it run in the wrong directory. Undefined only while the project is
   * not in the store, and then the `cd` is left off rather than guessed at.
   */
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

  /** The deploy running in a pane in this window, or undefined when none is. */
  deploy: RelayDeployState | undefined
  /**
   * Starts the deploy in a pane. Never offered when the build carries no relay:
   * `relay.deploy.command` is null then, and the button is disabled with the
   * runtime's own sentence beside it.
   */
  onDeployRelay: () => void
  /** Closes the deploy pane. */
  onCloseDeploy: () => void
  /**
   * Renders the pane itself.
   *
   * A slot rather than the component, because the component is xterm and this
   * file is otherwise a pure function of its props — which is what lets the
   * whole of what it says be rendered in a test without a canvas.
   */
  renderDeployPane: (terminalId: string) => React.ReactNode

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
  /**
   * Puts text on the clipboard.
   *
   * A prop rather than a call to `navigator.clipboard`, so this file stays a
   * pure function of what it is given — which is what lets the whole of what it
   * says be rendered in a test without a browser's permission model in the way.
   */
  onCopy: (text: string) => void
  /**
   * Now, as the panel should measure it.
   *
   * Passed in rather than read, because everything it is used for is a
   * duration somebody is watching — how long this push has been going, how long
   * git has been silent — and a clock a test cannot set is a clock those
   * sentences cannot be asserted against.
   */
  now?: number
}

/** A glyph for the eye; `MARK_WORDS` is what is actually read out. */
const MARK_GLYPHS: Record<StepMark, string> = { done: '✓', 'this-run': '✓', todo: '○', unchecked: '—', blocked: '!' }

const MARK_WORDS: Record<StepMark, string> = {
  done: 'done',
  // A tick with a caveat rather than a cross: the override is what the panel's
  // own tunnel option tells people to use, and it is genuinely not committed.
  'this-run': 'done for this run',
  todo: 'not done yet',
  // Never a tick and never a cross: teamree cannot see a commit, and both
  // marks would be it claiming it can.
  unchecked: 'yours to do — teamree does not check this',
  blocked: 'blocked'
}

/**
 * The steps, separately from the dialog that wires them to the store, so the
 * whole of what this says in each state can be rendered in a test.
 */
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
  // A repository where this already works has no question left to ask, and
  // putting the two paths in front of somebody who is connected would be the
  // app asking what they came here to do after they have done it.
  const asking = props.path === null && outcome?.done !== true

  return (
    <div className="steps">
      {flow.blocker === null ? null : (
        <div className="steps__blocker">
          <p className="steps__blocker-lead">
            <strong>This checkout cannot take part yet.</strong> {flow.blocker}
          </p>
          {props.status?.origin.ok === false ? (
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
                {/* Why, then what is true, then what they see. The order is the
                    argument: a step whose reason is only reachable from a
                    runbook is a step people do without understanding, and this
                    is a flow where not understanding it means waiting for
                    somebody who is waiting for you. */}
                <p className="step__why">{step.why}</p>
                {step.otherSide === null ? null : (
                  <p className="step__other-side">
                    <span className="step__other-side-label">On their machine</span> {step.otherSide}
                  </p>
                )}
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

/**
 * The question this panel used not to ask, and the whole reason the rest of it
 * can now be written in the second person.
 *
 * Both options are offered, both say what the other person does, and the one
 * the repository points at is marked and put first — marked, not taken. Reading
 * a relay file and a colleague's key is very good evidence about what is going
 * on here and still a guess about somebody's intent, and this panel does not
 * take those quietly.
 */
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
      <p className="path-choice__lead">
        Teamwork has two ends and they do different things. Saying which one you are on is what lets the rest of this
        page be about your half of it.
      </p>
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
            {option.id === suggestion?.id ? <p className="path-option__because">{suggestion.because}</p> : null}
            <p className="path-option__what">{option.what}</p>
            <p className="path-option__them">
              <span className="step__other-side-label">They</span> {option.them}
            </p>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** The answer, kept on screen and changeable — because people pick the wrong one. */
function ChosenPath({ path, onChange }: { path: TeamworkPath; onChange: () => void }): React.JSX.Element {
  const chosen = TEAMWORK_PATHS.find((option) => option.id === path) as (typeof TEAMWORK_PATHS)[number]
  return (
    <div className="chosen-path">
      <p className="chosen-path__line">
        <span className="chosen-path__label">You are</span> {chosen.title.toLowerCase()}.{' '}
        <span className="chosen-path__them">{chosen.them}</span>
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
      // No retry here even when the roster read failed: it is the same read as
      // step 1's, and two buttons for one question are two answers to it.
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
          // The options are a decision, and a relay already chosen is that
          // decision taken: offering them again is a wall of choices about a
          // thing that has been chosen.
          options={step.mark !== 'done' && step.mark !== 'this-run'}
          pending={props.relayPending}
          error={props.relayError}
          onSet={props.onSetRelay}
          deploy={props.deploy}
          onDeploy={props.onDeployRelay}
          onCloseDeploy={props.onCloseDeploy}
          renderDeployPane={props.renderDeployPane}
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

/**
 * The way out of a read that threw.
 *
 * What failed is already the step's summary, so this is only the button. The
 * panel used to have neither: three steps said "Reading…" for the life of the
 * window and the whole of the explanation was in a toast that had gone.
 */
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

/**
 * What a key grants, and then the button that grants it. In that order, and
 * not collapsed behind anything.
 *
 * `docs/teamwork.md` says this outright — "this is remote code execution, by
 * design and by request" — and a setup flow that let somebody add a colleague
 * without reading it would be the one place that sentence never reached the
 * person it is about.
 */
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
  // The name the runtime will file this under, which is not what was typed:
  // `Ada Lovelace` is written as `ada-lovelace.pub`.
  const file = memberFilePreview(list, handle)

  const submit = (event: React.FormEvent): void => {
    event.preventDefault()
    onJoin(handle.trim() || undefined)
  }

  return (
    <div className="step__body">
      <div className="grant">
        <p className="grant__head">{KEY_GRANT_WARNING.head}</p>
        <p className="grant__body">{KEY_GRANT_WARNING.body}</p>
        <p className="grant__body">None of it can be done invisibly:</p>
        <ul className="grant__mitigations">
          {KEY_GRANT_WARNING.mitigations.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p className="grant__close">{KEY_GRANT_WARNING.close}</p>
      </div>
      <form className="members__self members__self--join" onSubmit={submit}>
        <label className="field">
          <span className="field__label">Handle</span>
          <input
            className="field__input field__input--mono"
            value={handle}
            onChange={(event) => {
              setHandle(event.target.value)
              // The refusal named this box. Answering it is the keystroke that
              // makes it stale, so it goes then rather than on the next submit.
              onClearError()
            }}
            placeholder={list.self.handle ?? 'pick a name'}
            aria-invalid={error !== null}
            autoComplete="off"
            spellCheck={false}
          />
          <span className="field__hint">{hintFor(list, handle, file)}</span>
        </label>
        {/* Under the field, never in a corner: every refusal the runtime raises
            here ends in "choose another handle", and that is an instruction
            about this box. */}
        {error === null ? null : <p className="field__error">{error}</p>}
        <button type="submit" className="button button--primary" disabled={pending || chosen === null}>
          {pending ? 'Writing…' : ADD_KEY_BUTTON}
        </button>
        <p className="members__caveat">This writes the file and stops. Step 4 is what sends it.</p>
      </form>
    </div>
  )
}

/** What the field says it will do, for each of the three things it can be told. */
function hintFor(list: MemberList, typed: string, file: string | null): string {
  if (file !== null) {
    return list.self.handle === null
      ? `Writes ${file}.`
      : `Defaults to the local part of your git email. Writes ${file}.`
  }
  return typed.trim() === ''
    ? 'git has no user.email here, so there is no name to use — choose one. Lowercase, and [a-z0-9._-].'
    : 'Nothing in that name survives as a filename. Lowercase, and [a-z0-9._-].'
}

/**
 * The remote everybody cloned, as a field and a button.
 *
 * This was `git remote add origin <url>` printed in a panel, in an app that
 * owns git and knows exactly which directory the command belongs in. The
 * refusal is reached while somebody is still typing, because the wrong answer
 * here is not a typo — it is a path on this disk, which is a perfectly good git
 * remote and a useless project identity, and finding that out after a round
 * trip reads as the button being broken.
 */
function OriginFix({ origin, onSetOrigin }: { origin: OriginState; onSetOrigin: (url: string) => void }) {
  const [draft, setDraft] = useState('')
  const [why, setWhy] = useState(false)
  // The hint is a description rather than part of the name: a label that
  // swallowed it would have a screen reader announce a paragraph every time the
  // field took focus, and the field is called "Origin URL".
  const hint = useId()
  const check = checkOriginDraft(draft)
  // What the field itself refused beats what git last said: the reader is
  // typing, and the older message is about a URL that is no longer in the box.
  const refusal = check.state === 'bad' ? check.reason : draft.trim() === '' ? origin.error : null

  const submit = (event: React.FormEvent): void => {
    event.preventDefault()
    if (check.state === 'ok') onSetOrigin(check.url)
  }

  return (
    <form className="origin-fix" onSubmit={submit}>
      <label className="field">
        <span className="field__label">Origin URL</span>
        <input
          className="field__input field__input--mono"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="https://github.com/you/repo.git"
          aria-invalid={refusal !== null}
          aria-describedby={hint}
          autoComplete="off"
          spellCheck={false}
        />
      </label>
      <span className="field__hint" id={hint}>
        Runs <code>git remote add origin</code> in this checkout. It has to be a URL: your teammates clone it too.
      </span>
      {refusal === null ? null : <p className="field__error">{refusal}</p>}
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
          Why a path will not do
        </button>
        {why ? <p className="disclosure__body">{ORIGIN_DETAIL}</p> : null}
      </div>
    </form>
  )
}

/**
 * The relay: the button that stands one up, the field that writes one down,
 * and — folded away — every other way to get one.
 *
 * The order is the change. The deploy used to be several paragraphs of
 * Cloudflare, Durable Object pricing and what `cd relay` means before anything
 * pressable; now it is a button first, with the reasoning behind a disclosure
 * and the rest in `relay/README.md`.
 */
function RelayBody({
  path,
  relay,
  options,
  pending,
  error,
  onSet,
  deploy,
  onDeploy,
  onCloseDeploy,
  renderDeployPane
}: {
  path: TeamworkPath | null
  relay: RelaySetting
  /** Whether the other ways to get a relay are still a decision to make. */
  options: boolean
  pending: boolean
  error: string | null
  onSet: (url: string) => void
  deploy: RelayDeployState | undefined
  onDeploy: () => void
  onCloseDeploy: () => void
  renderDeployPane: (terminalId: string) => React.ReactNode
}): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const check = checkRelayDraft(draft)

  const submit = (event: React.FormEvent): void => {
    event.preventDefault()
    if (check.state === 'ok') onSet(check.url)
  }

  return (
    <div className="step__body">
      {/* The one warning a joiner needs and a starter does not. Somebody who
          was invited and finds no relay here is a step ahead of whoever
          invited them, and the wrong answer — standing a second relay up — is
          also the one this page is otherwise encouraging. */}
      {path === 'join' && relay.onDisk.url === null ? (
        <p className="relay-waiting">
          Nobody has pushed {relay.file} yet, so whoever set this up has not got that far. Pull in a moment and it fills
          in by itself. Only stand one up yourself if you have agreed that you are the one doing it — two relays means
          two halves of a team that never meet.
        </p>
      ) : null}
      {relay.url === null ? null : (
        <p className="members__relay-current">
          <code>{relay.url}</code>
          <span className="members__relay-source">
            {relay.source === 'environment' ? `from ${relay.override.name}` : `from ${relay.file}`}
          </span>
        </p>
      )}
      {options ? (
        <RelayDeploy
          relay={relay}
          deploy={deploy}
          onDeploy={onDeploy}
          onCloseDeploy={onCloseDeploy}
          onUse={onSet}
          pending={pending}
          renderDeployPane={renderDeployPane}
        />
      ) : null}
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
            {relay.onDisk.url === null ? 'Writes' : 'Replaces'} <code>{relay.file}</code>, and stops there. Everybody
            else gets it from the repository. Paste the whole message a teammate sent if you like — the URL is taken out
            of it.
          </span>
        </label>
        {check.state === 'bad' ? <RelayRefusal check={check} onUse={setDraft} /> : null}
        {error === null ? null : <p className="members__relay-error">{error}</p>}
        <button type="submit" className="button" disabled={pending || check.state !== 'ok'}>
          {pending ? 'Writing…' : 'Write relay file'}
        </button>
      </form>
      {options ? <RelayOptions /> : null}
      <Override relay={relay} />
    </div>
  )
}

/**
 * The deploy, as a button and a pane rather than a command to take elsewhere.
 *
 * Three things it will not do. It will not pretend to be enabled when this
 * build carries no relay — the runtime says so and the sentence is the
 * runtime's. It will not hide the command, because somebody will always want to
 * run it themselves and that is a legitimate answer. And it will not write the
 * URL the deploy printed into the repository on its own: the URL is offered on
 * a button, because a relay is a team-wide fact and a fact is somebody's to
 * assert.
 */
function RelayDeploy({
  relay,
  deploy,
  onDeploy,
  onCloseDeploy,
  onUse,
  pending,
  renderDeployPane
}: {
  relay: RelaySetting
  deploy: RelayDeployState | undefined
  onDeploy: () => void
  onCloseDeploy: () => void
  onUse: (url: string) => void
  pending: boolean
  renderDeployPane: (terminalId: string) => React.ReactNode
}): React.JSX.Element {
  const { command, reason } = relay.deploy
  return (
    <div className="relay-deploy">
      <p className="relay-options__lead">{RELAY_LEAD}</p>
      <p className="relay-deploy__what">{RELAY_DEPLOY.what}</p>
      <button
        type="button"
        className="button button--primary"
        disabled={command === null || deploy !== undefined}
        onClick={onDeploy}
      >
        {RELAY_DEPLOY.button}
      </button>
      {/* Why it cannot be pressed, always beside it: a control that is grey for
          a reason nobody can read is the same as one that does nothing. */}
      {command === null ? <p className="relay-deploy__blocked">{reason}</p> : null}
      <p className="relay-deploy__note">{deploy === undefined ? RELAY_DEPLOY.browser : RELAY_DEPLOY.watching}</p>
      {command === null ? null : (
        <details className="relay-deploy__manual">
          <summary>{RELAY_DEPLOY.manual}</summary>
          <pre className="relay-option__commands">{command}</pre>
        </details>
      )}
      {deploy === undefined ? null : (
        <div className="relay-deploy__pane">
          {deploy.url === null ? null : (
            <p className="relay-deploy__found">
              The deploy printed <code>{deploy.url}</code>.{' '}
              <button
                type="button"
                className="button button--primary button--small"
                disabled={pending}
                onClick={() => onUse(deploy.url as string)}
              >
                {RELAY_DEPLOY.use}
              </button>
            </p>
          )}
          <div className="relay-deploy__terminal">{renderDeployPane(deploy.terminalId)}</div>
          <button type="button" className="button button--small" onClick={onCloseDeploy}>
            {deploy.running ? 'Stop and close this pane' : 'Close this pane'}
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * Why the typed address was refused, and the corrected one to use instead.
 *
 * Offered as a button rather than substituted quietly: `https://host` is what a
 * deploy prints and the relay is that host with a path on it, which is a guess
 * that is right often enough to be trusted and wrong on the one deployment
 * whose relay is not at the root.
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
      {check.reason}
      {suggestion === null ? null : (
        <button type="button" className="button button--ghost" onClick={() => onUse(suggestion)}>
          Use {suggestion}
        </button>
      )}
    </p>
  )
}

/**
 * Every other way to get a relay, behind one button.
 *
 * All of them, now, and none of them in front of anybody by default. The
 * recommendation stopped being an item in a list the moment it became a button,
 * and what is left is genuinely for a team that already has the network or the
 * server — which is a question somebody asks rather than a wall they should
 * have to read past.
 *
 * A button with `aria-expanded` rather than a `details` element: what is inside
 * is not rendered until it is asked for, so it is absent from the page rather
 * than merely hidden, and nothing can read out or tab into an option nobody
 * opened.
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
        {option.keep === 'commit'
          ? 'Stable enough to commit: paste it above and push .teamree/relay.'
          : 'Too short-lived to commit: use TEAMREE_RELAY_URL instead, and leave .teamree/relay alone.'}
      </p>
    </li>
  )
}

/**
 * What the environment said, when it said anything.
 *
 * An override that is set is a live fact about what this run is dialling and
 * outranks the file, so it is on screen. The paragraph for the *absence* of one
 * is the answer to "I set TEAMREE_RELAY_URL and nothing happened" — a real
 * question on macOS, where an app opened from Finder inherits no shell
 * environment — and an answer is a thing to have available, not a thing to put
 * in front of everybody who ever opens this panel.
 */
function Override({ relay }: { relay: RelaySetting }): React.JSX.Element {
  const [open, setOpen] = useState(false)
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
            There is no <code>{relay.override.name}</code> in this app’s environment. An app opened from Finder or the
            dock does not inherit your shell’s, so that override only applies when teamree is started from a terminal
            that has it set.
          </p>
        ) : null}
      </div>
    )
  }
  return (
    <p className="members__relay-note">
      <code>{relay.override.name}</code> is set to <code>{relay.override.value}</code> in this app’s environment. It is
      per-machine and lasts as long as this process: commit the real relay when you are done testing.
      {relay.onDisk.url === null ? null : (
        <>
          {' '}
          <code>{relay.file}</code> says <code>{relay.onDisk.url}</code>, and the environment is beating it for this
          run.
        </>
      )}
    </p>
  )
}

/**
 * The commit that makes both files the team's, said in full before it is made.
 *
 * This is the outward-facing one — it writes history into somebody's repository
 * and sends it to a remote they share — so the plan is on screen above the
 * button rather than behind a confirmation nobody reads: the files, the message,
 * the remote, the branch, and whether this push is what sets the upstream. The
 * runtime answers all five, because the branch and the upstream are git's facts
 * and a panel that guessed them would be describing a different push.
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
  // The files come from what is on disk rather than from the plan, and the plan
  // supplies what only git knows. The two are read at different moments — the
  // roster is watched, the plan is asked for — and the one that can be a moment
  // behind must not be what decides whether this step has anything in it.
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
        {/* Beside the button and not behind a menu. A push can wait ten minutes
            on something nobody can answer, and a way out of that is not a
            refinement — it is the difference between a slow step and a dead
            window. */}
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
          <summary>Or run it yourself:</summary>
          <pre className="members__push-commands">{local.commands}</pre>
        </details>
      )}
    </div>
  )
}

/**
 * The push while it is happening: what it is doing, for how long, and what git
 * last said.
 *
 * `aria-live` because this is the one part of the panel that changes on its
 * own, and somebody who cannot see the lines move is exactly the reader for
 * whom "it appears stuck" was worst. Polite rather than assertive: it is a
 * progress report, not an alarm — except for the silence, which is its own
 * paragraph and is genuinely worth interrupting for.
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
        <p className="push__progress-line push__progress-line--quiet">git has not printed anything yet.</p>
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
        <dd>{plan.branch ?? 'none — this checkout is not on a branch'}</dd>
      </div>
      <div>
        <dt>Pushes to</dt>
        <dd>
          {plan.remote}
          {plan.upstream === null
            ? `, which ${plan.branch ?? 'this branch'} does not track yet — this push would set it`
            : ` (${plan.upstream})`}
        </dd>
      </div>
      {plan.committed ? (
        <div>
          <dt>Already committed</dt>
          <dd>Nothing new to commit; this would push what is already here.</dd>
        </div>
      ) : null}
    </dl>
  )
}

/**
 * What actually happened, in both halves.
 *
 * A commit that landed and a push that was refused is the ordinary way this
 * goes wrong — a teammate pushed first — and git's own words are printed whole
 * rather than paraphrased, because the paraphrase is not what anybody can
 * search for and the advice under it is teamree's opinion rather than git's.
 */
function PublishResult({ result, took }: { result: TeamworkPublish; took: number | null }): React.JSX.Element {
  return (
    <div className="push__result">
      <p>
        {result.commit === null
          ? 'Nothing new to commit.'
          : `Committed ${result.commit.shortSha} — “${result.commit.message}”.`}
        {/* Reported after the fact as well as during, because how long it took
            is the answer to "was that normal?" — which is the question a person
            who has just sat through a slow one actually has. */}
        {took === null ? '' : ` The whole thing took ${formatElapsed(took)}.`}
      </p>
      {result.push.ok ? (
        <p>
          {result.push.alreadyUpToDate
            ? `${result.remote} already had ${result.branch}.`
            : `Pushed ${result.branch} to ${result.remote}.`}
          {result.push.setUpstream ? ` It now tracks ${result.push.upstream}.` : ''}
        </p>
      ) : (
        <>
          {/* Only when it adds something. For a refusal teamree has no opinion
              about, the advice is git's own first line and printing it twice
              makes the page look like it is repeating itself. */}
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
 * Where this ended up, at the bottom, as four separate verdicts.
 *
 * A page of steps answers "what do I do next" and never answers "did that
 * work", because the answer to the second one is usually "partly": the commit
 * landed and the push did not, or everything here is done and the person at the
 * other end has not opened the app. One overall tick would have to pick one of
 * those to be wrong about. Four facts do not.
 */
function Outcome({
  outcome,
  ...props
}: TeamworkStepsProps & { outcome: SetupOutcome | null }): React.JSX.Element | null {
  if (outcome === null) return null
  const origin = props.status?.origin
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
 * The thing to send somebody, written out and copyable in one press.
 *
 * There is no invitation in this protocol — nothing is sent, and push access is
 * the whole of membership — which is precisely why the person doing this has to
 * write one: they have to explain a system with no invitations to somebody who
 * is waiting for one. Leaving them to compose that from a five-step page is how
 * the second half of a team ends up with instructions that miss the push.
 *
 * It is shown rather than hidden behind the button, because it goes to a
 * colleague under this person's name and nobody should send words they have not
 * read.
 */
function Invite({ invite, onCopy }: { invite: string; onCopy: (text: string) => void }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  // A confirmation that outstays the act is a confirmation about the last thing
  // rather than this one, and the timer is cleared on the way out so a panel
  // that is closed mid-flash cannot set state on a component that has gone.
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
  return (
    <div className="step__body">
      {list === undefined ? null : (
        <>
          <MemberRoster list={list} />
          <Problems list={list} />
          <Freshness list={list} />
        </>
      )}
      {status === undefined || status.links.length === 0 ? null : (
        <ul className="links">
          {status.links.map((link) => (
            <LinkRow key={link.publicKey} link={link} />
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * One teammate, and how this machine is getting on with reaching them.
 *
 * The detail is the runtime's own and is the point of the row: a link that has
 * waited across two hourly rendezvous rotations says so, and names the two
 * things checkable from this side — that both machines agree about the time,
 * and that `.teamree/relay` names the same relay on both.
 */
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
    return <p className="members__empty">No keys committed yet. Whoever adds the first one starts the roster.</p>
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

/**
 * Files that are in the directory and are not members. Named rather than
 * counted: a skipped file is somebody's key that is not working, and the only
 * useful version of that message is the one with the path in it.
 */
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

/**
 * Whether this list will stay true on its own.
 *
 * Said only when it will not. A roster that follows the file needs no
 * reassurance; one that nothing is watching is a list that was true when it was
 * read, and somebody about to believe it deserves to know which of the two they
 * are looking at.
 */
function Freshness({ list }: { list: MemberList }): React.JSX.Element | null {
  if (list.watched) return null
  return (
    <p className="members__stale">
      teamree could not watch this project’s files, so this list is only as fresh as this read. {UNWATCHED_TEAMREE_LAG}
    </p>
  )
}
