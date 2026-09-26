# New Task dialog

## Problem

The new branch's name sits in the hint under Start from as an unlabeled, dashed-underline button that turns
into a tiny input on click. People do not see that the branch can be renamed there. A hand-typed name that
is invalid or already taken is only refused by the runtime after the dialog has closed.

## What other launchers do

- **Claude Code on the web**: repo and branch pickers under the prompt; the new branch is an auto name
  (`claude/<words>-<hash>`) that cannot be edited, a standing complaint.
- **Codex cloud / CLI**: environment, branch and `--attempts` (best of N, up to 4) are explicit; nothing is
  previewed before the run.
- **Cursor background agents**: describe, pick the target branch, pick 1x/3x and one or more models, start.
- **GitHub Copilot coding agent**: repo and base branch in the assign dialog; branch is `copilot/<id>`, not
  configurable.
- **Devin**: repo picker and composer (Cmd/Ctrl+Enter sends); plan mode shows an editable plan before work.
- **Jules**: base branch defaults to the repo default and stays editable.
- **Conductor**: one workspace = one worktree + branch; starts from blank, a branch, a PR or an issue; model
  and effort pickers beside the composer, each with its own shortcut.

Borrow:
1. Branch derived from the task, always visible, editable before launch (the one thing most products get wrong).
2. Repo, base and count beside the prompt, not behind flags or menus.
3. Cmd/Ctrl+Enter submits from anywhere; the plan (how many worktrees, which agents) is visible before submit.
4. Spaces typed into a branch name become hyphens as typed (GitHub's own new-branch field does this).

Avoid:
1. Unreadable or locked branch names.
2. Errors that only surface after launch.
3. Hidden parallelism.

## Layout

```
New Task
Task        [ textarea                                  ]
Agents      Claude Code            − 1 +
            Codex                  − 0 +
Project       Start from
[ teamree ▾ ] [ origin/main                         ▾ ]
              9cb9af4
Branch      [ merge-pr-251                        auto ]
            merge-pr-251-claude · merge-pr-251-codex      (only with 2+ runs)
1 worktree · Claude Code                  Cancel  Start Task
```

## Branch field

- A labeled `Branch` input, full width, mono, the same box as every other field.
- Until edited it shows the name the runtime will create, including the `-2` suffix when the slug is taken,
  with an `auto` tag at its right edge.
- Typing makes it the user's; the tag becomes a reset button (`Use Task Name`) that returns to the derived name.
- Cleared, the field shows the derived name as its placeholder and submits as auto.
- Spaces become hyphens as typed.
- With two or more runs, the hint lists every branch that will be made (`name-claude · name-codex`).

## Validation

The naming rules move to `shared/branchName.ts` so the dialog and the runtime share them:
`isValidBranchName` (the runtime's `git branch` refusals), `branchCollides`, `allocateBranchName`.

- Invalid name: hint in the danger colour, `Not a valid branch name`; field `aria-invalid`; submit disabled.
- Taken name (a local branch from the refs listing, or a worktree the app already has): `Branch exists`.
- Auto names never error: they preview the suffix the runtime will pick.
- The runtime keeps its own checks; the listing can be truncated, so it stays the last word.

## Keyboard

- Focus opens in Task. Tab order follows the page: Task, steppers, Project, Start from, Branch, Cancel, Start.
  Project and Start from share a row, since together they say where the task starts.
- Enter in Task submits and Shift+Enter is a newline (unchanged). Enter in Branch submits.
- Cmd/Ctrl+Enter submits from any field.
- Escape closes the innermost open thing (ref list), then the dialog.

## Out of scope

- Model and effort pickers per agent, and starting from an issue or PR (Open Branch covers PRs).
- A plan/approval step before the agent runs.
- Branch prefixes per project or per user (`ada/`), which want a setting.
