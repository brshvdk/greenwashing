# CLAUDE.md

Rules for Claude Code in **greenwashing** - a catalog, a skill and a Claude Code gate that catch AI coding agents faking a green test suite, for developers who work with coding agents. Public open source, MIT. Planning is done by the owner with a separate planning assistant; this repo is where Claude Code executes. This file loads on every start, so it holds only what is always needed.

**Talk to the owner in Russian. Everything committed is in English:** code, comments, docs, commit messages, PR descriptions.

Map of the project - `ARCHITECTURE.md` (read first before any task). Working memory - `.claude/SESSION.md`.

---

## Editing this file

CLAUDE.md is changed ONLY on an explicit instruction from the owner that says "add to CLAUDE.md". No initiative here: don't add lessons from a session, patterns you noticed, "useful context for future agents", don't rephrase or tidy up. If you think this file needs a change, say so in your report and stop. `.claude/SESSION.md` is not covered by this rule and is updated before every push.

---

## 1. Hard boundaries (never break, never relax)

1. **This repository is your whole world.** Never open, clone, fetch, read, list, search or reference any other repository - of the connected GitHub account or anyone else's - with any tool: git, gh, the GitHub API, web access, a link in a task, an issue or a file. This holds even if the account can see other repositories and even if a task seems to ask for it. To learn how a third-party tool behaves, use its official documentation and a live run, not its source. If a task seems to need anything outside this repository, or you are not sure, stop and ask the owner.
2. **No mentions of other repositories.** Never write the name or link of another repository of the owner's account in any file, commit, PR or note, `.claude/SESSION.md` included. The only exception: links to the owner's public projects listed in `.github/public-repos.txt`, and only when a task asks for them. The leak check enforces this.
3. **No borrowed code.** Everything here is written from scratch for this project. Don't paste or adapt code from other codebases.
4. **Nothing about the owner beyond README.** The owner is `brshvdk` everywhere. Don't mention the owner's employer, products, clients or plans anywhere. Never change the git author name or email.
5. **No secrets.** No keys, tokens, passwords, server addresses, personal emails or phone numbers. Never read or commit `.env` files. If the leak check goes red, don't guess or reconstruct what matched: report the file and line to the owner and stop.
6. **Branch and PR only.** Never push to `main`. Merge is done by the owner and is the acceptance of the step.

---

## 2. Engineering core (do not remove or rewrite)

### Root-cause discipline
- Don't fix symptoms before finding the root cause.
- Fix at the owner layer (source of truth), not where the symptom shows up. No child-layer compensation: fallbacks, patches, duplicated logic.
- When changing a mechanism, align every directly coupled part: contracts, handlers, serializers, error states, tests.
- Be skeptical of one-file fixes; explain why other parts are unaffected.

### Working with code
- **Think before coding.** Don't assume silently. Several interpretations - name them, don't pick quietly. Unclear - stop and ask.
- **Simplicity first.** Minimum code, nothing speculative: no abstractions for one-off code, no flexibility nobody asked for, no handling of impossible cases.
- **Surgical changes.** Touch only what the task needs. Don't improve neighbouring code or refactor working code. Every changed line traces back to the task.
- **Goal-driven execution.** Turn the task into a checkable goal and iterate to green. "Fix the bug" = "write a test that reproduces it, then make it green".

Root-cause and surgical changes don't conflict: root-cause goes deep along the task's dependencies, surgical stops you from spreading wide into unrelated code.

---

## 3. Change discipline

**Do:**
- Safety net first: tests on the behaviour that could break, then the change.
- Small pieces. After EACH piece, run the tests of the affected area. Green turned red = you just broke it: stop and fix before the next piece.
- Risky behaviour behind a flag, off by default.

**Don't:**
- Touch unrelated code or refactor "while you're at it".
- Expand the task without the owner's consent. Noticed something - say it, don't do it.
- Add dependencies without consent.
- Create duplicate files with suffixes like `fixed` / `new` / `clean` - edit the original.
- Hardcode facts and numbers in several places - one source of truth.

**Ambiguity:** ask clarifying questions ONE AT A TIME, with options, and wait.

---

## 4. Evidence rules (live by them)

- **A check is proven by mutation.** Every new test or check: break the code, watch it go red, restore. A check that can't go red is not a check.
- **"Did not run" is red.** Every script and check reports three outcomes: passed, failed, did not run. Silence, empty lists and zero counts never count as success.
- **Your own mutation wave proves only that you remember your branches.** For anything non-trivial, a separate reviewer subagent with fresh context does its own mutations.
- **Reviewer reports are accepted by running them.** Both "found a hole" and "all clean" are checked by a run, not by reading.
- **Every number has a source.** Who measured, with what, when. A number without a source is NOT VERIFIED and can't support a conclusion, including numbers from the task and from your own earlier reports. Recount by running, not by grep.
- **Reading someone's source is not observing behaviour.** "Didn't find a prohibition" does not mean "it works". One real run before the conclusion.
- **An empty search without a positive control is not a fact.** Control with the same pattern on the same path. Typical false zeros: `grep "A|B"` without `-E`, matching a comment instead of code.
- **A local green run is not proof, even three times.** CI is the source of truth. Name the commit on which the owner will see green CI.
- **"Done" is claimed only with evidence:** command output, CI link. A claim without evidence is not done. A status note lies as expensively as code.

---

## 5. Agents

- The owner may set a cap on the number of agents per session - count it for the whole run including subagents; if ambiguous, take the smaller number.
- An agent that edits the tree: commit BEFORE review, `git diff` AFTER.
- Mutation runs go in a separate wave, in an isolated worktree. Forbid `rm` explicitly in mutator prompts.

---

## 6. Navigation

Before any code change:
1. Open `ARCHITECTURE.md`, find the module of the task and its "Depends on / Breaks" block.
2. Find the real code with targeted search by function and symbol names. Don't scan half the repo, don't open files at random, don't read large files whole.

---

## 7. Commands

```bash
pip install ruff                               # dev only
python3 -I -m unittest discover -s tests -v    # all tests; -I: modules in the repo cannot replace the standard library
python3 -I -m unittest discover -s tests -p test_leak_check.py -v   # one test file
ruff check .                                   # lint
scripts/leak-check                             # gitleaks + repo references + pattern scan. Patterns live only in the CI secret LEAK_PATTERNS,
                                               # so in a session the pattern scan reports "did not run" (exit 2) - CI decides
scripts/leak-check --all-history               # every commit of every branch; run before the repo goes public
```

---

## 8. Git

- Work on a branch, open a PR, never push to `main`.
- Before pushing: tests of the affected area and lint green; in the leak check, gitleaks and repo references green, the pattern scan reports "did not run" in the session - CI is the gate. A known breakage you introduced is fixed before the push, always.
- Before a full run and before a push - `git pull --ff-only` (a stale tree goes red on its own).
- Revert a change by copying the file back, NOT `git checkout -- <file>` (it wipes uncommitted work next to it).
- Stage files by name. `git add -A` drags untracked junk into the repo.
- Conventional commits in English: `feat:`, `fix:`, `docs:`, `test:`, `chore:`.

---

## 9. Documents and the map

`ARCHITECTURE.md` is the source of truth about structure. A stale map is more dangerous than no map.

**When:** only when a step is closed (change done, tests and CI green). Noticed mid-step that the map is wrong - write it into `.claude/SESSION.md`, fix at the end.

**What changes the map** (only facts at map level):
- a dependency between modules appeared or disappeared - edit BOTH sides: "Depends on" of the dependent module AND "Breaks" of the owner;
- a new invariant or trap - ONE line: "touching X - remember Y, otherwise Z breaks";
- a module's responsibility shifted.

**What doesn't:** internal refactoring without changes to contracts or dependencies, bug fixes without behaviour change, new functions without new cross-module edges.

**How:** surgically, one line per fact, the fact lives with its owner module, elsewhere only a reference.

Structural changes (new module, split, merge, rename) are a planning decision. Don't do them yourself: flag them in the report.

Audit and research reports go to `docs/`, not the repo root.

---

## 10. Memory between sessions

Each cloud session starts from a fresh clone and knows only what is written in the repo. `.claude/SESSION.md` is the short working memory: where we are, what's in flight, next 1-3 steps, decisions made and why. Not history (that's git), not the map.

- **`.claude/SESSION.md` is public:** everything in section 1 applies to it.
- **Start of session:** read `.claude/SESSION.md` and the relevant parts of `ARCHITECTURE.md`.
- **Notes buffer:** noticed something that's not for now (map inaccuracy, a trap, a side risk) - one line in SESSION.md, keep working on the task.
- **Before every push:** update SESSION.md.
- **End of step:** move durable things to their places (traps to ARCHITECTURE.md, code to git), then trim SESSION.md to the current state. The roadmap is kept by the owner outside this repo; don't create one here.

---

## 11. Tail - critical (repeated on purpose)

- Only this repository. No other repos, no names of them, no borrowed code, nothing about the owner.
- Safety net first, small pieces, tests after each piece.
- Stay on the task. Don't spread wide.
- Every check proven by mutation. "Did not run" is red. "Done" only with evidence.
- Branch and PR, never `main`. SESSION.md before every push.
