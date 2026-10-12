# Privacy

greenwashing collects no data and sends nothing anywhere.

- The gate and the mutation check run on your machine. They run your own test command and read its output. They call no AI model and no web service. Only git, run on your repository, may download from your git remote the objects a partial clone lacks.
- The gate keeps a state file for each session in your system's temporary folder: what the project looked like when the turn started, the text of test files with uncommitted changes included, so that it can tell what the turn changed. The mutation check works in a temporary copy of your project and removes it when it is done. Neither leaves your machine.
- The skill is text: instructions your agent reads.
- There is no telemetry and no account.

Your test command is your own: whatever it does, it does with or without greenwashing. Two things differ: the gate and the mutation check run it with CI=true, as a CI server would, and the mutation check runs it on code it broke on purpose, so your tests can take paths your code never takes, such as past a guard that keeps them away from a real service.

Questions: open an issue at https://github.com/brshvdk/greenwashing/issues
