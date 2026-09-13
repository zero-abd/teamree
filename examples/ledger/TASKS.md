# Work left to do

Three tasks. Take one each, and all three merge: no two of them change the same
file, and all three have been run together to prove it.

| # | What | Files it touches | Its target test |
|---|------|------------------|-----------------|
| 1 | `--json` output | `bin/ledger.js`, `test/tasks/task-1-json.test.js` | `npm run test:task1` |
| 2 | Per-person totals | `src/settle.js`, `test/settle.test.js`, `test/tasks/task-2-totals.test.js` | `npm run test:task2` |
| 3 | Repeating entries | `src/parse.js`, `test/parse.test.js`, `test/tasks/task-3-repeats.test.js` | `npm run test:task3` |

## Before you start

**Your task's target test is red right now.** That is what it is for: it is the
requirement written down, and it going green is what "done" means here, rather
than anybody's opinion of whether the code looks finished. `test/tasks/README.md`
says why those files sit outside `npm test`.

```sh
npm test               # 39 tests, about a second. Green now; keep it green.
npm run test:task2     # your target. Red now; make it green.
```

**Files not listed against your task are not yours**, and that is what makes
three people finishing at once work at all. `README.md`, `TASKS.md` and
`package.json` are shared by all three tasks — if your change means the README
is now wrong, say so in your commit message and leave it. The three of you will
fix it once, together, at the end, instead of three times in three conflicting
diffs.

**Where a task says "Ask first", stop and ask.** It marks a decision that is not
the implementer's to make: two answers are defensible, the repository does not
prefer either, and picking one quietly means finding out it was the other one
after the code is written. Ask in your pane and wait. Somebody is watching it.

---

## 1. `--json`, for programs rather than people

**Files:** `bin/ledger.js`, and `test/tasks/task-1-json.test.js` for anything you
add. **Done when** `npm run test:task1` passes and `npm test` still does.

`ledger --json <file>` prints one JSON object on stdout and nothing else:

```json
{
  "title": "Weekend in the hills",
  "balances": [{ "person": "ana", "cents": -1810 }],
  "transfers": [{ "from": "bo", "to": "cy", "cents": 1945 }]
}
```

Cents, not decimal strings — the caller is a program, and handing it "18.10" to
parse back is handing it the floating-point bug this codebase spent its whole
design avoiding.

The flag works either side of the filename. The human output stays exactly as it
is when the flag is absent, to the character; the target test pins it, because a
flag that quietly reformats the output for everybody is not a flag.

`spike/json-output` has a note from whoever started thinking about this. It is a
sketch, not a specification, and nothing on that branch is implemented.

> ### Ask first: what does `--json` do with a ledger that does not parse?
>
> Today a bad line is a message on stderr and exit 1, with nothing on stdout.
> Under `--json` that leaves a caller with two output formats to handle instead
> of one — so the alternative is to print `{"error": "line 4: ..."}` on stdout,
> still exit 1, and let the caller parse stdout unconditionally.
>
> Both are ordinary. Nothing in this repository prefers either, and the choice
> is the whole contract this flag exists to offer, so it outlives the afternoon
> you would spend guessing. **Ask, wait for an answer, then write the test for
> the answer you were given** — there is deliberately no test for it now.

---

## 2. Per-person totals

**Files:** `src/settle.js` and `test/settle.test.js`, plus
`test/tasks/task-2-totals.test.js`. **Done when** `npm run test:task2` passes and
`npm test` still does.

Balances say where everyone ended up. They do not say what anyone spent, and
"why do I owe so much" is the first question anybody asks of this program.

Add `totalsByPerson(entries)` returning, sorted by name:

```js
[{ person: 'ana', paid: 5510, owed: 7320 }]
```

`paid` is what they put in; `owed` is the sum of their shares. Somebody who paid
nothing but shared costs still appears, with `paid: 0`.

The difference between the two is already their balance, and the target test
asserts exactly that, on a ledger that does not divide evenly. That is the work
in this task: an entry's odd cents go to the first few participants *in the
entry's own order*, and `owed` has to be computed the same way `balances`
computes it, or the two numbers disagree by a penny. Two ways of computing the
same number that disagree is the bug worth catching here, so catch it in
`test/settle.test.js` as well, where the rest of this module's tests live.

---

## 3. Repeating entries

**Files:** `src/parse.js` and `test/parse.test.js`, plus
`test/tasks/task-3-repeats.test.js`. **Done when** `npm run test:task3` passes
and `npm test` still does.

A fifth night in the same hut is a fifth identical line. Let one line say so:

```
2024-03-01 | cy | 87.00 | ana bo cy | the hut     | x5
```

A sixth field, `x<n>`, meaning the entry happened `n` times. It expands at parse
time into `n` entries, so nothing downstream of the parser learns a new concept
— `balances` and `settle` must not change at all, and if they did, the design
was wrong. An expanded entry is the same object a written-out one is: no extra
field recording where it came from.

Every expanded entry keeps the line number it came from, so an error still
points at the line somebody wrote.

`n` must be a whole number of at least 2. `x1` is a mistake worth refusing:
somebody meant to type something else. A malformed multiplier is a `LedgerError`
naming its line, like every other bad field in this format.
