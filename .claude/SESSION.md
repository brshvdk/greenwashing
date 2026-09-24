# SESSION

## Current step
Step 1, PR 4b - the owner's decisions after PR 4: close the removed-worktree loophole, count a project as Python only by its Python tests or test config, move the gate's limits to `docs/limitations.md`. PR 4 (#10, the gate and the plugin) merged as a23285a.

## Progress
- [x] live check of the gate on this repository (2026-09-24, this session). A test broken in `gate/test/changes.test.js` (not committed); the turn end at 16:15 UTC was blocked with (verbatim; the 20 tail lines of TAP output that follow end in `# fail 1`):
  ```
  greenwashing gate: the tests failed - you cannot finish yet.
  Command: python3 -I -m unittest discover -s tests && node --test --test-reporter=tap gate/test/*.test.js (.greenwashing.json)
  Result: failed - 1 failed
  Counts: 303 passed, 1 failed, 0 skipped
  Last 20 lines of output:
  ```
  The file restored by copying; the next turn end at 16:16 UTC was allowed with `greenwashing: no files changed this turn - tests not run` (the turn's net change was zero, so no tests ran - by design). The gate had already been running in this session since 06:41 UTC (Claude Code picked up `.claude/settings.json` mid-session); its allows are in the session transcript, for example `greenwashing: tests passed - python3 -I -m unittest discover -s tests && node --test --test-reporter=tap gate/test/*.test.js: 304 passed, 0 failed, 0 skipped` (15:52 UTC).
- [ ] removed-worktree loophole: test a vanished tree's new commit in a temporary worktree
- [ ] Python counts only with Python tests or Python test config
- [ ] `docs/limitations.md`
- [ ] fresh-context review of this PR and of 7db9327..28aa8a6 (not reviewed in PR 4)
- [ ] PR; all three checks green (no guarded file touched)
(1 of 6 done)
gate on this repo: observed live

## Decisions made (and why)
- Owner (PR 4): the contradictions and silences the docs critic found (which shell runs a hook, an unquoted placeholder example, Stop on timeout, exit 2 with continue:false, trust for plugin hooks and cloud sessions) do not change the hook format; continue.
- Owner (PR 4 review): a prompt after a turn no Stop judged (interrupted, or sent back and then interrupted) keeps that turn's start; the gate follows the Stop input's `cwd` into worktrees; a non-git folder with no test command is allowed with one line; `.txt` is code, not documentation; a real `scripts.test` in `package.json` next to Python code needs `testCommand`; the test command runs with `CI=true`.
- Which trees a Stop checks (final review): always the project's tree, plus every worktree of the same repository (same `--git-common-dir`) the agent was in during the turn (the prompt's and each Stop's `cwd`); never a submodule or a nested clone. Checking only the `cwd`'s tree let an agent break the project and end the turn in a clean worktree; following `cwd` anywhere tested a nested clone instead of the project. Tests run at the project's place in each changed tree, one after another, stopping at the first red; the runs share the project's timeout, so a Stop stays under the hook's own timeout.
- Outside git, "no test command -> allow" applies only when no `.git` file and no `.git` folder with a HEAD is at or above the folder: a checkout git refuses to read (for example "dubious ownership") is did not run, not "not a git repository"; an empty `.git` folder is not a checkout.
- A tree entered after the start is unchanged while clean and on a commit that a worktree or a branch pointed at when the turn started (second review): content that existed before the turn, so a worktree made only to look at an old branch is not blocked.
- The project's `timeoutSeconds` bounds the test time of one Stop across all trees, and each run also keeps its own config's timeout; the time left is rounded up to whole seconds (a run gets at least 1 s while any is left; this sub-second boundary is not pinned by a test).
- From the review, without an owner question (each a false pass or a false alarm reproduced by a run): npm's `npm init` placeholder is no test script; a UTF-8 BOM is dropped before JSON; pytest counts as configured also by `conftest.py` in the root, `tests/` or `test/` and by `pytest.toml`/`.pytest.toml`; jest/vitest "No tests found, exiting with code N" is a zero-test run (GW-08); vitest's `Errors  N error` is did not run; every summary of several runs counts; tail lines are cut at 300 characters (Claude Code caps a hook's text at 10,000); state lives in a per-user `0700` folder; a hook stopped by a signal stops its tests.
- Stop hook timeout 3660 s, test timeout at most 3600 s (default 600): Claude Code cancels a hook at its timeout, discards its output and the stop goes through (hooks.md: "cancels ... discarding the hook's output").
- Block count: the gate's own counter (3) under Claude Code's cap (8 consecutive blocks); it restarts on a new prompt and when `stop_hook_active` is false.
- Changes are content hashes since the prompt, committed or not; no recorded start or no git repository -> the tests run (never skip on "unknown").
- Did not run also covers: a non-zero exit with no failed test, a test file that could not run (jest "Test Suites: N failed", vitest "Test Files N failed"), a skipped-only run (zero tests ran, GW-08), a broken `.greenwashing.json`, the gate itself failing.
- Failed tests name no catalog entry: the owner named GW-50 (did not run) and GW-08 (zero tests) only.
- Plugin root = repository root (`source: "./"`), so the skill ships without a copy; no `version`, so users get each commit (commit-SHA version).
- The install was checked for real: `claude plugin marketplace add` from a smart-HTTP git clone of this branch (the CLI refuses file:// and git://; plain HTTP refuses shallow clones) and `claude plugin install greenwashing@greenwashing` in an isolated CLAUDE_CONFIG_DIR: 1 skill, 2 hooks; the cached hook ran.
- Owner: the three adversarial cases from the first PR 3 review (a number written another way, a number in words, a repeated frontmatter key) stay unfixed.
- Owner: skills.sh cannot be read from the session, so the install path is checked by the `skills` npm README and a live run instead.
- Owner: gitleaks is not run in this session (its release binary lives in another repository, CLAUDE.md section 1); the CI leak-check job runs gitleaks 8.28.0.
- Live runs of the `skills` CLI use `DISABLE_TELEMETRY=1`: the repository is not public yet.
- The name pattern is one character class plus one lookaround per hyphen rule (second review): with two classes the one after a hyphen went untested, since no bad-character name has a hyphen. Brute force: the same names as the two-class pattern on all 2,396,745 strings of length 0-7 over `a`, `1`, `-`, `A`, `_`, U+00EB, space and dot.
- The name charset stays ASCII `a-z0-9-`, although the spec's text says "unicode lowercase alphanumeric characters (`a-z`, `0-9`)": stricter can only give a false alarm here, never a false pass.
- Mutation runs use a fresh bytecode cache per run (`-X pycache_prefix=<new dir>`, works under `-I`): two mutants of the same file size written in the same second reused the previous mutant's `.pyc`, so kills were credited to the wrong test (PR 3 wave). The catalog waves were re-run this way: same result (37 red, 5 controls + 1 known limit green, 36 checker mutants red; the second review's 41 mutants all killed).
- Skill test limits are literals in the boundary tests (64/65, 1024/1025), not the checker's constants, and each name rule is tested with the folder set to the same name: otherwise the folder check masked the charset and length rules (first wave).
- Catalog test: one checker `problems(text)` returns (rule, where); the real catalog must give `[]`, and each mutant built from the real text by position (first or last entry, never a named number) must give exactly its one rule (GW-12, GW-13). `SECTIONS` and `FIELDS` are the only fixed facts; the entry count comes from the catalog alone.
- Entry lines with no `###` heading above them start an entry without a heading ("bad heading"): otherwise a broken heading on the first entry of a section made the entry vanish and the test stayed green (found by the own mutation wave).
- README line is its own paragraph (blank line before it), otherwise Markdown joins it to the tagline.
- After the review, the checker follows Markdown, not Python: lines end only at CRLF, CR, LF (`str.splitlines` also splits on U+2028, U+0085, form feed); outside entries, markup that hides or moves entries once rendered is reported (indented or quoted lines, HTML, fences, other headings, setext underlines); numbers are ASCII in one form (`\d` took fullwidth digits, `GW-0016` passed); a title or line needs an ASCII letter or digit (a zero-width space or `<!-- -->` passed). Inline HTML such as `&nbsp;` still passes: a full renderer would be a dependency.
- The markup rule stays conservative and line-start based (second review): adversarial markup behind a list marker (`- ### GW-01`) or mid-line HTML passes, and some harmless line starts are red (autolink, inline HTML, `#1`, indented or nested lists, GitHub alerts, `---`). Both sides are listed in the map; the owner decides whether to widen or narrow it.
- gitleaks 8.28.0, pinned by SHA-256; positive control: no ERR/FTL line and 0 < "N commits scanned" <= non-merge commits in range (live runs: a bad revision gives an error, "0 commits scanned" and exit 0; only commits that add content count).
- gitleaks scans the git directory with `--ignore-gitleaks-allow`, an empty `--gitleaks-ignore-path` and no `GITLEAKS_CONFIG*`: exclusions from a PR cannot silence it (live-proven).
- leak-check runs with `python3 -I` in its own CI job; the allowlist is read from the base; text that is not UTF-8 and fake images make it "did not run".
- Tests replace gitleaks with a stub; the real gitleaks runs in CI and in session runs. leak-check tests run under the C locale with Python UTF-8 mode off.
- The guarded list and its one exemption live only in `scripts/safety-net`; its tests name examples per rule (a behaviour spec), so dropping a rule turns a test red. Paths are compared ignoring case (macOS reads `claude.md` as `CLAUDE.md`).
- Unit tests in CI: `python3 -I` (live, on a copy of main at daab343 with 60 tests plus one planted failing test: a root `unittest/` package printed "Ran 60 tests / OK" with exit 0 without `-I`; with `-I` all 61 ran and the planted failure gave exit 1). The one-file command is `discover -p` (under `-I`, `unittest tests.test_leak_check` cannot import `tests`).
- Lint in CI: `--no-respect-gitignore` from `ruff check --help` / `ruff config respect-gitignore` of ruff 0.15.8 (live: files hidden by a nested `.gitignore` or `.ignore` pass plain `ruff check .` and fail with the flag; `.venv`, `venv`, `.git` stay excluded). Only CI and CONTRIBUTING use the flag; CLAUDE.md keeps `ruff check .` (not in the owner's allowed edit).
- CI steps are tested under `bash -e` - what GitHub runs for a step without `shell:` (the CI log shows `shell: /usr/bin/bash -e {0}`); the first version assumed pipefail and piped into `tee`, which hid failing tests.
- The safety net runs as `python3 -I` (workflow and shebang) - not in the owner's list, but a merged `scripts/json.py` turned it into a permanent fake pass (proven by runs); same technique as item 1.

## Where we stopped
PR 4b is on `claude/hopeful-pascal-i0o22j`, restarted from main at a23285a after PR 4 was merged. Next steps:
1. PR 4b as above.
2. Then PR 5: fast checks for JS/TS and Python.

## Known issues / traps
- Gate limits: `docs/limitations.md` (user-facing, one list; keep it true when the gate changes). The traps for working on the gate stay in the map.
- Subagent worktrees (`.claude/worktrees/`) are nested repositories to git: each shows as one untracked folder entry, and tree walks must skip folders with their own `.git`.
- The CI "Gate tests" step, like the unit tests step, passes a suite whose tests are all skipped (mutant C6 survives as the stricter variant); PR 5.
- Open, owner decision (second review): a block value in `name` (`name: >`) is not tested; with the name dropped from the block check the skill still fails, only the reported rule changes to "bad name". Stricter patterns that need a letter somewhere or allow at most N hyphens also stay green (false alarms only).
- Open, owner decision: the skill test checks the Agent Skills spec only. Claude's API also forbids `anthropic` and `claude` in `name` and XML tags in `name` and `description` (platform.claude.com Agent Skills overview), and Claude Code skips a skill folder named `synced` (code.claude.com skills docs); the skill passes all three today (checked by grep with a positive control), no test holds it.
- PRs from forks do not get repository secrets, so their pattern scan reports "did not run" (red). The owner decides the policy for external PRs before launch.
- `tests/` and `scripts/` are not guarded as a whole (owner decision): a new test module can still disable assertions, and a `tests/json.py` still replaces `json` under `-I` (discover puts `tests/` first on `sys.path`); the project's own gate closes this later.
- Open, owner decision: `# ruff: noqa`, `# flake8: noqa` and a `# ruff: disable[...]` range hide code from ruff (proven by runs); `--ignore-noqa` in CI closes all three (the repo has no `noqa` today).
- Open, owner decision (review 1d, each proven by runs and confirmed by two refuters): a `.gitattributes` is not guarded; config and instruction files of other agents and editors are not guarded; a `.rgignore`/`.ignore` hides files from ripgrep (the agent's own search); a submodule (`.gitmodules` + gitlink) brings in a `CLAUDE.md` the file list never shows; ruff's default excludes (`dist/`, `_build/`, `node_modules/`) hide test modules that still run; a `# -*- coding: utf-7 -*-` file hides executed code from ruff; the Lint step has no did-not-run guard; the case-insensitive match makes an ordinary `docs/agents.md` red.
- gitleaks skips files by image name in its default config; a fake image is reported as did not run instead.
