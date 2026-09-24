'use strict';
// Runs hook.js the way Claude Code does: a command with the hook JSON on stdin, in a real
// temporary git project, with real test runners (node --test, python3 -m unittest).
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOOK = path.join(__dirname, '..', 'hook.js');
const NODE_PASS = "const test = require('node:test');\ntest('ok', () => {});\n";
const NODE_FAIL = "const test = require('node:test');\nconst assert = require('node:assert');\ntest('bad', () => assert.equal(1, 2));\n";
const NODE_EMPTY = "const test = require('node:test');\ntest.skip('later', () => {});\n";
const NODE_CMD = 'node --test --test-reporter=tap t.test.js';

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

// One session per test: its own temp directory holds the gate's state. NODE_TEST_CONTEXT is
// dropped: node --test sets it in this file's process, and a node --test the gate starts with it
// refuses to run ("run() is being called recursively").
function session(t, dir) {
  const tmp = tempDir(t);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const call = (event, input) => {
    const result = spawnSync(process.execPath, [HOOK, event], {
      input: typeof input === 'string' ? input : JSON.stringify(input),
      encoding: 'utf8',
      env: { ...env, TMPDIR: tmp, CLAUDE_PROJECT_DIR: dir },
    });
    const text = result.stdout.trim();
    return { code: result.status, stdout: result.stdout, stderr: result.stderr, json: text ? JSON.parse(text) : null };
  };
  return {
    prompt: () => call('prompt', { session_id: 's', cwd: dir, hook_event_name: 'UserPromptSubmit', prompt: 'go' }),
    stop: (active = false) => call('stop', { session_id: 's', cwd: dir, hook_event_name: 'Stop', stop_hook_active: active }),
    raw: call,
  };
}

test('tests that fail block the stop, with command, counts, reason and output tail', (t) => {
  const dir = project(t, { 't.test.js': NODE_PASS });
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 't.test.js': NODE_FAIL });
  const { code, json } = gate.stop();
  assert.equal(code, 0);
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
  assert.equal(fourth.decision, undefined);
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
  const dir = project(t, {
    'tests/__init__.py': '',
    'tests/test_a.py': 'import unittest\n\n\nclass T(unittest.TestCase):\n    def test_a(self):\n        self.assertEqual(1, 1)\n',
  }, null);
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 'tests/test_a.py': 'import unittest\n\n\nclass T(unittest.TestCase):\n    def test_a(self):\n        self.assertEqual(1, 2)\n' });
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
