// What an agent reads when a message is pasted into its prompt: one `[teamree]` line,
// and for an ask, the command that answers it. Never more than MAX_MESSAGE_BYTES.

import { MAX_MESSAGE_BYTES, type MessageParty, type TaskMessage } from '../../shared/messages'

/** A party's name as a pasted line says it. */
export type NameOf = (party: MessageParty) => string

export function pastedText(message: TaskMessage, nameOf: NameOf): string {
  const from = nameOf(message.from)
  const head = (() => {
    switch (message.kind) {
      case 'ask': {
        const options = message.options === undefined ? '' : ` (${message.options.join(' | ')})`
        return `[teamree] ask #${message.id} from "${from}": ${message.text}${options}`
      }
      case 'reply':
        return `[teamree] reply to #${message.replyTo ?? '?'} from "${from}": ${message.text}`
      case 'done': {
        const files = message.paths === undefined ? '' : ` Files: ${message.paths.length}.`
        const land =
          message.from.worktreeId === undefined ? '' : ` Merge: teamree worktree land ${message.from.worktreeId}`
        return `[teamree] "${from}" done (${message.outcome ?? 'succeeded'}): ${message.text}${files}${land}`
      }
      case 'note':
        return `[teamree] note from "${from}"${answering(message)}: ${message.text}`
    }
  })()
  const tail = message.kind === 'ask' ? `\nAnswer: teamree msg reply ${message.id} "<answer>"` : ''
  return `${cutToBytes(head, MAX_MESSAGE_BYTES - byteLength(tail))}${tail}`
}

/** A note that answers an ask its asker stopped waiting on says which. */
export function answering(message: Pick<TaskMessage, 'kind' | 'replyTo'>): string {
  return message.kind === 'note' && message.replyTo !== undefined ? `, answering #${message.replyTo}` : ''
}

const encoder = new TextEncoder()

function byteLength(text: string): number {
  return encoder.encode(text).length
}

function cutToBytes(text: string, bytes: number): string {
  if (byteLength(text) <= bytes) return text
  // A character split by the cut decodes as U+FFFD, which is dropped.
  const kept = new TextDecoder().decode(encoder.encode(text).subarray(0, bytes - byteLength('…')))
  return `${kept.replace(/\uFFFD+$/u, '')}…`
}
