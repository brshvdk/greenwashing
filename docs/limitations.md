# Limitations of the gate

The gate (`gate/`) is a Claude Code Stop hook: when a turn changed code, it runs the project's tests and does not let the agent finish while they fail or did not really run. These are its known limits in v0.1. Each one follows from a design decision or was seen in a run, and none is fixed in code.

## Where it looks

- **A folder outside git that holds projects.** Started in such a folder, the gate finds no repository and no test command, so it lets every turn end with one line.
- **Outside git in general.** Nothing tells what changed, so the tests run on every stop. Only Python test files in the folder itself, not in its subfolders, make it a Python project.
- **Worktrees.** Only a tree that is the agent's working folder at a prompt or a stop is watched. A worktree edited only by absolute path is not checked. A worktree moved with `git worktree move` or by hand is not followed either, so its changes from before or after the move are not seen.
- **Removed worktrees.** The gate tests the commit a removed worktree left, found through the branch the worktree had when the gate last saw it. It misses commits that end up elsewhere: on a renamed branch, on a new branch while the old one is reset back, or in a worktree switched back to its start commit instead of removed. A branch merged with `git merge -s ours` counts as merged.
- **The temporary checkout has no ignored files.** A removed worktree's commit is tested in a fresh checkout without `node_modules`, a virtual environment or a `.env`. A test command that needs them reads as did not run.
- **A removed worktree's commit is tested whatever it changed.** A commit that only edits documentation is still blocked when the tests were already failing on its branch.
- **Branches left behind.** Commits the agent makes on a branch and then leaves are not tested, for example when it switches the project back to its old branch. The gate tests what is checked out, plus the commit of a removed worktree.
- **Submodules and nested repositories.** Changes inside them are not seen: git reports the folder, not its files.
- **Files git does not report.** Changes to these are not seen: an ignored `.env` the tests read, a project inside an ignored folder, files marked `assume-unchanged` or `skip-worktree`.
- **Symlinks and permissions.** Editing a file through a symlink that points outside the repository is not seen, and neither is a change to a file's permissions only.
- **Throwing work away.** Resetting a worktree the agent entered during the turn back to a commit that existed before the turn counts as no change.
- **Report files.** The test run may rewrite a file git does not ignore (for example `junit.xml`). Then a turn that only ran the tests looks like a code change.
- **A session started in a subfolder.** The gate reads `.greenwashing.json` from that subfolder, while changes count in the whole repository.

## What it counts

- **`node --test` and `process.exit`.** A test file with no tests reads as one passing test. So does a file whose code under test calls `process.exit(0)`.
- **`pytest.exit`.** `pytest.exit(..., returncode=0)` reads as passed.
- **Fewer tests.** A new `.only` or skip in a test file is red (GW-17), but an agent can still narrow the test script, exclude files in the runner's config (jest `testPathIgnorePatterns`, pytest `-k` or `collect_ignore`), delete a failing test, or rename it so the runner no longer collects it. The gate then gets green counts for the tests that still run.
- **`skipIf(CI)`.** The gate runs the tests with `CI=true`, so a test skipped in CI counts as skipped, not failed.
- **Summary-like output.** A test that prints a line looking like a runner summary adds counts.
- **vitest `Tests  no tests`.** The result is right (did not run), but the reason is "no test counts" instead of GW-08.

## Which command it runs

- **Other runners.** Only pytest, unittest, jest, vitest and `node --test` output is read. `go test`, `cargo test` and others always read as did not run.
- **pnpm.** `pnpm -r test` puts the package name in front of each line, which hides the counts.
- **A virtual environment not on PATH.** `python3 -m pytest` runs the system Python; set `testCommand` to the environment's Python.
- **Other Python test names.** Only `test_*.py` and `*_test.py` files, or pytest settings, make a project Python. Tests kept only in files like `tests.py` or `testing.py` need a `testCommand`.
- **Python tests without pytest settings.** They run under `python3 -m unittest discover`. That runs only `unittest.TestCase` tests in `test*.py` files; pytest-style test functions and `*_test.py` files are left out. Set `testCommand`.
- **jest and `CI=true`.** jest fails a new snapshot instead of writing it, and an explicit `jest --watchAll` still waits for the timeout.

## The quick checks of changed tests

Before the tests, the gate reads the test lines the turn added or changed. These are the limits of that reading.

- **What the checks look for.** Only a new skip, focus or expected-failure marker (GW-17), a new or changed test with no assertion (GW-18) and a check whose two sides are the same (GW-01). The most common ways to buy green are none of these, and the tests then pass: changing the expected value to what the code returns, deleting a failing test or a table row, weakening an assertion (`.toBe(6)` to `.toBeDefined()`), swallowing the failure (`try`/`catch`, an early `return` on CI), taking the expected value from the code under test, mocking the code under test, or writing the wrong output into a snapshot.
- **Which files are tests.** Only what jest, vitest and `node --test` collect by default (`*.test.*`, `*.spec.*`, `*-test.*`, `*_test.*`, `test-*`, `test.js`, files under `__tests__/` or `test/`) and Python `test*.py` (so also `tests.py`) and `*_test.py`. Tests under `tests/` with a jest config that points there, Cypress `*.cy.js`, Jasmine `spec/` files, `conftest.py` and runner config are not read.
- **Skips it does not see.** A skip condition changed away from its marker (`HAS_TZ = False` behind an old `skipif(not HAS_TZ)`), node:test options passed in a variable (`test('x', flaky, fn)`), a name given to a marker in another file, by a function (`function itIf(c) { return c ? it : it.skip; }`, a pytest mark returned by a `def`) or by a later assignment (`let maybe = it; if (!db) maybe = it.skip;`), a vitest `test.extend` object under another name, a skip added in `conftest.py` or runner config, a test renamed so the runner no longer collects it (`_test_...`, `test_x.__test__ = False`), a test wrapped in a string, a failing test replaced by `it.todo` with its name, and skip decorators outside pytest and unittest (Django's `skipUnlessDBFeature`).
- **Suites that skip.** A test added to or moved into a suite that never runs (`describe.skip`, `xdescribe`, a class or module marked `pytest.mark.skip`, `unittest.skip` or xfail, also through a class's own `pytestmark`) is reported; an edit of a test that was already there is not. Not seen: a test moved into a suite that a condition skips (`describe.skipIf(...)`, `pytestmark = pytest.mark.skipif(...)`: a new honest test there must not block while the condition lets it run), into a suite skipped through a named variable, node:test suite options, a `setUp` that calls `skipTest`, Playwright's `test.describe.skip`, or a class that already has `__test__ = False`, and a suite's closing bracket moved below a test that keeps its lines.
- **A helper that asserts under another name.** A test that checks only through its own helper (`checkUser(u)`, `verify(response)`, nock's `scope.done()`) or only by calling code that throws (Testing Library `getBy...`, a "does not throw" test) reads as "no assertion". Calls named `assert...` or `expect...`, the test's context (`t.` or its first parameter, other than members that check nothing like `t.diagnostic`) and functions imported from assertion modules (`node:assert`, `chai`) count. Otherwise turn the check off: `"checks": {"assertions": false}` in `.greenwashing.json`.
- **A test function defined elsewhere.** `test('saves', savesTheUser)` is not read; only an inline function is.
- **Assertions that cannot fail.** `assert True`, `assert.ok(true)`, `expect(1).toBeDefined()`, an assert on a non-empty tuple (`assert (x == 6, "message")`) and `console.assert` count as no assertion. Other constant checks still count as one (`expect(null).toBeNull()`, `self.assertIsNone(None)`, `expect(r === r).toBe(true)`).
- **Same sides, by text.** GW-01 compares the text of both sides (JavaScript without spaces and comments, Python by its syntax tree). Two different expressions that always hold the same value are not seen, and the same call or value on both sides is reported also where it is meant: a determinism check (`expect(f()).toBe(f())`), an identity or cache check (`assert get_config() is get_config()`), a reflexivity check (`assertEqual(cart, cart)`).
- **Lines are compared as text.** Re-indenting (wrapping tests in a `describe` or a class), a new quote style, or any edit of a line that holds an old marker (a new reason for `@pytest.mark.skip`) reports that marker again. Indentation is kept on purpose: in Python, indenting a test into a skipped class is a new skip. Past 2000 inserted and removed lines in one file, every line between the first and the last change counts as changed, so a codemod over a big file reports its old markers again.
- **Moved test files.** A new test file that keeps, in order, at least half of its lines from a test file the turn deleted is read against that file, and so is each part of a deleted file split in several. A copy (the file it came from is still there) or a file moved with most of its lines changed is new: every line counts, so an old skip in it is reported.
- **Not a parser.** The JavaScript and TypeScript reading is a scanner for strings, comments, templates and regular expressions. Unusual code (JSX text with a quote in it, a backtick in JSX text with a template later, `/*` in JSX text with a real `*/` later, a regular expression right after `)`) can make it misread a line.
- **Look-alikes.** A new doc comment with a usage example (` * it('adds', ...)`) reads as a test in a comment, and `this.skip(n)` on any object reads as mocha's skip.
- **Python.** The Python checks run `python3` from PATH, which must read the project's syntax. No `python3`, or a file it cannot read (syntax newer than that `python3`, such as `def first[T]()` under Python 3.11), is did not run on every turn until a newer `python3` is on PATH or the checks are turned off.
- **No start of the turn.** Outside git, or when the prompt hook did not record the start of the turn (it failed, or the hooks were added in the middle of a session), nothing tells which lines changed: the tests run, the checks do not, and the allow line says so.
- **Big or linked files.** A test file over 1 MiB that was dirty when the turn started counts as all new. A test file that is a symlink is not read.
- **The gate's settings.** A change to any `.greenwashing.json` in a checked tree during the turn blocks (GW-114), also when the user made it while the agent worked, or after a blocked turn the user then interrupted. The user changes it between turns, after a turn the gate let end. The project's own file counts also when git ignores it. In a worktree the agent entered during the turn, an ignored `.greenwashing.json` is not seen, and it sets that worktree's checks and test command. A removed worktree that held an ignored copy of it blocks as a settings change: its commit has no such file.
- **After WORK NOT ACCEPTED.** Three blocks in a row let the agent stop. The next turn starts from what that turn left, so its new skip or its settings are then the start and no longer reported.

## Time, turns and sessions

- **`timeoutSeconds` is one budget per stop.** It bounds all test runs of one stop together: the project, its worktrees, a removed worktree's commit. With several long suites, raise it.
- **Many changed files.** Change detection reads each changed file with a separate git call, so tens of thousands of files take minutes.
- **An interrupted turn.** A turn cut off before its stop keeps its start. An edit the user makes before the next prompt then counts as the turn's change.
- **Two sessions in one checkout.** Each sees the other's changes as its own, so a session that changed nothing can be blocked.
- **Someone else's work in a worktree.** The agent may only visit a worktree that holds failing work it did not make: uncommitted work of the user or of another session, or a commit fetched after the turn started. The gate tests that work and blocks. A commit the user makes in a worktree the agent was in counts as the agent's.

## The gate itself

- **Its own files.** The gate runs the command and the code of the working tree. An agent that edits `.greenwashing.json` or `gate/` during the turn changes what runs.
- **Its state.** The state file lives in the user's temp folder, where the agent can edit it. If the gate cannot write its state folder, every stop fails (exit 2) until Claude Code's own limit of blocks.
- **Another user's folder.** On a shared machine, another user can create `greenwashing-gate-<uid>` first, open to everyone, and rewrite the state.
- **Signals.** A signal to the hook ends it with a non-blocking error, and the turn ends ungated. An example is a `pkill` the agent started. A hook killed with SIGKILL during a temporary checkout leaves that checkout in the temp folder and in `git worktree list`; remove it with `git worktree remove`.
- **A gate that cannot start.** Claude Code treats the hook's error as non-blocking when `node` is not on PATH or `gate/hook.js` has moved.
- **Documentation by extension.** A turn that changes only `.md .markdown .rst .adoc` files skips the tests, even when tests read those files. In this repository that is true of `CATALOG.md` and `SKILL.md`.
- **The block message.** It names up to 10 failed tests, read from TAP, pytest, jest, vitest and unittest output, and shows the last 20 lines. Other output gives no names: the `spec` reporter of `node --test` (its default on Node 23 and later, also when the output is not a terminal) and other runners.
