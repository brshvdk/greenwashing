# Privacy

greenwashing collects no data and sends nothing anywhere.

- The gate and the mutation check run on your machine. They run your own test command and read its output. They call no AI model and no web service. Only git, run on your repository, may download from your git remote the objects a partial clone lacks.
- What the gate says when it stops a turn goes to your agent, as any hook's reason for stopping one does. Its reply can quote the last lines of your test output.
- The gate keeps a state file for each session and project, so that it can tell what the turn changed, in a folder of its own in your system's temporary folder: `greenwashing-gate-<your user id>` (`greenwashing-gate-user` in your own temporary folder on Windows). The file holds the folders of the project and of the worktrees the agent works in; the branch and commit of each, and the commits the repository's branches and worktrees point at; the path and a hash of the content of every file with uncommitted changes; the text of the test files with uncommitted changes when the turn started (up to 1 MiB each), and of test files as the gate saw them at an earlier prompt or Stop where it needs that to tell who changed them; the text of the project's `.greenwashing.json`; and the gate's own notes on the turn: how many times in a row it sent the agent back, whether it accepted the turn, whether a Stop has run since your last prompt, whether that prompt allowed removing tests, and whether it can check the project: which test runners it uses or, when the gate cannot check it, why (which can quote your `npm test` script). Only you can open the folder (`0700`), and the gate writes the file `0600` (a hook stopped while it writes can leave a second copy beside it, as private): when the folder is not like that, the gate keeps nothing there and says it is off. The files stay there until your system clears that folder.
- The gate and the mutation check may also work in temporary copies of your project, and remove them when they are done. The state file and the copies never leave your machine.
- The skill is text: instructions your agent reads.
- There is no telemetry and no account.

Your test command is your own, and greenwashing runs it as it is, with two differences: the gate and the mutation check set CI=true, as a CI server would (the mutation check also keeps Python from writing bytecode files), and the mutation check runs your tests on code it broke on purpose, so they can take paths your code never takes, such as past a guard that keeps them away from a real service.

Questions: open an issue at https://github.com/brshvdk/greenwashing/issues
