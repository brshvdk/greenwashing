# Configuration

The gate and the mutation check need no settings: without them, the gate picks the test command itself and every check is on. To change that, put a `.greenwashing.json` in the project root (the folder Claude Code was started in).

Change it between turns, never during one: a `.greenwashing.json` that changes during a turn blocks that turn ([GW-114](../CATALOG.md#gw-114-the-checked-code-configures-its-checker)), so the agent cannot change the settings that judge its own work. A file that is not valid JSON, is not a JSON object or has a key not listed here blocks every turn that changes code as "did not run" until a human fixes it.

```json
{
  "testCommand": "npm run test:unit",
  "timeoutSeconds": 900,
  "checks": { "assertions": false },
  "python": ".venv/bin/python",
  "mutants": { "limit": 40, "timeoutSeconds": 1800 }
}
```

## `testCommand`

The command that runs your tests, run in the project root by the shell, with `CI=true`. Without it the gate picks one: `npm test` when `package.json` has a real `test` script, else `python3 -m pytest` when pytest is configured, else `python3 -m unittest discover` when there are Python test files (`test_*.py`, `*_test.py`). A project with both a `test` script and Python tests needs `testCommand`, so neither half goes untested.

A command set here always runs, and the gate reads its output: the counts that pytest, unittest, jest, vitest and `node --test` print. Output with no counts is "did not run". The mutation check runs the same command.

A project whose test command, when the work starts, runs none of these runners is not checked: each turn ends with a line that says so. Setting `testCommand` to a command that runs your tests with one of them makes it checked.

## `timeoutSeconds`

The time for the test runs of one stop, in seconds: a whole number from 1 to 3600, 600 when not set. It covers every run of that stop together (the project, its worktrees, a removed worktree's commit). A run still going at the end is stopped and is "did not run".

## `checks`

The quick checks of the test lines a turn added or changed, each `true` (the default) or `false`:

- `skips`: a new skip, focus or expected-failure marker ([GW-17](../CATALOG.md#gw-17-a-skip-that-buys-green)); also a test the turn removed. Turning it off turns off both.
- `assertions`: a new or changed test with no assertion ([GW-18](../CATALOG.md#gw-18-a-test-with-nothing-to-check)).
- `selfComparisons`: a check whose two sides are the same ([GW-01](../CATALOG.md#gw-01-self-referential-assertion)).

The check of `.greenwashing.json` itself ([GW-114](../CATALOG.md#gw-114-the-checked-code-configures-its-checker)) cannot be turned off.

## `python`

The Python that reads Python test files for the checks and lists the breaks of Python code for the mutation check: a path from the project folder (`.venv/bin/python`) or a name on PATH. `python3` from PATH when not set. Set it when `python3` is missing or older than your code's syntax. It does not choose the Python your tests run with: `testCommand` does.

## `mutants`

The limits of the mutation check, each a whole number from 1 to 86400:

- `limit`: how many breaks it tries at most; 20 when not set.
- `timeoutSeconds`: the time for everything, in seconds; 600 when not set.
- `runTimeoutSeconds`: the time for one test run with a break, in seconds. When not set, each run with a break gets the time the first test run (on the unchanged code) took x 1.5 + 10 s.

The options of `/greenwashing:mutants` win over these.

## Allowing a test removal

The words `allow test removal` in your prompt let that turn remove tests: any test, not only the one you meant. They count in any case and with any spaces between them, as whole words. The removed tests then do not block: the gate lists them in the line it ends the turn with. Only your prompt counts: nothing the agent writes and no file does. What else the words do and do not cover is under "Allowing a removal" in [limitations.md](limitations.md#the-quick-checks-of-changed-tests).

## Options of the mutation check

`/greenwashing:mutants` takes these after its name, for example `/greenwashing:mutants --limit 40 --timeout 1800`:

- `--base <ref>`: the branch or commit the change is measured from (the lines added since the merge base of `HEAD` with it). When not given: `origin/HEAD`, else the first of `origin/main`, `origin/master`, `main` and `master` that exists.
- `--limit <n>`: how many breaks to try at most; `limit` in `mutants`, else 20.
- `--timeout <seconds>`: the time for everything; `timeoutSeconds` in `mutants`, else 600.
- `--run-timeout <seconds>`: the time for one test run with a break; `runTimeoutSeconds` in `mutants`, else the first run's time x 1.5 + 10 s. A value shorter than the first run takes means no break runs.
- `--project <folder>`: the project folder, where the test command runs and `.greenwashing.json` is read; the current folder when not given. `/greenwashing:mutants` gives it the project folder itself.

Each number is a whole number from 1 to 86400.
