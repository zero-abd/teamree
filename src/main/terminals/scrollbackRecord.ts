// What a pane's output may be kept as, and what it is allowed to do when it is
// put back on screen.
//
// Terminal output is not text. It is a stream of instructions to an emulator,
// written by whatever was running in the pane, and some of those instructions
// make the emulator *send bytes back*: a cursor-position report, a device
// attributes request, ENQ's answerback, focus reporting. Live, that is a
// conversation — a program asked the emulator a question and read the answer on
// its own stdin. Replayed into a pane a week later it is something else
// entirely: the answer would be typed into a brand new shell that never asked
// anything, which is a file on disk putting characters on somebody's command
// line. Other sequences reach outside the pane altogether — OSC 52 writes the
// system clipboard, OSC 0 renames the window, OSC 8 hangs a URL off a run of
// text — and ESC c resets the emulator outright, erasing whatever was above it.
//
// So a record is not kept the way it arrived. It is reduced to an allowlist on
// the way to disk and reduced again on the way back, and that list has exactly
// one escape sequence on it: SGR, which sets colour and weight and can do
// nothing else. Every other CSI, every string sequence (OSC, DCS, APC, PM,
// SOS), every C0 control that is not whitespace, and the whole C1 range are
// dropped.
//
// An allowlist rather than a list of the dangerous ones, because the dangerous
// ones are not a closed set: emulators gain sequences, and a denylist written
// today is wrong later without anybody touching it. The cost is that a record
// of a full-screen program reads as the lines it drew rather than as the
// picture it drew — `outputEvidence.ts` makes the same trade for the same
// reason, and a record is for reading rather than for working in. The gain is
// that nothing on this disk can reprogram a terminal on the next launch, and
// that `cat`ing one of these files is safe too.

/** One pane's kept output, and when this machine wrote it down. */
export type RecordedScrollback = {
  text: string
  /**
   * By this machine's clock, at the moment the record was taken — which is not
   * necessarily when the pane stopped printing. A record is written when a pane
   * exits, when the app quits, and at a checkpoint while the pane is still
   * running, and only the first of those three is an ending. So this is the
   * last moment the record is known to be true, and the pane may have printed
   * more after it that nothing wrote down.
   */
  recordedAt: number
}

const ESC = '\x1b'
const BEL = '\x07'
const ST_C1 = '\u009c'

/** The dim a pane's own asides are printed in; see TerminalView's exit line. */
const DIM = `${ESC}[38;5;244m`
const RESET = `${ESC}[0m`

/**
 * What is left once the sanitizer has run: text, the whitespace controls, and
 * colour. Exported because it is the claim this module makes, and a claim is
 * worth being able to assert directly.
 */
export const INERT_RECORD = /^(?:[^\u0000-\u001f\u007f-\u009f]|[\n\r\t\u0008]|\u001b\[[0-9;:]*m)*$/u

/**
 * The record as it is written into a restored pane: what it is, the output
 * itself, and the line the new shell starts under.
 *
 * Both marks are said in words rather than left to be inferred from a colour,
 * because the one thing a reader must never do here is take a record for a
 * running process. The first line says the output is finished and how far it
 * goes; the last says what begins below it. A record long enough to scroll
 * past its own opening line still has the closing one immediately above the
 * first thing the new shell printed, which is the boundary that actually gets
 * read.
 *
 * `startsBelow` names what the reader is about to read, because it is not
 * always a new shell: a pane that came back to resume a conversation and could
 * not shows this record under the failed attempt instead. A mark that says
 * "shell" above an agent's refusal is a small lie, and the whole point of
 * saying these things in words is that they are true.
 */
export function replayableRecord(record: RecordedScrollback, startsBelow?: string): string {
  return `${openingMark(record.recordedAt)}${record.text}${closingMark(startsBelow)}`
}

/**
 * What follows a record in the ordinary case: the pane was brought back, its
 * command was deliberately not re-issued, and a shell is what starts.
 *
 * Four words rather than a clause. Every mark in this file is a caption on a
 * terminal, read by somebody who writes terminals for a living, and the reading
 * it has to survive is the fast one on the way down the pane.
 */
export const NEW_SHELL_BELOW = 'new shell below'

/**
 * What follows it when the pane was brought back to resume a conversation and
 * the resume did not take: what begins under this line is the attempt at that
 * resume, not a shell and not the conversation. The record is shown at all only
 * in that case — see `pty-session.ts`, which withholds it while a resume may
 * still be working.
 */
export const FAILED_RESUME_BELOW = 'resume attempt below'

/**
 * What follows it when a pane that had exited was asked to run its program
 * again: the same program, in the same directory, from the top.
 *
 * Named rather than left as "a new shell", because the pane most often run
 * again is an agent's, and a mark saying "shell" over an agent booting up is
 * the same small lie the two constants above exist to avoid. It says "again"
 * rather than "resumed" for the larger reason: this is a fresh conversation,
 * and the record above it belongs to the one that ended.
 */
export function startsAgainBelow(program: string): string {
  return `${program} starts again below`
}

/**
 * Said into a pane whose resume did not take, in place of the conversation.
 *
 * One line, and every word of it something this app actually knows: that the
 * resume was refused, what the agent exited with, whether the pane's earlier
 * output is above, and whether a fresh agent came up underneath. It does *not*
 * know why the agent refused — only the agent knows that, and the agent has
 * just printed it immediately above this line, so the mark points at that by
 * sitting under it rather than guessing over the top of it.
 *
 * This was four sentences, and the middle two were the reassurance: that a
 * conversation being gone is not a malfunction — they are deleted, they expire,
 * and they are recorded on whichever machine held them, so a worktree synced to
 * a second laptop has none of them. That is worth knowing once and is written
 * here; it is not worth eighty words in a terminal pane every time, in front of
 * a reader who runs agents for a living.
 *
 * `restarted` is told rather than guessed at, because only the pane knows
 * whether the fresh agent came up: a mark promising an agent that never came
 * would be a lie in the other direction.
 */
export function failedResumeMark(exitCode: number, hasRecord: boolean, restarted: boolean): string {
  const kept = hasRecord ? ', record above' : ''
  const next = restarted ? 'fresh agent below' : 'open a new pane for a fresh one'
  return `${RESET}\r\n${DIM}[resume refused — agent exited ${exitCode}${kept}; ${next}]${RESET}\r\n`
}

/**
 * Said into a pane that was going to resume a conversation and did not, because
 * the agent's own store has nothing written under the id this pane was given.
 *
 * Printed above the fresh agent rather than under a refusal, which is the whole
 * difference between this mark and the one above: nothing has failed here and
 * nothing was asked of the CLI at all. The pane looked where that agent keeps
 * its conversations, found none under the session id it was given, and started
 * over — and a pane that comes back without the conversation somebody left in
 * it owes them a line either way. "We looked" is a different line from "it
 * refused", so it is a different mark, and the two are told apart by their
 * first four words.
 *
 * Why the conversation is absent is deliberately not in the line. It can have
 * been deleted, or expired, or recorded on another machine, and it can be that
 * the agent never wrote one — the pane was opened, a key was pressed at a
 * prompt that was not a conversation, and nothing was ever said. Nothing here
 * can tell those apart from outside, so the mark names what it can demonstrate
 * and leaves the rest to the reader, who knows all four.
 */
export function noConversationMark(agent: string): string {
  return `${RESET}\r\n${DIM}[no conversation to resume — fresh ${agent} below]${RESET}\r\n`
}

/**
 * Said before the record, so it is described before it is read.
 *
 * Three facts and no sentence: that this is a record, how far it goes, and that
 * nothing in it is live. The time is the one thing here a reader can act on, so
 * it is the moment this was written down rather than the moment the pane
 * stopped — the two are the same only when the pane exited, and a machine that
 * lost power mid-build wrote its last checkpoint some seconds before it printed
 * its last line. "Up to 14:32" is a claim this can keep; saying the pane ended
 * then is not, which is why the word is "up to" and not "until".
 */
export function openingMark(recordedAt: number): string {
  return `${RESET}${DIM}[record — up to ${clockLabel(recordedAt)}, nothing running]${RESET}\r\n`
}

/** Said after it, which is the line somebody reads on the way down. */
export function closingMark(startsBelow: string = NEW_SHELL_BELOW): string {
  return `${RESET}\r\n${DIM}[end of record — ${startsBelow}]${RESET}\r\n`
}

/**
 * Local wall-clock, to the minute.
 *
 * Absolute rather than "two hours ago": a restored pane can sit open for days,
 * and a relative label computed once at restore is a sentence that goes quietly
 * wrong while nobody is looking at it. Seconds would be noise on a record.
 */
export function clockLabel(at: number): string {
  const when = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ` +
    `${pad(when.getHours())}:${pad(when.getMinutes())}`
  )
}

/**
 * The output reduced to what it is safe to replay: printable text, the
 * whitespace controls a line is made of, and SGR.
 *
 * Applied on the way in so the file on disk is already inert, and again on the
 * way out because the file is the boundary whatever wrote it — the rule
 * `parseTeammateCache` states about bounds, for the same reason.
 */
export function sanitizeRecordedOutput(text: string): string {
  let kept = ''
  let index = 0

  while (index < text.length) {
    const char = text[index] as string

    if (char === ESC) {
      const sequence = readEscape(text, index)
      if (sequence.keep !== undefined) kept += sequence.keep
      index = sequence.end
      continue
    }

    // The whitespace a record is made of. A tab holds a column, a carriage
    // return is how a progress line overwrote itself, and a backspace is how a
    // spinner erased the frame before it.
    if (char === '\n' || char === '\r' || char === '\t' || char === '\b') {
      kept += char
      index += 1
      continue
    }

    // The C1 range is the eight-bit spelling of the sequences above, and the
    // introducers take a payload with them: dropping the single byte would
    // leave `6n` sitting in the record as text where a cursor report had been.
    const code = char.charCodeAt(0)
    if (code === 0x9b) {
      index = scanCsi(text, index + 1).end
      continue
    }
    if (code === 0x90 || code === 0x98 || code === 0x9d || code === 0x9e || code === 0x9f) {
      index = endOfString(text, index + 1)
      continue
    }

    // Everything else under a space is signalling rather than text — BEL rings,
    // ENQ answers back, SO and SI switch character sets.
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      index += 1
      continue
    }

    kept += char
    index += 1
  }

  return kept
}

/**
 * The trailing `capBytes` of `text`, starting at a line boundary.
 *
 * Bytes rather than characters, because that is the unit a cap can mean
 * anything in; and then forward to the first newline, because a byte-aligned
 * cut lands wherever it lands. Half a colour sequence is either nonsense on
 * screen or — when the half that survives is the opening one — an escape left
 * waiting to swallow whatever follows it.
 */
export function tailFromLineBoundary(text: string, capBytes: number): string {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.byteLength <= capBytes) return text

  let start = buffer.byteLength - capBytes
  // A cut inside a multi-byte character would decode to a replacement one.
  while (start < buffer.byteLength && ((buffer[start] ?? 0) & 0xc0) === 0x80) start++
  const cut = buffer.subarray(start).toString('utf8')
  const newline = cut.indexOf('\n')
  return newline === -1 ? cut : cut.slice(newline + 1)
}

/** One escape sequence: where it ends, and what of it is worth keeping. */
type Escape = { end: number; keep?: string }

/**
 * Consumes the sequence starting at `start` and decides its fate.
 *
 * Only a CSI whose final byte is `m` and whose parameters are plain digits
 * survives — SGR, and deliberately not a private-parameter `m`, which is a
 * different instruction wearing the same final byte. A sequence the text cuts
 * off in the middle is dropped along with the rest of the string, because there
 * is no final byte to judge it by and guessing at one is how a half-sequence
 * gets replayed whole.
 */
function readEscape(text: string, start: number): Escape {
  const next = text[start + 1]
  if (next === undefined) return { end: text.length }

  if (next === '[') {
    const csi = scanCsi(text, start + 2)
    if (csi.final === 'm' && /^[0-9;:]*$/.test(csi.params)) return { end: csi.end, keep: text.slice(start, csi.end) }
    return { end: csi.end }
  }

  // The string sequences: OSC, DCS, SOS, PM, APC. Each runs to a string
  // terminator and the whole payload goes with it — a title, a clipboard write,
  // a notification and a hyperlink are all things a record is not allowed to do
  // on somebody's behalf a week after the fact.
  if (next === ']' || next === 'P' || next === 'X' || next === '^' || next === '_') {
    return { end: endOfString(text, start + 2) }
  }

  // The short escapes: ESC c resets the emulator, ESC ( B picks a character
  // set, ESC = switches the keypad. None of them is output.
  let index = start + 1
  while (index < text.length && (text[index] as string) >= ' ' && (text[index] as string) <= '/') index++
  return { end: Math.min(index + 1, text.length) }
}

/**
 * Consumes a CSI from just after its introducer, to the final byte that names
 * what it does. A sequence with no final byte is one the tail cut in half.
 */
function scanCsi(text: string, from: number): { end: number; final?: string; params: string } {
  let index = from
  while (index < text.length) {
    const char = text[index] as string
    if (char >= '@' && char <= '~') return { end: index + 1, final: char, params: text.slice(from, index) }
    index++
  }
  return { end: text.length, params: text.slice(from) }
}

/** Where a string sequence ends: BEL, ESC backslash, or the C1 terminator. */
function endOfString(text: string, from: number): number {
  let index = from
  while (index < text.length) {
    const char = text[index] as string
    if (char === BEL || char === ST_C1) return index + 1
    if (char === ESC && text[index + 1] === '\\') return index + 2
    index++
  }
  return text.length
}
