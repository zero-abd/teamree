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
| Site `<title>` | `teamree — the ADE for teams` |
| Site hero h1 | `Your whole team ships in parallel.` |
| Site hero lede | `teamree is an agentic development environment for teams. Claude Code, Codex and the other agents each get their own git worktree, and every teammate's agents show up in one sidebar.` |
| Site hero buttons | `Download for macOS` · `Source on GitHub` |
| Site hero note | `open source · MIT · macOS universal · free` |
| Site section h2 | The showreel's lines: `Every agent, its own worktree.` · `One sidebar shows every task.` · `Agents can even ask you, right from the CLI.` · `Split it. Tab it. Answer it.` · `Host a relay. Send the link. Your team is live.` · `Every teammate's agents in one sidebar.` · `Review live.` · `Ready to land? Land All.` |
| Site meta / og description | `teamree is the agentic development environment for teams. Claude Code, Codex and other coding agents, each in its own git worktree, and every teammate's agents in one sidebar. Open source and free for macOS.` |
| og card | label `// 00 — the ADE for teams` — lockup — h1 `Your whole team ships in parallel.` — `Download for macOS` — `open source · MIT · macOS · teamree.us`; Sprig waving on a lavender panel |
| README first line | `**Your whole team ships in parallel.**` then `The agentic development environment for teams.` and the sub-line; the showreel teaser under it |
| `package.json` description | `Your whole team ships in parallel. Every agent in its own git worktree. Every teammate in the same window.` |
| GitHub repo description | `Your whole team ships in parallel.` |
| App About / DMG | `teamree` — `Your whole team ships in parallel.` — version |
| App welcome (empty window) | Unchanged: `No terminals here yet` and the three buttons. No slogan in the app. |
| 404 | `Not found.` — `The link is old or the page moved.` — `Back to teamree` |
| Showreel end card | lockup — `Open source & free for all.` — `Download for macOS` · `teamree.us` — `open source · MIT · macOS · v0.8.3` |

## Voice

1. State facts. *"Four states, read off the PTY."* not *"Powerful real-time status."*
2. Verbs on buttons, and the button is the explanation. *`Download for macOS`*, never *"Click here to download"*.
3. No adjectives that grade the product. *"Split terminals, a PTY each."* not *"Blazing-fast split terminals."*
4. Name the agents. *"Claude Code, Codex, Gemini, opencode, droid on your PATH."* not *"any AI agent"*.
5. Say what it does not do. *"Waiting means the output stopped, not that you were asked."*

## Visual system

The look comes from the v5 showreel; the site, the og card and the reel share it.

Grounds. Three, and a page moves between them: **paper** `#F5F5F2` (cards `#FFFFFF`),
**lavender** `#8B8CF7`, **black** `#090909` (bento ground `#0E0F12`, tiles `#17181C`).
A new ground arrives as a circle growing from an object on screen, never a hard cut.

| Token | Hex | Use |
| --- | --- | --- |
| `--paper` | `#F5F5F2` | the default ground |
| `--ink` | `#0B0C0E` | type on paper and lavender |
| `--ink2` | `#3A3B40` | body on paper |
| `--muted` | `#5F5F5A` | captions, labels |
| `--accent` | `#8B8CF7` | the lavender ground, the wordmark's dot, the accent word on black |
| `--accent-ink` | `#5B5CEB` | buttons, the accent word on paper, focus |
| `--light` | `#F3F2EE` | type on black |
| state dots | `#9E9EF8` working · `#D6A24A` asking · `#57C38A` ready · `#E8615A` failed · `#85878B` ended | as in the app |

One accent. Red appears once, on *Chaos.*, and on conflicts.

Type. Two voices: the system grotesk (`-apple-system, "SF Pro Display"`) at 650,
tracking `-0.035em`, line-height `0.98`, for every headline; and **one italic serif
word** per headline (Fraunces italic 400; `New York` / Georgia where it cannot load)
in `--accent-ink` on paper, `--accent` on black, ink on lavender. The accent word is
the payoff: *parallel.*, *worktree.*, *ask*, *live.*, *conflict.*, *straight*, *All.*
Chrome is mono (JetBrains Mono 500, 11–12px): `// 04 — terminal control` at the
top left of a section, `TEAMREE 00:00:12:04` running at the top right.

Footage. Real recordings of the current version with stand-in agents, in a
framed window: radius 12–20px, a 1.5px hairline, a long soft shadow. Never a
mock-up of the app where a recording exists.

Buttons. Pills: `--accent-ink` with white text, 48px tall; a ghost pill with a
hairline for the second action.

Sprig. The mascot: a curly tree-crown head with a lavender leaf, a sweater with
the mark on it, clay hands, drawn in a 1-bit halftone dither. On the site it
appears as transparent stills (wave, point, talk, grab, happy, worried) beside
the content, never over footage and never over the hero reel. It is not in the app.

The mark: unchanged. Clear space half its width; never cropped, never the
accent, never rotated. The lockup is the mark, the wordmark, and the lavender dot
on the baseline.

## Motion

- No hard cuts. A change of ground is a flood from an object; footage enters with
  a whip (a short rise with a blur that clears).
- Headlines rise word by word with an echo that settles; the accent word lands last.
- Scroll-driven scenes keep moving until they release; nothing holds still while
  the user scrolls.
- Clips play only while on screen. Under `prefers-reduced-motion` every scene shows
  its final state and nothing plays.

## Page blueprint

The page follows the showreel's script, one section per line:

0. **Hero.** `// 00` label, the h1 with *parallel.*, the lede, `Download for macOS`
   and `Source on GitHub`, the note; the showreel beside it with `Watch with sound`.
1. **Hook** (paper, pinned). *Five agents. One repo. Chaos.* Five agent cards pile
   into one and turn red; the lavender floods out to *Meet teamree, the ADE for teams.*
2. **Worktrees** · 3. **Sidebar** (black) · 4. **Asking** · 5. **Terminal control**
   (lavender) · 6. **Relay, in three steps** · 7. **Teammates** (black bento, the
   overlap tile in lavender) · 8. **Review** (lavender) · 9. **Land All** ·
   10. **Details** · 11. **Install** (black) · 12. **FAQ**
13. **Finale** (black): *Your whole team ships in parallel.* Then the end card:
   lockup, `Open source & free for all.`, the download pill, `teamree.us`, the proof line.

`site/README.md` holds the clip-slot contract and the encoder.
