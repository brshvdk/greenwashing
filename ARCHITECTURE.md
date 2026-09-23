# ARCHITECTURE

Map of the repository: only what exists now. The product modules (catalog, skill, gate) are not here yet.

## Layout

```
CLAUDE.md                     rules for Claude Code (changed only on the owner's instruction)
.claude/SESSION.md            working memory between sessions
ARCHITECTURE.md               this map
README.md, LICENSE, CONTRIBUTING.md, .github/ISSUE_TEMPLATE/   base files
.gitignore
ruff.toml                     lint config
scripts/leak-check            leak check (Python 3, standard library only)
tests/test_leak_check.py      tests of the leak check (unittest)
scripts/safety-net            guarded-file check for pull requests (Python 3, standard library only)
tests/test_safety_net.py      tests of the safety net (unittest, local fake of the GitHub API)
tests/test_ci_steps.py        tests of CI steps (runs them as written in the workflow files)
.github/public-repos.txt      allowlist of the owner's public repositories for the leak check
.github/workflows/ci.yml      CI
.github/workflows/safety-net.yml   safety net workflow
```

## Modules

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

Purpose: make any change to the checks themselves visible as a separate red check "Safety net". Runs on `pull_request_target` (opened, synchronize, reopened, edited - so a PR retargeted to main is checked too), so the workflow and script come from main and a PR cannot switch them off. Reads the PR's changed files through the GitHub API (read-only token; PR number only through `env:`), never checks out or runs PR code. Red when a guarded file is added, changed, removed or renamed (old and new names). The guarded list and its one exemption live only in `scripts/safety-net` (categories: exact paths, the workflows directory; in any folder, agent instruction file names, tool config and Python startup hook names, and `.claude/` folders; compared ignoring case). Runs as `python3 -I scripts/safety-net`. Did not run when the file list is empty, has an entry without a name, or is incomplete (count differs from the PR's `changed_files`). Output: guarded names only.

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

Purpose: the gate for every PR. On `pull_request` (opened, synchronize, reopened, edited): job `checks` - `ruff check --no-respect-gitignore .`, `python3 -I -m unittest discover -s tests -v` (red on zero tests or no "Ran N tests" line); job `leak-check` - gitleaks install (official release, pinned version and SHA-256), `python3 -I scripts/leak-check` on the PR range. On `workflow_dispatch`: the same with `--all-history`.

Tests: `tests/test_ci_steps.py` - runs the tools venv, Lint and Unit tests `run:` blocks (and the safety-net step) as written, under `bash -e`, in throwaway directories; rejects step keys other than name, env, run.

Depends on: `scripts/leak-check`; `tests/`; `ruff.toml` (ruff 0.15.8); repository secret `LEAK_PATTERNS`; `actions/checkout` pinned by commit.

Breaks: acceptance of every PR (the owner merges on green); `tests/test_ci_steps.py` (finds the steps by name).

Traps:
- touching the leak check step - PR title, body and SHAs only through `env:`, never `${{ }}` inside `run:`, otherwise command injection.
- no `LEAK_PATTERNS` secret (also every PR from a fork) - the pattern scan did not run, the step is red.
- touching checkout - keep `fetch-depth: 0`, otherwise the PR range is missing and the leak check did not run.
- touching the Lint step - keep `--no-respect-gitignore`, otherwise a `.gitignore` or `.ignore` added in any folder hides files from ruff.
- touching the Unit tests step - keep `-I` and the "Ran N tests" check, otherwise a root package named like the standard library (`unittest/`) prints a fake OK, or a run of zero tests passes.
- piping a command in a step - GitHub runs steps without a `shell:` key as `bash -e` without pipefail, so `cmd | tee` takes the exit status of `tee` and a failing run goes green.
- touching the tools venv step - keep `python3 -I -m venv` run outside the checkout, otherwise a `venv.py` in the PR builds the environment whose `bin/` (fake `ruff`, `python3`) comes first on PATH for Lint and Unit tests.
- `-I` does not cover `tests/` itself: `unittest discover` puts `tests/` first on `sys.path`, so a `tests/json.py` still replaces `json` (the same open risk as an unguarded test module).
- a `# ruff: noqa` or `# flake8: noqa` comment, or a `# ruff: disable[...]` range, still hides code from ruff (open, owner decision; `--ignore-noqa` closes all three - checked by a run).
- moving the leak check into a job that runs PR tests or tools first - that code can rewrite `GITHUB_ENV` / `GITHUB_PATH` of later steps and fake the leak check; keep it in its own job.
