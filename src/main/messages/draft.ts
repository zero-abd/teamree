// What a person has typed at an agent's prompt and not sent, told from their keys alone.
// It errs toward a draft: a key whose effect on the input is unknown leaves one standing.

export type Draft = {
  /** The typed text as if the caret stayed at its end: never shorter than the input. */
  text: string
  /** The input may hold text no key shows: recalled history, a completion, a yank. */
  unknown: boolean
  /** The caret left the end, so a line or word kill may leave text behind it. */
  moved: boolean
  /** The keys are answering a menu on screen, not editing the input. */
  answering: boolean
}

export const NO_DRAFT: Draft = { text: '', unknown: false, moved: false, answering: false }

export function hasDraft(draft: Draft): boolean {
  return draft.text !== '' || draft.unknown
}

type Key =
  | 'submit'
  | 'newline'
  | 'erase'
  | 'killLine'
  | 'killWord'
  | 'move'
  | 'lineEnd'
  | 'vertical'
  | 'complete'
  | 'unknown'

const CONTROL: Readonly<Record<string, Key>> = {
  '\r': 'submit',
  '\x03': 'submit',
  '\n': 'newline',
  '\x7f': 'erase',
  '\b': 'erase',
  '\x15': 'killLine',
  '\x17': 'killWord',
  '\x01': 'move',
  '\x02': 'move',
  '\x06': 'move',
  '\x05': 'lineEnd',
  '\x10': 'vertical',
  '\x0e': 'vertical',
  '\t': 'complete',
  '\x07': 'unknown',
  '\x12': 'unknown',
  '\x16': 'unknown',
  '\x19': 'unknown',
  '\x1f': 'unknown'
}

const CSI_FINAL: Readonly<Record<string, Key>> = {
  A: 'vertical',
  B: 'vertical',
  C: 'move',
  D: 'move',
  H: 'move',
  F: 'lineEnd'
}
const PASTE_END = '\x1b[201~'

/** The draft after `data` reached the pane; `menu` when its screen shows a menu those keys answer. */
export function typedInto(draft: Draft, data: string, menu: boolean): Draft {
  if (menu || draft.answering) {
    // Return, Escape, Ctrl-C or one character closes a menu; arrows only move through it.
    const closes = data === '\r' || data === '\x1b' || data === '\x03' || /^[^\x00-\x1f\x7f]$/u.test(data)
    return { ...draft, answering: !closes }
  }
  let next = draft
  for (let at = 0; at < data.length; ) {
    if (data.startsWith('\x1b[200~', at)) {
      const end = data.indexOf(PASTE_END, at)
      next = { ...next, text: next.text + data.slice(at + 6, end < 0 ? undefined : end) }
      at = end < 0 ? data.length : end + PASTE_END.length
      continue
    }
    const sequence = /^\x1b(?:\[[0-?]*[ -/]*[@-~]|O.|\r|\x7f|\x08|.)?/su.exec(data.slice(at))
    const char = sequence?.[0] ?? String.fromCodePoint(data.codePointAt(at)!)
    // An X10 mouse report's three bytes follow its CSI M.
    at += char.length + (char === '\x1b[M' ? 3 : 0)
    const key = sequence === null ? CONTROL[char] : escapeKey(char)
    if (key !== undefined) next = pressed(next, key)
    else if (sequence === null && !/^[\x00-\x1f]$/u.test(char)) next = { ...next, text: next.text + char }
  }
  return next
}

function escapeKey(sequence: string): Key | undefined {
  if (sequence === '\x1b\r') return 'newline'
  if (sequence === '\x1b\x7f' || sequence === '\x1b\x08') return 'killWord'
  if (sequence === '\x1bb' || sequence === '\x1bf') return 'move'
  if (sequence === '\x1b[1~' || sequence === '\x1b[7~') return 'move'
  if (sequence === '\x1b[4~' || sequence === '\x1b[8~') return 'lineEnd'
  const ss3OrCsi = /^\x1b(?:O|\[[\d;]*)([A-Z])$/u.exec(sequence)
  return ss3OrCsi === null ? undefined : CSI_FINAL[ss3OrCsi[1]!]
}

function pressed(draft: Draft, key: Key): Draft {
  const { text } = draft
  const single = !text.includes('\n')
  switch (key) {
    case 'submit':
      return NO_DRAFT
    case 'newline':
      return { ...draft, text: `${text}\n` }
    case 'erase': {
      const left = Array.from(text).slice(0, -1).join('')
      return { ...draft, text: left, moved: draft.moved && left !== '' }
    }
    case 'killLine':
      if (draft.moved || text.endsWith('\n')) return draft
      return { ...draft, text: text.slice(0, text.lastIndexOf('\n') + 1) }
    case 'killWord':
      return draft.moved ? draft : { ...draft, text: text.replace(/\S*[^\S\n]*$/u, '') }
    case 'lineEnd':
      return { ...draft, moved: hasDraft(draft) && !single }
    case 'move':
      return { ...draft, moved: hasDraft(draft) }
    case 'vertical':
      return hasDraft(draft) ? { ...draft, moved: true } : { ...draft, unknown: true }
    case 'complete':
      return hasDraft(draft) ? { ...draft, unknown: true } : draft
    case 'unknown':
      return { ...draft, unknown: true }
  }
}
