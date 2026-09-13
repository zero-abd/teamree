# Work left to do

Three tasks, each landing in files the other two do not touch. Take one each and
they will all merge.

Each says what "done" looks like, because an agent given "improve the output"
will improve it in a direction nobody asked for.

---

## 1. `--json`, for programs rather than people

**Files:** `bin/ledger.js`, a new `test/json.test.js`.

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

The human output stays exactly as it is when the flag is absent. Errors still go
to stderr and keep their exit codes; `--json` changes what success looks like,
not what failure does.

**Done when:** the flag works either side of the filename, output parses with
`JSON.parse`, and the existing CLI tests still pass untouched.

---

## 2. Per-person totals

**Files:** `src/settle.js`, `test/settle.test.js`.

Balances say where everyone ended up. They do not say what anyone spent, and
"why do I owe so much" is the first question anybody asks of this program.

Add `totalsByPerson(entries)` returning, sorted by name:

```js
[{ person: 'ana', paid: 5510, owed: 7320 }]
```

`paid` is what they put in; `owed` is the sum of their shares. The difference is
already their balance, and a test should assert that — two ways of computing the
same number that disagree is the bug worth catching here.

Somebody who paid nothing but shared costs still appears, with `paid: 0`.

**Done when:** the function is exported and tested, including the case where one
person appears only as a participant and never as a payer.

---

## 3. Repeating entries

**Files:** `src/parse.js`, `test/parse.test.js`.

A fifth night in the same hut is a fifth identical line. Let one line say so:

```
2024-03-01 | cy | 87.00 | ana bo cy | the hut     | x5
```

A sixth field, `x<n>`, meaning the entry happened `n` times. It expands at parse
time into `n` entries, so nothing downstream of the parser learns a new concept
— `balances` and `settle` must not change at all, and if they did, the design
was wrong.

Every expanded entry keeps the line number it came from, so an error still
points at the line somebody wrote.

`n` must be a whole number of at least 2. `x1` is a mistake worth refusing:
somebody meant to type something else.

**Done when:** five fields still parse exactly as they do today, six fields
expand, and a bad multiplier is a `LedgerError` naming its line.
