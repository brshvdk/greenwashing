# Privacy

greenwashing collects no data and sends nothing anywhere.

- The gate and the mutation check run on your machine. They run your own test command and read its output. They call no AI model and no web service. Only git, run on your repository, may download from your git remote the objects a partial clone lacks.
- What the gate says when it stops a turn goes to your agent, as any hook's reason for stopping one does. Its reply can quote the last lines of your test output.
- The gate keeps a state file for each session in your system's temporary folder: what the project looked like when the turn started, the text of test files with uncommitted changes included, so that it can tell what the turn changed. The file stays there until your system clears that folder.
- The gate and the mutation check may also work in temporary copies of your project, and remove them when they are done. The state file and the copies never leave your machine.
- The skill is text: instructions your agent reads.
- There is no telemetry and no account.

Your test command is your own, and greenwashing runs it as it is, with two differences: the gate and the mutation check set CI=true, as a CI server would (the mutation check also keeps Python from writing bytecode files), and the mutation check runs your tests on code it broke on purpose, so they can take paths your code never takes, such as past a guard that keeps them away from a real service.

Questions: open an issue at https://github.com/brshvdk/greenwashing/issues
