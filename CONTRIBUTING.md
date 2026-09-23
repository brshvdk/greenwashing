# Contributing

Thanks for your interest in greenwashing. The project is at an early stage.

## Run the checks

Python 3 and git are enough for the tests; ruff is needed for lint only.

```bash
python3 -I -m unittest discover -s tests -v   # tests (isolated, as in CI)
pip install ruff && ruff check .           # lint
scripts/leak-check                         # leak check
```

The leak check has three parts: gitleaks (install it to run that part), references to other repositories, and a stop-word pattern scan. The patterns live only in CI, so locally the pattern scan reports "did not run" and the script exits 2; CI decides.

## Propose a change

1. Open an issue first. Describe the problem or the idea, so the approach is agreed on before code is written.
2. Then open a pull request that references the issue. Keep it small and focused, add tests for the behaviour you change, and make sure CI is green.

Everything in the repository is in English: code, comments, docs, commit messages. Commit messages follow Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).
