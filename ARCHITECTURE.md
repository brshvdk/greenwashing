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
.github/public-repos.txt      allowlist of the owner's public repositories for the leak check
.github/workflows/ci.yml      CI
```

## Modules

### scripts/leak-check

Purpose: stop leaks before they are published. Three parts, each ends as passed, failed or did not run: (1) gitleaks over the commits in range; (2) references to other repositories of the owner (`brshvdk/<name>`, any case, URLs included), except this repository and the names in `.github/public-repos.txt`; (3) stop-word patterns from `LEAK_PATTERNS` (one regex per line, pattern #N = line N). Parts 2 and 3 scan tracked files (path and content), every commit in range (author and committer name and email, message, patch) and the PR title and body. Range: `BASE_SHA..HEAD_SHA`, else from the merge base with `origin/main`, else every commit reachable from HEAD; `--all-history` scans every ref. Exit 0 all passed, 1 any failed, 2 nothing failed but something did not run. Output: location and pattern number only.

Inputs: env `LEAK_PATTERNS`, `BASE_SHA`, `HEAD_SHA`, `PR_TITLE`, `PR_BODY`, `GITHUB_EVENT_NAME`; file `.github/public-repos.txt`; `git` and `gitleaks` on PATH.

Tests: `tests/test_leak_check.py` - temporary git repositories, made-up patterns, a hostile non-UTF-8 locale, a gitleaks stub.

Depends on: git; gitleaks 8.28.0 (optional: missing -> did not run); `.github/public-repos.txt`.

Breaks: CI "Leak check" step; `tests/test_leak_check.py` (output lines and exit codes are its contract).

Traps:
- touching any text decoding - keep UTF-8 explicit (env, files, git output, stdout), otherwise Cyrillic patterns silently match nothing.
- touching output - never print matched text, a pattern, a matching file name or gitleaks' own log, otherwise public CI logs leak them.
- writing the owner's name, a slash and a repository name anywhere (tests and docs included) - build it at runtime or use a placeholder like `<name>`, otherwise the repository's own leak check goes red.
- touching the gitleaks call - gitleaks 8.28.0 on a bad revision logs an ERR line and "0 commits scanned" and exits 0; keep the checks (no ERR/FTL line, 0 < scanned <= non-merge commits in range), otherwise "not scanned" reads as "clean".
- a PR whose commits add no content (only deletions, renames, mode changes) - gitleaks 8.28.0 counts 0 commits, so the gitleaks part is "did not run" by design.
- running in a shallow clone - the leak check reports "did not run": the history it must scan is incomplete.
- touching the patch scan - keep `--text`, otherwise content git treats as binary (a NUL byte, `.gitattributes`) is never scanned.
- gitleaks honours `.gitleaks.toml`, `.gitleaksignore` and `gitleaks:allow` comments from the scanned repository - a PR adding any of them weakens the check.
- `.github/public-repos.txt` is read from the PR head - a PR can allow a name for itself; review changes to it as security changes.

### .github/workflows/ci.yml

Purpose: the gate for every PR. On `pull_request` (opened, synchronize, reopened, edited): ruff, unittest, gitleaks install (official release, pinned version and SHA-256), `scripts/leak-check` on the PR range. On `workflow_dispatch`: the same with `scripts/leak-check --all-history`.

Depends on: `scripts/leak-check`; `tests/`; `ruff.toml` (ruff 0.15.8); repository secret `LEAK_PATTERNS`.

Breaks: acceptance of every PR (the owner merges on green).

Traps:
- touching the leak check step - PR title, body and SHAs only through `env:`, never `${{ }}` inside `run:`, otherwise command injection.
- no `LEAK_PATTERNS` secret (also every PR from a fork) - the pattern scan did not run, the step is red.
- touching checkout - keep `fetch-depth: 0`, otherwise the PR range is missing and the leak check did not run.
