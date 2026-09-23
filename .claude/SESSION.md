# SESSION

## Current step
Step 1, PR 1 - repo skeleton: rules, map, base files, leak check, CI

## Progress
- [x] CLAUDE.md (owner's text, verbatim), ARCHITECTURE.md, this file
- [x] base files: README, LICENSE, CONTRIBUTING, issue templates, .github/public-repos.txt, .gitignore, ruff.toml
- [x] scripts/leak-check and tests/test_leak_check.py
- [x] .github/workflows/ci.yml
- [ ] mutation wave, fresh-context review, session leak-check run
- [ ] branch pushed, PR open, CI green on the PR
(4 of 6 done)

## Decisions made (and why)
- gitleaks pinned to 8.28.0 with the SHA-256 from its official checksums file - reproducible CI, a swapped download fails the step.
- gitleaks positive control: no ERR/FTL line and 0 < "N commits scanned" <= non-merge commits in range - live runs of gitleaks 8.28.0: a bad revision gives an ERR line, "0 commits scanned" and exit 0; only commits that add content are counted (an empty, delete-only, rename-only or mode-only commit counts 0), so an exact count match would give false reds.
- Tests replace gitleaks with a stub - they stay hermetic; the real gitleaks runs in the CI leak check step and in the session run.
- Tests run the script under the C locale with Python UTF-8 mode off - on a UTF-8 machine the "remove explicit UTF-8" mutation could not go red otherwise.
- ruff.toml includes scripts/leak-check by name - ruff skips files without `.py` (proven: without it an unused import passed).
- CI installs ruff into a venv with the runner's python3 - no extra setup action.
- The patch scan covers added and removed lines - removed lines are visible on the public PR page too.
- Tracked file paths are scanned as well; a matching path is replaced by "tracked file #N (name hidden)" in the output.

## Where we stopped
Files written, tests and ruff green locally. Next: commit, mutation wave, reviewer, session leak-check run, push, PR.

## Known issues / traps
- PRs from forks do not get repository secrets, so their pattern scan reports "did not run" (red). The owner decides the policy for external PRs before launch.
- gitleaks honours `.gitleaks.toml`, `.gitleaksignore` and `gitleaks:allow` from the scanned repository; `.github/public-repos.txt` is read from the PR head. A PR touching any of these can weaken the check (see ARCHITECTURE.md traps).
