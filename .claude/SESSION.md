# SESSION

## Current step
Step 1, PR 2 - the catalog: `CATALOG.md` (text from the owner, verbatim) and `tests/test_catalog.py` (structure). Guarded files untouched, so "Safety net" must be green on this PR (second half of the live check of the net).

## Progress
- [x] `CATALOG.md` as given (two independent transcriptions diffed identical; Markdown sanity script: no odd backticks, stray emphasis, trailing spaces or non-ASCII)
- [x] `tests/test_catalog.py`: headings, unique and ascending numbers, the three lines in order and not empty, sections A-H with entries, no entry outside them; one mutant of the real catalog per rule
- [x] README line, ARCHITECTURE.md module `CATALOG.md`
- [x] own mutation wave (worktree): 25 catalog mutants red, 2 controls green, 17 checker mutants red; one survivor found and fixed (a first entry of a section with a `####` heading vanished)
- [x] fresh-context reviewer: Markdown renders clean (remark), no leaks found; 17 catalog survivors and 5 checker survivors, each re-run and confirmed, then fixed (see decisions)
- [x] mutation wave 3 on 117aeeb: 37 catalog mutants red, 5 controls green (CRLF, blank line inside an entry, closing `###`, reworded text, unchanged), 36 checker mutants red, 0 did not run; `&nbsp;` as a value stays green (known limit, in the map)
- [x] PR #5 open; at 28d015e `checks`, `leak-check` and "Safety net" all green
- [ ] CI green on the latest commit
(5 of 6 done)

## Decisions made (and why)
- Catalog test: one checker `problems(text)` returns (rule, where); the real catalog must give `[]`, and each mutant built from the real text by position (first or last entry, never a named number) must give exactly its one rule (GW-12, GW-13). `SECTIONS` and `FIELDS` are the only fixed facts; the entry count comes from the catalog alone.
- Entry lines with no `###` heading above them start an entry without a heading ("bad heading"): otherwise a broken heading on the first entry of a section made the entry vanish and the test stayed green (found by the own mutation wave).
- README line is its own paragraph (blank line before it), otherwise Markdown joins it to the tagline.
- After the review, the checker follows Markdown, not Python: lines end only at CRLF, CR, LF (`str.splitlines` also splits on U+2028, U+0085, form feed); outside entries, markup that hides or moves entries once rendered is reported (indented or quoted lines, HTML, fences, other headings, setext underlines); numbers are ASCII in one form (`\d` took fullwidth digits, `GW-0016` passed); a title or line needs an ASCII letter or digit (a zero-width space or `<!-- -->` passed). Inline HTML such as `&nbsp;` still passes: a full renderer would be a dependency.
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
Review findings fixed, map updated. Next: CI green on the latest commit, then the owner's merge.
Next step after this PR: PR 3 - the skill.

## Known issues / traps
- PRs from forks do not get repository secrets, so their pattern scan reports "did not run" (red). The owner decides the policy for external PRs before launch.
- `tests/` and `scripts/` are not guarded as a whole (owner decision): a new test module can still disable assertions, and a `tests/json.py` still replaces `json` under `-I` (discover puts `tests/` first on `sys.path`); the project's own gate closes this later.
- Open, owner decision: `# ruff: noqa`, `# flake8: noqa` and a `# ruff: disable[...]` range hide code from ruff (proven by runs); `--ignore-noqa` in CI closes all three (the repo has no `noqa` today).
- Open, owner decision (review 1d, each proven by runs and confirmed by two refuters): a `.gitattributes` is not guarded; config and instruction files of other agents and editors are not guarded; a `.rgignore`/`.ignore` hides files from ripgrep (the agent's own search); a submodule (`.gitmodules` + gitlink) brings in a `CLAUDE.md` the file list never shows; ruff's default excludes (`dist/`, `_build/`, `node_modules/`) hide test modules that still run; a `# -*- coding: utf-7 -*-` file hides executed code from ruff; the Lint step has no did-not-run guard; the case-insensitive match makes an ordinary `docs/agents.md` red.
- gitleaks skips files by image name in its default config; a fake image is reported as did not run instead.
