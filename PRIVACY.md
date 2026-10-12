# Privacy

greenwashing collects no data and sends nothing anywhere.

- The gate and the mutation check run on your machine. They run your own test command and read its output. They call no AI model and no web service.
- The gate keeps a state file for each session in your system's temporary folder: what the project looked like when the turn started, so that it can tell what the turn changed. The mutation check works in a temporary copy of your project and removes it when it is done. Neither leaves your machine.
- The skill is text: instructions your agent reads.
- There is no telemetry and no account.

Your test command is your own: whatever it does, it does with or without greenwashing. The gate and the mutation check run it with CI=true, as a CI server would.

Questions: open an issue at https://github.com/brshvdk/greenwashing/issues
