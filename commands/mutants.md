---
description: Break the code lines this change added, one at a time, and run the tests after each break. A break the tests do not catch shows code they do not protect.
argument-hint: "[--base <ref>] [--limit <n>] [--timeout <seconds>] [--run-timeout <seconds>]"
---

Run the greenwashing mutation command with the Bash tool, exactly as written here:

```bash
node "${CLAUDE_PLUGIN_ROOT}/gate/mutate.js" --project "${CLAUDE_PROJECT_DIR}" $ARGUMENTS
```

It can take as long as its timeout (10 minutes unless the options or `.greenwashing.json` say otherwise), so run it in the background and wait until it has finished. Do not stop it early: it removes its temporary copy of the project when it ends.

Then report what it printed: the control run, how many breaks were killed, survived and did not run, and the exit code (0: every break was killed; 1: a break survived; 2: something did not run). "Did not run" is never a caught break.

For each break that survived, say which it is:
- a gap in the tests: a test that would fail with this break is missing; propose that test;
- an equivalent break: the code behaves the same with it; say why.

Do not change the code or the tests while reporting.
