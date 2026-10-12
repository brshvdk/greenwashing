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
// What the plugin folder holds: only what works for the user. The plugin directory reads and checks
// this folder alone; tests, CI and the benchmark stay out.
const SHIPPED = [
  '.claude-plugin/plugin.json', '.claude-plugin/icon.png', 'hooks/hooks.json', 'commands/mutants.md', 'skills/greenwashing/SKILL.md',
  'gate/hook.js', 'gate/mutate.js', 'gate/runner.js', 'gate/lib/changes.js', 'gate/lib/checks.js', 'gate/lib/command.js', 'gate/lib/diff.js',
  'gate/lib/mutants.js', 'gate/lib/parse.js', 'gate/lib/verdict.js', 'gate/lib/python_checks.py', 'gate/lib/python_mutants.py', 'LICENSE', 'README.md',
];
// The files git holds or would add (an ignored file never reaches a user; a nested checkout is one entry).
function gitFiles(...where) {
  const listed = spawnSync('git', ['-C', ROOT, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...where], { encoding: 'utf8' });
  return { status: listed.status, stderr: listed.stderr, files: listed.stdout.split('\0').filter(Boolean) };
}
// CRC-32 as PNG uses it, for the icon's chunks.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes) => {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
// A PNG's chunks after the signature, [type, data], and the first problem: a chunk cut off, or one that fails its CRC.
function chunksOf(png) {
  const chunks = [];
  for (let at = 8; at < png.length;) {
    if (at + 12 > png.length || at + 12 + png.readUInt32BE(at) > png.length) return { chunks, problem: `a chunk cut off at byte ${at}` };
    const end = at + 12 + png.readUInt32BE(at);
    const type = png.toString('latin1', at + 4, at + 8);
    if (png.readUInt32BE(end - 4) !== crc32(png.subarray(at + 4, end - 4))) return { chunks, problem: `${type} at byte ${at} fails its CRC` };
    chunks.push([type, png.subarray(at + 8, end - 4)]);
    at = end;
  }
  return { chunks, problem: null };
}

test('the marketplace has one plugin, greenwashing, whose root is the folder plugin/', () => {
  const marketplace = readJson('.claude-plugin/marketplace.json');
  assert.equal(marketplace.name, 'greenwashing');
  assert.equal(marketplace.owner.name, 'brshvdk');
  assert.deepEqual(marketplace.plugins.map(({ name, source }) => [name, source]), [['greenwashing', './plugin']]);
  const manifest = readJson('plugin/.claude-plugin/plugin.json');
  assert.equal(manifest.name, 'greenwashing');
  // No version: users get each commit (the owner's decision). No icon: it sits where the plugin directory looks for it.
  assert.deepEqual(['version', 'icon'].filter((key) => key in manifest), []);
});

test('the plugin folder holds only what works for the user: the manifest and icon, the hooks, the command, the skill, the gate, LICENSE, README.md', () => {
  const { status, stderr, files } = gitFiles('plugin');
  assert.equal(status, 0, stderr);
  assert.deepEqual(files.map((file) => path.posix.relative('plugin', file)).sort(), [...SHIPPED].sort());
  // Plain files: a link could point out of the folder, which the plugin cache does not hold.
  for (const file of files) assert.ok(fs.lstatSync(path.join(ROOT, file)).isFile(), `${file} is no plain file`);
});

test("plugin/LICENSE is the repository's LICENSE, byte for byte", () => {
  assert.ok(fs.readFileSync(path.join(PLUGIN, 'LICENSE')).equals(fs.readFileSync(path.join(ROOT, 'LICENSE'))), 'plugin/LICENSE differs from LICENSE');
});

test('the icon is a square PNG of 512 to 2048 pixels a side, under 2 MB', () => {
  const icon = fs.readFileSync(path.join(PLUGIN, '.claude-plugin', 'icon.png'));
  assert.ok(icon.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'no PNG signature');
  // A whole PNG: every chunk there and its CRC right, IHDR first and 13 bytes long, IEND last.
  const { chunks, problem } = chunksOf(icon);
  assert.equal(problem, null);
  assert.deepEqual([chunks[0]?.[0], chunks[0]?.[1].length, chunks.at(-1)?.[0], chunks.at(-1)?.[1].length], ['IHDR', 13, 'IEND', 0]);
  const [width, height] = [chunks[0][1].readUInt32BE(0), chunks[0][1].readUInt32BE(4)];
  assert.equal(width, height, `${width}x${height} is not square`);
  assert.ok(width >= 512 && width <= 2048, `${width} px a side`);
  assert.ok(icon.length < 2000000, `${icon.length} bytes`);
});

test('every path the hooks and the command give under ${CLAUDE_PLUGIN_ROOT} is a file inside plugin/', () => {
  const hooks = Object.values(readJson('plugin/hooks/hooks.json').hooks).flat().flatMap((group) => group.hooks).map((hook) => hook.command);
  const texts = { 'plugin/hooks/hooks.json': hooks.join('\n'), 'plugin/commands/mutants.md': fs.readFileSync(path.join(PLUGIN, 'commands', 'mutants.md'), 'utf8') };
  for (const [file, text] of Object.entries(texts)) {
    // The rest of the shell word after the variable, its quotes taken out as the shell does.
    const paths = [...text.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/(\S*)/g)].map((m) => m[1].replace(/["'`]/g, ''));
    // Every use of the variable is one of these paths, and there is at least one.
    assert.ok(paths.length > 0, `${file} names no path under \${CLAUDE_PLUGIN_ROOT}`);
    assert.equal(paths.length, text.split('CLAUDE_PLUGIN_ROOT').length - 1, `${file} uses CLAUDE_PLUGIN_ROOT another way`);
    for (const rel of paths) {
      // Installed, the plugin's folder has another name: a path through .. leaves it even when it comes back here.
      assert.ok(!rel.split('/').includes('..'), `${file}: ${rel} goes out of the plugin's folder`);
      const full = path.join(PLUGIN, rel);
      assert.ok(fs.existsSync(full) && fs.statSync(full).isFile(), `${file}: ${rel} is no file in plugin/`);
    }
  }
});

test('the repository holds exactly one skill file: the plugin loads plugin/skills/greenwashing/SKILL.md', () => {
  // Links and node_modules too; a folder with its own .git (a worktree, a nested checkout) is another copy.
  const { status, stderr, files } = gitFiles();
  assert.equal(status, 0, stderr);
  assert.deepEqual(files.filter((file) => path.posix.basename(file).toLowerCase() === 'skill.md'), ['plugin/skills/greenwashing/SKILL.md']);
  // A link to a folder could bring a skill in a second time: there is none.
  const linked = files.filter((file) => fs.lstatSync(path.join(ROOT, file), { throwIfNoEntry: false })?.isSymbolicLink()
    && fs.statSync(path.join(ROOT, file), { throwIfNoEntry: false })?.isDirectory());
  assert.deepEqual(linked, []);
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
