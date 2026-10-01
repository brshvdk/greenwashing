# Contributing

Thanks for your interest in greenwashing. The project is at an early stage.

## Run the checks

The tests need Python 3, git, ruff (some tests run the CI lint step) and Node.js 20 or newer (the gate, the benchmark and some of the Python tests run it).

```bash
python3 -I -m unittest discover -s tests -v   # tests (isolated, as in CI)
pip install ruff && ruff check --no-respect-gitignore .   # lint, as in CI
node --test --test-reporter=tap gate/test/*.test.js    # the gate's tests, as in CI
node --test --test-reporter=tap bench/test/*.test.js   # the benchmark's tests, as in CI
node bench/run                             # the benchmark: rewrites bench/RESULTS.md and bench/results.json, which CI compares with its own run
node bench/readme                          # README.md against that run: its scene, its table of the gate's replies and its numbers, as in CI
scripts/leak-check                         # leak check
```

The leak check has three parts: gitleaks (install it to run that part), references to other repositories, and a stop-word pattern scan. The patterns live only in CI, so locally the pattern scan reports "did not run" and the script exits 2; CI decides.

## Propose a change

1. Open an issue first. Describe the problem or the idea, so the approach is agreed on before code is written.
2. Then open a pull request that references the issue. Keep it small and focused, add tests for the behaviour you change, and make sure CI is green.

Everything in the repository is in English: code, comments, docs, commit messages. Commit messages follow Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).
