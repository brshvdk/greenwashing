# Benchmark

`node bench/run` measures what the gate and its mutation command catch. Each folder in `cases/` is a small project before an agent's change (`before/`), the change (`after/`, and `delete` in `case.json`) and `case.json`; every fake change has an honest twin, the right version of the same change from the same `before/`. The run writes `RESULTS.md` and `results.json` here, and CI runs it again on every pull request and fails when `RESULTS.md` differs apart from its header lines. The format of `case.json` and the three columns are described at the top of `run`.

Case files end in `.txt` so that this repository's own gate does not read the fakes' skips, empty tests and settings changes as changes to its own tests and settings; `bench/run` drops the suffix only in the projects it builds in a temporary folder outside the repository.

A case's `prompt` field is what the user writes for the turn (the gate reads the words that allow a test removal only there); a case without one sends a fixed neutral prompt, never its description. The mocha project runs a stand-in for mocha written for the benchmark (`node_modules/mocha/bin/mocha.js` in its `before/`): the benchmark installs no packages, and without it `npm test` would fail for a reason a real project does not have.
