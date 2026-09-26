# Pasted image preview

Claude Code shows a pasted image as `[Image #N]`, in its input box and later in the
transcript. This makes each placeholder in a pane a link: hover shows a thumbnail,
a click opens the full image with a Show in Finder button.

## What was checked, not assumed

Against Claude Code 2.1.282, on the owner's machine and in its binary:

- **Where the image is.** Claude Code writes every pasted image at paste time, before
  the prompt is sent, to `<tmp>/claude-<uid>/<cwd slug>/<session id>/images/<N>.<ext>`.
  `<tmp>` is `CLAUDE_CODE_TMPDIR`, else `/tmp` (`/private/tmp` on a Mac). The
  extension comes from the bytes (`png`, `jpeg`, `webp` and `gif` were all seen or named);
  the file name pattern is `^(\d+)\.[a-z]+$`.
- **N is the placeholder's number.** `1.png`, `2.png` and `3.png` were written at the
  moment of each paste; `[Image #2]` and `[Image #3]` in the transcript carry
  `imagePasteIds: [2]` and `[3]`. `1.png` was pasted and never sent, so the file is the
  only record of an image still in the input box.
- **Numbering.** One counter per session. A resumed session continues it: Claude
  Code advances past every id in the transcript and past the highest file in the
  images directory. A new session (`/clear`, a new conversation) starts at 1 in a
  new directory.
- **Which session a pane is on.** teamree pins the id at launch (`--session-id`), but
  `/clear` and `/resume` move the running process to another one. Claude Code keeps
  `~/.claude/sessions/<pid>.json` (under `CLAUDE_CONFIG_DIR` when set) and rewrites its
  `sessionId` on every switch. That is the live answer.
- **Lifetime.** Claude Code deletes the images directory of sessions that are not
  running once they are old enough. A placeholder can outlive its file.

## Why the disk and not teamree's own copy

teamree does not see most image pastes. Claude Code reads the macOS clipboard
itself on Ctrl+V; the pane only passes the key through. A copy taken by teamree at
paste time would also have to guess Claude Code's numbering, which resumes across
restarts and restarts on `/clear`. The file Claude Code wrote is the image it
attached, under the number it printed.

## Mapping

In the main process, per lookup of `(pane, N)`:

1. The pane's process tree from one `ps` (the table the resources panel already
   parses), then `~/.claude/sessions/<pid>.json` for the pane's own descendants
   only. Other Claude Code sessions on the machine are never read.
2. No live Claude process (it exited): the last session this pane was seen on,
   then the id teamree pinned at launch.
3. The session's images directory, found by that session id under
   `claude-<uid>/*/`: the cwd slug is Claude Code's to spell.
4. `N.<ext>` with a known image extension, handed to the window as a
   `teamree-file://` grant confined to that directory.

Anything missing at any step answers `null`, and the placeholder stays plain text.

## Rendering

An xterm link provider, as the file links are: nothing is drawn into the buffer,
so selection and copy are untouched. A link is offered only once the file is found.

- Hover: a thumbnail near the pointer.
- Click: a modal with the image, Show in Finder and Close. Esc or a click outside closes.

Inline image rendering was rejected: it needs an image addon, changes row heights
under a full-screen program, and draws over text the agent owns.

## Strip

The images in the prompt still being written show as thumbnails in a row under the pane.

- **Which.** The placeholders between the two rules of Claude Code's input box at the bottom
  of the screen (`promptImages.ts`). A sent prompt moves into the transcript, and `/clear` or
  a new session leaves the input empty, so the strip clears by itself. While a dialog covers
  the input the strip keeps what it showed.
- **Where.** A row, not an overlay, so it covers no text; the pty is refit when it comes and
  goes, at a paste and a submit. It sits ahead of the surface in the DOM for Tab (xterm keeps
  Tab) and is drawn below it, next to the input. Each pane has its own, in any split.
- **−** folds it to a count, per pane.
- **×** deletes the image's placeholder from the input (below). The thumbnail goes when the
  input no longer holds it; when it stays, the strip says why in a few words.

## Removing an image

Claude Code keeps a pasted image only while its placeholder is in the input. Deleting the
placeholder is the whole removal; teamree does it with the keys a person would press.

Read in the 2.1.283 bundle (strings only, the CLI was never run):

- **The placeholder is one caret stop.** The input's cursor class matches
  `\[(?:Pasted text|Image|Audio|...Truncated text) #\d+( \+\d+ lines)?\.*\]` at the caret:
  `left()` and `right()` jump the whole placeholder, and `backspace()` is
  `left().modifyText(this)`, so one Backspace after its `]` deletes all of it.
- **The keys.** In the prompt, ← is `left()` (on an empty input it opens agents instead), → is
  `right()` (on an empty input it takes the suggestion), Backspace is `backspace()`. ↑ and ↓ move
  into history at the first and last rows, so they are never sent.
- **The image goes with it.** A subscription on the input's value deletes every image entry whose
  id is no longer among its placeholders, on the edit itself, not at submit.
- **The caret is on screen.** The prompt declares its caret cell, and the renderer moves the
  terminal cursor there after every frame (absolute in full screen, relative inline).
- **The input is all there.** In full screen the input shows at most
  `max(3, floor(rows / 2) - 5)` rows and scrolls with the caret, silently; inline it has no cap.

So, in `promptEdit.ts`, only when all hold:

1. The pane reads `quiet` (`paneActivity.ts`): its turn is over and it is not asking anything.
2. Nobody typed into the pane in the last second, here or as a teammate.
3. The input box is on screen, shorter than the full-screen cap, holds `[Image #N]` exactly
   once, and the terminal cursor is inside it.

Then ← or → one at a time until the cursor sits on the placeholder's `[`, each press checked to
have moved it. One → must land just past its `]`: proof the placeholder is a single stop in this
version. If not, one ← puts the caret back and nothing is deleted. A keystroke from anybody on
the way stops it short of deleting. Then Backspace, and the input must read as before less the
placeholder. A miss is not undone; the strip says "not removed" and the person looks.

## Surface

- `terminal.pastedImage { terminalId, index } -> { url, path } | null`, a local
  runtime method. It is not on the teammate allow-list; a watched pane shows plain text.
- Lookups are cached for a few seconds per pane; a hover asks for every row the pointer crosses.

## Edge cases

- Several images: each placeholder resolves by its own number.
- Resumed session: same id, same directory, numbering continues.
- `/clear` or `/resume` in the pane: the live session file moves the lookup to the new
  directory. Scrollback from before is usually cleared by Claude Code itself.
- Missing file, missing directory, unreadable session file, no `ps`, Windows: no link.
