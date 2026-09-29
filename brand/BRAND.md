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
| Site hero note | `Free · MIT · macOS · Apple Silicon and Intel` |
| Site chapter h2 | `Every task gets its own worktree.` · `One sidebar. Every state.` · `When an agent needs you, it asks.` · `Split panes, each with its own tabs.` · `Stage, commit, push.` · `Comments go straight to the agent.` · `Ready to land? Land All.` · `Your team, live in your sidebar.` · `Pick up where it stopped.` · `The small things, handled.` · `A CLI over the same runtime.` · `Installed in a minute.` · `Questions, answered.` |
| Site meta / og description | `The agentic development environment for teams. Claude Code, Codex and other coding agents shipping side by side, each in its own git worktree, in one window your teammates can watch.` |
| og card | h1 `Your whole team ships in parallel.` — line `Every agent in its own git worktree. Every teammate in the same window.` — status strip, Sprig — foot `teamree.us · free · MIT · macOS universal` |
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

The app, the icon and dark surfaces (the site has its own paper system, below):

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

In the app the accent is spent on the wordmark's dot, focus and links. Not on
buttons, not on backgrounds, not on headings.

### The site (teamree.us)

Editorial paper and ink with one violet, set like a motion designer's working file.

| Token | Hex | Use |
| --- | --- | --- |
| `--paper` | `#FDFDFB` | ground, with a fixed 48px hairline grid |
| `--ink` | `#0B0C0E` | text, buttons, dark chapters |
| `--accent` | `#8B8CF7` | the land chapter's flood, echoes, decorative dots |
| `--accent-ink` | `#5051C5` | the italic accent word and small accent text on paper (≥ 4.5:1) |
| `--muted` | `#5E6065` | captions, chrome, inactive states (never dim text with opacity) |
| state dots | as in the app | working, asking, ready, failed, ended; Sprig's leaves use them too |

Type: two voices, both system faces, nothing downloaded. A bold grotesk (`-apple-system … "SF Pro Display"`,
tight -0.06em tracking) for headlines and body, and one italic serif word per headline (`ui-serif, "New York"`)
in `--accent-ink` with a hand-drawn underline. Mono (`ui-monospace, "SF Mono"`) is chrome only: `// 0N — name`
chapter labels, the vertical `00:00:SS:FF` timecodes, `fig. NN` captions, commands and agent names.

Motion: headline words rise out of a baseline mask (expo-out, no overshoot); clips whip in with hard echo
outlines, not blur; explainers run on short step timelines while on screen; floods are scroll-linked circles
that grow from an object (a status dot, the Land All button). Something always moves (clock, timecodes,
marquee, Sprig) and nothing moves under `prefers-reduced-motion`.

Sprig, the character from the showreels, is rendered in the studio (never redrawn by hand), stands on paper
only, and never overlaps the lockup.

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

The site's blueprint lives in `site/README.md` and the page itself: a hero (h1, sub-line, the two buttons, the
note, the showreel slot with a status strip), the agent-CLI marquee, thirteen chapters `// 01`–`// 13` (each a
headline, one or two facts, real v0.8.3 footage and, where the footage cannot show it, a drawn explainer), the
install steps beside a drawn macOS dialog, the FAQ, an end card, and the footer (`GitHub · Releases · MIT
licence · Install guide · Trying teamwork · Roadmap`, `macOS. Universal. Free.`).

Clip slots keep the `site/tools/check-demos.mjs` contract: `data-clip`, `data-sizes`, `width`/`height` and a
poster on each `<video>`, and a `figcaption`. A clip plays only while on screen and never under reduced motion.
