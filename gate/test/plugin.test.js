'use strict';
// The plugin package and the gate's wiring in this repository: manifests, hook configs (run as
// written, through `sh -c` like Claude Code's shell form) and this repository's .greenwashing.json.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readConfig, MAX_TIMEOUT_SECONDS } = require('../lib/command');

const ROOT = path.join(__dirname, '..', '..');
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));

test('the marketplace has one plugin, greenwashing, whose root is the repository root', () => {
  const marketplace = readJson('.claude-plugin/marketplace.json');
  assert.equal(marketplace.name, 'greenwashing');
  assert.equal(marketplace.owner.name, 'brshvdk');
  assert.deepEqual(marketplace.plugins.map(({ name, source }) => [name, source]), [['greenwashing', './']]);
  assert.equal(readJson('.claude-plugin/plugin.json').name, 'greenwashing');
});

test('the repository holds exactly one skill file: the plugin loads skills/greenwashing/SKILL.md', () => {
  const found = [];
  // A folder with its own .git (a worktree, a nested checkout) is another copy, not this repository.
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory() && !fs.existsSync(path.join(full, '.git'))) walk(full);
      else if (entry.isFile() && entry.name.toLowerCase() === 'skill.md') found.push(path.relative(ROOT, full));
    }
  };
  walk(ROOT);
  assert.deepEqual(found, [path.join('skills', 'greenwashing', 'SKILL.md')]);
});

const CONFIGS = {
  'hooks/hooks.json': { variable: 'CLAUDE_PLUGIN_ROOT', placeholder: '${CLAUDE_PLUGIN_ROOT}' },
  '.claude/settings.json': { variable: 'CLAUDE_PROJECT_DIR', placeholder: '$CLAUDE_PROJECT_DIR' },
};

for (const [file, { variable, placeholder }] of Object.entries(CONFIGS)) {
  test(`${file}: one prompt hook and one Stop hook, the Stop hook outlives the longest test run`, () => {
    const { hooks } = readJson(file);
    assert.deepEqual(Object.keys(hooks).sort(), ['Stop', 'UserPromptSubmit']);
    const [prompt] = hooks.UserPromptSubmit.flatMap((group) => group.hooks);
    const [stop] = hooks.Stop.flatMap((group) => group.hooks);
    assert.equal(hooks.UserPromptSubmit.flatMap((group) => group.hooks).length, 1);
    assert.equal(hooks.Stop.flatMap((group) => group.hooks).length, 1);
    assert.deepEqual([prompt.type, prompt.command, prompt.timeout], ['command', `node "${placeholder}/gate/hook.js" prompt`, undefined]);
    assert.deepEqual([stop.type, stop.command], ['command', `node "${placeholder}/gate/hook.js" stop`]);
    // Claude Code cancels a hook at its timeout and lets the agent stop: the hook must outlive the tests.
    assert.equal(stop.timeout, MAX_TIMEOUT_SECONDS + 60);
  });

  test(`${file}: the commands work as written, run by sh -c from a path with a space`, (t) => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gw plugin '));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const install = path.join(base, 'install dir');
    fs.cpSync(path.join(ROOT, 'gate'), path.join(install, 'gate'), { recursive: true });
    const project = path.join(base, 'project');
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, '.greenwashing.json'), JSON.stringify({ testCommand: 'echo ok' }));
    // The plugin runs the gate from its install folder; this repository runs it from the project.
    const env = { ...process.env, TMPDIR: base, CLAUDE_PROJECT_DIR: project };
    if (variable === 'CLAUDE_PLUGIN_ROOT') env.CLAUDE_PLUGIN_ROOT = install;
    else fs.cpSync(path.join(ROOT, 'gate'), path.join(project, 'gate'), { recursive: true });
    const { hooks } = readJson(file);
    const input = JSON.stringify({ session_id: 'p', cwd: project, stop_hook_active: false });
    const run = (command) => spawnSync('sh', ['-c', command], { input, env, encoding: 'utf8' });
    const prompt = run(hooks.UserPromptSubmit[0].hooks[0].command);
    assert.deepEqual([prompt.status, prompt.stdout, prompt.stderr], [0, '', '']);
    const stop = run(hooks.Stop[0].hooks[0].command);
    assert.equal(stop.status, 0, stop.stderr);
    // Not a git repository, so the tests run; "echo ok" prints no counts: blocked.
    const output = JSON.parse(stop.stdout);
    assert.equal(output.decision, 'block');
    assert.match(output.reason, /Command: echo ok \(\.greenwashing\.json\)/);
  });
}

test('the plugin command /greenwashing:mutants runs the mutation command as written, from a path with a space', (t) => {
  const text = fs.readFileSync(path.join(ROOT, 'commands', 'mutants.md'), 'utf8');
  const [, frontmatter, body] = /^---\n([^]*?)\n---\n([^]*)$/.exec(text);
  assert.match(frontmatter, /^description: \S/m);
  assert.match(frontmatter, /^argument-hint: /m);
  const commands = [...body.matchAll(/^```bash\n(.*)\n```$/gm)].map((m) => m[1]);
  assert.deepEqual(commands, ['node "${CLAUDE_PLUGIN_ROOT}/gate/mutate.js" --project "${CLAUDE_PROJECT_DIR}" $ARGUMENTS']);
  // Claude Code puts the paths and the arguments in the text; the agent runs the line in a shell.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gw plugin '));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const install = path.join(base, 'install dir');
  fs.cpSync(path.join(ROOT, 'gate'), path.join(install, 'gate'), { recursive: true });
  const project = path.join(base, 'a project');
  fs.mkdirSync(project);
  const line = commands[0].replace('${CLAUDE_PLUGIN_ROOT}', install).replace('${CLAUDE_PROJECT_DIR}', project).replace('$ARGUMENTS', '--limit 3');
  const run = spawnSync('sh', ['-c', line], { cwd: base, encoding: 'utf8', env: { ...process.env, TMPDIR: base } });
  // Not a git repository: nothing tells which lines changed, so the command did not run.
  assert.equal(run.status, 2, run.stdout + run.stderr);
  assert.match(run.stdout, /Did not run: .*a project is not in a git repository: the changed lines come from git\n/);
});

test("this repository's .greenwashing.json runs the Python tests isolated and then the gate's tests", () => {
  const config = readConfig(fs.readFileSync(path.join(ROOT, '.greenwashing.json'), 'utf8'));
  assert.equal(config.error, undefined);
  const [python, node, ...rest] = config.testCommand.split(' && ');
  assert.deepEqual(rest, []);
  assert.equal(python, 'python3 -I -m unittest discover -s tests');
  assert.equal(node, 'node --test --test-reporter=tap gate/test/*.test.js');
});
