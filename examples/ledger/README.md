# ledger

Splits a shared bill: read a file of who paid for what, work out who owes whom,
and print the shortest list of payments that ends it.

```
$ node bin/ledger.js fixtures/trip.ledger
Weekend in the hills

ana  owes     18.10
bo   owes     19.45
cy   is owed  37.55

bo pays cy 19.45
ana pays cy 18.10
```

## Why this exists

This is the project teamree's teamwork features are tried on. Testing "can two
people work in the same repository at once" against an empty directory proves
nothing: an agent needs something to read, something to change, and a test suite
that says whether it broke anything. That is all this is for.

It is deliberately small and deliberately real. No dependencies, so there is
nothing to install on either machine and nothing to go stale; no build step, so
a change is live the moment it is saved; and a test suite that runs in a second,
so an agent's work can be checked as often as you like.

**[`../../docs/trying-teamwork.md`](../../docs/trying-teamwork.md) is the runbook
that uses it**, and the place to start if you are here to try teamwork rather
than to read a bill-splitter. It turns this directory into a real repository with
`../init-example-repo.mjs`, has both people push it somewhere they can both push
to — which matters, because push access is what membership is, and because
teamree matches two checkouts by their `origin` remote and a project without one
does not take part — and walks from there to each person's worktrees showing up
in the other's sidebar.

## Running it

Node 20 or newer. Nothing to install.

```sh
npm test                                # 39 tests, about a second
node bin/ledger.js fixtures/trip.ledger # the example above
npm run test:task1                      # the target test for task 1: red until it is done
```

## The shape of it

- `src/parse.js` — the file format. Every amount becomes an integer number of
  cents here and stays that way, because a ledger that balances to the penny in
  decimal does not balance in binary floating point.
- `src/settle.js` — net position per person, then the payments that clear it.
- `src/format.js` — cents back into something a person reads.
- `bin/ledger.js` — the command line, and the exit codes another program
  depends on.
- `fixtures/` — a weekend that settles, and a ledger with a mistake in it kept
  on purpose, so the error path has something to fail on.
- `test/tasks/` — one failing test per task in `TASKS.md`, outside `npm test` so
  that a suite which means "you broke something" never carries work nobody has
  started.

## The file format

```
title: Weekend in the hills

# date     | payer | amount | who shared it | what it was
2024-03-01 | ana   | 42.60  | ana bo cy     | groceries
```

Pipe-separated, so a description can contain spaces without anyone inventing
quoting rules. Blank lines and `#` comments are ignored. A line that is not one
of those two shapes is an error naming its line number, rather than a line
quietly skipped — a ledger that silently drops an entry is worse than one that
refuses to load.

## Work left to do

`TASKS.md` has three, chosen so that three people can take one each without
touching the same file. That is the point: two agents in two worktrees should be
able to finish and both merge.

Each one has a test that fails today and passes when the task is done, so "done"
is a command anybody can run rather than a judgement. One of them also has a
question in it that the implementer cannot answer alone — which is the other
thing worth trying here, and the reason somebody is watching the pane.
