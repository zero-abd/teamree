// The window's edited files as it last published them, and the question put to it before a quit or a
// close. Its edits are in the profile as drafts, so a window that is gone or cannot answer lets it go.

import type { IpcMain, IpcMainEvent, WebContents } from 'electron'

/** Keep in step with `src/preload/index.ts`, which repeats the literals. */
export const UNSAVED_PUBLISH_CHANNEL = 'teamree:unsaved:publish'
export const UNSAVED_ASK_CHANNEL = 'teamree:unsaved:ask'
export const UNSAVED_ANSWER_CHANNEL = 'teamree:unsaved:answer'

export type LeaveReason = 'quit' | 'close'

const MOST_FILES = 1_000
const LONGEST_PATH = 4_096

/** The paths, checked one by one, or null. */
export function readUnsavedPaths(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > MOST_FILES) return null
  const paths: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > LONGEST_PATH) return null
    paths.push(entry)
  }
  return paths
}

function readAnswer(value: unknown): { id: number; proceed: boolean } | null {
  const answer = value as { id?: unknown; proceed?: unknown } | null
  if (typeof answer !== 'object' || answer === null) return null
  if (typeof answer.id !== 'number' || typeof answer.proceed !== 'boolean') return null
  return { id: answer.id, proceed: answer.proceed }
}

type Sender = Pick<WebContents, 'send' | 'isDestroyed' | 'once'>

export type UnsavedFilesHost = {
  /** The close button's edited dot: `setDocumentEdited` on the sender's window. */
  setEdited: (sender: WebContents, edited: boolean) => void
  /** Only the window's main frame speaks for it. */
  fromMainFrame: (event: IpcMainEvent) => boolean
}

export type UnsavedFiles = {
  paths: () => readonly string[]
  /** Asks the window to save or discard; true when it may go. One question at a time. */
  ask: (reason: LeaveReason) => Promise<boolean>
  /** Lets a question in flight go through, for a forced quit. */
  release: () => void
}

export function installUnsavedFiles(ipc: Pick<IpcMain, 'on'>, host: UnsavedFilesHost): UnsavedFiles {
  let published: { sender: Sender; paths: string[] } | null = null
  let asked = 0
  let question: { id: number; answer: Promise<boolean>; settle: (proceed: boolean) => void } | null = null

  const settle = (proceed: boolean): void => {
    const pending = question
    question = null
    pending?.settle(proceed)
  }

  ipc.on(UNSAVED_PUBLISH_CHANNEL, (event: IpcMainEvent, payload: unknown) => {
    if (!host.fromMainFrame(event)) return
    const paths = readUnsavedPaths(payload)
    if (!paths) return
    const sender = event.sender
    if (published?.sender !== sender) {
      sender.once('destroyed', () => {
        if (published?.sender !== sender) return
        published = null
        settle(true)
      })
    }
    published = { sender, paths }
    host.setEdited(sender, paths.length > 0)
  })

  ipc.on(UNSAVED_ANSWER_CHANNEL, (event: IpcMainEvent, payload: unknown) => {
    if (!host.fromMainFrame(event) || event.sender !== published?.sender) return
    const answer = readAnswer(payload)
    if (answer !== null && answer.id === question?.id) settle(answer.proceed)
  })

  return {
    paths: () => published?.paths ?? [],
    ask(reason) {
      if (question !== null) return question.answer
      if (published === null || published.paths.length === 0 || published.sender.isDestroyed()) {
        return Promise.resolve(true)
      }
      const id = ++asked
      let resolve: (proceed: boolean) => void = () => {}
      const answer = new Promise<boolean>((done) => (resolve = done))
      question = { id, answer, settle: resolve }
      published.sender.send(UNSAVED_ASK_CHANNEL, { id, reason })
      return answer
    },
    release: () => settle(true)
  }
}
