'use strict';
// Runs hook.js the way Claude Code does: a command with the hook JSON on stdin, in a real
// temporary git project, with real test runners (node --test, python3 -m unittest).
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK = path.join(__dirname, '..', 'hook.js');
const NODE_PASS = "const test = require('node:test');\ntest('ok', () => {});\n";
const NODE_FAIL = "const test = require('node:test');\nconst assert = require('node:assert');\ntest('bad', () => assert.equal(1, 2));\n";
const NODE_EMPTY = "const test = require('node:test');\ntest.skip('later', () => {});\n";
const NODE_CMD = 'node --test --test-reporter=tap t.test.js';
const PY_PASS = 'import unittest\n\n\nclass T(unittest.TestCase):\n    def test_a(self):\n        self.assertEqual(1, 1)\n';
const PY_FAIL = 'import unittest\n\n\nclass T(unittest.TestCase):\n    def test_a(self):\n        self.assertEqual(1, 2)\n';
// A command that prints the counts of a green unittest run without running anything.
const GREEN_ECHO = "printf 'Ran 1 test in 0.1s\\n\\nOK\\n'";
const NO_CHANGES = { systemMessage: 'greenwashing: no files changed this turn - tests not run' };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-hook-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function write(dir, files) {
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
}

function git(dir, ...args) {
  const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

// A committed project; testCommand goes to .greenwashing.json unless it is null.
function project(t, files, testCommand = NODE_CMD) {
  const dir = tempDir(t);
  const config = testCommand === null ? {} : { '.greenwashing.json': JSON.stringify({ testCommand }) };
  write(dir, { ...config, ...files });
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'gate@example.invalid');
  git(dir, 'config', 'user.name', 'gate');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'start');
  return dir;
}

// One Claude Code session started in dir. Its temp directory holds the gate's state (sessions given
// the same tmp share it, as the sessions of one user do); prompt and stop take the cwd Claude is in.
// NODE_TEST_CONTEXT is dropped: node --test sets it in this file's process, and a node --test the
// gate starts with it refuses to run ("run() is being called recursively").
function session(t, dir, { id = 's', tmp = tempDir(t), env: extra = {} } = {}) {
  const env = { ...process.env, TMPDIR: tmp, CLAUDE_PROJECT_DIR: dir, ...extra };
  delete env.NODE_TEST_CONTEXT;
  const call = (event, input) => {
    const result = spawnSync(process.execPath, [HOOK, event], {
      input: typeof input === 'string' ? input : JSON.stringify(input),
      encoding: 'utf8',
      env,
    });
    const text = result.stdout.trim();
    return { code: result.status, stdout: result.stdout, stderr: result.stderr, json: text ? JSON.parse(text) : null };
  };
  const stopInput = (active, cwd) => ({ session_id: id, cwd, hook_event_name: 'Stop', stop_hook_active: active });
  return {
    prompt: (cwd = dir) => call('prompt', { session_id: id, cwd, hook_event_name: 'UserPromptSubmit', prompt: 'go' }),
    stop: (active = false, cwd = dir) => call('stop', stopInput(active, cwd)),
    raw: call,
    stopInput,
    env,
    tmp,
  };
}

test('tests that fail block the stop, with command, counts, reason and output tail', (t) => {
  const dir = project(t, { 't.test.js': NODE_PASS });
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 't.test.js': NODE_FAIL });
  const { code, json } = gate.stop();
  assert.equal(code, 0);
  // Only the fields Claude Code reads for a block: nothing that would end the session.
  assert.deepEqual(Object.keys(json).sort(), ['decision', 'reason']);
  assert.equal(json.decision, 'block');
  assert.match(json.reason, /the tests failed/);
  assert.match(json.reason, /Command: node --test --test-reporter=tap t\.test\.js \(\.greenwashing\.json\)/);
  assert.match(json.reason, /Counts: 0 passed, 1 failed, 0 skipped/);
  assert.match(json.reason, /# fail 1/);
});

test('green tests let the agent stop with one line naming the command and the counts', (t) => {
  const dir = project(t, { 't.test.js': NODE_FAIL });
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 't.test.js': NODE_PASS });
  const { json } = gate.stop();
  assert.deepEqual(json, { systemMessage: 'greenwashing: tests passed - node --test --test-reporter=tap t.test.js: 1 passed, 0 failed, 0 skipped' });
});

test('zero tests ran: blocked as did not run, GW-08', (t) => {
  const dir = project(t, { 't.test.js': NODE_PASS });
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 't.test.js': NODE_EMPTY });
  const { json } = gate.stop();
  assert.equal(json.decision, 'block');
  assert.match(json.reason, /the tests did not run/);
  assert.match(json.reason, /zero tests ran \(node --test\)/);
  assert.match(json.reason, /See GW-08 in /);
});

test('a command that only prints "ok": blocked as did not run, GW-50', (t) => {
  const dir = project(t, { 'app.js': '1;\n' }, 'echo ok');
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 'app.js': '2;\n' });
  const { json } = gate.stop();
  assert.equal(json.decision, 'block');
  assert.match(json.reason, /no test counts from pytest, unittest, jest, vitest or node --test/);
  assert.match(json.reason, /See GW-50 in /);
  assert.match(json.reason, /Last 20 lines of output:\nok$/);
});

test('a command that is not found: blocked as did not run', (t) => {
  const dir = project(t, { 'app.js': '1;\n' }, 'no-such-test-runner-xyz --all');
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 'app.js': '2;\n' });
  const { json } = gate.stop();
  assert.equal(json.decision, 'block');
  assert.match(json.reason, /the command was not found \(exit code 127\)/);
});

test('a timeout: blocked as did not run, and the processes the command started are stopped', (t) => {
  const dir = project(t, { 'app.js': '1;\n' }, 'x');
  const marker = path.join(dir, 'late-marker');
  write(dir, { '.greenwashing.json': JSON.stringify({ testCommand: `(sleep 3; touch ${JSON.stringify(marker)}) & sleep 30`, timeoutSeconds: 1 }) });
  git(dir, 'commit', '-qam', 'config');
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 'app.js': '2;\n' });
  const started = Date.now();
  const { json } = gate.stop();
  assert.ok(Date.now() - started < 15000, 'the gate waited for the whole command');
  assert.equal(json.decision, 'block');
  assert.match(json.reason, /did not finish in 1 s and was stopped/);
  spawnSync('sleep', ['4']);
  assert.equal(fs.existsSync(marker), false, 'a process of the timed-out command kept running');
});

test('the timeout is the configured number of seconds: counts printed after it do not count', (t) => {
  const dir = project(t, { 'app.js': '1;\n' }, 'x');
  write(dir, { '.greenwashing.json': JSON.stringify({ testCommand: `sleep 1.6; ${GREEN_ECHO}`, timeoutSeconds: 1 }) });
  git(dir, 'commit', '-qam', 'config');
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 'app.js': '2;\n' });
  const { json } = gate.stop();
  assert.equal(json.decision, 'block');
  assert.match(json.reason, /did not finish in 1 s and was stopped/);
});

test('only documentation changed: the stop is allowed with one line, the tests are not run', (t) => {
  const dir = project(t, { 't.test.js': NODE_FAIL, 'README.md': 'a\n' });
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 'README.md': 'b\n', 'docs/new.rst': 'c\n' });
  const { json } = gate.stop();
  assert.deepEqual(json, { systemMessage: 'greenwashing: only documentation changed (2 files) - tests not run' });
});

test('nothing changed: the stop is allowed with one line', (t) => {
  const dir = project(t, { 't.test.js': NODE_FAIL });
  const gate = session(t, dir);
  gate.prompt();
  assert.deepEqual(gate.stop().json, { systemMessage: 'greenwashing: no files changed this turn - tests not run' });
});

test('changes committed during the turn count as changes', (t) => {
  const dir = project(t, { 't.test.js': NODE_PASS });
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 't.test.js': NODE_FAIL });
  git(dir, 'commit', '-qam', 'break it');
  assert.equal(git(dir, 'status', '--porcelain'), '');
  assert.equal(gate.stop().json.decision, 'block');
});

test('a file already edited before the turn and left alone is not a change', (t) => {
  const dir = project(t, { 't.test.js': NODE_FAIL, 'app.js': '1;\n' });
  write(dir, { 'app.js': '2;\n', 'scratch.js': 'x;\n' });
  const gate = session(t, dir);
  gate.prompt();
  assert.deepEqual(gate.stop().json, { systemMessage: 'greenwashing: no files changed this turn - tests not run' });
  write(dir, { 'app.js': '3;\n' });
  assert.equal(gate.stop().json.decision, 'block');
});

test('a change committed and then undone in the working tree is not a change', (t) => {
  const dir = project(t, { 't.test.js': NODE_FAIL, 'app.js': '1;\n' });
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 'app.js': '2;\n' });
  git(dir, 'commit', '-qam', 'change');
  write(dir, { 'app.js': '1;\n' });
  assert.deepEqual(gate.stop().json, { systemMessage: 'greenwashing: no files changed this turn - tests not run' });
});

test('new, deleted and reverted files count as changes', (t) => {
  for (const change of [
    (dir) => write(dir, { 'new.js': 'x;\n' }),
    (dir) => fs.rmSync(path.join(dir, 'app.js')),
    (dir) => git(dir, 'checkout', '--', 'app.js'),
  ]) {
    const dir = project(t, { 't.test.js': NODE_FAIL, 'app.js': '1;\n' });
    write(dir, { 'app.js': '2;\n' });
    const gate = session(t, dir);
    gate.prompt();
    change(dir);
    assert.equal(gate.stop().json.decision, 'block', change.toString());
  }
});

test('three blocks in a row, then the fourth stop is let go with a red message for the user', (t) => {
  const dir = project(t, { 't.test.js': NODE_PASS });
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 't.test.js': NODE_FAIL });
  assert.equal(gate.stop(false).json.decision, 'block');
  assert.equal(gate.stop(true).json.decision, 'block');
  assert.equal(gate.stop(true).json.decision, 'block');
  const fourth = gate.stop(true).json;
  assert.deepEqual(Object.keys(fourth), ['systemMessage']);
  assert.match(fourth.systemMessage, /^greenwashing: TESTS DID NOT PASS - WORK NOT ACCEPTED\. The gate sent the agent back 3 times in a row/);
});

test('a new user prompt starts the count again', (t) => {
  const dir = project(t, { 't.test.js': NODE_PASS });
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 't.test.js': NODE_FAIL });
  gate.stop(false);
  gate.stop(true);
  gate.prompt();
  write(dir, { 't.test.js': `${NODE_FAIL}// again\n` });
  assert.equal(gate.stop(true).json.decision, 'block');
  assert.equal(gate.stop(true).json.decision, 'block');
  assert.equal(gate.stop(true).json.decision, 'block');
  assert.match(gate.stop(true).json.systemMessage, /WORK NOT ACCEPTED/);
});

test('a stop that Claude Code says is not continuing after a block starts the count again', (t) => {
  const dir = project(t, { 't.test.js': NODE_PASS });
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 't.test.js': NODE_FAIL });
  gate.stop(false);
  gate.stop(true);
  // No new prompt, but stop_hook_active is false: a fresh chain of three blocks.
  assert.equal(gate.stop(false).json.decision, 'block');
  assert.equal(gate.stop(true).json.decision, 'block');
  assert.equal(gate.stop(true).json.decision, 'block');
  assert.match(gate.stop(true).json.systemMessage, /WORK NOT ACCEPTED/);
});

test('without a recorded start of the turn, the tests run', (t) => {
  const dir = project(t, { 't.test.js': NODE_FAIL });
  const gate = session(t, dir);
  assert.equal(gate.stop().json.decision, 'block');
});

test('outside a git repository, the tests run', (t) => {
  const dir = tempDir(t);
  write(dir, { '.greenwashing.json': JSON.stringify({ testCommand: NODE_CMD }), 't.test.js': NODE_PASS });
  const gate = session(t, dir);
  gate.prompt();
  assert.match(gate.stop().json.systemMessage, /^greenwashing: tests passed - .*: 1 passed, 0 failed, 0 skipped$/);
});

test('a Python project without a test command runs unittest', (t) => {
  const dir = project(t, { 'tests/__init__.py': '', 'tests/test_a.py': PY_PASS }, null);
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 'tests/test_a.py': PY_FAIL });
  const { json } = gate.stop();
  assert.equal(json.decision, 'block');
  assert.match(json.reason, /Command: python3 -m unittest discover \(Python project\)/);
  assert.match(json.reason, /Counts: 0 passed, 1 failed, 0 skipped/);
});

test('no way to find a test command: blocked, and the reason says how to set one', (t) => {
  const dir = project(t, { 'main.go': 'package main\n' }, null);
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 'main.go': 'package main\n\nfunc main() {}\n' });
  const { json } = gate.stop();
  assert.equal(json.decision, 'block');
  assert.match(json.reason, /add \{"testCommand": "<the command that runs your tests>"\} to \.greenwashing\.json in the project root/);
});

test('input that is not JSON: the stop is blocked, the prompt is never blocked', (t) => {
  const dir = project(t, { 't.test.js': NODE_PASS });
  const gate = session(t, dir);
  const stop = gate.raw('stop', 'not json');
  assert.equal(stop.json.decision, 'block');
  assert.match(stop.json.reason, /the gate failed: the hook input is not JSON/);
  const prompt = gate.raw('prompt', 'not json');
  assert.equal(prompt.code, 0);
  assert.equal(prompt.stdout, '');
});

test('the prompt hook prints nothing on stdout (it would reach the agent as context)', (t) => {
  const dir = project(t, { 't.test.js': NODE_PASS });
  const result = session(t, dir).prompt();
  assert.deepEqual([result.code, result.stdout], [0, '']);
});

test('a turn no Stop judged keeps its start: an interrupted turn, or one the gate sent back', (t) => {
  for (const cut of [() => {}, (gate) => assert.equal(gate.stop().json.decision, 'block')]) {
    const dir = project(t, { 't.test.js': NODE_PASS });
    const gate = session(t, dir);
    gate.prompt();
    write(dir, { 't.test.js': NODE_FAIL });
    cut(gate);
    // The user interrupts and writes again: the broken file is still this turn's change.
    gate.prompt();
    assert.equal(gate.stop().json.decision, 'block', cut.toString());
  }
});

test('after a Stop judged the turn (green, docs only, released), the next prompt takes a new start', (t) => {
  const green = project(t, { 't.test.js': NODE_FAIL });
  const one = session(t, green);
  one.prompt();
  write(green, { 't.test.js': NODE_PASS });
  assert.match(one.stop().json.systemMessage, /^greenwashing: tests passed/);
  one.prompt();
  assert.deepEqual(one.stop().json, NO_CHANGES);

  const docs = project(t, { 't.test.js': NODE_FAIL, 'README.md': 'a\n' });
  const two = session(t, docs);
  two.prompt();
  write(docs, { 'README.md': 'b\n' });
  assert.match(two.stop().json.systemMessage, /^greenwashing: only documentation changed/);
  two.prompt();
  assert.deepEqual(two.stop().json, NO_CHANGES);

  const released = project(t, { 't.test.js': NODE_PASS });
  const three = session(t, released);
  three.prompt();
  write(released, { 't.test.js': NODE_FAIL });
  for (const active of [false, true, true]) assert.equal(three.stop(active).json.decision, 'block');
  assert.match(three.stop(true).json.systemMessage, /WORK NOT ACCEPTED/);
  // A question after the red release: no file changes, so nothing to block.
  three.prompt();
  assert.deepEqual(three.stop().json, NO_CHANGES);
});

test('when the agent works in another worktree of the repository, that worktree is tested', (t) => {
  // Claude Code's default place for worktrees, which its docs say to add to .gitignore: then the
  // main checkout shows no change at all (code.claude.com/docs/en/worktrees).
  const dir = project(t, { 't.test.js': NODE_PASS, '.gitignore': '.claude/worktrees/\n' });
  const gate = session(t, dir);
  gate.prompt();
  const tree = path.join(dir, '.claude', 'worktrees', 'feat');
  git(dir, 'worktree', 'add', '-q', tree, '-b', 'feat');
  write(tree, { 't.test.js': NODE_FAIL });
  const blocked = gate.stop(false, tree).json;
  assert.equal(blocked.decision, 'block');
  assert.match(blocked.reason, /# fail 1/);
  write(tree, { 't.test.js': NODE_PASS });
  assert.match(gate.stop(true, tree).json.systemMessage, /^greenwashing: tests passed/);
  gate.prompt(tree);
  assert.deepEqual(gate.stop(false, tree).json, NO_CHANGES);
});

test('another repository inside the project (a submodule, a clone) never stands in for it', (t) => {
  const dir = project(t, { 't.test.js': NODE_PASS });
  const nested = path.join(dir, 'vendor', 'lib');
  write(nested, { '.greenwashing.json': JSON.stringify({ testCommand: GREEN_ECHO }) });
  git(nested, 'init', '-q');
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 't.test.js': NODE_FAIL });
  const { json } = gate.stop(false, nested);
  assert.equal(json.decision, 'block');
  assert.match(json.reason, /Command: node --test --test-reporter=tap t\.test\.js \(\.greenwashing\.json\)/);
});

test('the agent in a subfolder: the tests run from the project with its .greenwashing.json', (t) => {
  const dir = project(t, { 't.test.js': NODE_PASS, 'sub/.greenwashing.json': JSON.stringify({ testCommand: GREEN_ECHO }) });
  const gate = session(t, dir);
  const sub = path.join(dir, 'sub');
  gate.prompt(sub);
  write(dir, { 't.test.js': NODE_FAIL });
  const { json } = gate.stop(false, sub);
  assert.equal(json.decision, 'block');
  assert.match(json.reason, /Command: node --test --test-reporter=tap t\.test\.js \(\.greenwashing\.json\)/);
});

test('a project in a subfolder of its repository is tested from that subfolder, not the repository root', (t) => {
  const dir = project(t, {
    '.greenwashing.json': JSON.stringify({ testCommand: GREEN_ECHO }),
    'app/.greenwashing.json': JSON.stringify({ testCommand: NODE_CMD }),
    'app/t.test.js': NODE_PASS,
  }, null);
  const app = path.join(dir, 'app');
  const gate = session(t, app);
  gate.prompt();
  write(app, { 't.test.js': NODE_FAIL });
  const { json } = gate.stop();
  assert.equal(json.decision, 'block');
  assert.match(json.reason, /Counts: 0 passed, 1 failed, 0 skipped/);
});

test('outside a git repository with no test command, the stop is allowed with one line', (t) => {
  const dir = tempDir(t);
  write(dir, { 'main.go': 'package main\n' });
  const gate = session(t, dir);
  gate.prompt();
  assert.deepEqual(gate.stop().json, { systemMessage: 'greenwashing: not a git repository and no test command - tests not run' });
  // A broken config is a broken setup, not "nothing to test".
  write(dir, { '.greenwashing.json': '{"testCommand": ' });
  assert.equal(gate.stop().json.decision, 'block');
});

test('Python files git does not track yet make a Python project; outside git, a top-level .py does', (t) => {
  const dir = project(t, { 'data.json': '{}\n' }, null);
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 'tests/__init__.py': '', 'tests/test_a.py': PY_FAIL });
  const { json } = gate.stop();
  assert.equal(json.decision, 'block');
  assert.match(json.reason, /Command: python3 -m unittest discover \(Python project\)/);

  const plain = tempDir(t);
  write(plain, { 'test_a.py': PY_PASS });
  const other = session(t, plain);
  other.prompt();
  assert.deepEqual(other.stop().json, { systemMessage: 'greenwashing: tests passed - python3 -m unittest discover: 1 passed, 0 failed, 0 skipped' });
});

test('the tests run with CI=true, which test scripts check before they start a watch mode', (t) => {
  const dir = project(t, { 'ci.js': "if (process.env.CI === 'true') console.log('Ran 1 test in 0.1s\\n\\nOK');\n" }, 'node ci.js');
  const gate = session(t, dir, { env: { CI: 'false' } });
  gate.prompt();
  write(dir, { 'app.js': '1;\n' });
  assert.deepEqual(gate.stop().json, { systemMessage: 'greenwashing: tests passed - node ci.js: 1 passed, 0 failed, 0 skipped' });
});

test('the state folder is per user and private', (t) => {
  const dir = project(t, { 't.test.js': NODE_PASS });
  const gate = session(t, dir);
  gate.prompt();
  const folder = `greenwashing-gate-${process.getuid()}`;
  assert.deepEqual(fs.readdirSync(gate.tmp), [folder]);
  assert.equal(fs.statSync(path.join(gate.tmp, folder)).mode & 0o777, 0o700);
});

test('when the gate cannot keep its state, the prompt still goes through and the stop fails loudly', (t) => {
  const dir = project(t, { 'app.js': '1;\n' }, 'echo ok');
  const file = path.join(tempDir(t), 'not-a-folder');
  fs.writeFileSync(file, '');
  const gate = session(t, dir, { tmp: file });
  const prompt = gate.prompt();
  assert.deepEqual([prompt.code, prompt.stdout], [0, '']);
  assert.match(prompt.stderr, /could not record the start of the turn/);
  const stop = gate.stop();
  // Exit code 2 on Stop: Claude Code keeps the agent working and shows it stderr.
  assert.deepEqual([stop.code, stop.stdout], [2, '']);
  assert.match(stop.stderr, /^greenwashing gate failed: /);
});

test('two sessions in one project keep separate starts', (t) => {
  const dir = project(t, { 't.test.js': NODE_PASS });
  const tmp = tempDir(t);
  const first = session(t, dir, { id: 'first', tmp });
  const second = session(t, dir, { id: 'second', tmp });
  first.prompt();
  write(dir, { 't.test.js': NODE_FAIL });
  second.prompt();
  assert.equal(first.stop().json.decision, 'block');
  assert.deepEqual(second.stop().json, NO_CHANGES);
});

test('a repository with no commit yet: the first commit of the turn counts as a change', (t) => {
  const dir = tempDir(t);
  write(dir, { '.greenwashing.json': JSON.stringify({ testCommand: NODE_CMD }) });
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'gate@example.invalid');
  git(dir, 'config', 'user.name', 'gate');
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 't.test.js': NODE_FAIL });
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'first');
  assert.equal(gate.stop().json.decision, 'block');
});

test('documentation and code changed together: the tests run', (t) => {
  const dir = project(t, { 't.test.js': NODE_PASS, 'README.md': 'a\n' });
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 'README.md': 'b\n', 't.test.js': NODE_FAIL });
  assert.equal(gate.stop().json.decision, 'block');
});

test('a new file in a folder that was already untracked at the start counts as a change', (t) => {
  const dir = project(t, { 't.test.js': NODE_FAIL });
  write(dir, { 'extra/a.js': '1;\n' });
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 'extra/b.js': '2;\n' });
  assert.equal(gate.stop().json.decision, 'block');
});

test('a change the agent undoes after a block leaves the turn with nothing changed', (t) => {
  const dir = project(t, { 't.test.js': NODE_PASS });
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 't.test.js': NODE_FAIL });
  assert.equal(gate.stop().json.decision, 'block');
  write(dir, { 't.test.js': NODE_PASS });
  assert.deepEqual(gate.stop(true).json, NO_CHANGES);
});

test('when git cannot tell what changed, the tests run', (t) => {
  const dir = project(t, { 't.test.js': NODE_FAIL });
  const gate = session(t, dir);
  gate.prompt();
  fs.writeFileSync(path.join(dir, '.git', 'index'), 'not an index');
  assert.equal(gate.stop().json.decision, 'block');
});

test('a command killed after it printed green counts: did not run', (t) => {
  const dir = project(t, { 'app.js': '1;\n' }, `${GREEN_ECHO}; kill -9 $$`);
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 'app.js': '2;\n' });
  const { json } = gate.stop();
  assert.equal(json.decision, 'block');
  assert.match(json.reason, /the command exited with code 137 although no test failed/);
});

test('output over 64 MB is not read, even when it ends in green counts', (t) => {
  const dir = project(t, { 'app.js': '1;\n' }, `head -c ${64 * 1024 * 1024 + 1} /dev/zero; ${GREEN_ECHO}`);
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 'app.js': '2;\n' });
  const { json } = gate.stop();
  assert.equal(json.decision, 'block');
  assert.match(json.reason, /the output was larger than 67108864 bytes and was not read/);
});

test('when the hook itself is stopped, it stops the tests it started', async (t) => {
  const dir = project(t, { 'app.js': '1;\n' }, 'x');
  const started = path.join(dir, 'started-marker');
  const late = path.join(dir, 'late-marker');
  write(dir, { '.greenwashing.json': JSON.stringify({ testCommand: `touch ${JSON.stringify(started)}; sleep 2; touch ${JSON.stringify(late)}` }) });
  git(dir, 'commit', '-qam', 'config');
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 'app.js': '2;\n' });
  const hook = spawn(process.execPath, [HOOK, 'stop'], { env: gate.env, stdio: ['pipe', 'ignore', 'ignore'] });
  const exited = new Promise((resolve) => hook.on('exit', (code, signal) => resolve({ code, signal })));
  hook.stdin.end(JSON.stringify(gate.stopInput(false, dir)));
  for (let i = 0; i < 100 && !fs.existsSync(started); i += 1) await sleep(100);
  assert.ok(fs.existsSync(started), 'the tests never started');
  hook.kill('SIGTERM');
  assert.deepEqual(await exited, { code: 143, signal: null });
  await sleep(3000);
  assert.equal(fs.existsSync(late), false, 'the tests kept running after the hook was stopped');
});

test('one session id in two projects: each project keeps its own start', (t) => {
  const tmp = tempDir(t);
  const one = project(t, { 't.test.js': NODE_PASS });
  const two = project(t, { 't.test.js': NODE_PASS });
  const first = session(t, one, { tmp });
  session(t, two, { tmp }).prompt();
  first.prompt();
  session(t, two, { tmp }).prompt();
  assert.deepEqual(first.stop().json, NO_CHANGES);
});

test('a prompt that could not record its start leaves no older start behind: the tests run', (t) => {
  const dir = project(t, { 't.test.js': NODE_FAIL });
  const gate = session(t, dir);
  gate.prompt();
  assert.deepEqual(gate.stop().json, NO_CHANGES);
  const index = path.join(dir, '.git', 'index');
  const good = fs.readFileSync(index);
  fs.writeFileSync(index, 'not an index');
  assert.match(gate.prompt().stderr, /could not record the start of the turn/);
  fs.writeFileSync(index, good);
  assert.equal(gate.stop().json.decision, 'block');
});
