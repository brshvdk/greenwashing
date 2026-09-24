# ARCHITECTURE

Map of the repository: only what exists now. All three product modules are here: the catalog, the skill and the gate, the last two shipped as a Claude Code plugin.

## Layout

```
CLAUDE.md                     rules for Claude Code (changed only on the owner's instruction)
.claude/SESSION.md            working memory between sessions
ARCHITECTURE.md               this map
README.md, LICENSE, CONTRIBUTING.md, .github/ISSUE_TEMPLATE/   base files
CATALOG.md                    the public catalog (data, Markdown)
.gitignore
ruff.toml                     lint config
scripts/leak-check            leak check (Python 3, standard library only)
tests/test_leak_check.py      tests of the leak check (unittest)
scripts/safety-net            guarded-file check for pull requests (Python 3, standard library only)
tests/test_safety_net.py      tests of the safety net (unittest, local fake of the GitHub API)
tests/test_ci_steps.py        tests of CI steps (runs them as written in the workflow files)
tests/test_catalog.py         tests of the catalog structure (unittest)
skills/greenwashing/SKILL.md  the skill (Agent Skills format)
tests/test_skill.py           tests of the skill's frontmatter and catalog links (unittest)
gate/hook.js                  the gate: Claude Code hook entry point (hook JSON, git, test process, state)
gate/lib/                     the gate's logic: parse.js, verdict.js, changes.js, command.js (no I/O)
gate/test/                    tests of the gate (node --test); fixtures/ = real output of five test runners
.claude-plugin/               marketplace.json and plugin.json: this repository is a plugin marketplace
hooks/hooks.json              the plugin's hooks (the gate)
.claude/settings.json         the gate on this repository (Claude Code hooks)
.greenwashing.json            this repository's test command for the gate
.github/public-repos.txt      allowlist of the owner's public repositories for the leak check
.github/workflows/ci.yml      CI
.github/workflows/safety-net.yml   safety net workflow
```

## Modules

### CATALOG.md

Purpose: the public catalog - the ways a test suite goes green without the code being right. Data, not code. Sections `## A.` to `## H.`; each entry is a `### GW-NN Title` heading followed by exactly three list items in order: `- **Looks like:**`, `- **Why it's green:**`, `- **Catch it:**`. IDs are stable and never renumbered; gaps between sections are on purpose. The catalog is the only source of its entries: nothing else counts them or lists their numbers.

Tests: `tests/test_catalog.py` - the structure only, read line by line as Markdown splits lines: entry headings (ASCII number in one form, a title with an ASCII letter or digit), numbers unique and ascending, the three lines in order and each with an ASCII letter or digit, sections A-H in order and none empty, no entry outside them, and outside entries no line that starts like markup able to hide entries or move them under another heading (indented or quoted lines, HTML, code fences, headings other than a `# ` title on the first line, setext underlines); markup after a list marker or in the middle of a line is not checked. Mutants of the real catalog must report exactly the rules they break, valid variants none.

Depends on: nothing.

Breaks: `tests/test_catalog.py` (the structure is its contract); `tests/test_skill.py` (the skill cites entry numbers); the gate's block messages (cite GW-08 and GW-50, `gate/test/verdict.test.js`); the link in `README.md` and the link in `skills/greenwashing/SKILL.md`.

Traps:
- adding a section after H or changing the three lines - change `SECTIONS` or `FIELDS` in `tests/test_catalog.py` in the same PR, otherwise the test goes red.
- renumbering an entry - the test checks that numbers are unique and ascending, not that they stay the same, so a renumbering passes it.
- inline HTML or an empty link inside an entry line or title - the test only asks for one ASCII letter or digit, so `&nbsp;`, `<!-- x -->` or `[](url)` passes and renders empty.
- writing outside entries - the markup rule is conservative: an autolink, inline HTML or `#1` at the start of a line, an indented or nested list, a GitHub alert (`> [!NOTE]`) and `---` turn the test red.
- touching line splitting in the test - keep CRLF, CR and LF only, otherwise (`str.splitlines`) U+2028, form feed and others split an entry that Markdown renders as one line.

### skills/greenwashing/SKILL.md

Purpose: the skill for coding agents that read the Agent Skills format: what to do before reporting "done" and how to report, citing catalog entries by `GW-NN`. Frontmatter `name` (the folder name) and `description`. Meant to be installed with `npx skills add brshvdk/greenwashing`: the `skills` CLI looks for `skills/<name>/SKILL.md` (its npm README, 1.7.0), and a live `skills@1.7.0` install from a local copy put the file unchanged into the project's `.claude/skills/greenwashing/SKILL.md`. The field rules follow agentskills.io/specification.

Tests: `tests/test_skill.py` - frontmatter present (LF, CRLF or CR endings, a BOM allowed; one-line values, quotes removed, `~`/`null` read as empty; a block value `>` or `|` is reported, the checker cannot measure it); `name` equals the folder, only lower case letters, digits and hyphens, a hyphen only between letters or digits (none at the start or end, never two in a row), at most 64 characters; `description` not empty, at most 1024 characters; the skill cites at least one `GW-NN` and every one is an entry heading of `CATALOG.md`; the catalog's entry count does not appear in the skill. Mutants of the real skill must report exactly the rules they break.

Depends on: `CATALOG.md` (entry numbers, entry count).

Breaks: `tests/test_skill.py` (the frontmatter and cited numbers are its contract); the plugin (loads it from `skills/greenwashing/`, see below).

Traps:
- removing or renumbering a catalog entry the skill cites - `tests/test_skill.py` goes red; change the skill in the same PR.
- adding or removing a catalog entry - the forbidden number changes, so any bare number in the skill equal to the new count (`0.87`, `line 87`) turns `tests/test_skill.py` red.
- the skill links to `CATALOG.md` on `main` by URL - renaming or moving the catalog breaks the link, and no test checks it.

### gate (`gate/`)

Purpose: the Claude Code hooks that keep an agent from finishing a turn that changed code while the tests fail or did not really run. `node gate/hook.js prompt` (UserPromptSubmit) records HEAD and a content hash of every file git reports as dirty, in a state file in the temp directory (one per session and project). `node gate/hook.js stop` (Stop) finds the files whose content differs from that start, committed or not; nothing changed or only documentation (`.md .markdown .txt .rst .adoc`) -> allow with one line. Otherwise it picks the command (`testCommand` in the project's `.greenwashing.json`, else `npm test` for a `scripts.test` in `package.json`, else `python3 -m pytest` when pytest is configured, else `python3 -m unittest discover` in a Python project, else did not run with the how-to), runs it in its own process group with the timeout (`timeoutSeconds`, default 600, at most 3600), reads the counts of pytest, unittest, jest, vitest and `node --test`, and decides: passed -> allow with one line (command and counts); failed or did not run (no counts, zero tests ran, a file that could not run, a non-zero exit with no failed test, not found, timeout, a broken config, the gate itself failing) -> block with the command, counts, reason, last 20 lines and GW-50 (did not run) or GW-08 (zero tests); after 3 blocks in a row -> allow with a red "WORK NOT ACCEPTED" line. The count restarts on a new prompt and when `stop_hook_active` is false. No model calls, no dependencies: Node 18+ standard library; logic in `gate/lib/` apart from the hook I/O in `hook.js`.

Tests: `gate/test/*.test.js` (`node --test`) - the parser on real output of pytest 9.1.1, unittest (Python 3.11, 3.12), jest 30.5.2, vitest 5.0.1 and `node --test` (Node 20, 22); verdicts, decisions, change detection, command choice; `hook.test.js` runs `hook.js` with hook JSON on stdin in real temporary git projects; `plugin.test.js` checks the hook configs (below). Run on Node 20, 21, 22.

Depends on: Node 18+ and git on PATH; `CATALOG.md` (GW-08 and GW-50, cited by URL); the Claude Code hook contract (hooks reference: Stop input `stop_hook_active`, `decision: "block"` + `reason`, `systemMessage`, per-hook `timeout`, UserPromptSubmit default timeout 30 s); the project's `.greenwashing.json`.

Breaks: `gate/test/` (messages and decisions are its contract); the plugin's `hooks/hooks.json` and this repository's `.claude/settings.json` (they call `gate/hook.js prompt|stop`); CI "Gate tests" step.

Traps:
- touching `MAX_TIMEOUT_SECONDS` or a Stop hook `timeout` - keep the hook's timeout 60 s above the longest test run in both `hooks/hooks.json` and `.claude/settings.json` (`gate/test/plugin.test.js`), otherwise Claude Code cancels the hook and the agent stops ungated.
- touching the prompt hook - it must never exit 2 (on UserPromptSubmit that erases the user's prompt) or print to stdout (that goes to the agent as context).
- a gate that cannot start (no `node` on PATH, a moved `hook.js`) is a non-blocking hook error in Claude Code: the agent stops ungated.
- `node --test` counts a test file with no tests as one passing test (live on Node 20 and 22), and a test that prints a summary-like line adds counts: the counts cannot tell these apart.
- the gate runs the command and code from the working tree: an agent that edits `.greenwashing.json` or `gate/` during the turn changes what runs; Safety net guards `.greenwashing.json` only at PR level.
- in this repository `CATALOG.md` and `SKILL.md` are tested data, but by extension they are documentation: a turn that changes only them skips the tests.
- running `node --test` inside a `node --test` child: `NODE_TEST_CONTEXT` makes the nested run refuse ("called recursively"); `hook.test.js` drops it from the hook's environment.

### plugin (`.claude-plugin/`, `hooks/hooks.json`)

Purpose: this repository is a Claude Code plugin marketplace named `greenwashing` with one plugin, `greenwashing`, whose root is the repository root (`source: "./"`): `hooks/hooks.json` runs the gate through `${CLAUDE_PLUGIN_ROOT}`, and the default `skills/` scan loads `skills/greenwashing/SKILL.md` (one copy). Install: `/plugin marketplace add brshvdk/greenwashing`, then `/plugin install greenwashing@greenwashing`. No `version`: users get each new commit (commit-SHA version). This repository runs the same gate through `.claude/settings.json` with `.greenwashing.json` (Python tests with `-I`, then the gate's tests).

Tests: `gate/test/plugin.test.js` - manifests, exactly one `SKILL.md`, both hook configs' commands run as written by `sh -c` from a path with a space, Stop timeouts, this repository's `.greenwashing.json`; `claude plugin validate` passes with two warnings (no `version`; `CLAUDE.md` at the plugin root is not loaded as context).

Depends on: `gate/hook.js`; `skills/greenwashing/SKILL.md`; the Claude Code plugin and marketplace format.

Breaks: every user install.

Traps:
- adding a top-level component folder or file (`commands/`, `agents/`, `monitors/`, `.mcp.json`, `settings.json`) - the whole repository is the plugin, so it ships to every user.
- moving the skill or the gate out of the repository root - a plugin cannot reference files outside its root, and the cache holds only what is inside it.
- working on this repository with the plugin installed runs the gate twice (plugin and `.claude/settings.json`).

### scripts/leak-check

Purpose: stop leaks before they are published. Three parts, each ends as passed, failed or did not run: (1) gitleaks over the commits in range; (2) references to other repositories of the owner (`brshvdk/<name>`, any case, URLs included), except this repository and the names in `.github/public-repos.txt` read from the base of the range (`BASE_SHA`, else the merge base with `origin/main`; with `--all-history` `origin/main`, else `HEAD`; no base -> part 2 did not run); (3) stop-word patterns from `LEAK_PATTERNS` (one regex per line, pattern #N = line N). Parts 2 and 3 scan tracked files (path and content), every commit in range (author and committer name and email, message, patch) and the PR title and body; a file or patch that is not UTF-8 makes them did not run, image files (`.png .jpg .jpeg .gif .webp .ico` whose bytes start with that format's signature) are not read and are counted as "skipped N image files"; a file with an image name that is not an image is scanned as text and makes all three parts did not run. A commit identity or message, or a file name, that is not UTF-8 also gives did not run. gitleaks ignores exclusions from the scanned repository. Run isolated (`python3 -I`, also in the shebang). Range: `BASE_SHA..HEAD_SHA`, else from the merge base with `origin/main`, else every commit reachable from HEAD; `--all-history` scans every ref. Exit 0 all passed, 1 any failed, 2 nothing failed but something did not run. Output: location and pattern number only.

Inputs: env `LEAK_PATTERNS`, `BASE_SHA`, `HEAD_SHA`, `PR_TITLE`, `PR_BODY`, `GITHUB_EVENT_NAME`; file `.github/public-repos.txt` at the base commit; `git` and `gitleaks` on PATH.

Tests: `tests/test_leak_check.py` - temporary git repositories, made-up patterns, a hostile non-UTF-8 locale, a gitleaks stub.

Depends on: git; gitleaks 8.28.0 (optional: missing -> did not run); `.github/public-repos.txt`.

Breaks: CI "Leak check" step; `tests/test_leak_check.py` (output lines and exit codes are its contract). Guarded by: safety net workflow (changes to it are red there).

Traps:
- touching any text decoding - keep UTF-8 explicit (env, files, git output, stdout), otherwise Cyrillic patterns silently match nothing.
- touching output - never print matched text, a pattern, a matching file name or gitleaks' own log, otherwise public CI logs leak them.
- writing the owner's name, a slash and a repository name anywhere (tests and docs included) - build it at runtime or use a placeholder like `<name>`, otherwise the repository's own leak check goes red.
- touching the gitleaks call - gitleaks 8.28.0 on a bad revision logs an ERR line and "0 commits scanned" and exits 0; keep the checks (no ERR/FTL line, 0 < scanned <= non-merge commits in range), otherwise "not scanned" reads as "clean".
- a PR whose commits add no content (only deletions, renames, mode changes) - gitleaks 8.28.0 counts 0 commits, so the gitleaks part is "did not run" by design.
- running in a shallow clone - the leak check reports "did not run": the history it must scan is incomplete.
- touching the patch scan - keep `--text`, otherwise content git treats as binary (a NUL byte, `.gitattributes`) is never scanned.
- touching the gitleaks call - keep the target the git directory, `--ignore-gitleaks-allow`, `--gitleaks-ignore-path` on an empty directory and no `GITLEAKS_CONFIG*` in its env, otherwise `.gitleaks.toml`, `.gitleaksignore` or `gitleaks:allow` in a PR silence a finding (live-proven with gitleaks 8.28.0).
- changing `.github/public-repos.txt` - it is read from the base, so the change takes effect only after merge; a PR cannot allow a name for itself.
- adding a file that is neither UTF-8 nor an image (cp1251 text, an archive, a PDF) - parts 2 and 3 report did not run by design; an image needs both the extension and the file signature.
- running the script without `-I` - a module a PR adds next to it (`scripts/argparse.py`) replaces the standard library and can fake a pass.
- `git commit` itself re-encodes a non-UTF-8 message or name as Latin-1, so such text reaches the repository as valid UTF-8 mojibake that the check cannot recognise.

### safety-net workflow (`.github/workflows/safety-net.yml`, `scripts/safety-net`)

Purpose: make any change to the checks themselves visible as a separate red check "Safety net". Runs on `pull_request_target` (opened, synchronize, reopened, edited - so a PR retargeted to main is checked too), so the workflow and script come from main and a PR cannot switch them off. Reads the PR's changed files through the GitHub API (read-only token; PR number only through `env:`), never checks out or runs PR code. Red when a guarded file is added, changed, removed or renamed (old and new names). The guarded list and its one exemption live only in `scripts/safety-net` (categories: exact paths, the workflows directory; in any folder, agent instruction file names, tool config, the gate's `.greenwashing.json` and Python startup hook names, and `.claude/` folders; compared ignoring case). Runs as `python3 -I scripts/safety-net`. Did not run when the file list is empty, has an entry without a name, or is incomplete (count differs from the PR's `changed_files`). Output: guarded names only.

Tests: `tests/test_safety_net.py` - comparison logic directly, the script against a local fake of the GitHub API.

Depends on: `scripts/safety-net` on main; GitHub API; `actions/checkout` pinned by commit.

Breaks: acceptance of any PR that touches a guarded file (red by design; the owner decides).

Traps:
- touching the workflow - never add a checkout of the PR ref or run PR code: `pull_request_target` runs with the base repository's token.
- adding a file that guards the checks - add a rule to the list in `scripts/safety-net` (the only copy) and a test for that rule in `tests/test_safety_net.py`, otherwise it is unguarded.
- changing the safety net in a PR - the PR itself is still checked by main's version; the change acts only after merge.
- running the script without `-I` - a module merged next to it (`scripts/json.py`) replaces the standard library and prints a fake pass for every later PR.
- touching the comparison - keep it case-insensitive, otherwise a `claude.md` (read as `CLAUDE.md` on the case-insensitive macOS default file system) slips through.
- `tests/` and `scripts/` are not guarded as a whole (owner decision: otherwise every PR with new tests is red and red stops meaning anything) - a new test module can still disable assertions; the project's own gate closes this later.

### .github/workflows/ci.yml

Purpose: the gate for every PR. On `pull_request` (opened, synchronize, reopened, edited): job `checks` - `ruff check --no-respect-gitignore .`, `python3 -I -m unittest discover -s tests -v` (red on zero tests or no "Ran N tests" line), the gate's tests `node --test --test-reporter=tap gate/test/*.test.js` on the runner's own Node, version printed (red on zero tests or no "# tests N" line); job `leak-check` - gitleaks install (official release, pinned version and SHA-256), `python3 -I scripts/leak-check` on the PR range. On `workflow_dispatch`: the same with `--all-history`.

Tests: `tests/test_ci_steps.py` - runs the tools venv, Lint, Unit tests and Gate tests `run:` blocks (and the safety-net step) as written, under `bash -e`, in throwaway directories; rejects step keys other than name, env, run.

Depends on: `scripts/leak-check`; `tests/`; `gate/test/` and the runner's Node; `ruff.toml` (ruff 0.15.8); repository secret `LEAK_PATTERNS`; `actions/checkout` pinned by commit.

Breaks: acceptance of every PR (the owner merges on green); `tests/test_ci_steps.py` (finds the steps by name).

Traps:
- touching the leak check step - PR title, body and SHAs only through `env:`, never `${{ }}` inside `run:`, otherwise command injection.
- no `LEAK_PATTERNS` secret (also every PR from a fork) - the pattern scan did not run, the step is red.
- touching checkout - keep `fetch-depth: 0`, otherwise the PR range is missing and the leak check did not run.
- touching the Lint step - keep `--no-respect-gitignore`, otherwise a `.gitignore` or `.ignore` added in any folder hides files from ruff.
- touching the Unit tests step - keep `-I` and the "Ran N tests" check, otherwise a root package named like the standard library (`unittest/`) prints a fake OK, or a run of zero tests passes.
- piping a command in a step - GitHub runs steps without a `shell:` key as `bash -e` without pipefail, so `cmd | tee` takes the exit status of `tee` and a failing run goes green.
- touching the Gate tests step - keep the zero and no-count guard: Node 22 reads a glob that matches nothing as "# tests 0" and exits 0.
- touching the tools venv step - keep `python3 -I -m venv` run outside the checkout, otherwise a `venv.py` in the PR builds the environment whose `bin/` (fake `ruff`, `python3`) comes first on PATH for Lint and Unit tests.
- `-I` does not cover `tests/` itself: `unittest discover` puts `tests/` first on `sys.path`, so a `tests/json.py` still replaces `json` (the same open risk as an unguarded test module).
- a `# ruff: noqa` or `# flake8: noqa` comment, or a `# ruff: disable[...]` range, still hides code from ruff (open, owner decision; `--ignore-noqa` closes all three - checked by a run).
- moving the leak check into a job that runs PR tests or tools first - that code can rewrite `GITHUB_ENV` / `GITHUB_PATH` of later steps and fake the leak check; keep it in its own job.
