// The Quick Note panel opened from the menu bar: a project, the note, Save. Esc closes, ⌘↩ saves,
// and a panel left empty goes away when it loses the focus.

import { useEffect, useState } from 'react'

export type QuickNoteBridge = {
  context: () => Promise<{
    projects: { id: string; name: string }[]
    projectId: string | null
    worktree: { id: string; name: string; projectId: string } | null
  }>
  save: (note: {
    projectId: string
    worktreeId: string | null
    text: string
  }) => Promise<{ saved: string } | { problem: string }>
  close: () => void
}

type Context = Awaited<ReturnType<QuickNoteBridge['context']>>

export function QuickNote({ bridge }: { bridge: QuickNoteBridge }): React.JSX.Element {
  const [context, setContext] = useState<Context | null>(null)
  const [projectId, setProjectId] = useState('')
  const [attach, setAttach] = useState(false)
  const [text, setText] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void bridge.context().then((answer) => {
      setContext(answer)
      setProjectId(answer.projectId ?? '')
    })
  }, [bridge])

  useEffect(() => {
    const onBlur = (): void => {
      if (text.trim() === '') bridge.close()
    }
    window.addEventListener('blur', onBlur)
    return () => window.removeEventListener('blur', onBlur)
  }, [bridge, text])

  const worktree = context?.worktree?.projectId === projectId ? context.worktree : null
  const canSave = projectId !== '' && text.trim() !== '' && !saving

  const save = async (): Promise<void> => {
    if (!canSave) return
    setSaving(true)
    const answer = await bridge.save({ projectId, worktreeId: attach && worktree ? worktree.id : null, text })
    setSaving(false)
    setProblem('problem' in answer ? answer.problem : null)
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      bridge.close()
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      void save()
    }
  }

  const projects = context?.projects ?? []
  return (
    <form
      className="quick-note"
      onKeyDown={onKeyDown}
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      <div className="quick-note__bar">
        <span className="select">
          <select
            className="select__input"
            aria-label="Project"
            value={projectId}
            disabled={projects.length === 0}
            onChange={(event) => setProjectId(event.target.value)}
          >
            {projects.length === 0 ? <option value="">No projects</option> : null}
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
          <span className="select__chevron">
            <svg viewBox="0 0 12 12" aria-hidden="true">
              <path d="M3 4.5 6 7.5 9 4.5" />
            </svg>
          </span>
        </span>
        {worktree ? (
          <label className="quick-note__attach">
            <input type="checkbox" checked={attach} onChange={(event) => setAttach(event.target.checked)} />
            <span>Attach to {worktree.name}</span>
          </label>
        ) : null}
      </div>
      <textarea
        className="quick-note__text"
        aria-label="Note"
        placeholder="Note"
        autoFocus
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <div className="quick-note__foot">
        {problem ? <p className="quick-note__problem">{problem}</p> : null}
        <button type="submit" className="button button--primary button--small" disabled={!canSave}>
          Save <kbd>⌘↩</kbd>
        </button>
      </div>
    </form>
  )
}
