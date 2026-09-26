// The agent guide `teamree guide` prints, bundled with the CLI so it always
// matches the commands of this build. At most GUIDE_MAX_LINES lines a topic.

import type { CommandSpec } from './command-spec.js'

export const GUIDE_MAX_LINES = 60

export type GuideTopic = {
  name: string
  summary: string
  /** Shown only when this build has the commands the topic teaches. */
  needs?: (find: (path: readonly string[]) => CommandSpec | undefined) => boolean
  text: string
}

const PANE = `teamree guide: the teamree CLI for an agent in a teamree pane.

This pane
  TEAMREE_TERMINAL_ID, TEAMREE_WORKTREE_ID and TEAMREE_PROJECT_ID name it.
  \`here\` means this pane, worktree or project wherever a command takes one.
  "$TEAMREE_CLI" is this app's teamree, for a shell that finds another first.
  teamree whoami [--json]                  pane, worktree, branch, project, parent tasks

Your worktree
  teamree worktree status here             branch, ahead/behind, staged and unstaged counts
  teamree worktree changes here            changed paths
  teamree worktree diff here [--path <p>] --max-bytes 8000
  teamree worktree log here                commits the base does not have
  teamree worktree merges here             would it merge cleanly
  teamree worktree commit here -m "<msg>" -- <paths>
  teamree worktree push here
  teamree worktree land here               open a pull request

Other panes and worktrees
  teamree worktree list [--project here]
  teamree terminal list --worktree here
  teamree terminal read <id> --tail-bytes 4000 --plain
  teamree terminal send <id> --text "<text>" --enter
  teamree terminal wait <id> --for quiet|exit
  teamree terminal run --worktree here --command "npm test"

Rules
  Read with a budget (--tail-bytes, --max-bytes); never a whole scrollback.
  Add --json for one JSON document on stdout.
  Exit codes: 0 ok, 1 refused or not found, 2 usage, 3 app not running.`

const TREE = `teamree guide tree: child tasks.

A child worktree branches from its parent's branch and lands back in it.
  teamree worktree create --parent here --name <name> [--agent claude --prompt "<task>"]
    From a pane, create makes a child of this worktree; --top makes a top-level task.
    --agent with --prompt starts an agent on the child: that is how work is handed out.
  teamree worktree list --tree             the task tree, indented
  teamree worktree remove <child>          a parent with children needs --children
Agents may nest 3 deep and keep 6 open children per parent.`

const MSG = `teamree guide msg: talking to the parent and children.

  teamree msg done "<three sentences>" [--failed]   report the outcome; the parent is told
  teamree msg ask "<question>" [--options a,b]      block until the parent answers
  teamree msg ask --resume <id>                     keep waiting on the same question
  teamree msg reply <id> "<answer>"                 answer a child's question
  teamree msg wait --kind done,ask --from children  block for children, as a supervisor
A message to an idle agent is pasted into its prompt; a busy one gets it when it stops.`

const CONTEXT = `teamree guide context: what the project already knows.

  teamree context [--query "<text>"] [--max-bytes 4096]   decisions, notes and open questions
  teamree note "<finding>"                                keep a finding for siblings and later tasks
Read context before starting; add a note when you settle something others will need.`

export const GUIDE_TOPICS: readonly GuideTopic[] = [
  { name: 'pane', summary: 'identity, your worktree, other panes', text: PANE },
  {
    name: 'tree',
    summary: 'child tasks',
    needs: (find) => find(['worktree', 'create'])?.flags?.some((flag) => flag.name === 'parent') === true,
    text: TREE
  },
  { name: 'msg', summary: 'ask, reply, done', needs: (find) => find(['msg', 'done']) !== undefined, text: MSG },
  {
    name: 'context',
    summary: 'decisions and notes',
    needs: (find) => find(['context']) !== undefined && find(['note']) !== undefined,
    text: CONTEXT
  }
]
