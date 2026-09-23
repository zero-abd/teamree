# teamree brand

The one book. Copy, voice, colour, type, and the page. Anything on a surface that
is not in here is wrong; fix it here first. `brand/README.md` holds the mark.

## Positioning

For developers who run more than one coding agent at a time, teamree replaces a
row of terminal tabs and a repository the agents overwrite for each other.

The promise is speed through parallelism: a team on teamree ships more because
every agent works in its own worktree at the same time, and every teammate sees
all of it in one window. Say it with the plain words *ship* and *parallel*.
Never a multiplier ("10x", "100x", "n times faster"): a competitor owns one, and
none of them is a fact about the product.

Category, used everywhere the product is described in a sentence:
**the agentic development environment for teams**. Short form: *an ADE for
teams*. Not "IDE": there is no editor in the app, and its own menu sends you to
yours. Not "orchestrator": teamree watches a PTY and does not speak an agent's
protocol.

## Tagline

Ten candidates were written for the shipping message; the first is the one.

| Candidate | Words | Why, or why not |
| --- | --- | --- |
| **Your whole team ships in parallel.** (chosen) | 6 | The name's own word, the verb that matters, and the mechanism (worktrees side by side) in one plain sentence about the people, not the agents. |
| Ship in parallel, not in turns. | 6 | The contrast is right, but it names the old way instead of the product. |
| One window. Every agent. Everything shipping. | 6 | Good as a thumbnail; three fragments and no subject. |
| Agents that ship like teammates. | 5 | Sells the agents; teamree is for the people running them. |
| Ship every branch at once. | 5 | Concrete, but "branch" undersells a worktree and the team is missing. |
| Your team ships as fast as its agents. | 8 | True, and the comparison points at the agents rather than the team. |
| Run five tasks at once. Ship all five. | 8 | Too long, and the number is arbitrary. |
| More agents, more shipped. | 4 | Flat; any tool could say it. |
| Every agent, one window. | 4 | Says nothing about shipping. |
| Run your agents like a team. | 6 | The previous line, retired: it describes the window, not what the team gets from it. |

Sub-line (12 words): **Every agent in its own git worktree. Every teammate in the
same window.** Two parallel sentences, two facts: kept apart, shared.

The tagline is the `h1` on the site, the og card's line, the README's first
line, and the app's About. Nowhere else is a second slogan allowed. Every other
surface states a fact.

## Copy by surface

| Surface | Exact copy |
| --- | --- |
| Site `<title>` | `teamree — your whole team ships in parallel` |
| Site hero h1 | `Your whole team ships in parallel.` |
| Site hero sub-line | `Every agent in its own git worktree. Every teammate in the same window.` |
| Site hero buttons | `Download for macOS` · `Source on GitHub` |
| Site hero note | `Free. macOS 12 or later. Universal build.` |
| Site section h2 | `A worktree per task` · `A state per pane` · `A CLI agents can drive` · `Teammates in the window` · `Install` |
| Site meta / og description | `The agentic development environment for teams. Claude Code, Codex and other coding agents shipping side by side, each in its own git worktree, in one window your teammates can watch.` |
| og card | h1 `Your whole team ships in parallel.` — line `Every agent in its own git worktree. Every teammate in the same window.` — foot `teamree.us` |
| README first line | `**Your whole team ships in parallel.**` then the sub-line |
| `package.json` description | `Your whole team ships in parallel. Every agent in its own git worktree. Every teammate in the same window.` |
| GitHub repo description | `Your whole team ships in parallel.` |
| App About / DMG | `teamree` — `Your whole team ships in parallel.` — version |
| App welcome (empty window) | Unchanged: `No terminals here yet` and the three buttons. No slogan in the app. |
| 404 | `Not found.` — `The link is old or the page moved.` — `Back to teamree` |

## Voice

1. State facts. *"Four states, read off the PTY."* not *"Powerful real-time status."*
2. Verbs on buttons, and the button is the explanation. *`Download for macOS`*, never *"Click here to download"*.
3. No adjectives that grade the product. *"Split terminals, a PTY each."* not *"Blazing-fast split terminals."*
4. Name the agents. *"Claude Code, Codex, Gemini, opencode, droid on your PATH."* not *"any AI agent"*.
5. Say what it does not do. *"Waiting means the output stopped, not that you were asked."*

## Visual system

Palette (light on dark; no light theme on the site):

| Token | Hex | Use |
| --- | --- | --- |
| `--ground` | `#0B0C0E` | page |
| `--tile` | `#101114` | cards, window mats, the header pill |
| `--tile-2` | `#171718` | the tile under the mark, code chips, hover |
| `--ink` | `#F3F2EE` | headings, the mark |
| `--ink-2` | `#C8C7C2` | body |
| `--muted` | `#A09F9B` | captions, footer |
| `--line` | `rgb(243 242 238 / 9%)` | hairlines; `16%` on hover |
| `--accent` | `#8b8cf7` | the dot after the wordmark, focus ring; links use `#A9AAFF` |
| `--working` | `#9e9ef8` | state dot, as in the app |
| `--waiting` | `#d6a24a` | state dot |
| `--finished` | `#57c38a` | state dot |
| `--failed` | `#e8615a` | state dot |

The accent is spent in three places on the page: the wordmark's dot, focus, and
links. Not on buttons, not on backgrounds, not on headings.

Type: the system face (`-apple-system, BlinkMacSystemFont, "SF Pro Text",
"Helvetica Neue", Arial, sans-serif`) for everything; `ui-monospace, "SF Mono",
Menlo, monospace` for commands, paths and agent names. Nothing downloaded.

| Role | Size / line / tracking / weight |
| --- | --- |
| h1 | `clamp(40px, 2.2rem + 2.4vw, 64px)` / 1.05 / -0.03em / 600 |
| h2 | 28px / 1.2 / -0.02em / 600 |
| h3 | 20px / 1.3 / -0.015em / 600 |
| lede | 20px / 1.5 / 0 / 400, `--ink-2` |
| body | 17px / 1.6 / 0 / 400, `--ink-2` |
| small | 15px / 1.5 / 0 / 400, `--muted` |
| code | 13px / 1.75, mono |

Spacing on an 8px grid: sections 96px apart (64px under 900px), 32px between a
heading and its media, 24px gutters, content column 1120px, page padding 32px
(20px on phones). Radius: 6px controls, 10px buttons and chips, 14px window
frames, 999px the header pill.

Background: not flat. Two layers on `--ground`, both fixed, both under everything:
a radial vignette from the tile tone, `radial-gradient(ellipse 70% 50% at 50% 0,
#15161A, #0B0C0E 70%)`, and a 48px grid of `rgb(243 242 238 / 3%)` hairlines,
masked with `linear-gradient(#000 0, transparent 900px)` so it fades out under
the product shot. No noise, no glow, no animated gradient.

The mark:

- Clear space around the mark is half its width, on every side, always.
- Never cropped. Every inline SVG that carries brand paths uses the mark's own
  `viewBox="0 0 256 256"` (28 units of headroom are inside it) or, for the
  wordmark, a viewBox padded by at least 8 units on every side, and
  `overflow: visible`. Today's `viewBox="0 10 582 82"` leaves 0.4px above the
  mark at 118px wide and is what clips it; it is retired.
- In navigation and footer the mark sits on its tile: a 28px square of
  `--tile-2`, radius 7px, the mark at 62% of the tile's width, centred; then an
  8px gap, the wordmark (the path, cap height 14px, in `--ink`), then the accent
  dot, 4px, sitting on the wordmark's baseline. That is the lockup the app's
  title strip draws; the site draws the same one.
- Standalone, without a tile, only in the hero, at large size: left of the h1,
  spanning from the cap line of the first line to the baseline of the second.
  For the system face that is top `0.16em` below the h1 box and height
  `1.72em` of the h1 size. The h1 is set to break at exactly two lines above
  900px; below that the mark moves above the h1 at 56px tall and the rule is
  simply left-aligned with the text.
- The mark is `--ink`. Never the accent, never a gradient, never rotated.

## Page blueprint

Header. At scroll 0: full width, flush, 60px tall, transparent over the
vignette: lockup on the left, `Worktrees · Panes · Teamwork · Install` and a
`GitHub` button on the right. Past 32px of scroll it becomes a fixed, centred
pill (back below 8px): 48px tall, 12px from the top, at most 760px wide, `--tile`
at 80% over `backdrop-filter: blur(16px)`, one `--line` border, radius 999px,
holding the same lockup, links and button. The row never resizes: the lockup
and links translate inward while the pill fades in and narrows from the row's
width with its edges riding on them, all in one 640ms `cubic-bezier(.2,.8,.2,1)`
that a reversed scroll reverses mid-flight. Under `prefers-reduced-motion` the
contents switch at once and the pill cross-fades in 200ms. On phones both states hold the lockup and a `Menu` disclosure; the
pill is 48px tall and spans the width less 16px each side.

Footer. One row: the lockup on its tile at the left; `Source · Releases · MIT ·
Installing · Trying teamwork · Roadmap` at the right; under it, in `--muted`,
`macOS. Universal. Free.` No slogan.

Sections, in order, six at most:

1. **Hero.** Mark, h1, sub-line, the two buttons, the note. Under it the product
   shot: `screenshot.png` in a window frame (a `--tile` mat, 6px, radius 14px,
   three traffic-light dots drawn in `--line`), aspect 1400 / 900. The frame is
   `data-media="tour"` and holds the showcase clip slot with `screenshot.png`
   as its poster; the frame never resizes when a clip swaps in.
2. **A worktree per task.** h2, one line: `Start from any ref. Attempts never
   see each other's files; abandoning one is deleting a directory.` Clip slot
   `data-demo="worktrees"`.
3. **A state per pane.** h2, one line: `Working, waiting, finished or failed,
   read off the PTY. One view lists every pane, failures first.` Beside it the
   four dots with their words, in the app's colours. Then: `Split terminals,
   nested, a real PTY in each. Finds claude, codex, gemini, opencode and droid on
   your PATH.` Clip slot `data-demo="terminals"`.
4. **A CLI agents can drive.** h2, one line: `Create worktrees, run commands and
   read output over a local socket. Every command takes --json.` A four-line
   command block, mono, with a Copy button. Clip slot `data-demo="cli"`.
5. **Teammates in the window.** h2, one line: `Add a teammate's key and they
   can watch your panes and ask to type; keystrokes run only when you allow
   them.` Link: `Trying teamwork`. Clip slot `data-demo="teamwork"`.
6. **Install.** h2. `Free, macOS 12 or later, signed ad-hoc. macOS refuses the
   first launch: press Done, not Move to Trash, then clear the flag.` The
   quarantine command and the checksum command, each with Copy. Link:
   `docs/install.md`.

Clip slots keep the `site/tools/sync-demos.mjs` contract exactly: the
`demo:video:parked` comments, `data-demo` ids, `width`/`height` on each
`<video>`, the `.demo-frame::before` padding, and a `figcaption.demo-cap`. A
clip plays only while on screen, never under reduced motion, and never loops
on its own; nothing on the page loops.
