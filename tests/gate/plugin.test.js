'use strict';
// The plugin package and the gate's wiring in this repository: what the plugin folder holds, manifests,
// hook configs (run as written, through `sh -c` like Claude Code's shell form) and this repository's
// .greenwashing.json.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  readConfig, gateOff, MAX_TIMEOUT_SECONDS, MIN_NODE, NO_NODE,
} = require('../../plugin/gate/lib/command');

const ROOT = path.join(__dirname, '..', '..');
const PLUGIN = path.join(ROOT, 'plugin');
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
// What the plugin folder holds, apart from the gate's modules in gate/lib/: only what works for the
// user. The plugin directory reads and checks this folder alone; tests, CI and the benchmark stay out.
const SHIPPED = [
  '.claude-plugin/plugin.json', '.claude-plugin/icon.png', 'hooks/hooks.json', 'commands/mutants.md', 'skills/greenwashing/SKILL.md',
  'gate/hook.js', 'gate/mutate.js', 'gate/runner.js', 'LICENSE', 'README.md',
];

test('the marketplace has one plugin, greenwashing, whose root is the folder plugin/', () => {
  const marketplace = readJson('.claude-plugin/marketplace.json');
  assert.equal(marketplace.name, 'greenwashing');
  assert.equal(marketplace.owner.name, 'brshvdk');
  assert.deepEqual(marketplace.plugins.map(({ name, source }) => [name, source]), [['greenwashing', './plugin']]);
  assert.equal(readJson('plugin/.claude-plugin/plugin.json').name, 'greenwashing');
});

test('the plugin folder holds only what works for the user: the manifest and icon, the hooks, the command, the skill, the gate, LICENSE, README.md', () => {
  // The files git holds there or would add (an ignored file never reaches a user).
  const listed = spawnSync('git', ['-C', ROOT, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', 'plugin'], { encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  const files = listed.stdout.split('\0').filter(Boolean).map((file) => path.posix.relative('plugin', file));
  const lib = files.filter((file) => /^gate\/lib\/[^/]+$/.test(file));
  assert.ok(lib.length > 0, `no module of the gate in plugin/gate/lib: ${files.join(', ')}`);
  assert.deepEqual(files.filter((file) => !lib.includes(file)).sort(), [...SHIPPED].sort());
  // Plain files: a link could point out of the folder, which the plugin cache does not hold.
  for (const file of files) assert.ok(fs.lstatSync(path.join(PLUGIN, file)).isFile(), `plugin/${file} is no plain file`);
});

test("plugin/LICENSE is the repository's LICENSE, byte for byte", () => {
  assert.ok(fs.readFileSync(path.join(PLUGIN, 'LICENSE')).equals(fs.readFileSync(path.join(ROOT, 'LICENSE'))), 'plugin/LICENSE differs from LICENSE');
});

test('the icon is a square PNG of 512 to 2048 pixels a side, under 2 MB', () => {
  const icon = fs.readFileSync(path.join(PLUGIN, '.claude-plugin', 'icon.png'));
  assert.ok(icon.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'no PNG signature');
  assert.equal(icon.toString('latin1', 12, 16), 'IHDR');
  const [width, height] = [icon.readUInt32BE(16), icon.readUInt32BE(20)];
  assert.equal(width, height, `${width}x${height} is not square`);
  assert.ok(width >= 512 && width <= 2048, `${width} px a side`);
  assert.ok(icon.length < 2000000, `${icon.length} bytes`);
});

test('every path the hooks and the command give under ${CLAUDE_PLUGIN_ROOT} is a file inside plugin/', () => {
  const hooks = Object.values(readJson('plugin/hooks/hooks.json').hooks).flat().flatMap((group) => group.hooks).map((hook) => hook.command);
  const texts = { 'plugin/hooks/hooks.json': hooks.join('\n'), 'plugin/commands/mutants.md': fs.readFileSync(path.join(PLUGIN, 'commands', 'mutants.md'), 'utf8') };
  for (const [file, text] of Object.entries(texts)) {
    const paths = [...text.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"'\s]+)/g)].map((m) => m[1]);
    // Every use of the variable is one of these paths, and there is at least one.
    assert.ok(paths.length > 0, `${file} names no path under \${CLAUDE_PLUGIN_ROOT}`);
    assert.equal(paths.length, text.split('CLAUDE_PLUGIN_ROOT').length - 1, `${file} uses CLAUDE_PLUGIN_ROOT another way`);
    for (const rel of paths) {
      const full = path.join(PLUGIN, rel);
      assert.ok(!path.relative(PLUGIN, full).startsWith('..'), `${file}: ${rel} is outside plugin/`);
      assert.ok(fs.existsSync(full) && fs.statSync(full).isFile(), `${file}: ${rel} is no file in plugin/`);
    }
  }
});

test('the repository holds exactly one skill file: the plugin loads plugin/skills/greenwashing/SKILL.md', () => {
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
  assert.deepEqual(found, [path.join('plugin', 'skills', 'greenwashing', 'SKILL.md')]);
});

// The plugin runs the gate from its own folder, this repository from plugin/ in the project.
const CONFIGS = {
  'plugin/hooks/hooks.json': { variable: 'CLAUDE_PLUGIN_ROOT', hook: '${CLAUDE_PLUGIN_ROOT}/gate/hook.js' },
  '.claude/settings.json': { variable: 'CLAUDE_PROJECT_DIR', hook: '$CLAUDE_PROJECT_DIR/plugin/gate/hook.js' },
};

for (const [file, { variable, hook }] of Object.entries(CONFIGS)) {
  test(`${file}: one session hook that tells the user when node cannot start the gate`, () => {
    const { hooks } = readJson(file);
    // When node cannot start the gate at all, the shell prints the line itself.
    assert.deepEqual(hooks.SessionStart.flatMap((group) => group.hooks),
      [{ type: 'command', command: `node "${hook}" session || echo '${JSON.stringify({ systemMessage: gateOff(NO_NODE) })}'` }]);
  });

  test(`${file}: one prompt hook and one Stop hook, the Stop hook outlives the longest test run`, () => {
    const { hooks } = readJson(file);
    assert.deepEqual(Object.keys(hooks).sort(), ['SessionStart', 'Stop', 'UserPromptSubmit']);
    const [prompt] = hooks.UserPromptSubmit.flatMap((group) => group.hooks);
    const [stop] = hooks.Stop.flatMap((group) => group.hooks);
    assert.equal(hooks.UserPromptSubmit.flatMap((group) => group.hooks).length, 1);
    assert.equal(hooks.Stop.flatMap((group) => group.hooks).length, 1);
    assert.deepEqual([prompt.type, prompt.command, prompt.timeout], ['command', `node "${hook}" prompt`, undefined]);
    assert.deepEqual([stop.type, stop.command], ['command', `node "${hook}" stop`]);
    // Claude Code cancels a hook at its timeout and lets the agent stop: the hook must outlive the tests.
    assert.equal(stop.timeout, MAX_TIMEOUT_SECONDS + 60);
  });

  test(`${file}: the commands work as written, run by sh -c from a path with a space`, (t) => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gw plugin '));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const install = path.join(base, 'install dir');
    fs.cpSync(PLUGIN, install, { recursive: true });
    const project = path.join(base, 'project');
    fs.mkdirSync(project);
    fs.writeFileSync(path.join(project, '.greenwashing.json'), JSON.stringify({ testCommand: 'echo ok' }));
    // The plugin runs the gate from its install folder (a copy of plugin/); this repository runs it from the project.
    const env = { ...process.env, TMPDIR: base, CLAUDE_PROJECT_DIR: project };
    if (variable === 'CLAUDE_PLUGIN_ROOT') env.CLAUDE_PLUGIN_ROOT = install;
    else fs.cpSync(path.join(PLUGIN, 'gate'), path.join(project, 'plugin', 'gate'), { recursive: true });
    const { hooks } = readJson(file);
    const input = JSON.stringify({ session_id: 'p', cwd: project, stop_hook_active: false });
    const run = (command) => spawnSync('sh', ['-c', command], { input, env, encoding: 'utf8' });
    const prompt = run(hooks.UserPromptSubmit[0].hooks[0].command);
    assert.deepEqual([prompt.status, prompt.stdout, prompt.stderr], [0, '', '']);
    // A Node the gate runs on: the session hook says nothing. No node on PATH: the user is told.
    const session = hooks.SessionStart[0].hooks[0].command;
    assert.deepEqual([run(session).status, run(session).stdout], [0, '']);
    const noNode = spawnSync('/bin/sh', ['-c', session], { input, env: { ...env, PATH: fs.mkdtempSync(path.join(base, 'empty path ')) }, encoding: 'utf8' });
    assert.equal(noNode.status, 0);
    assert.deepEqual(JSON.parse(noNode.stdout), { systemMessage: gateOff(NO_NODE) });
    const stop = run(hooks.Stop[0].hooks[0].command);
    assert.equal(stop.status, 0, stop.stderr);
    // Not a git repository, so the tests run; "echo ok" prints no counts: blocked.
    const output = JSON.parse(stop.stdout);
    assert.equal(output.decision, 'block');
    assert.match(output.reason, /Command: echo ok \(\.greenwashing\.json\)/);
  });
}

test('the oldest Node the gate runs on is the oldest Node CI tests', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  const majors = [...workflow.matchAll(/^ {10}- node: "(\d+)\.\d+\.\d+"$/gm)].map((m) => Number(m[1]));
  assert.ok(majors.length > 0, 'no Node versions in ci.yml');
  assert.equal(Math.min(...majors), MIN_NODE);
});

test('the plugin command /greenwashing:mutants runs the mutation command as written, from a path with a space', (t) => {
  const text = fs.readFileSync(path.join(PLUGIN, 'commands', 'mutants.md'), 'utf8');
  const [, frontmatter, body] = /^---\n([^]*?)\n---\n([^]*)$/.exec(text);
  assert.match(frontmatter, /^description: \S/m);
  assert.match(frontmatter, /^argument-hint: /m);
  const commands = [...body.matchAll(/^```bash\n(.*)\n```$/gm)].map((m) => m[1]);
  assert.deepEqual(commands, ['node "${CLAUDE_PLUGIN_ROOT}/gate/mutate.js" --project "${CLAUDE_PROJECT_DIR}" $ARGUMENTS']);
  // Claude Code puts the paths and the arguments in the text; the agent runs the line in a shell.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gw plugin '));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const install = path.join(base, 'install dir');
  fs.cpSync(PLUGIN, install, { recursive: true });
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
  assert.equal(node, 'node --test --test-reporter=tap tests/gate/*.test.js');
});
