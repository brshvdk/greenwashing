# SESSION

## Current step
Step 1, PR 1d - close three holes from the PR 1c review: tests cannot be faked, the linter cannot be blinded, agent instructions cannot change quietly

## Progress
- [x] CI unit tests run isolated (`python3 -I`) and fail on zero tests or no "Ran N tests" line; CLAUDE.md section 7 test commands updated (owner's "add to CLAUDE.md")
- [x] CI lint runs with `--no-respect-gitignore`; ruff's default excludes still apply
- [x] safety net guards agent instruction files in any folder and everything in `.claude/` except `.claude/SESSION.md`
- [x] `tests/test_ci_steps.py` runs the Lint and Unit tests steps as written; every new rule and step proven by a mutation
- [ ] fresh-context review verified by runs; PR open; `checks` and `leak-check` green, "Safety net" red (this PR changes guarded files)
(4 of 5 done)

## Decisions made (and why)
- gitleaks 8.28.0, pinned by SHA-256; positive control: no ERR/FTL line and 0 < "N commits scanned" <= non-merge commits in range (live runs: a bad revision gives an error, "0 commits scanned" and exit 0; only commits that add content count).
- gitleaks scans the git directory with `--ignore-gitleaks-allow`, an empty `--gitleaks-ignore-path` and no `GITLEAKS_CONFIG*`: exclusions from a PR cannot silence it (live-proven).
- leak-check runs with `python3 -I` in its own CI job; the allowlist is read from the base; text that is not UTF-8 and fake images make it "did not run".
- Tests replace gitleaks with a stub; the real gitleaks runs in CI and in session runs. leak-check tests run under the C locale with Python UTF-8 mode off.
- The guarded list lives only in `scripts/safety-net`; its tests name examples per rule (a behaviour spec), so dropping a rule turns a test red. Paths are compared ignoring case (macOS reads `claude.md` as `CLAUDE.md`); a `.claude/` folder is guarded in any folder, the exception is only the root `.claude/SESSION.md`.
- Unit tests in CI: `python3 -I` (live: a root `unittest/` package printed "Ran 60 tests / OK" with exit 0 without `-I`; with `-I` the real 61 tests ran and a planted failure gave exit 1). The one-file command is `discover -p` (under `-I`, `unittest tests.test_leak_check` cannot import `tests`).
- Lint in CI: `--no-respect-gitignore` from `ruff check --help` / `ruff config respect-gitignore` of ruff 0.15.8 (live: files hidden by a nested `.gitignore` or `.ignore` pass plain `ruff check .` and fail with the flag; `.venv`, `venv`, `.git` stay excluded). Only CI uses the flag; CLAUDE.md keeps `ruff check .`.

## Where we stopped
All items written, tests and ruff green locally. Next: review, push, PR; "Safety net" must be red on it.
Next step after this PR: PR 2 - the catalog (the owner provides the catalog text).

## Known issues / traps
- PRs from forks do not get repository secrets, so their pattern scan reports "did not run" (red). The owner decides the policy for external PRs before launch.
- `tests/` and `scripts/` are not guarded as a whole (owner decision): a new test module can still disable assertions, and a `tests/json.py` still replaces `json` under `-I` (discover puts `tests/` first on `sys.path`); the project's own gate closes this later.
- Open, owner decision: a `# ruff: noqa` comment in a file hides that file from ruff (proven by a run); `--ignore-noqa` in CI would close it (the repo has no `noqa` today).
- gitleaks skips files by image name in its default config; a fake image is reported as did not run instead.
