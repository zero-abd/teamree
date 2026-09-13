# Contributing

Patches are welcome. This is a small project, so the process is short.

## Getting set up

```sh
npm install
npm run dev
```

Development is on macOS. The app builds on Linux too, but the released artifact
is macOS only and that is where everything gets exercised.

## The gate

Run these before you open a pull request. Together they are what a release runs,
and a failure in any of them blocks one:

```sh
npm run typecheck
npm run lint
npm run format:check
npm test
```

`npm test` includes an acceptance pass that drives a real runtime over the real
socket. It refuses to start in a checkout that cannot run all of it rather than
quietly running less — in particular, the tests that drive the relay need
`relay/dist`:

```sh
cd relay && npm ci && npm run build
```

The refusal names the command that fixes it. `TEAMREE_SKIP_RELAY_TESTS=1` and
`TEAMREE_SKIP_PTY_TESTS=1` are how you say you meant to leave those out; an
unexplained skip fails the run.

## Where things are

| Path | What is in it |
| --- | --- |
| `src/main` | The runtime — git, worktrees, terminals, state |
| `src/shared` | The one contract typing the runtime, the GUI and the CLI |
| `src/renderer` | The React window |
| `src/cli` | The `teamree` command |
| `relay/` | The relay Worker, with its own package and suite |
| `scripts/` | Build, packaging, smoke and release scripts |
| `examples/ledger` | A small repository that exists to be worked in |

A method signature lives in `src/shared`, so changing one breaks every caller at
compile time rather than at runtime. That is deliberate.

## Pull requests

Describe what changed and why. If it changes behaviour somebody could see, say
what they will see. Keep claims in documentation true of what is on disk —
[`ROADMAP.md`](ROADMAP.md) records the known gaps, and adding to that list is a
perfectly good contribution.

## Further reading

- [`docs/packaging.md`](docs/packaging.md) — building installers, and what signing does and does not do
- [`docs/releasing.md`](docs/releasing.md) — cutting a release
- [`docs/teamwork.md`](docs/teamwork.md) — why teamwork is built the way it is
- [`ROADMAP.md`](ROADMAP.md) — what is done, and what is known to be missing
