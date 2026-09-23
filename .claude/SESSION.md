# SESSION

## Current step
Step 1, PR 1d - close three holes from the PR 1c review: tests cannot be faked, the linter cannot be blinded, agent instructions cannot change quietly

## Progress
- [x] CI unit tests run isolated (`python3 -I`) and fail on zero tests or no "Ran N tests" line; CLAUDE.md section 7 test commands updated (owner's "add to CLAUDE.md")
- [x] CI lint runs with `--no-respect-gitignore`; ruff's default excludes still apply
- [x] safety net guards agent instruction files in any folder and everything in `.claude/` except `.claude/SESSION.md`
- [x] `tests/test_ci_steps.py` runs CI steps as written under `bash -e`; every new rule and step proven by a mutation
- [x] PR #4 open: `checks` and `leak-check` green, "Safety net" red listing the four guarded files it changes
- [x] fresh-context review (4 lenses, each finding checked by 2 refuters): blockers fixed - unit tests went green on failing tests under GitHub's `bash -e` (no pipefail), a root `venv.py` hijacked the tools venv, the safety net itself ran without `-I`
- [ ] CI green on the latest commit
(7 of 8 done)

## Decisions made (and why)
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
Review findings fixed and pushed. Mutations after the review: 33 plus 5 re-checks; single removals of the venv `-I`, the venv `cd` or the safety-net workflow `-I` are equivalent (the other protection holds), removing both turns a test red.
Next: CI green on the latest commit, then the owner's merge.
Next step after this PR: PR 2 - the catalog (the owner provides the catalog text).

## Known issues / traps
- PRs from forks do not get repository secrets, so their pattern scan reports "did not run" (red). The owner decides the policy for external PRs before launch.
- `tests/` and `scripts/` are not guarded as a whole (owner decision): a new test module can still disable assertions, and a `tests/json.py` still replaces `json` under `-I` (discover puts `tests/` first on `sys.path`); the project's own gate closes this later.
- Open, owner decision: `# ruff: noqa`, `# flake8: noqa` and a `# ruff: disable[...]` range hide code from ruff (proven by runs); `--ignore-noqa` in CI closes all three (the repo has no `noqa` today).
- Open, owner decision (review 1d, each proven by runs and confirmed by two refuters): a `.gitattributes` is not guarded; config and instruction files of other agents and editors are not guarded; a `.rgignore`/`.ignore` hides files from ripgrep (the agent's own search); a submodule (`.gitmodules` + gitlink) brings in a `CLAUDE.md` the file list never shows; ruff's default excludes (`dist/`, `_build/`, `node_modules/`) hide test modules that still run; a `# -*- coding: utf-7 -*-` file hides executed code from ruff; the Lint step has no did-not-run guard; the case-insensitive match makes an ordinary `docs/agents.md` red.
- gitleaks skips files by image name in its default config; a fake image is reported as did not run instead.
