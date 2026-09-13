// Setting teamwork up, as five steps instead of a document.
//
// Every piece of this already worked and every piece already had a method
// behind it. What did not exist was one place that says where you are and what
// the next thing is, so doing it meant following `docs/trying-teamwork.md` with
// a terminal in the other hand. The steps here are that runbook's 3, 4 and 5.
//
// Three things the panel refuses to do, each of them a decision rather than an
// omission:
//
// **It does not commit or push.** It writes files and stops. Being able to push
// that file is the entire definition of membership, and an app that pushed on
// somebody's behalf would be making a claim they never made.
//
// **It does not run a relay.** It accepts a URL. Standing a relay up is a
// decision about somebody's Cloudflare account or somebody's box, taken in a
// terminal, and an app that started a container would be taking it for them.
//
// **It does not pick a relay for you either.** A bare URL field assumes the
// person already knows what to paste, and the one thing certainly true of
// somebody opening this for the first time is that they do not. What it does
// now is rank: one recommendation, one fallback, and the two that are somebody
// else's infrastructure behind a disclosure. Four options presented as equals
// was a decision handed to the one person in the room least able to take it.
//
// The roster, the relay panel and the push commands were already here; they are
// the same panels, under the steps that say why each one matters.

import { useState } from 'react'
import {
  UNWATCHED_TEAMREE_LAG,
  type Member,
  type MemberList,
  type PeerLink,
  type RelaySetting,
  type TeamworkStatus
} from '@shared/entities'
import {
  ADD_KEY_BUTTON,
  checkRelayDraft,
  KEY_GRANT_WARNING,
  memberFilePreview,
  pushPlan,
  MORE_RELAYS_BUTTON,
  MORE_RELAYS_LEAD,
  RELAY_LEAD,
  RELAY_OPTIONS,
  type RelayOption,
  shortKey,
  startTeamworkFlow,
  type RelayDraftCheck,
  type StartTeamworkRead,
  type StartTeamworkReadErrors,
  type StartTeamworkStep,
  type StepMark
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
    failedReads: props.readErrors
  })
  return (
    <div className="steps">
      {flow.blocker === null ? null : (
        <p className="steps__blocker">
          <strong>This checkout cannot take part yet.</strong> {flow.blocker}
        </p>
      )}
      <ol className="steps__list">
        {flow.steps.map((step, index) => (
          <li key={step.id} className={`step step--${step.mark}${step.id === flow.currentId ? ' step--current' : ''}`}>
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
          relay={props.relay}
          // The four options are a decision, and the override is that decision
          // taken: showing them again is a wall of choices about a chosen thing.
          options={step.mark !== 'done' && step.mark !== 'this-run'}
          pending={props.relayPending}
          error={props.relayError}
          onSet={props.onSetRelay}
        />
      )
    case 'push':
      return <PushBody list={props.list} relay={props.relay} projectPath={props.projectPath} />
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
        <p className="grant__body">What makes that survivable is that none of it can be done invisibly:</p>
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
        <p className="members__caveat">This writes the file and stops. Step 4 is the part that means something.</p>
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
 * The relay: what is in effect, what the environment said, the four ways to
 * get one when there is none, and the field that writes the file.
 */
function RelayBody({
  relay,
  options,
  pending,
  error,
  onSet
}: {
  relay: RelaySetting
  /** Whether the four ways to get a relay are still a decision to make. */
  options: boolean
  pending: boolean
  error: string | null
  onSet: (url: string) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const check = checkRelayDraft(draft)

  const submit = (event: React.FormEvent): void => {
    event.preventDefault()
    if (check.state === 'ok') onSet(check.url)
  }

  return (
    <div className="step__body">
      {relay.url === null ? null : (
        <p className="members__relay-current">
          <code>{relay.url}</code>
          <span className="members__relay-source">
            {relay.source === 'environment' ? `from ${relay.override.name}` : `from ${relay.file}`}
          </span>
        </p>
      )}
      <Override relay={relay} />
      {options ? <RelayOptions /> : null}
      <form className="members__relay" onSubmit={submit}>
        <label className="field">
          <span className="field__label">
            {relay.onDisk.url === null ? 'Set the relay for this project' : 'Change the relay for this project'}
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
            Whoever stood the relay up pastes its URL here once. Everybody else gets it from the repository.{' '}
            {relay.onDisk.url === null ? 'Writes' : 'Replaces'} <code>{relay.file}</code>, and stops there.
          </span>
        </label>
        {check.state === 'bad' ? <RelayRefusal check={check} onUse={setDraft} /> : null}
        {error === null ? null : <p className="members__relay-error">{error}</p>}
        <button type="submit" className="button" disabled={pending || check.state !== 'ok'}>
          {pending ? 'Writing…' : 'Write relay file'}
        </button>
      </form>
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
 * How a team gets a relay: the one to take, the one to fall back on, and a way
 * to reach the rest without having to read them.
 *
 * Shown only to somebody who has none, because a joiner has no decision to
 * make: their relay arrives in the repository, and this is a wall of choices
 * about a thing already chosen. And ranked rather than listed, because the wall
 * was the problem — `relay/README.md` has always said to take the Worker unless
 * you have a reason not to, and a panel that showed four equals was refusing to
 * pass that sentence on.
 *
 * The folded two are a button with `aria-expanded` rather than a `details`
 * element: what is inside is not rendered until it is asked for, so it is
 * absent from the page rather than merely hidden, and nothing can read out or
 * tab into an option nobody opened.
 */
function RelayOptions(): React.JSX.Element {
  const [showMore, setShowMore] = useState(false)
  const lead = RELAY_OPTIONS.filter((option) => option.tier !== 'more')
  const more = RELAY_OPTIONS.filter((option) => option.tier === 'more')

  return (
    <div className="relay-options">
      <p className="relay-options__lead">{RELAY_LEAD}</p>
      <ul className="relay-options__list">
        {lead.map((option) => (
          <RelayOptionCard key={option.id} option={option} />
        ))}
      </ul>
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
              {more.map((option) => (
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
      <p className="relay-option__name">
        {option.name}
        {option.tier === 'lead' ? <span className="relay-option__tier">Recommended</span> : null}
      </p>
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
          ? 'Stable enough to commit: paste it below and push .teamree/relay.'
          : 'Too short-lived to commit: use TEAMREE_RELAY_URL instead, and leave .teamree/relay alone.'}
      </p>
    </li>
  )
}

/**
 * What the environment said, including when it said nothing.
 *
 * "I set TEAMREE_RELAY_URL and nothing happened" is a predictable question on
 * macOS, where an app opened from Finder or the dock inherits none of a
 * shell's environment. The app cannot fix that — it is how the platform starts
 * programs — but it can say whether it saw an override at all, which is the one
 * thing nobody outside the process can check.
 */
function Override({ relay }: { relay: RelaySetting }): React.JSX.Element {
  if (relay.override.value === null) {
    return (
      <p className="members__relay-note">
        No <code>{relay.override.name}</code> in this app’s environment. An app opened from Finder or the dock does not
        inherit your shell’s, so that override only applies when teamree is started from a terminal that has it set.
      </p>
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

/** The exact files that were written, and the one commit that carries them. */
function PushBody({
  list,
  relay,
  projectPath
}: {
  list: MemberList | undefined
  relay: RelaySetting | undefined
  projectPath: string | undefined
}): React.JSX.Element | null {
  const plan = pushPlan(list, relay, projectPath)
  if (plan === null) return null
  return (
    <div className="step__body">
      <ul className="push__files">
        {plan.files.map((file) => (
          <li key={file}>
            <code>{file}</code>
          </li>
        ))}
      </ul>
      <pre className="members__push-commands">{plan.commands}</pre>
      <p className="members__caveat">
        If your teammate pushes at the same moment, the second push is rejected with “fetch first”. That is not a merge
        conflict — you added different files and git merges them without an opinion — so the answer is{' '}
        <code>git pull --rebase &amp;&amp; git push</code>, never a force.
      </p>
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
