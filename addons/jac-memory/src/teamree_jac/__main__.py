"""Entry point: `teamree-jac serve` for teamree, or `why`/`risk`/`related` on a repository."""

import argparse
import os
import sys
import tempfile

from teamree_jac import __version__


def main() -> int:
    parser = argparse.ArgumentParser(prog="teamree-jac", description="teamree's team work graph, in Jac.")
    parser.add_argument("--version", action="version", version=__version__)
    commands = parser.add_subparsers(dest="command")
    serve = commands.add_parser("serve", help="Answer teamree on stdio (NDJSON).")
    serve.add_argument("--data", required=True, help="Where the journal lives.")
    for name, words in (("why", "path"), ("risk", "path"), ("related", "words")):
        sub = commands.add_parser(name)
        sub.add_argument("args", nargs="+", metavar=words)
        sub.add_argument("--repo", default=".")
        sub.add_argument("--base", default="HEAD")
    options = parser.parse_args()
    if options.command is None:
        parser.print_help()
        return 2

    # Graph writes otherwise look for jac.toml up the tree on every edge.
    os.environ.setdefault("JAC_TOPOLOGY_INDEX", "0")
    if options.command == "serve":
        data = os.path.abspath(options.data)
        os.makedirs(data, exist_ok=True)
        # Jac's own store; the graph is rebuilt from git and the journal, so nothing lands there.
        os.environ["JAC_DATA_PATH"] = data
        # stdout is the protocol: whatever Jac or a library prints goes to stderr instead.
        out = os.fdopen(os.dup(1), "w", encoding="utf-8", buffering=1)
        os.dup2(2, 1)
        sys.stdout = sys.stderr
        os.chdir(data)
        import jaclang  # noqa: F401
        from teamree_jac.serve import serve as run

        run(out, data, __version__)
        return 0

    os.environ.setdefault("JAC_DATA_PATH", os.path.join(tempfile.gettempdir(), "teamree-jac"))
    import jaclang  # noqa: F401
    from teamree_jac.serve import ask_once

    print(ask_once(options.command, os.path.abspath(options.repo), options.base, options.args))
    return 0


if __name__ == "__main__":
    sys.exit(main())
