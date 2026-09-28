// A pull request in one step: commit under the message typed here, publish or push, then create it with the title and
// body the runtime drafted. Each step shows as it runs; a failed one says why, and Retry resumes from it.

import { useEffect, useRef, useState } from 'react'
import {
  pullRequestSteps,
  runPullRequestSteps,
  type PullRequestStep,
  type PullRequestStepFailure
} from '@shared/pullRequestSteps'
import { runtimeClient } from '../runtimeClient/currentRuntimeClient'
import { useWorkspaceStore } from '../state/workspaceStore'
import { CommitFrom } from '../workspace/rightPanel/CommitFrom'
import { useCommitMessage } from '../workspace/rightPanel/commitMessage'
import { Confirm } from './Confirm'
import { Input, Textarea } from '../ui/Input'

export function CreatePullRequestDialog({ worktreeId }: { worktreeId: string }): React.JSX.Element {
  const landing = useWorkspaceStore((state) => state.landings[worktreeId])
  const status = useWorkspaceStore((state) => state.statuses[worktreeId])
  const pending = useWorkspaceStore((state) => state.changes[worktreeId])
  const closeDialog = useWorkspaceStore((state) => state.closeDialog)
  const noteCommit = useWorkspaceStore((state) => state.noteCommit)
  const createPullRequest = useWorkspaceStore((state) => state.createPullRequest)
  const pushWorktree = useWorkspaceStore((state) => state.pushActiveWorktree)
  const { message, from, setMessage } = useCommitMessage(worktreeId)
  const messageBox = useRef<HTMLTextAreaElement>(null)
  const [drafted, setDrafted] = useState<{ title: string; body: string } | null>(null)
  const [title, setTitle] = useState<string | null>(null)
  const [body, setBody] = useState<string | null>(null)
  const [draft, setDraft] = useState(false)
  // Frozen on confirm: the status moves under a run, and a retry resumes the same list.
  const [plan, setPlan] = useState<PullRequestStep[] | null>(null)
  const [running, setRunning] = useState<PullRequestStep | null>(null)
  const [done, setDone] = useState<PullRequestStep[]>([])
  const [failure, setFailure] = useState<PullRequestStepFailure | null>(null)

  const counted = status === undefined ? 0 : status.staged + status.unstaged + status.untracked
  const steps =
    plan ??
    pullRequestSteps({
      uncommitted: Math.max(pending?.total ?? 0, counted),
      published: landing?.published ?? false,
      ahead: status?.ahead ?? 0
    })
  const remaining =
    failure === null ? steps.filter((step) => !done.includes(step)) : steps.slice(steps.indexOf(failure.step))
  const commitFirst = remaining.includes('commit')
  const shownTitle = title ?? drafted?.title ?? ''
  const shownBody = body ?? drafted?.body ?? ''
  const label = (step: PullRequestStep): string =>
    step === 'commit' ? 'Commit' : step === 'create' ? 'Create Pull Request' : landing?.published ? 'Push' : 'Publish'
  const blocked =
    commitFirst && message.trim() === ''
      ? 'Needs a commit message'
      : shownTitle.trim() === ''
        ? 'Needs a title'
        : undefined

  useEffect(() => {
    if (from !== null) messageBox.current?.select()
    let alive = true
    runtimeClient
      .call('worktree.createPullRequest', { worktreeId, dryRun: true, ...(commitFirst ? { pending: message } : {}) })
      .then((read) => {
        if (alive && read.title !== undefined) setDrafted({ title: read.title, body: read.body ?? '' })
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [worktreeId])

  const run = async (): Promise<void> => {
    if (running !== null || blocked !== undefined) return
    const order = plan ?? steps
    setPlan(order)
    const request = { title: shownTitle.trim(), body: shownBody, ...(draft ? { draft: true } : {}) }
    const failed = await runPullRequestSteps(
      order,
      async (step) => {
        if (step === 'commit') {
          noteCommit(worktreeId)
          await runtimeClient.call('worktree.commit', { worktreeId, message, all: true }).catch((error: unknown) => {
            if (noteCommit(worktreeId, error)) closeDialog()
            throw error
          })
          setMessage('')
        } else if (step === 'push') {
          await pushWorktree(worktreeId)
          const push = useWorkspaceStore.getState().pushes[worktreeId]
          if (push?.phase === 'failed') throw new Error(push.error === 'Push failed' ? push.detail : push.error)
        } else {
          const why = await createPullRequest(worktreeId, request)
          if (why !== null) throw new Error(why)
        }
        setDone((finished) => [...finished, step])
      },
      (step) => {
        setFailure(null)
        setRunning(step)
      },
      failure?.step
    )
    setRunning(null)
    setFailure(failed)
    const shown = useWorkspaceStore.getState().dialog
    if (failed === null && shown?.kind === 'create-pr' && shown.worktreeId === worktreeId) closeDialog()
  }

  const busy = running !== null
  const onEnter = (event: React.KeyboardEvent): void => {
    if (event.key !== 'Enter' || event.shiftKey) return
    event.preventDefault()
    void run()
  }

  return (
    <Confirm
      title={`Create a pull request into ${landing?.base ?? 'main'}?`}
      titleHint={landing?.branch}
      cancel="Cancel"
      confirm={
        running !== null
          ? `${label(running)}…`
          : failure !== null
            ? 'Retry'
            : commitFirst
              ? 'Commit & Create'
              : 'Create'
      }
      tone="primary"
      confirmDisabled={busy || blocked !== undefined}
      {...(busy || blocked === undefined ? {} : { confirmHint: blocked })}
      onCancel={closeDialog}
      onConfirm={() => void run()}
    >
      {commitFirst ? (
        <>
          <p className="confirm__body">{`${Math.max(pending?.total ?? 0, counted).toLocaleString('en-US')} uncommitted`}</p>
          <textarea
            ref={messageBox}
            className="textarea field__message"
            rows={1}
            value={message}
            placeholder="Commit message"
            aria-label="Commit message"
            autoFocus
            disabled={busy}
            onChange={(event) => setMessage(event.target.value)}
            onKeyDown={onEnter}
          />
          <CommitFrom from={busy ? null : from} onClear={() => setMessage('')} />
        </>
      ) : null}
      {commitFirst ? <p className="confirm__body">Pull request</p> : null}
      <Input
        value={shownTitle}
        placeholder="Title"
        aria-label="Title"
        autoFocus={!commitFirst}
        disabled={busy}
        onChange={(event) => setTitle(event.target.value)}
        onKeyDown={onEnter}
      />
      <Textarea
        className="field__message pullRequest__body"
        rows={3}
        value={shownBody}
        placeholder="Body"
        aria-label="Body"
        disabled={busy}
        onChange={(event) => setBody(event.target.value)}
      />
      <label className="confirm__check">
        <input type="checkbox" checked={draft} disabled={busy} onChange={(event) => setDraft(event.target.checked)} />
        Draft
      </label>
      <ol className="pullRequest__steps">
        {steps.map((step) => {
          const state =
            failure?.step === step ? 'failed' : running === step ? 'running' : done.includes(step) ? 'done' : ''
          return (
            <li
              key={step}
              className={`pullRequest__step${state === '' ? '' : ` pullRequest__step--${state}`}`}
              aria-label={state === '' ? label(step) : `${label(step)} ${state}`}
            >
              <span className="pullRequest__mark" aria-hidden="true">
                {STEP_MARK[state]}
              </span>
              <span>{label(step)}</span>
            </li>
          )
        })}
      </ol>
      {failure === null ? null : (
        <span className="field__error" role="alert">
          {failure.reason}
        </span>
      )}
    </Confirm>
  )
}

const STEP_MARK = { '': '○', running: '…', done: '✓', failed: '✕' } as const
