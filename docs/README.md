# Documentation

Four kinds of reader come here: somebody installing a build, two people setting
up teamwork, whoever runs the relay, and whoever works on the project. Start at
the [README](../README.md) if you have not seen it before.

## Using teamree

- [**Installing teamree**](install.md) — the download and its checksum, what
  macOS says about an unsigned build and what that warning actually means,
  putting the `teamree` command on your PATH, and what uninstalling leaves
  behind.

## Working with a team

Read them in this order. The first is the only one you need in order to try it.

- [**Trying teamwork**](trying-teamwork.md) — the walkthrough for two people on
  two Macs: the relay, both keys committed and pushed, and each other's
  worktrees in the sidebar. Ends with a troubleshooting section for what
  actually goes wrong, and is exact about what has not been tried. Step 2 sends
  you into [`examples/ledger`](../examples/ledger/), a small program with a test
  suite that runs in a second and a task list chosen so two people can take one
  each without colliding.
- [**The relay**](../relay/README.md) — the relay your team runs: one command to
  deploy it as a Cloudflare Worker, a container for teams who will not, what it
  costs, what its operator can and cannot see, and the protocol on the wire.
- [**Teamwork**](teamwork.md) — why it is built this way. Push access is
  membership, the relay is never trusted with what crosses it, and a teammate
  who can type into your pane can run commands as you.

## Contributing and releasing

- [**Contributing**](../CONTRIBUTING.md) — getting set up, the checks a pull
  request has to pass, and where things are in the tree.
- [**Packaging**](packaging.md) — what each platform's packaging produces, which
  of them has actually been built, and what signing does and does not do.
- [**Cutting a release**](releasing.md) — the one command, everything it refuses
  before it spends a minute on anything, and what signing and notarizing would
  take.
- [**The teamwork scenario**](teamwork-scenario.md) — what a passing end-to-end
  teamwork test looks like, step by step; `tests/teamwork/scenario.test.ts` is
  this document as a test, with the same step numbers.
- [**Roadmap**](../ROADMAP.md) — what has landed, and the known gaps, recorded
  rather than discovered.
