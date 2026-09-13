# examples

Fixtures. Nothing in here is part of teamree, nothing in here ships, and nothing
in here is imported by `src/`.

`examples/` rather than `tests/fixtures/` because of who these are for. A fixture
under `tests/` is read by a test runner; `ledger` is meant to be read by a
*person* — cloned onto a second machine, opened in the app, worked in by an agent
for half an hour. It has a README of its own, a task list, and a git history,
because somebody is going to sit in front of it. That is a different thing from a
directory a test globs over, and putting it under `tests/` would invite exactly
the test-runner and lint globs it must stay out of.

## What is here

**`ledger/`** — a small program that splits a shared bill: no dependencies, no
build step, 39 tests that run in about a second, and three pieces of work in
`TASKS.md` chosen so that three people can take one each without touching the
same file. It exists so that teamwork can be tried on something real. Testing
"can two people work in the same repository at once" against an empty directory
proves nothing: an agent needs something to read, something to change, and a test
suite that says whether it broke anything.

Two things in it are there for the teamwork run rather than for the bill-splitter,
and both should survive anybody tidying it up:

- **`test/tasks/` — one failing test per task**, outside the `npm test` glob.
  Inside it, every agent starts red for two reasons that are not its own and
  learns to ignore the suite. Outside it, "done" is still a command anybody can
  run, which is what lets two people trust each other's finished work without
  reading it.
- **Task 1 has a question in it that its implementer cannot answer**, marked
  *Ask first* in `TASKS.md`, unanswered in the note on `spike/json-output`, and
  deliberately untested. An agent that stops there and asks is the entire event
  teamwork exists to serve, and a sample where every requirement is decidable
  from the repository never produces it.

**`init-example-repo.mjs`** — turns `ledger/` into an actual git repository:

```sh
node examples/init-example-repo.mjs ~/teamree-example
node examples/init-example-repo.mjs ~/teamree-example --with-origin
```

Six commits on `main` and a `spike/json-output` branch, so the start-from picker
has something real in it. Every commit leaves the suite passing, so any of them
can be checked out and run, and the script refuses to finish if it copied a file
that no commit covers — a checkout that is dirty the moment it is made is a
fixture that teaches everybody to ignore `git status`. `--with-origin` also makes a bare repository beside
it and pushes to it, which is what `scripts/teamwork/two-peers.mjs` needs: two
peers that can both clone and push without a git host in between.

The example cannot simply *be* a git repository in this tree — a repository
inside a repository is either a submodule, which is a thing to maintain, or an
ignored directory, which is a thing nobody reviews. So the files are tracked here
as ordinary files and assembled on demand.

## Where it is used

- `docs/trying-teamwork.md` — the two-person walkthrough.
- `docs/teamwork-scenario.md` — what a passing end-to-end run looks like.
- `scripts/teamwork/two-peers.mjs` — both peers, on one machine.
