---
name: greenwashing
description: Use before you report that a coding task is done, that tests pass, or that a bug is fixed. Stops a green test suite from standing in for working code - tests that cannot fail, checks that never ran, mocks that only agree with each other - and makes the report show evidence instead of claims.
---

# greenwashing

A green suite is a claim, not proof. Before you say "done", make the claim checkable.

## Before you report "done"

1. **Run the checks yourself, now.** Run the project's test command in this session and read the output. In your report, quote the command and the summary line: how many tests ran, passed, failed and were skipped. Never report a result you did not see.
2. **"Did not run" is not green.** Zero tests, "no tests found", a crashed runner, a timeout or a command you could not run is its own outcome. Report it as "did not run", never as "passed" (GW-08, GW-50).
3. **Prove each new or changed test can fail.** Break the code it protects - remove the guard, flip the condition, return a constant - and run the test. It must fail. Then restore the code. Report the mutation and the test that failed. A test that stays green protects nothing: fix the test, not the report (GW-02).
4. **Don't buy green.** Don't add `.skip`, `.only`, `xit`, `xfail`, `@pytest.mark.skip` or commented-out tests. Don't loosen assertions, widen tolerances or delete checks to make a test pass. If an expectation was wrong, say why in the report.
5. **Expected values come from outside the code under test.** Use literals or the spec, never the object you are testing (GW-01).
6. **Fixtures must contain the difference under test.** Use at least two distinct items, and different values wherever arguments could be swapped (GW-04, GW-11).
7. **Mock honestly.** Never mock both sides of one seam (GW-22). Mock the real error contract: if the client returns `{ error }`, don't make the mock throw (GW-25).

## How to report

- Every check gets one of three outcomes: passed, failed, did not run.
- Separate what you observed from what you assume. Say "not verified" instead of guessing (GW-55).
- A local green run is not CI. If the project has CI, say that CI has not run yet (GW-62).
- If the change has no behavior to test (docs, comments, formatting), say so instead of inventing a test.

## Full catalog

Ways a test suite goes green without the code being right: https://github.com/brshvdk/greenwashing/blob/main/CATALOG.md
