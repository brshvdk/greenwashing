# The greenwashing catalog

Ways a test suite goes green without the code being right. Collected from months of running AI coding agents on a production codebase. Every entry is a pattern that actually happened. The examples here use neutral code, and the numbers are illustrative.

IDs are stable and never renumbered. Gaps between sections are on purpose.

## How to read an entry

- **Looks like** - what you see: a green suite, a "done" report, a passing check.
- **Why it's green** - the mechanism that makes it pass while being wrong.
- **Catch it** - the check that turns it red. A check is a mechanism, not a request to the agent.

## The rules behind the catalog

1. **A check is proven by mutation.** If you can't break the code and watch the check go red, it is not a check.
2. **Absence of a signal is not a good signal.** "No errors" often means "nothing ran". Silence, empty lists and zero counts are failures until proven otherwise.
3. **The executor doesn't accept its own work.** Done means an independent run, a query against the real system, a green CI or a human looking at the result.
4. **Your own mutation wave is not proof.** The agent that wrote the tests picks mutations its tests catch. An independent reviewer finds the survivors.
5. **Put the net where everyone passes.** A check that works only if the agent follows instructions is skipped exactly when it matters.
6. **Instructions don't fix defects.** An instruction is a request, a check is a mechanism. When a defect repeats, the fix is code or a gate.
7. **Every honesty fix needs a test for the honest case.** A fix that stops fake success tends to break real success. Test both sides.
8. **A note lies as expensively as code.** "Step closed", a changelog line, a comment saying "verified" - all of these are claims that need evidence.

## A. Tests that cannot go red

### GW-01 Self-referential assertion
- **Looks like:** `expect(result.limit).toBe(config.limit)`.
- **Why it's green:** expected and actual come from the same place. If both are `undefined`, it passes.
- **Catch it:** expected values are literals or come from an independent source. Delete the config field: the test must fail.

### GW-02 Guard test that is green without the guard
- **Looks like:** a test named "rejects oversized input" passes.
- **Why it's green:** the input is rejected earlier by something else, or never reaches the guard.
- **Catch it:** remove each guard one at a time and rerun. If nothing goes red, the test protects nothing.

### GW-03 Asserting the new instead of the absence of the old
- **Looks like:** after a rename, the test checks that the new name exists.
- **Why it's green:** the old path is still there and still used.
- **Catch it:** assert that the old thing is gone, not only that the new one appeared.

### GW-04 A fixture where the difference cannot exist
- **Looks like:** an ordering test on a list of one; a "per-user" test with one user.
- **Why it's green:** first equals last, "mine" equals "all". "Always take item 0" passes everything.
- **Catch it:** fixtures contain the distinction under test: at least two or three distinct items in a non-trivial order.

### GW-05 A counter that can only read zero
- **Looks like:** `expect(freeSlots()).toBe(0)` to prove "all slots are busy".
- **Why it's green:** "slot dead" and "slot busy" both give zero. The test could not fail.
- **Catch it:** assert on the state you mean, not on a number that collapses several states into one.

### GW-06 Pinned words, not their relationship
- **Looks like:** a test checks that a query contains `DELETE`, `WHERE` and `user_id`.
- **Why it's green:** `DELETE FROM t; -- user_id WHERE` keeps every word. "Delete everything" passes.
- **Catch it:** run the query against a real or in-memory engine and check the effect.

### GW-07 Iterating over the fields you already declared
- **Looks like:** `for (const f of expectedFields) expect(obj[f]).toBeDefined()`.
- **Why it's green:** a field you forgot to list is never checked. A whole flag can disappear.
- **Catch it:** compare the full shape (a snapshot of keys, schema validation), not a hand-picked list.

### GW-08 "0 of 0 problems"
- **Looks like:** a report shows zero problems found, in green.
- **Why it's green:** an empty evidence list renders as success.
- **Catch it:** an empty set where you expected items is a failure. Require a minimum count.

### GW-09 One-direction threshold test
- **Looks like:** a threshold test that catches "too high".
- **Why it's green:** nothing checks "too low", so the opposite mutation always passes.
- **Catch it:** test both directions, or assert an invariant over data instead of a one-sided predicate.

### GW-10 An absence test with no presence anchor
- **Looks like:** "no error events emitted" passes.
- **Why it's green:** no events are emitted at all, including the normal ones.
- **Catch it:** in the same test, assert that expected events do appear. Kill the whole event stream: the test must go red.

### GW-11 A mutation survives because the values are equal
- **Looks like:** the test claims to catch swapped arguments.
- **Why it's green:** the fixture uses `(5, 5)`.
- **Catch it:** fixture values differ wherever the code could confuse them.

### GW-12 One bad input that breaks five rules guards none
- **Looks like:** one "invalid input" fixture that violates five rules at once.
- **Why it's green:** remove any single rule and the input is still rejected by the others.
- **Catch it:** one fixture per rule, each violating exactly one.

### GW-13 A check run in one direction only
- **Looks like:** "I ran it on the broken version and it failed, so it works."
- **Why it's green:** that proves it can go red, not that it goes green on correct code, or the other way round.
- **Catch it:** run every check on a known-good and a known-bad input.

### GW-14 A substring the tool prints on its own
- **Looks like:** the test greps the output for an expected string.
- **Why it's green:** the tool prints that string itself, inside its error message.
- **Catch it:** match structured output, exit codes and effects, not substrings.

### GW-15 Listing the forbidden cases by name
- **Looks like:** a test rejects `rm -rf`, `DROP TABLE` and three other known-bad inputs.
- **Why it's green:** the sixth variant passes.
- **Catch it:** test the rule (a property, an allowlist), not a list of examples.

### GW-16 A branch with no case at all
- **Looks like:** code handles "missing name", but no fixture ever produces one.
- **Why it's green:** the branch never runs, and file-level coverage still looks fine.
- **Catch it:** branch coverage on changed lines, and a fixture per branch.

## B. Test doubles that lie

### GW-20 A mock without the exports the code needs
- **Looks like:** a test passes with a "graceful" error message.
- **Why it's green:** the mock lacks a function, the code throws before reaching the branch under test, and the fallback text happens to match.
- **Catch it:** assert which branch ran, not only the final message. Fail on unexpected errors.

### GW-21 The test double lies about the platform
- **Looks like:** dozens of green tests over a route.
- **Why it's green:** the stub behaves the way you think the platform works. The real platform behaves differently.
- **Catch it:** at least one test per seam against the real thing: a container, a local instance, a recorded real response.

### GW-22 Both sides of the seam mocked toward each other
- **Looks like:** a test counts calls across a component boundary.
- **Why it's green:** caller and callee are both mocked to agree. The test proves the mocks agree.
- **Catch it:** never mock both sides of one seam in one test. One integration test with real wiring.

### GW-23 Stubs that answer instantly
- **Looks like:** race conditions and timeouts are "covered".
- **Why it's green:** with zero latency the race never opens and timeouts never fire. Set any timeout to 1 ms and the suite stays green.
- **Catch it:** stubs with realistic and adversarial delays. Changing a timeout must turn something red.

### GW-24 One stub for every creation call
- **Looks like:** "three clients created" passes.
- **Why it's green:** all three share one underlying object. "Two clients on one connection" is invisible.
- **Catch it:** stubs return distinct instances; assert identity.

### GW-25 The mock throws, the real client returns an error
- **Looks like:** error handling is tested with `mockRejectedValue`.
- **Why it's green:** the real client never throws, it returns `{ error }`. The `catch` block is dead code in production.
- **Catch it:** check the real client's error contract and test with the shape it actually returns.

### GW-26 A fixture built in code, not taken from the real producer
- **Looks like:** a parser test on a generated file.
- **Why it's green:** writing and reading back normalizes away the exact shape that breaks the parser. Real files still fail.
- **Catch it:** keep a corpus of real files from the real upstream tool.

### GW-27 A mock with only one layer
- **Looks like:** the "reject" branch of a validator is covered.
- **Why it's green:** the mock returns success at the first layer, so the negative branch deeper down is unreachable.
- **Catch it:** mocks that can fail at every layer the code checks, and a test per layer.

### GW-28 A cache warmed by the neighbors
- **Looks like:** a cache test passes.
- **Why it's green:** earlier tests already filled the keys.
- **Catch it:** isolate state per test; run tests in random order.

## C. Checking the wrong thing

### GW-30 Presence instead of function
- **Looks like:** "the button exists" is tested.
- **Why it's green:** the button renders, but clicking it does nothing, or it already worked before the change.
- **Catch it:** test the action and its effect.

### GW-31 Tests guard a path production no longer takes
- **Looks like:** thorough tests on the old contract.
- **Why it's green:** the live code moved to a new path; the tests still exercise the old one.
- **Catch it:** trace the production entry point to the code under test; delete tests for dead paths.

### GW-32 Checking the file, not the system
- **Looks like:** "migration applied" because the migration file has the right column names.
- **Why it's green:** the names also appear in a comment; the database was never touched.
- **Catch it:** query the live system. Repository contents are not facts about production.

### GW-33 One copy guarded, the twin ships
- **Looks like:** a fixed string or rule has a test.
- **Why it's green:** the same text lives in another module, unguarded, or the test checks one piece, not the assembled output.
- **Catch it:** search for duplicates; test the final assembled artifact.

### GW-34 Wait for one thing, assert another
- **Looks like:** an end-to-end test waits for a label, then asserts a button.
- **Why it's green:** between the two there are zero elements, and the assertion passes vacuously or races.
- **Catch it:** wait and assert on the same condition.

### GW-35 The uncovered seam between producer and consumer
- **Looks like:** parser tests green, comparison tests green.
- **Why it's green:** the parser never calls the comparison, and the comparison gets data that bypasses the parser. A bug in between passes everything.
- **Catch it:** one test through the real seam.

### GW-36 A text guard parses differently than the executor
- **Looks like:** a hook that blocks dangerous shell commands by matching their text.
- **Why it's green:** quoting, line continuations and path tricks: the shell sees something the guard didn't.
- **Catch it:** guard at execution, not by reading text. If you must read text, use the executor's own parser.

### GW-37 A grep that misses the real spelling
- **Looks like:** a check counts `status=fail` lines and reports zero failures.
- **Why it's green:** the tool logs `status=FAILED`. The pattern never matches, and zero reads as clean.
- **Catch it:** parse structured fields; add a positive fixture that must match.

### GW-38 A grep that finds its own trace
- **Looks like:** a search confirms a problem exists.
- **Why it's green:** the search string is your own wording, printed by your own code.
- **Catch it:** search for the effect, not for words you wrote.

### GW-39 A coarse grep reports "applied"
- **Looks like:** a check confirms a change is in place by finding a pattern.
- **Why it's green:** the pattern existed before the change.
- **Catch it:** diff before and after, or check a value only the change could produce.

### GW-40 Testing the command text instead of the command
- **Looks like:** a cleanup command is tested by checking its string.
- **Why it's green:** the command is a program. Many changes alter what it does and keep the tested substrings.
- **Catch it:** run the command in a throwaway environment and check the result.

## D. Reports that lie

### GW-50 "Not checked" reported as "disproved"
- **Looks like:** a probe prints green: "hypothesis rejected".
- **Why it's green:** the check never ran, or the action never happened.
- **Catch it:** every check reports three outcomes: passed, failed, did not run. "Did not run" is red.

### GW-51 Success reported for an unverified operation
- **Looks like:** an endpoint returns `ok: true`, and the log records success.
- **Why it's green:** nobody read the result back. The log now holds a false record.
- **Catch it:** read back the result before reporting it.

### GW-52 "Confirmed" by any successful response
- **Looks like:** a summary says "confirmed".
- **Why it's green:** the flag is set by any normal completion, including zero effect.
- **Catch it:** confirm by the effect itself (rows changed, file written), not by the response status.

### GW-53 An async start reported as completion
- **Looks like:** "reset done".
- **Why it's green:** the call was not awaited; the reset only started.
- **Catch it:** report what you know: "reset started". Await or poll before "done".

### GW-54 The fix that looks done and does nothing
- **Looks like:** a retry option added for a failing case.
- **Why it's green:** with a limit of one attempt, the retry can never happen.
- **Catch it:** a test that exercises the new behavior, not the existence of new code.

### GW-55 A confident wrong answer
- **Looks like:** a detailed diagnosis with a clear verdict.
- **Why it's green:** the experiment never observed the symptom it explains. For an agent, a confident answer beats "unknown".
- **Catch it:** ask "which observation shows this?" before accepting any verdict.

### GW-56 Claims about an environment nobody looked at
- **Looks like:** "production doesn't have this setting".
- **Why it's green:** it was inferred from example files in the repository.
- **Catch it:** facts about a live environment come from that environment.

### GW-57 Reading the source is not watching it run
- **Looks like:** "the library doesn't block this, I checked the code".
- **Why it's green:** not finding a prohibition doesn't mean it works.
- **Catch it:** one live run before the conclusion.

### GW-58 Certainty about someone else's behavior
- **Looks like:** "a false alarm is impossible here".
- **Why it's green:** an untested assumption; the first real run disproves it.
- **Catch it:** treat third-party behavior as a hypothesis until observed.

### GW-59 The label is stronger than the evidence
- **Looks like:** a result tagged `cause=network` blames the network.
- **Why it's green:** the check behind the tag verifies nothing.
- **Catch it:** every label points to the observation that produced it.

### GW-60 One verdict for several failures
- **Looks like:** "the backend didn't respond".
- **Why it's green:** several different failures collapsed into one line. It's an opinion, not an observation.
- **Catch it:** separate outcomes per mechanism.

### GW-61 A harness that can't tell three outcomes apart
- **Looks like:** a mutation run reports a perfect score.
- **Why it's green:** "the run didn't happen" was read as "red", so every mutant looked killed.
- **Catch it:** distinguish passed, failed and errored. Errors never count as kills.

### GW-62 "Passes locally, three times"
- **Looks like:** the agent reports a green local run, repeated.
- **Why it's green:** CI differs in cores, file layout, locale and tools.
- **Catch it:** CI is the source of truth; reproduce CI conditions.

### GW-63 The status note lies
- **Looks like:** "step closed" in the session notes.
- **Why it's green:** the step is not closed; a recheck finds the recorded facts false.
- **Catch it:** status claims need the same evidence as code (rule 8).

## E. Instruments and metrics that lie

### GW-70 An instrument blind to its own case
- **Looks like:** a safety check that never fires.
- **Why it's green:** in exactly the case it was built for, its input is empty and it skips.
- **Catch it:** test the instrument on its own target case.

### GW-71 Data leaking from the previous attempt
- **Looks like:** a retry reports the right reason.
- **Why it's green:** the field kept the value from the previous attempt.
- **Catch it:** reset per-attempt state; assert fresh values.

### GW-72 A state gauge blind to events
- **Looks like:** a failure counter shows zero.
- **Why it's green:** the counter resets on success, so intermittent failures never add up.
- **Catch it:** count events, not state.

### GW-73 A signal read as more than it proves
- **Looks like:** the log says "job cancelled", so the job counts as stopped.
- **Why it's green:** the line proves a cancel was sent, not that the job stopped. Only a status check proves it is gone.
- **Catch it:** state what each signal actually proves.

### GW-74 An unnamed denominator
- **Looks like:** "1% error rate".
- **Why it's green:** the denominator is health-check pings, not user requests. The real rate is several times higher.
- **Catch it:** publish every rate with what it is divided by.

### GW-75 Averaging hours into a day
- **Looks like:** a daily rate computed as the mean of hourly rates.
- **Why it's green:** hours have different traffic.
- **Catch it:** sum numerators and denominators, then divide.

### GW-76 A free field that is dead
- **Looks like:** a breakdown by a field that "comes for free".
- **Why it's green:** the field is `-1` in every record.
- **Catch it:** check that a signal exists and varies before building on it.

### GW-77 Someone else's number presented as yours
- **Looks like:** a test inside a container reports the machine's total memory.
- **Why it's green:** the value comes from the host, not the container.
- **Catch it:** every number carries its owner.

### GW-78 Your own default mistaken for an external limit
- **Looks like:** "the API times out after 30 seconds".
- **Why it's green:** 30 seconds is your HTTP client's default that nobody overrode.
- **Catch it:** before blaming a limit, search your own config and your dependencies' defaults.

### GW-79 A schema that promises fields nobody fills
- **Looks like:** a log schema with duration and memory fields.
- **Why it's green:** zero records have them filled.
- **Catch it:** assert the fill rate on real data.

### GW-80 Wrong units
- **Looks like:** a guard limits input length in characters.
- **Why it's green:** the limit it protects counts bytes.
- **Catch it:** measure in the units of the limit you protect.

### GW-81 Silent truncation
- **Looks like:** a log shows 20 permission errors.
- **Why it's green:** `head -20` hid the rest without a marker.
- **Catch it:** always print "N more omitted".

### GW-82 An instrument that judges by how it was called
- **Looks like:** a reference value built from the tool's own environment.
- **Why it's green:** the result depends on the flags of whoever launched it.
- **Catch it:** reference values come from outside the process under test.

### GW-83 No votes read as "rejected"
- **Looks like:** a review summary says "disproved".
- **Why it's green:** `[].some(...) === false` - nobody voted.
- **Catch it:** empty input is its own outcome, never a verdict.

### GW-84 Verified with the same blind tool
- **Looks like:** a verification step confirms a transformation.
- **Why it's green:** it uses the same parser that did the transformation, so it shares the bug.
- **Catch it:** verify through an independent path.

### GW-85 A scope narrower than the reader thinks
- **Looks like:** "mismatch counter: 0".
- **Why it's green:** it counts one of several paths.
- **Catch it:** write the scope next to the number.

### GW-86 Your own timeout read as their refusal
- **Looks like:** a latency chart with a wall at exactly 10 seconds.
- **Why it's green:** that is your own client timeout cutting calls off, and the evidence of what the server did is gone.
- **Catch it:** mark self-inflicted terminations distinctly.

### GW-87 A positive control that doesn't move the target
- **Looks like:** a control run that "passes".
- **Why it's green:** it doesn't vary the one thing it was meant to detect.
- **Catch it:** the control must move the quantity it controls.

## F. Environment and time

### GW-90 A time-bomb fixture
- **Looks like:** a fixture "one hour ago" and a grouping by "yesterday".
- **Why it's green:** it passes whenever the suite runs after 1 am. Between midnight and 1 am, "one hour ago" is yesterday and the test fails.
- **Catch it:** freeze time; run with clocks around boundaries.

### GW-91 Green depends on the installed tools
- **Looks like:** shell scripts red in CI three times in a row, green on the laptop.
- **Why it's green:** awk dialects, buffering, `grep -q` with `pipefail`.
- **Catch it:** pin tools or use portable constructs; test on the CI image.

### GW-92 Non-ASCII search depends on locale
- **Looks like:** a check that searches for non-Latin text is always green.
- **Why it's green:** under some locales the pattern matches nothing.
- **Catch it:** set the locale explicitly; add a positive fixture that must match.

### GW-93 Green by weather
- **Looks like:** an integration test that calls a real external service passes today.
- **Why it's green:** it depends on that service being up.
- **Catch it:** fail tests that reach the network unexpectedly; count uncovered network calls.

### GW-94 Addressing by position in a list that gets reversed
- **Looks like:** "the last rule" is taken as the newest.
- **Why it's green:** the API prepends, so the last one is the oldest.
- **Catch it:** address by identity, not position; check the ordering in the docs and in a live run.

### GW-95 A check that dies exactly on the healthy case
- **Looks like:** a shell probe that reports failures fine.
- **Why it's green:** on the success path a construct silently kills the script, so "no output" looks like success.
- **Catch it:** explicit success output; run on the target shell.

## G. Fixes that lie

### GW-100 The honesty fix that lies inside out
- **Looks like:** a fix that stops the agent from claiming success.
- **Why it's green:** it now blocks real successes too.
- **Catch it:** rule 7 - a paired test for the honest case.

### GW-101 The error handler calls what it protects against
- **Looks like:** an error handler logs `repr(obj)`.
- **Why it's green:** `__repr__` raises again, and the handler itself crashes.
- **Catch it:** handlers don't run untrusted code; test the handler with a hostile object.

### GW-102 Removing a condition removes a side protection
- **Looks like:** a simplified threshold.
- **Why it's green:** the old condition also prevented double counting.
- **Catch it:** before removing a condition, list everything it guarded.

### GW-103 Half a fix
- **Looks like:** the fix is applied to one of two call sites.
- **Why it's green:** the twin still ships the bug.
- **Catch it:** search all call sites; one test per site.

### GW-104 Code changed, the config template didn't
- **Looks like:** a default flipped to OFF in code.
- **Why it's green:** the example config files still ship ON, so real deployments stay ON.
- **Catch it:** change the code, every config template, and verify the live value.

### GW-105 Classification built on the wrong axis
- **Looks like:** "did the agent mean to change something" derived from the task type.
- **Why it's green:** many actions fit no category and fall through.
- **Catch it:** derive the signal from the thing itself (the actions taken), not from a proxy.

## H. CI that lies

Found by independent reviewer agents while building this repository's own CI.

### GW-110 A pipe swallows the exit code
- **Looks like:** `pytest | tee test.log` in a CI step, and the step is green.
- **Why it's green:** without `pipefail` the step gets the exit code of `tee`, not of the tests. GitHub Actions runs `run:` steps without `pipefail` unless you set `shell: bash`.
- **Catch it:** no pipes on the test command, or `set -o pipefail`. Make one test fail on purpose: CI must go red.

### GW-111 A file in the repo replaces the standard library
- **Looks like:** `python -m unittest` prints `OK`.
- **Why it's green:** a `unittest/` folder or a `json.py` in the project shadows the real module, and nothing ran.
- **Catch it:** run tools in isolated mode (`python -I`) and fail when zero tests ran.

### GW-112 A scanner that scanned nothing exits 0
- **Looks like:** a secret scan reports "no leaks found".
- **Why it's green:** given a bad revision range, it logged an error, scanned 0 commits and exited 0 (seen with gitleaks 8.28.0).
- **Catch it:** a positive control on what was scanned: "0 scanned" is red.

### GW-113 The pull request edits the check that judges it
- **Looks like:** every check on the PR is green.
- **Why it's green:** `pull_request` workflows run from the PR's own branch, so the PR can weaken or delete its own gate.
- **Catch it:** run the guard from the base branch (`pull_request_target`, without checking out PR code) and flag any change to the checks themselves.

### GW-114 The checked code configures its checker
- **Looks like:** the linter and the secret scanner are clean.
- **Why it's green:** a nested `.gitignore`, a `ruff.toml` in a subfolder, a `.gitleaksignore` or a `gitleaks:allow` comment inside the change told the tools to look away.
- **Catch it:** run checkers with config from outside the checked tree, and guard config files.

### GW-115 The allowlist is read from the change it guards
- **Looks like:** an allowed-names check passes.
- **Why it's green:** the allowlist file is read from the PR itself, so the PR can allow its own exception.
- **Catch it:** read allowlists from the base branch.
