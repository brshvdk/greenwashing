# SESSION

## Current step
Step 1, PR 1c - extend the safety net's guarded list and see the safety net live

## Progress
- [x] guarded list extended with tool config, Python startup hooks and Claude Code settings in any folder (the list itself: `scripts/safety-net` only)
- [x] a test per rule (nested folders, renames into and out of guarded names); every rule proven by a mutation
- [x] PR open: `checks` and `leak-check` green, "Safety net" red on it, listing exactly the two guarded files it changes
- [x] fresh-context review verified by runs: nested `ruff.toml` now guarded, SESSION.md list copy removed, `.pth` dot pinned by a test; two findings outside the owner's list left to the owner (below)
(4 of 4 done)

## Decisions made (and why)
- gitleaks 8.28.0, pinned by SHA-256; positive control: no ERR/FTL line and 0 < "N commits scanned" <= non-merge commits in range (live runs: a bad revision gives an error, "0 commits scanned" and exit 0; only commits that add content count).
- gitleaks scans the git directory with `--ignore-gitleaks-allow`, an empty `--gitleaks-ignore-path` and no `GITLEAKS_CONFIG*`: exclusions from a PR cannot silence it (live-proven).
- leak-check runs with `python3 -I` in its own CI job; the allowlist is read from the base; text that is not UTF-8 and fake images make it "did not run".
- Tests replace gitleaks with a stub; the real gitleaks runs in CI and in session runs. leak-check tests run under the C locale with Python UTF-8 mode off.
- The guarded list lives only in `scripts/safety-net`; its tests name examples per rule (a behaviour spec), so dropping a rule turns a test red.
- `scripts/safety-net` and `tests/test_safety_net.py` are guarded too: any change to the checks must be visible.

## Where we stopped
safety net observed live: red on PR #3 (https://github.com/brshvdk/greenwashing/actions/runs/35870693126/job/107213675854) - it listed `scripts/safety-net` and `tests/test_safety_net.py`, the two guarded files among the four the PR changes. This red is expected; the owner merges knowing it.
Next: the owner's merge, then PR 2 - the catalog (the owner provides the catalog text).
Next step after this PR: PR 2 - the catalog (the owner provides the catalog text).

## Known issues / traps
- PRs from forks do not get repository secrets, so their pattern scan reports "did not run" (red). The owner decides the policy for external PRs before launch.
- `tests/` and `scripts/` are not guarded as a whole (owner decision): a new test module can still disable assertions; the project's own gate closes this later.
- Open, owner decision (review 1c, proven by runs): a root `unittest/` package makes `python3 -m unittest discover` print OK without running tests; a `.ignore` or `.gitignore` in any folder hides files from ruff. Neither is guarded.
- gitleaks skips files by image name in its default config; a fake image is reported as did not run instead.
