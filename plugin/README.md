# greenwashing

**Your AI agent is greenwashing your test suite.**

greenwashing is a Claude Code plugin that won't take "done" for an answer until the tests really pass. It runs them itself and catches tests that were deleted, skipped or made to check nothing.

- **The gate.** When the agent tries to finish a turn that changed code, the gate reads the test lines the turn changed: a new skip, a test with no assertion, a check of a value against itself, a test that is gone. Then it runs your test command itself. If anything is wrong, it sends the agent back with the reason.
- **The mutation check.** `/greenwashing:mutants` breaks the lines your change added, one at a time, and runs your tests after each break: a break the tests don't catch shows code they don't protect.
- **The skill.** The same rules as instructions: what to check before saying "done" and how to report it.

**Where it works:** JavaScript, TypeScript and Python projects whose tests run with pytest, unittest, jest, vitest or `node --test`, with Node 20+ on PATH. In other projects the gate ends each turn with one line saying the turn was not checked, and lets the agent finish.

**Does it call an AI model or send my code anywhere?** No. The gate and the mutation check are plain scripts with no packages to install: they run your own test command on your machine and read its output.

The full README, with the gate's real reply, the benchmark and what it doesn't catch: https://github.com/brshvdk/greenwashing
