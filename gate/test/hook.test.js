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
const NODE_PASS = "const test = require('node:test');\nconst assert = require('node:assert');\ntest('ok', () => assert.equal(1 + 1, 2));\n";
// The same test as NODE_PASS, failing: a test edited in place, not one removed and another added (GW-17).
const NODE_FAIL = "const test = require('node:test');\nconst assert = require('node:assert');\ntest('ok', () => assert.equal(1, 2));\n";
const NODE_EMPTY = "const test = require('node:test');\ntest.skip('later', () => {});\n";
const NODE_CMD = 'node --test --test-reporter=tap t.test.js';
const PY_PASS = 'import unittest\n\n\nclass T(unittest.TestCase):\n    def test_a(self):\n        self.assertEqual(1 + 1, 2)\n';
const PY_FAIL = 'import unittest\n\n\nclass T(unittest.TestCase):\n    def test_a(self):\n        self.assertEqual(1, 2)\n';
// A command that prints the counts of a green unittest run without running anything.
const GREEN_ECHO = "printf 'Ran 1 test in 0.1s\\n\\nOK\\n'";
const NO_CHANGES = { systemMessage: 'greenwashing: no files changed this turn - tests not run' };
// The line of a turn in a project the gate cannot check.
const NOT_CHECKED = (why) => `greenwashing: this turn was NOT checked - ${why}, and the gate reads only the test output of pytest, unittest, jest, vitest and node --test. `
  + 'To have turns checked, a human sets {"testCommand": "<a command that runs your tests with one of them, or prints their output>"} in .greenwashing.json '
  + 'in the project root, between turns.';
// The line of a turn in a project that had no test command when the turn started and has one the gate checks now.
const FIRST_COMMAND = (command) => 'greenwashing: this turn was NOT checked - the project had no test command when the turn started. '
  + `The next turn will be checked with ${command}.`;
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
function project(t, files, testCommand = NODE_CMD, dir = tempDir(t)) {
  fs.mkdirSync(dir, { recursive: true });
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
    prompt: (cwd = dir, text = 'go') => call('prompt', { session_id: id, cwd, hook_event_name: 'UserPromptSubmit', prompt: text }),
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
  // The skip check is off, so the skipped test reaches the test run.
  const dir = project(t, { 't.test.js': NODE_PASS, '.greenwashing.json': JSON.stringify({ testCommand: NODE_CMD, checks: { skips: false } }) }, null);
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
  assert.ok(Date.now() - started < 5000, `the gate took ${Date.now() - started} ms for a 1 s timeout`);
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
  // A second Stop without a prompt still measures from the same start.
  assert.deepEqual(gate.stop().json, NO_CHANGES);
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
  // A second Stop without a prompt still measures from the start, not from "unknown".
  assert.deepEqual(gate.stop().json, NO_CHANGES);
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
  // Nothing tells which test lines changed either, and the user reads that the checks did not run.
  assert.match(gate.stop().json.systemMessage,
    /^greenwashing: tests passed - .*: 1 passed, 0 failed, 0 skipped; quick checks of changed tests not run \(not a git repository\)$/);
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
  // A project the gate checked when the work started, whose test script the turn removes.
  const dir = project(t, { 'package.json': '{"scripts": {"test": "node --test"}}', 'app.js': '1;\n' }, null);
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 'package.json': '{"scripts": {}}', 'app.js': '2;\n' });
  const { json } = gate.stop();
  assert.equal(json.decision, 'block');
  assert.match(json.reason, /a human adds \{"testCommand": "<the command that runs your tests>"\} to \.greenwashing\.json in the project root, between turns/);
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

test('after a Stop accepted the turn (green, docs only), the next prompt takes a new start; after WORK NOT ACCEPTED it does not', (t) => {
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
  // A question after the red release: the work the gate did not accept is still this turn's change.
  three.prompt();
  const again = three.stop().json;
  assert.equal(again.decision, 'block');
  assert.match(again.reason, /Counts: 0 passed, 1 failed, 0 skipped/);
  // Undone by the user between turns: nothing is left to test, and the next start is new.
  write(released, { 't.test.js': NODE_PASS });
  three.prompt();
  assert.deepEqual(three.stop().json, NO_CHANGES);
  write(released, { 't.test.js': NODE_FAIL });
  git(released, 'commit', '-qam', 'the user commits a red test between turns');
  three.prompt();
  assert.deepEqual(three.stop().json, NO_CHANGES);
});

test('after WORK NOT ACCEPTED, the findings of that turn block again in the next one', (t) => {
  const dir = project(t, { 'a.test.js': JEST_OK }, GREEN_ECHO);
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 'a.test.js': `${JEST_OK}it.skip('later', () => { expect(a).toBe(1); });\n` });
  for (const active of [false, true, true]) assert.equal(gate.stop(active).json.decision, 'block');
  assert.match(gate.stop(true).json.systemMessage, /CHECKS DID NOT PASS - WORK NOT ACCEPTED/);
  gate.prompt();
  assert.match(gate.stop().json.reason, /- a\.test\.js:4: it\.skip - the test does not run \(GW-17\)/);
});

test('the settings are measured from the start of each turn, while the work is measured from the last accepted state', (t) => {
  const config = (checks) => ({ '.greenwashing.json': JSON.stringify({ testCommand: GREEN_ECHO, ...(checks ? { checks } : {}) }) });
  const skip = `${JEST_OK}it.skip('later', () => { expect(a).toBe(1); });\n`;
  const dir = project(t, { 'a.test.js': JEST_OK }, GREEN_ECHO);
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 'a.test.js': skip });
  for (const active of [false, true, true]) assert.equal(gate.stop(active).json.decision, 'block');
  assert.match(gate.stop(true).json.systemMessage, /WORK NOT ACCEPTED/);
  // The user accepts the skip between turns: not a settings change of the turn, and the checks
  // use the new settings, so the old skip no longer blocks and the work is accepted.
  write(dir, config({ skips: false }));
  gate.prompt();
  assert.match(gate.stop().json.systemMessage, /^greenwashing: tests passed/);
  // The next turn starts from there: the user's settings and the skip are the start.
  gate.prompt();
  assert.deepEqual(gate.stop().json, NO_CHANGES);
  // The agent changes the settings during a turn: blocked, measured from that turn's start.
  write(dir, config({ skips: false, assertions: false }));
  assert.match(gate.stop().json.reason, /Changed: \.greenwashing\.json\n/);
});

test('settings changed between turns while unaccepted work stays: no GW-114, the work still blocks, and a change in the turn does', (t) => {
  const config = (checks) => ({ '.greenwashing.json': JSON.stringify({ testCommand: NODE_CMD, ...(checks ? { checks } : {}) }) });
  const dir = project(t, { 't.test.js': NODE_PASS }, NODE_CMD);
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 't.test.js': NODE_FAIL });
  for (const active of [false, true, true]) assert.equal(gate.stop(active).json.decision, 'block');
  assert.match(gate.stop(true).json.systemMessage, /TESTS DID NOT PASS - WORK NOT ACCEPTED/);
  write(dir, config({ assertions: false }));
  gate.prompt();
  const red = gate.stop().json;
  assert.match(red.reason, /the tests failed/);
  assert.doesNotMatch(red.reason, /GW-114/);
  // Put back during the turn: that is a change of the turn's settings.
  write(dir, config());
  assert.match(gate.stop(true).json.reason, /the gate's settings changed during this turn[^]*Changed: \.greenwashing\.json\n/);
  // Also when nothing else differs from the last accepted state: the user undid the work and changed
  // the settings between turns, and the agent puts the settings back.
  assert.equal(gate.stop(true).json.decision, 'block');
  assert.match(gate.stop(true).json.systemMessage, /WORK NOT ACCEPTED/);
  write(dir, { 't.test.js': NODE_PASS, ...config({ assertions: false }) });
  gate.prompt();
  write(dir, config());
  assert.match(gate.stop().json.reason, /Changed: \.greenwashing\.json\n/);
});

test("after WORK NOT ACCEPTED, the agent's settings change carried into the next turn still blocks, and the tests keep the settings the work started with", (t) => {
  const dir = project(t, { 't.test.js': NODE_PASS }, NODE_CMD);
  const gate = session(t, dir);
  gate.prompt();
  // The agent breaks a test and fakes the test command.
  write(dir, { 't.test.js': NODE_FAIL, '.greenwashing.json': JSON.stringify({ testCommand: GREEN_ECHO }) });
  for (const active of [false, true, true]) assert.match(gate.stop(active).json.reason, /Changed: \.greenwashing\.json\n/);
  assert.match(gate.stop(true).json.systemMessage, /WORK NOT ACCEPTED/);
  // The next prompt finds the settings as the last Stop saw them: the agent's change, not the user's.
  gate.prompt();
  assert.match(gate.stop().json.reason, /the gate's settings changed during this turn[^]*Changed: \.greenwashing\.json\n/);
  // A turn interrupted before any Stop changes nothing.
  gate.prompt();
  gate.prompt();
  assert.match(gate.stop().json.reason, /Changed: \.greenwashing\.json\n/);
  // Put back by the agent: nothing changed in the settings, and the tests run with the command the
  // work started with, not the fake one of the prompt's time.
  write(dir, { '.greenwashing.json': JSON.stringify({ testCommand: NODE_CMD }) });
  const red = gate.stop(true).json;
  assert.doesNotMatch(red.reason, /GW-114/);
  assert.match(red.reason, /Counts: 0 passed, 1 failed, 0 skipped/);
});

test('after WORK NOT ACCEPTED with a settings change of the agent, the user changing the file between turns makes it theirs', (t) => {
  const config = (extra) => ({ '.greenwashing.json': JSON.stringify({ testCommand: NODE_CMD, ...extra }) });
  const dir = project(t, { 't.test.js': NODE_PASS }, NODE_CMD);
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 't.test.js': NODE_FAIL, ...config({ checks: { skips: false } }) });
  for (const active of [false, true, true]) assert.equal(gate.stop(active).json.decision, 'block');
  assert.match(gate.stop(true).json.systemMessage, /WORK NOT ACCEPTED/);
  // The user writes the file between turns: it differs from what the last Stop saw, so it is theirs.
  write(dir, config({ timeoutSeconds: 60 }));
  gate.prompt();
  const red = gate.stop().json;
  assert.doesNotMatch(red.reason, /GW-114/);
  assert.match(red.reason, /Counts: 0 passed, 1 failed, 0 skipped/);
  // The agent changes it in that turn: measured from the user's version.
  write(dir, config({ timeoutSeconds: 60, checks: { skips: false } }));
  assert.match(gate.stop(true).json.reason, /Changed: \.greenwashing\.json\n/);
});

test('after WORK NOT ACCEPTED, a .greenwashing.json git ignores: the agent\'s change still blocks, the user\'s between turns does not', (t) => {
  const dir = project(t, { 't.test.js': NODE_PASS, '.gitignore': '.greenwashing.json\n' }, null);
  const settings = (extra) => ({ '.greenwashing.json': JSON.stringify({ testCommand: NODE_CMD, ...extra }) });
  write(dir, settings());
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 't.test.js': NODE_FAIL, ...settings({ timeoutSeconds: 30 }) });
  for (const active of [false, true, true]) assert.match(gate.stop(active).json.reason, /Changed: \.greenwashing\.json\n/);
  assert.match(gate.stop(true).json.systemMessage, /WORK NOT ACCEPTED/);
  gate.prompt();
  assert.match(gate.stop().json.reason, /Changed: \.greenwashing\.json\n/);
  for (const active of [true, true]) assert.equal(gate.stop(active).json.decision, 'block');
  assert.match(gate.stop(true).json.systemMessage, /WORK NOT ACCEPTED/);
  // The user writes it between turns: git does not list the file, and it is still seen as theirs.
  write(dir, settings({ timeoutSeconds: 60 }));
  gate.prompt();
  const red = gate.stop().json;
  assert.doesNotMatch(red.reason, /GW-114/);
  assert.match(red.reason, /Counts: 0 passed, 1 failed, 0 skipped/);
});

// Stops until the gate lets the turn go as WORK NOT ACCEPTED.
function release(gate, cwd) {
  for (const active of [false, true, true]) assert.equal(gate.stop(active, cwd).json.decision, 'block');
  assert.match(gate.stop(true, cwd).json.systemMessage, /WORK NOT ACCEPTED/);
}

test('after WORK NOT ACCEPTED, each settings file is judged alone: the user changing another one does not make the agent\'s change theirs', (t) => {
  const dir = project(t, { 't.test.js': NODE_PASS, 'pkg/.greenwashing.json': JSON.stringify({ timeoutSeconds: 100 }) }, NODE_CMD);
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 't.test.js': NODE_FAIL, '.greenwashing.json': JSON.stringify({ testCommand: GREEN_ECHO }) });
  release(gate);
  // The user changes the package's file between turns, not the root one.
  write(dir, { 'pkg/.greenwashing.json': JSON.stringify({ timeoutSeconds: 200 }) });
  gate.prompt();
  assert.match(gate.stop().json.reason, /Changed: \.greenwashing\.json\n/);
  // The agent puts the root file back: the command the work started with runs.
  write(dir, { '.greenwashing.json': JSON.stringify({ testCommand: NODE_CMD }) });
  assert.match(gate.stop(true).json.reason, /Counts: 0 passed, 1 failed, 0 skipped/);
});

test('after WORK NOT ACCEPTED, the project\'s own settings the user changes are used while another file of the tree is carried', (t) => {
  const dir = project(t, { 't.test.js': NODE_PASS, 'pkg/.greenwashing.json': JSON.stringify({ timeoutSeconds: 100 }) }, NODE_CMD);
  const gate = session(t, dir);
  gate.prompt();
  // The agent commits its change: the earlier state of the package's file is in the commit before.
  write(dir, { 't.test.js': NODE_FAIL, 'pkg/.greenwashing.json': JSON.stringify({ timeoutSeconds: 5 }) });
  git(dir, 'commit', '-qam', 'the agent commits');
  release(gate);
  const serial = NODE_CMD.replace('--test-reporter=tap', '--test-reporter=tap --test-concurrency=1');
  write(dir, { '.greenwashing.json': JSON.stringify({ testCommand: serial }) });
  gate.prompt();
  assert.match(gate.stop().json.reason, /Changed: pkg\/\.greenwashing\.json\n/);
  write(dir, { 'pkg/.greenwashing.json': JSON.stringify({ timeoutSeconds: 100 }) });
  assert.match(gate.stop(true).json.reason, /Command: node --test --test-reporter=tap --test-concurrency=1 t\.test\.js /);
});

test('after a turn cut off before its Stop, the settings are judged against the prompt of that turn, not an older Stop', (t) => {
  const s0 = JSON.stringify({ testCommand: NODE_CMD });
  const dir = project(t, { 't.test.js': NODE_PASS }, NODE_CMD);
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 't.test.js': NODE_FAIL });
  release(gate);
  // The user turns the skip check off between turns, then puts the file back before the next prompt;
  // the turn in between was cut off before any Stop.
  write(dir, { '.greenwashing.json': JSON.stringify({ testCommand: NODE_CMD, checks: { skips: false } }) });
  gate.prompt();
  write(dir, { '.greenwashing.json': s0 });
  gate.prompt();
  const red = gate.stop().json;
  assert.doesNotMatch(red.reason, /GW-114/);
  assert.match(red.reason, /Counts: 0 passed, 1 failed, 0 skipped/);
});

test('a worktree entered after the prompt with the user\'s own settings change blocks in that turn only', (t) => {
  const { dir, tree } = withWorktree(t);
  write(tree, { '.greenwashing.json': JSON.stringify({ testCommand: NODE_CMD, timeoutSeconds: 90 }) });
  const gate = session(t, dir);
  gate.prompt(dir);
  write(tree, { 't.test.js': NODE_FAIL });
  assert.match(gate.stop(false, tree).json.reason, /Changed: \.claude\/worktrees\/feat\/\.greenwashing\.json\n/);
  for (const active of [true, true]) assert.equal(gate.stop(active, tree).json.decision, 'block');
  assert.match(gate.stop(true, tree).json.systemMessage, /WORK NOT ACCEPTED/);
  gate.prompt(tree);
  write(tree, { 't.test.js': NODE_PASS });
  assert.match(gate.stop(false, tree).json.systemMessage, /^greenwashing: tests passed/);
});

test("after WORK NOT ACCEPTED, the project's settings the user changes between turns are used while a worktree's change of the agent is carried", (t) => {
  const { tree, gate } = seenWorktree(t);
  const dir = path.dirname(path.dirname(path.dirname(tree)));
  write(tree, { '.greenwashing.json': JSON.stringify({ testCommand: GREEN_ECHO }), 't.test.js': NODE_FAIL });
  release(gate, tree);
  const serial = `${NODE_CMD.replace('--test-reporter=tap', '--test-reporter=tap --test-concurrency=1')}`;
  write(dir, { '.greenwashing.json': JSON.stringify({ testCommand: serial }) });
  gate.prompt(tree);
  assert.match(gate.stop(false, tree).json.reason, /Changed: \.claude\/worktrees\/feat\/\.greenwashing\.json\n/);
  write(tree, { '.greenwashing.json': JSON.stringify({ testCommand: NODE_CMD }) });
  const red = gate.stop(true, tree).json.reason;
  assert.match(red, /Command: node --test --test-reporter=tap --test-concurrency=1 t\.test\.js /);
  assert.match(red, /Counts: 0 passed, 1 failed, 0 skipped/);
});

test("after WORK NOT ACCEPTED, a worktree's settings change of the agent still blocks; the user's between turns does not", (t) => {
  const { dir, tree, gate } = seenWorktree(t);
  write(tree, { '.greenwashing.json': JSON.stringify({ testCommand: GREEN_ECHO }), 'app.js': '1;\n' });
  for (const active of [false, true, true]) {
    assert.match(gate.stop(active, tree).json.reason, /Changed: \.claude\/worktrees\/feat\/\.greenwashing\.json\n/);
  }
  assert.match(gate.stop(true, tree).json.systemMessage, /WORK NOT ACCEPTED/);
  gate.prompt(tree);
  assert.match(gate.stop(false, tree).json.reason, /Changed: \.claude\/worktrees\/feat\/\.greenwashing\.json\n/);
  assert.match(gate.stop(true, tree).json.reason, /Changed: \.claude\/worktrees\/feat\/\.greenwashing\.json\n/);
  assert.match(gate.stop(true, tree).json.reason, /Changed: \.claude\/worktrees\/feat\/\.greenwashing\.json\n/);
  assert.match(gate.stop(true, tree).json.systemMessage, /WORK NOT ACCEPTED/);
  // The user sets the worktree's file between turns; the project's is unchanged all along.
  write(tree, { '.greenwashing.json': JSON.stringify({ testCommand: NODE_CMD, timeoutSeconds: 60 }) });
  gate.prompt(tree);
  assert.match(gate.stop(false, tree).json.systemMessage, /^greenwashing: tests passed/);
  assert.equal(fs.readFileSync(path.join(dir, '.greenwashing.json'), 'utf8'), JSON.stringify({ testCommand: NODE_CMD }));
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
  write(tree, { 't.test.js': `${NODE_PASS}// fixed\n` });
  assert.match(gate.stop(true, tree).json.systemMessage, /^greenwashing: tests passed - .* in \.claude\/worktrees\/feat: 1 passed/);
  gate.prompt(tree);
  assert.deepEqual(gate.stop(false, tree).json, NO_CHANGES);
});

// A committed project whose worktrees folder is ignored, as Claude Code's docs advise, and one
// worktree of it made before the turn starts.
function withWorktree(t, files = { 't.test.js': NODE_PASS }) {
  const dir = project(t, { ...files, '.gitignore': '.claude/worktrees/\n' });
  const tree = path.join(dir, '.claude', 'worktrees', 'feat');
  git(dir, 'worktree', 'add', '-q', tree, '-b', 'feat');
  return { dir, tree };
}

test('the project is checked too when the agent ends the turn in a clean worktree', (t) => {
  const { dir, tree } = withWorktree(t);
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 't.test.js': NODE_FAIL });
  const { json } = gate.stop(false, tree);
  assert.equal(json.decision, 'block');
  assert.doesNotMatch(json.reason, /Folder:/);
});

test('a turn that starts in a worktree still checks the project, wherever the agent stops', (t) => {
  const { dir, tree } = withWorktree(t);
  const gate = session(t, dir);
  gate.prompt(tree);
  write(dir, { 't.test.js': NODE_FAIL });
  assert.equal(gate.stop(false, tree).json.decision, 'block');
  assert.equal(gate.stop(true, dir).json.decision, 'block');
});

test('a worktree the agent worked in is still checked after it leaves it', (t) => {
  const dir = project(t, { 't.test.js': NODE_PASS, '.gitignore': '.claude/worktrees/\n' });
  const gate = session(t, dir);
  gate.prompt();
  const tree = path.join(dir, '.claude', 'worktrees', 'feat');
  git(dir, 'worktree', 'add', '-q', tree, '-b', 'feat');
  write(tree, { 't.test.js': NODE_FAIL });
  assert.equal(gate.stop(false, tree).json.decision, 'block');
  const { json } = gate.stop(true, dir);
  assert.equal(json.decision, 'block');
  assert.match(json.reason, /\nFolder: \.claude\/worktrees\/feat\n/);
});

test('a worktree that is clean and on the commit it had at the start is not a change', (t) => {
  const { dir, tree } = withWorktree(t);
  write(tree, { 't.test.js': NODE_FAIL });
  git(tree, 'commit', '-qam', 'old broken work');
  const gate = session(t, dir);
  gate.prompt();
  // The agent only goes into the worktree of an old branch whose tests fail.
  assert.deepEqual(gate.stop(false, tree).json, NO_CHANGES);
  write(tree, { 't.test.js': `${NODE_FAIL}// touched\n` });
  assert.equal(gate.stop(false, tree).json.decision, 'block');
  // Committed: the worktree is clean again, but no longer on the commit it had at the start.
  git(tree, 'commit', '-qam', 'more broken work');
  assert.equal(gate.stop(false, tree).json.decision, 'block');
});

test('a turn that starts in a worktree records the start of the project too', (t) => {
  const { dir, tree } = withWorktree(t, { 't.test.js': NODE_PASS, 'app.js': '1;\n' });
  // The project already had an edit when the turn started; the agent changes nothing.
  write(dir, { 'app.js': '2;\n' });
  const gate = session(t, dir);
  gate.prompt(tree);
  assert.deepEqual(gate.stop(false, tree).json, NO_CHANGES);
});

test('a turn interrupted in a worktree keeps that worktree for the next prompt', (t) => {
  const dir = project(t, { 't.test.js': NODE_PASS, '.gitignore': '.claude/worktrees/\n' });
  const gate = session(t, dir);
  gate.prompt();
  const tree = path.join(dir, '.claude', 'worktrees', 'feat');
  git(dir, 'worktree', 'add', '-q', tree, '-b', 'feat');
  write(tree, { 't.test.js': NODE_FAIL });
  // No Stop: the user interrupts while the agent is in the worktree, then writes again.
  gate.prompt(tree);
  assert.equal(gate.stop(false, dir).json.decision, 'block');
});

test('a worktree added to look at a branch or a commit that existed before the turn is not a change', (t) => {
  const dir = project(t, { 't.test.js': NODE_FAIL, '.gitignore': '.claude/worktrees/\n' });
  const red = git(dir, 'rev-parse', 'HEAD').trim();
  write(dir, { 't.test.js': `${NODE_FAIL}// old\n` });
  git(dir, 'commit', '-qam', 'still red');
  git(dir, 'branch', 'old');
  write(dir, { 't.test.js': NODE_PASS });
  git(dir, 'commit', '-qam', 'green');
  // A worktree detached at a red commit no branch points at, there before the turn: known by its HEAD only.
  const detached = path.join(dir, '.claude', 'worktrees', 'detached');
  git(dir, 'worktree', 'add', '-q', '--detach', detached, red);
  const gate = session(t, dir);
  gate.prompt();
  assert.deepEqual(gate.stop(false, detached).json, NO_CHANGES);
  // A new worktree of a branch whose tests fail, made only to look at it: known as a branch tip only.
  const old = path.join(dir, '.claude', 'worktrees', 'old');
  git(dir, 'worktree', 'add', '-q', old, 'old');
  assert.deepEqual(gate.stop(false, old).json, NO_CHANGES);
});

test('a worktree the agent is in at the prompt measures from that prompt, with its own edits at the start', (t) => {
  const { dir, tree } = withWorktree(t);
  write(tree, { 't.test.js': NODE_FAIL });
  const gate = session(t, dir);
  gate.prompt(tree);
  assert.deepEqual(gate.stop(false, tree).json, NO_CHANGES);
});

test('a commit in a worktree during an interrupted turn stays a change after the next prompt', (t) => {
  const { dir, tree } = withWorktree(t);
  const gate = session(t, dir);
  gate.prompt();
  write(tree, { 't.test.js': NODE_FAIL });
  git(tree, 'commit', '-qam', 'red');
  gate.prompt(tree);
  assert.equal(gate.stop(false, tree).json.decision, 'block');
});

test('a worktree seen at an allowed Stop is still checked when another Stop hook keeps the turn going', (t) => {
  const { dir, tree } = withWorktree(t);
  const gate = session(t, dir);
  gate.prompt();
  assert.deepEqual(gate.stop(false, tree).json, NO_CHANGES);
  write(tree, { 't.test.js': NODE_FAIL });
  assert.equal(gate.stop(true, dir).json.decision, 'block');
});

test('the project folder missing in a worktree is did not run, and the worktree stays checked', (t) => {
  const repo = project(t, { 'app/t.test.js': NODE_PASS, 'app/.greenwashing.json': JSON.stringify({ testCommand: NODE_CMD }), '.gitignore': '.claude/worktrees/\n' }, null);
  const main = git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
  git(repo, 'checkout', '-q', '--orphan', 'other');
  git(repo, 'rm', '-rq', '--cached', '.');
  write(repo, { 'other.txt': 'x\n' });
  git(repo, 'add', 'other.txt');
  git(repo, 'commit', '-qm', 'other');
  git(repo, 'checkout', '-q', '-f', main);
  const tree = path.join(repo, '.claude', 'worktrees', 'other');
  git(repo, 'worktree', 'add', '-q', tree, 'other');
  const app = path.join(repo, 'app');
  const gate = session(t, app);
  gate.prompt();
  write(tree, { 'other.txt': 'y\n' });
  const { json } = gate.stop(false, tree);
  assert.equal(json.decision, 'block');
  assert.match(json.reason, /\nFolder: \.\.\/\.claude\/worktrees\/other\/app\nResult: did not run - the project's folder is missing there/);
  assert.equal(gate.stop(true, app).json.decision, 'block');
});

test('the tests stop at the first tree that is not green', (t) => {
  const dir = project(t, { 't.test.js': NODE_PASS, '.gitignore': '.claude/worktrees/\ngate.ran\n' }, `touch gate.ran; ${NODE_CMD}`);
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 't.test.js': NODE_FAIL });
  const tree = path.join(dir, '.claude', 'worktrees', 'feat');
  git(dir, 'worktree', 'add', '-q', tree, '-b', 'feat');
  write(tree, { 'app.js': '1;\n' });
  assert.equal(gate.stop(false, tree).json.decision, 'block');
  assert.deepEqual([fs.existsSync(path.join(dir, 'gate.ran')), fs.existsSync(path.join(tree, 'gate.ran'))], [true, false]);
});

test("a worktree's own .greenwashing.json is ignored: its tests run with the project's settings, and the message says so", (t) => {
  const { dir, tree } = withWorktree(t);
  write(dir, { '.greenwashing.json': JSON.stringify({ testCommand: GREEN_ECHO, timeoutSeconds: 20 }) });
  git(dir, 'commit', '-qam', 'fast');
  write(tree, { '.greenwashing.json': JSON.stringify({ testCommand: `sleep 3; ${GREEN_ECHO}`, timeoutSeconds: 2 }) });
  git(tree, 'commit', '-qam', 'slow, 2 s timeout');
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 'app.js': '1;\n' });
  write(tree, { 'app.js': '2;\n' });
  assert.equal(gate.stop(false, tree).json.systemMessage, "greenwashing: tests passed - printf 'Ran 1 test in 0.1s\\n\\nOK\\n': 1 passed, 0 failed, 0 skipped; "
    + "printf 'Ran 1 test in 0.1s\\n\\nOK\\n' in .claude/worktrees/feat (its own .greenwashing.json ignored): 1 passed, 0 failed, 0 skipped");
  // Red in the worktree: the block says it too.
  write(tree, { 't.test.js': NODE_FAIL, '.greenwashing.json': JSON.stringify({ testCommand: GREEN_ECHO }) });
  git(tree, 'commit', '-qam', 'red, and a green echo of its own');
  write(dir, { '.greenwashing.json': JSON.stringify({ testCommand: NODE_CMD }) });
  git(dir, 'commit', '-qam', 'node');
  gate.prompt();
  write(dir, { 'app.js': '3;\n' });
  write(tree, { 'app.js': '4;\n' });
  const { json } = gate.stop(false, tree);
  assert.match(json.reason, /\nFolder: \.claude\/worktrees\/feat\nSettings: the project folder's; the \.greenwashing\.json in this folder is ignored\n/);
  assert.match(json.reason, /Counts: 0 passed, 1 failed, 0 skipped/);
});

test("the checks in a worktree use the project's settings, not the worktree's own", (t) => {
  const { dir, tree } = withWorktree(t, { 'a.test.js': JEST_OK });
  write(dir, { '.greenwashing.json': JSON.stringify({ testCommand: GREEN_ECHO }) });
  git(dir, 'commit', '-qam', 'green echo');
  git(tree, 'merge', '-q', 'master');
  write(tree, { '.greenwashing.json': JSON.stringify({ testCommand: GREEN_ECHO, checks: { skips: false } }) });
  git(tree, 'commit', '-qam', 'skips off on the branch');
  const gate = session(t, dir);
  gate.prompt(tree);
  write(tree, { 'a.test.js': `${JEST_OK}xit('later', () => {});\n` });
  assert.match(gate.stop(false, tree).json.reason, /- \.claude\/worktrees\/feat\/a\.test\.js:4: xit - the test does not run \(GW-17\)/);
});

test("an ignored .greenwashing.json in a worktree changes nothing: not a settings change, not used, and said", (t) => {
  const dir = project(t, { 'a.test.js': JEST_OK, '.gitignore': '.claude/worktrees/\n.greenwashing.json\n' }, null);
  const tree = path.join(dir, '.claude', 'worktrees', 'feat');
  git(dir, 'worktree', 'add', '-q', tree, '-b', 'feat');
  write(dir, { '.greenwashing.json': JSON.stringify({ testCommand: GREEN_ECHO }) });
  write(tree, { '.greenwashing.json': JSON.stringify({ testCommand: 'true' }) });
  const gate = session(t, dir);
  gate.prompt(tree);
  write(tree, { '.greenwashing.json': JSON.stringify({ testCommand: 'false' }), 'app.js': '1;\n' });
  assert.match(gate.stop(false, tree).json.systemMessage,
    /^greenwashing: tests passed - .* in \.claude\/worktrees\/feat \(its own \.greenwashing\.json ignored\): 1 passed/);
  // Committed there and the worktree removed: its commit is no settings change either.
  git(tree, 'add', 'app.js');
  git(tree, 'commit', '-qm', 'app');
  git(dir, 'worktree', 'remove', '--force', tree);
  assert.match(gate.stop(true, dir).json.systemMessage, /^greenwashing: tests passed - .* in a temporary checkout of /);
});

// The temporary checkouts the gate made and has not removed: folders in the session's temp
// directory, or worktrees git still lists.
function leftovers(gate, dir) {
  const folders = fs.readdirSync(gate.tmp).filter((name) => name.startsWith('greenwashing-gate-check-'));
  const listed = git(dir, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.includes('greenwashing-gate-check-'));
  return [...folders, ...listed];
}

// A project and a worktree of it on branch feat, both seen by the gate at the prompt.
function seenWorktree(t, files = { 't.test.js': NODE_PASS }, testCommand = NODE_CMD) {
  const dir = project(t, { ...files, '.gitignore': '.claude/worktrees/\n' }, testCommand);
  const tree = path.join(dir, '.claude', 'worktrees', 'feat');
  git(dir, 'worktree', 'add', '-q', tree, '-b', 'feat');
  const gate = session(t, dir);
  gate.prompt(tree);
  return { dir, tree, gate };
}

test('a worktree removed after a red commit: that commit is tested in a temporary checkout, and blocks', (t) => {
  const { dir, tree, gate } = seenWorktree(t);
  write(tree, { 't.test.js': NODE_FAIL });
  git(tree, 'commit', '-qam', 'red');
  const red = git(tree, 'rev-parse', 'HEAD').trim();
  git(dir, 'worktree', 'remove', tree);
  const { json } = gate.stop(false, dir);
  assert.equal(json.decision, 'block');
  assert.match(json.reason, new RegExp(`\\nFolder: a temporary checkout of ${red.slice(0, 12)} \\(branch feat\\), the last commit of the removed worktree \\.claude/worktrees/feat\\nResult: failed - 1 failed`));
  assert.deepEqual(leftovers(gate, dir), []);
});

test('a worktree removed after a green commit: the temporary checkout passes and the stop is allowed', (t) => {
  const { dir, tree, gate } = seenWorktree(t);
  write(tree, { 't.test.js': `${NODE_PASS}// more\n` });
  git(tree, 'commit', '-qam', 'green');
  git(dir, 'worktree', 'remove', tree);
  assert.match(gate.stop(false, dir).json.systemMessage,
    /^greenwashing: tests passed - node --test --test-reporter=tap t\.test\.js in a temporary checkout of [0-9a-f]{12} \(branch feat\), the last commit of the removed worktree \.claude\/worktrees\/feat: 1 passed, 0 failed, 0 skipped$/);
  assert.deepEqual(leftovers(gate, dir), []);
});

test('a removed worktree whose branch the project merged is not tested again', (t) => {
  const log = path.join(tempDir(t), 'ran-in');
  const { dir, tree, gate } = seenWorktree(t, { 't.test.js': NODE_PASS }, `pwd >> ${JSON.stringify(log)}; ${NODE_CMD}`);
  write(tree, { 't.test.js': `${NODE_PASS}// more\n` });
  git(tree, 'commit', '-qam', 'green');
  git(dir, 'merge', '-q', 'feat');
  git(dir, 'worktree', 'remove', tree);
  assert.match(gate.stop(false, dir).json.systemMessage, /^greenwashing: tests passed - pwd >> .*: 1 passed, 0 failed, 0 skipped$/);
  // The project ran its tests for the merge; nothing ran in a temporary checkout.
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), [fs.realpathSync(dir)]);
});

test('a removed worktree whose commit cannot be tested: did not run, and the checkout is still removed', (t) => {
  const packageJson = JSON.stringify({ name: 'demo', scripts: { test: 'node --test --test-reporter=tap' } });
  const { dir, tree, gate } = seenWorktree(t, { 't.test.js': NODE_PASS, 'package.json': packageJson }, null);
  write(tree, { 'package.json': '{"scripts": ' });
  git(tree, 'commit', '-qam', 'broken package.json');
  git(dir, 'worktree', 'remove', tree);
  const { json } = gate.stop(false, dir);
  assert.equal(json.decision, 'block');
  assert.match(json.reason, /Result: did not run - package\.json is not valid JSON/);
  assert.deepEqual(leftovers(gate, dir), []);
});

test('a removed worktree whose commit changed .greenwashing.json: blocked before any test runs (GW-114)', (t) => {
  const { dir, tree, gate } = seenWorktree(t);
  write(tree, { '.greenwashing.json': JSON.stringify({ testCommand: GREEN_ECHO }) });
  git(tree, 'commit', '-qam', 'green on paper');
  git(dir, 'worktree', 'remove', tree);
  const { json } = gate.stop(false, dir);
  assert.equal(json.decision, 'block');
  assert.match(json.reason, /the gate's settings changed during this turn/);
  assert.match(json.reason, /Changed: \.greenwashing\.json \(last commit of the removed worktree \.claude\/worktrees\/feat\)/);
  assert.match(json.reason, /See GW-114 in /);
  assert.deepEqual(leftovers(gate, dir), []);
});

test('a removed worktree whose branch and commits are gone: did not run', (t) => {
  const { dir, tree, gate } = seenWorktree(t);
  write(tree, { 't.test.js': NODE_FAIL });
  git(tree, 'commit', '-qam', 'red');
  // The gate sees the red commit, then the worktree, its branch and the commit disappear.
  assert.equal(gate.stop(false, tree).json.decision, 'block');
  git(dir, 'worktree', 'remove', tree);
  git(dir, 'branch', '-q', '-D', 'feat');
  git(dir, 'reflog', 'expire', '--expire=now', '--all');
  git(dir, 'gc', '-q', '--prune=now');
  const { json } = gate.stop(true, dir);
  assert.equal(json.decision, 'block');
  assert.match(json.reason, /Result: did not run - the worktree \.claude\/worktrees\/feat was removed and the commit it left cannot be found/);
});

test('a removed worktree of an old branch it did not change leaves nothing to test', (t) => {
  const dir = project(t, { 't.test.js': NODE_PASS, '.gitignore': '.claude/worktrees/\n' });
  const tree = path.join(dir, '.claude', 'worktrees', 'old');
  git(dir, 'worktree', 'add', '-q', tree, '-b', 'old');
  write(tree, { 't.test.js': NODE_FAIL });
  git(tree, 'commit', '-qam', 'old red work, not in the project');
  const gate = session(t, dir);
  gate.prompt(tree);
  git(dir, 'worktree', 'remove', tree);
  assert.deepEqual(gate.stop(false, dir).json, NO_CHANGES);
});

test('a removed worktree whose branch was deleted, its commit kept on another branch: that commit is tested', (t) => {
  const { dir, tree, gate } = seenWorktree(t);
  write(tree, { 't.test.js': NODE_FAIL });
  git(tree, 'commit', '-qam', 'red');
  const red = git(tree, 'rev-parse', 'HEAD').trim();
  assert.equal(gate.stop(false, tree).json.decision, 'block');
  git(dir, 'branch', 'keep', 'feat');
  git(dir, 'worktree', 'remove', tree);
  git(dir, 'branch', '-q', '-D', 'feat');
  const { json } = gate.stop(true, dir);
  assert.equal(json.decision, 'block');
  assert.match(json.reason, new RegExp(`\\nFolder: a temporary checkout of ${red.slice(0, 12)} \\(no branch\\), the last commit of the removed worktree`));
  assert.match(json.reason, /Result: failed - 1 failed/);
});

test('a discarded experiment - worktree removed, branch deleted, nothing holds the commit - leaves nothing to test', (t) => {
  const { dir, tree, gate } = seenWorktree(t);
  write(tree, { 't.test.js': NODE_FAIL });
  git(tree, 'commit', '-qam', 'red experiment');
  assert.equal(gate.stop(false, tree).json.decision, 'block');
  git(dir, 'worktree', 'remove', tree);
  git(dir, 'branch', '-q', '-D', 'feat');
  assert.deepEqual(gate.stop(true, dir).json, NO_CHANGES);
});

test('a detached worktree whose red commit another branch keeps is tested when removed', (t) => {
  const dir = project(t, { 't.test.js': NODE_PASS, '.gitignore': '.claude/worktrees/\n' });
  const tree = path.join(dir, '.claude', 'worktrees', 'loose');
  git(dir, 'worktree', 'add', '-q', '--detach', tree);
  const gate = session(t, dir);
  gate.prompt(tree);
  write(tree, { 't.test.js': NODE_FAIL });
  git(tree, 'commit', '-qam', 'red');
  assert.equal(gate.stop(false, tree).json.decision, 'block');
  git(tree, 'branch', 'keep');
  git(dir, 'worktree', 'remove', tree);
  const { json } = gate.stop(true, dir);
  assert.equal(json.decision, 'block');
  assert.match(json.reason, /\(no branch\), the last commit of the removed worktree \.claude\/worktrees\/loose\nResult: failed - 1 failed/);
});

test("a removed worktree's commit shares the stop's timeout with the project's own run", (t) => {
  const config = JSON.stringify({ testCommand: `sleep 2; ${GREEN_ECHO}`, timeoutSeconds: 3 });
  const { dir, tree, gate } = seenWorktree(t, { 'app.js': '1;\n', '.greenwashing.json': config }, null);
  write(tree, { 'app.js': '2;\n' });
  git(tree, 'commit', '-qam', 'work');
  git(dir, 'worktree', 'remove', tree);
  write(dir, { 'app.js': '3;\n' });
  // Each run alone is green in 2 s; the project's and the removed worktree's do not fit in 3 s.
  assert.equal(gate.stop(false, dir).json.decision, 'block');
  assert.deepEqual(leftovers(gate, dir), []);
});

test('a commit that cannot be checked out: did not run, and no checkout is left', (t) => {
  const { dir, tree, gate } = seenWorktree(t);
  write(tree, { 't.test.js': `${NODE_PASS}// more\n` });
  git(tree, 'commit', '-qam', 'green');
  git(dir, 'worktree', 'remove', tree);
  // A post-checkout hook that fails makes `git worktree add` fail for the gate's checkout.
  write(dir, { '.git/hooks/post-checkout': '#!/bin/sh\nexit 1\n' });
  fs.chmodSync(path.join(dir, '.git', 'hooks', 'post-checkout'), 0o755);
  const { json } = gate.stop(false, dir);
  assert.equal(json.decision, 'block');
  assert.match(json.reason, /Result: did not run - commit [0-9a-f]{40} could not be checked out/);
  assert.deepEqual(leftovers(gate, dir), []);
});

test('a worktree git no longer knows (its .git file moved away): which lines changed cannot be told, so the checks did not run', (t) => {
  const { dir, tree, gate } = seenWorktree(t);
  write(tree, { 't.test.js': NODE_FAIL });
  fs.renameSync(path.join(tree, '.git'), path.join(tree, 'moved-git-file'));
  const { json } = gate.stop(false, dir);
  assert.equal(json.decision, 'block');
  assert.match(json.reason, /Result: did not run - git cannot tell which lines changed in \.claude\/worktrees\/feat/);
});

test("a merged branch is judged again when the project's HEAD moves back", (t) => {
  const { dir, tree, gate } = seenWorktree(t);
  const start = git(dir, 'rev-parse', 'HEAD').trim();
  write(tree, { 't.test.js': NODE_FAIL });
  git(tree, 'commit', '-qam', 'red');
  git(dir, 'merge', '-q', 'feat');
  git(dir, 'worktree', 'remove', tree);
  assert.equal(gate.stop(false, dir).json.decision, 'block');
  git(dir, 'reset', '-q', '--hard', start);
  const { json } = gate.stop(true, dir);
  assert.equal(json.decision, 'block');
  assert.match(json.reason, /temporary checkout of [0-9a-f]{12} \(branch feat\)/);
});

test("removing the temporary checkout leaves the user's other worktrees alone", (t) => {
  const { dir, tree, gate } = seenWorktree(t);
  // A worktree of the user's whose folder is away (an unmounted drive): git lists it as prunable.
  const away = path.join(tempDir(t), 'usb');
  git(dir, 'worktree', 'add', '-q', away, '-b', 'usb');
  fs.renameSync(away, `${away}-unmounted`);
  write(tree, { 't.test.js': `${NODE_PASS}// more\n` });
  git(tree, 'commit', '-qam', 'green');
  git(dir, 'worktree', 'remove', tree);
  assert.match(gate.stop(false, dir).json.systemMessage, /^greenwashing: tests passed/);
  assert.match(git(dir, 'worktree', 'list', '--porcelain'), new RegExp(`worktree ${fs.realpathSync(path.dirname(away)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/usb\n`));
});

test('a worktree on a remote branch that existed when the turn started is not a change', (t) => {
  const dir = project(t, { 't.test.js': NODE_PASS, '.gitignore': '.claude/worktrees/\n' });
  const main = git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
  git(dir, 'checkout', '-q', '-b', 'pr');
  write(dir, { 't.test.js': NODE_FAIL });
  git(dir, 'commit', '-qam', 'red pull request');
  git(dir, 'update-ref', 'refs/remotes/origin/pr-1', 'HEAD');
  git(dir, 'checkout', '-q', main);
  git(dir, 'branch', '-q', '-D', 'pr');
  const gate = session(t, dir);
  gate.prompt();
  // The agent opens the pull request in a worktree to review it, and changes nothing.
  const tree = path.join(dir, '.claude', 'worktrees', 'review');
  git(dir, 'worktree', 'add', '-q', '--detach', tree, 'origin/pr-1');
  assert.deepEqual(gate.stop(false, tree).json, NO_CHANGES);
});

test('a worktree first seen at the prompt after an interrupted turn is still checked when removed', (t) => {
  const dir = project(t, { 't.test.js': NODE_PASS, '.gitignore': '.claude/worktrees/\n' });
  const gate = session(t, dir);
  gate.prompt();
  const tree = path.join(dir, '.claude', 'worktrees', 'feat');
  git(dir, 'worktree', 'add', '-q', tree, '-b', 'feat');
  // No Stop: the user interrupts while the agent is in the worktree, then writes again.
  gate.prompt(tree);
  write(tree, { 't.test.js': `${NODE_PASS}// more\n` });
  git(tree, 'commit', '-qam', 'green');
  git(dir, 'worktree', 'remove', tree);
  assert.match(gate.stop(false, dir).json.systemMessage, /^greenwashing: tests passed - .* in a temporary checkout of [0-9a-f]{12} \(branch feat\)/);
});

test('a signal while the temporary checkout is being made removes it too', async (t) => {
  const started = path.join(tempDir(t), 'started');
  const { dir, tree, gate } = seenWorktree(t);
  write(tree, { 't.test.js': `${NODE_PASS}// more\n` });
  git(tree, 'commit', '-qam', 'green');
  git(dir, 'worktree', 'remove', tree);
  // A slow post-checkout hook keeps `git worktree add` busy when the signal comes.
  write(dir, { '.git/hooks/post-checkout': `#!/bin/sh\ntouch ${JSON.stringify(started)}\nsleep 2\n` });
  fs.chmodSync(path.join(dir, '.git', 'hooks', 'post-checkout'), 0o755);
  const hook = spawn(process.execPath, [HOOK, 'stop'], { env: gate.env, stdio: ['pipe', 'ignore', 'ignore'] });
  const exited = new Promise((resolve) => hook.on('exit', (code) => resolve(code)));
  hook.stdin.end(JSON.stringify(gate.stopInput(false, dir)));
  for (let i = 0; i < 100 && !fs.existsSync(started); i += 1) await sleep(100);
  assert.ok(fs.existsSync(started), 'the checkout never started');
  hook.kill('SIGTERM');
  assert.equal(await exited, 143);
  assert.deepEqual(leftovers(gate, dir), []);
});

test("a removed worktree of a project in a subfolder is tested at the project's place in the checkout", (t) => {
  const repo = project(t, { 'app/t.test.js': NODE_PASS, 'app/.greenwashing.json': JSON.stringify({ testCommand: NODE_CMD }), '.gitignore': '.claude/worktrees/\n' }, null);
  const tree = path.join(repo, '.claude', 'worktrees', 'feat');
  git(repo, 'worktree', 'add', '-q', tree, '-b', 'feat');
  const app = path.join(repo, 'app');
  const gate = session(t, app);
  gate.prompt(tree);
  write(tree, { 'app/t.test.js': NODE_FAIL });
  git(tree, 'commit', '-qam', 'red');
  git(repo, 'worktree', 'remove', tree);
  const { json } = gate.stop(false, app);
  assert.equal(json.decision, 'block');
  assert.match(json.reason, /the removed worktree \.\.\/\.claude\/worktrees\/feat\nResult: failed - 1 failed/);
});

test('when the hook is stopped during a temporary checkout, the checkout is removed too', async (t) => {
  const started = path.join(tempDir(t), 'started');
  const { dir, tree, gate } = seenWorktree(t, { 'run.sh': 'true\n' }, 'sh run.sh');
  write(tree, { 'run.sh': `touch ${JSON.stringify(started)}; sleep 30\n` });
  git(tree, 'commit', '-qam', 'slow');
  git(dir, 'worktree', 'remove', tree);
  const hook = spawn(process.execPath, [HOOK, 'stop'], { env: gate.env, stdio: ['pipe', 'ignore', 'ignore'] });
  const exited = new Promise((resolve) => hook.on('exit', (code) => resolve(code)));
  hook.stdin.end(JSON.stringify(gate.stopInput(false, dir)));
  for (let i = 0; i < 100 && !fs.existsSync(started); i += 1) await sleep(100);
  assert.ok(fs.existsSync(started), 'the tests never started');
  hook.kill('SIGTERM');
  assert.equal(await exited, 143);
  assert.deepEqual(leftovers(gate, dir), []);
});

test('a worktree removed during the turn leaves nothing to test', (t) => {
  const { dir, tree } = withWorktree(t);
  const gate = session(t, dir);
  gate.prompt(tree);
  git(dir, 'worktree', 'remove', tree);
  assert.deepEqual(gate.stop(false, dir).json, NO_CHANGES);
});

test('two trees to test: all green gives one line for each, and the first red one decides', (t) => {
  const dir = project(t, { 't.test.js': NODE_PASS, 'app.js': '1;\n', '.gitignore': '.claude/worktrees/\n' });
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 'app.js': '2;\n' });
  const tree = path.join(dir, '.claude', 'worktrees', 'feat');
  git(dir, 'worktree', 'add', '-q', tree, '-b', 'feat');
  write(tree, { 'app.js': '3;\n' });
  assert.deepEqual(gate.stop(false, tree).json, { systemMessage: `greenwashing: tests passed - ${NODE_CMD}: 1 passed, 0 failed, 0 skipped; `
    + `${NODE_CMD} in .claude/worktrees/feat: 1 passed, 0 failed, 0 skipped` });
  write(tree, { 't.test.js': NODE_FAIL });
  const { json } = gate.stop(false, tree);
  assert.equal(json.decision, 'block');
  assert.match(json.reason, /\nFolder: \.claude\/worktrees\/feat\nResult: failed - 1 failed/);
});

test('the test runs of one stop share one timeout', (t) => {
  const testCommand = `sleep 2; ${GREEN_ECHO}`;
  const dir = project(t, { 'app.js': '1;\n', '.gitignore': '.claude/worktrees/\n', '.greenwashing.json': JSON.stringify({ testCommand, timeoutSeconds: 3 }) }, null);
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 'app.js': '2;\n' });
  const tree = path.join(dir, '.claude', 'worktrees', 'feat');
  git(dir, 'worktree', 'add', '-q', tree, '-b', 'feat');
  write(tree, { 'app.js': '3;\n' });
  // Each run alone is green in 2 s; two of them do not fit in the 3 s the project allows a Stop.
  assert.equal(gate.stop(false, tree).json.decision, 'block');
});

test('a project reached through a symbolic link is tested in the worktree the agent works in', (t) => {
  const base = tempDir(t);
  const dir = project(t, { 't.test.js': NODE_PASS }, NODE_CMD, path.join(base, 'p'));
  const tree = path.join(base, 'p-feat');
  git(dir, 'worktree', 'add', '-q', tree, '-b', 'feat');
  const link = path.join(base, 'link');
  fs.symlinkSync(dir, link);
  const gate = session(t, link);
  gate.prompt();
  write(tree, { 't.test.js': NODE_FAIL });
  assert.equal(gate.stop(false, tree).json.decision, 'block');
});

test('a repository whose .git is a symbolic link still has its worktrees followed', (t) => {
  const base = tempDir(t);
  const dir = project(t, { 't.test.js': NODE_PASS }, NODE_CMD, path.join(base, 'p'));
  fs.renameSync(path.join(dir, '.git'), path.join(base, 'store'));
  fs.symlinkSync(path.join(base, 'store'), path.join(dir, '.git'));
  const tree = path.join(base, 'p-feat');
  git(dir, 'worktree', 'add', '-q', tree, '-b', 'feat');
  const gate = session(t, dir);
  gate.prompt();
  write(tree, { 't.test.js': NODE_FAIL });
  assert.equal(gate.stop(false, tree).json.decision, 'block');
});

test('a folder git cannot read is not taken for one outside git', (t) => {
  const dir = tempDir(t);
  write(dir, { '.git': 'gitdir: /nonexistent/greenwashing-gate-test\n', 'main.go': 'package main\n' });
  // With a prompt recorded (which found no test command, reading what git would not list) and without.
  const gate = session(t, dir);
  gate.prompt();
  const { json } = gate.stop();
  assert.equal(json.decision, 'block');
  assert.match(json.reason, /git cannot read the repository this folder is in/);
  assert.match(session(t, dir, { id: 'no-prompt' }).stop().json.reason, /git cannot read the repository this folder is in/);
  // The same for a project in a subfolder of such a checkout.
  write(dir, { 'p/main.go': 'package main\n' });
  assert.match(session(t, path.join(dir, 'p')).stop().json.reason, /git cannot read the repository this folder is in/);
});

test('a .git folder with a HEAD that git cannot read is a checkout', (t) => {
  const dir = tempDir(t);
  write(dir, { '.git/HEAD': 'ref: refs/heads/main\n', 'main.go': 'package main\n' });
  const { json } = session(t, dir).stop();
  assert.equal(json.decision, 'block');
  assert.match(json.reason, /git cannot read the repository this folder is in/);
});

test('an empty .git folder above a folder outside git is not a checkout', (t) => {
  const dir = tempDir(t);
  fs.mkdirSync(path.join(dir, '.git'));
  write(dir, { 'p/main.go': 'package main\n' });
  // No prompt recorded, as for a folder git cannot read.
  const gate = session(t, path.join(dir, 'p'));
  assert.deepEqual(gate.stop().json, { systemMessage: 'greenwashing: not a git repository and no test command - tests not run' });
});

test('outside git, the tests run from the project, not from the folder the agent is in', (t) => {
  const dir = tempDir(t);
  write(dir, {
    '.greenwashing.json': JSON.stringify({ testCommand: NODE_CMD }),
    't.test.js': NODE_FAIL,
    'sub/.greenwashing.json': JSON.stringify({ testCommand: GREEN_ECHO }),
  });
  const gate = session(t, dir);
  const sub = path.join(dir, 'sub');
  gate.prompt(sub);
  assert.equal(gate.stop(false, sub).json.decision, 'block');
});

test('another repository inside the project (a submodule, a clone) never stands in for it', (t) => {
  const dir = project(t, { 't.test.js': NODE_PASS });
  const nested = path.join(dir, 'vendor', 'lib');
  write(nested, { '.greenwashing.json': JSON.stringify({ testCommand: GREEN_ECHO }) });
  git(nested, 'init', '-q');
  const gate = session(t, dir);
  gate.prompt();
  // Only looking into it is no change, and its own tests are not the gate's business.
  assert.deepEqual(gate.stop(false, nested).json, NO_CHANGES);
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
  assert.doesNotMatch(json.reason, /Folder:/);
});

test('outside a git repository with no test command, the stop is allowed with one line', (t) => {
  const dir = tempDir(t);
  // A Python helper that is no test does not make the folder a Python project.
  write(dir, { 'main.go': 'package main\n', 'helper.py': 'print("helper")\n' });
  const gate = session(t, dir);
  gate.prompt();
  assert.deepEqual(gate.stop().json, { systemMessage: NOT_CHECKED('no test command was found') });
  // A broken config is a broken setup, not "nothing to test".
  write(dir, { '.greenwashing.json': '{"testCommand": ' });
  gate.prompt();
  assert.equal(gate.stop().json.decision, 'block');
});

test('outside git too, the tests run with the settings the turn started with', (t) => {
  const dir = tempDir(t);
  write(dir, { '.greenwashing.json': JSON.stringify({ testCommand: NODE_CMD }), 't.test.js': NODE_FAIL });
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { '.greenwashing.json': JSON.stringify({ testCommand: GREEN_ECHO }) });
  assert.match(gate.stop().json.reason, /Command: node --test --test-reporter=tap t\.test\.js \(\.greenwashing\.json\)/);
  // With no prompt recorded, as the file is now.
  const other = session(t, dir, { id: 'other' });
  assert.match(other.stop().json.systemMessage, /^greenwashing: tests passed - printf/);
});

test('Python files git does not track yet make a Python project; outside git, a top-level .py does', (t) => {
  const dir = project(t, { 'data.json': '{}\n' }, null);
  write(dir, { 'tests/__init__.py': '', 'tests/test_a.py': PY_PASS });
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 'tests/test_a.py': PY_FAIL });
  const { json } = gate.stop();
  assert.equal(json.decision, 'block');
  assert.match(json.reason, /Command: python3 -m unittest discover \(Python project\)/);

  const plain = tempDir(t);
  write(plain, { 'test_a.py': PY_PASS });
  const other = session(t, plain);
  other.prompt();
  assert.deepEqual(other.stop().json, {
    systemMessage: 'greenwashing: tests passed - python3 -m unittest discover: 1 passed, 0 failed, 0 skipped; quick checks of changed tests not run (not a git repository)',
  });
});

test('a JavaScript project with a helper Python script runs npm test, no testCommand needed', (t) => {
  const dir = project(t, {
    'package.json': JSON.stringify({ name: 'demo', scripts: { test: 'node --test --test-reporter=tap' } }),
    'sum.test.js': NODE_PASS,
    'scripts/helper.py': 'print("helper")\n',
  }, null);
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 'sum.test.js': `${NODE_PASS}// touched\n` });
  assert.deepEqual(gate.stop().json, { systemMessage: 'greenwashing: tests passed - npm test: 1 passed, 0 failed, 0 skipped' });
});

test('a JavaScript project with a pytest section in pyproject.toml, setup.cfg or tox.ini needs a testCommand', (t) => {
  for (const [name, text] of [['pyproject.toml', '[tool.pytest.ini_options]\n'], ['setup.cfg', '[tool:pytest]\n'], ['tox.ini', '[pytest]\n']]) {
    const dir = project(t, {
      'package.json': JSON.stringify({ name: 'demo', scripts: { test: 'node --test --test-reporter=tap' } }),
      'sum.test.js': NODE_PASS,
      [name]: text,
    }, null);
    const gate = session(t, dir);
    gate.prompt();
    write(dir, { 'sum.test.js': `${NODE_PASS}// touched\n` });
    assert.match(gate.stop().json.reason, /package\.json has a test script and the project also has Python tests/, name);
  }
});

test('a JavaScript project with Python tests (test_*.py or *_test.py) needs a testCommand', (t) => {
  for (const tests of ['tests/test_x.py', 'x_test.py']) {
    const dir = project(t, {
      'package.json': JSON.stringify({ name: 'demo', scripts: { test: 'node --test --test-reporter=tap' } }),
      'sum.test.js': NODE_PASS,
      [tests]: PY_PASS,
    }, null);
    const gate = session(t, dir);
    gate.prompt();
    write(dir, { 'sum.test.js': `${NODE_PASS}// touched\n` });
    const { json } = gate.stop();
    assert.equal(json.decision, 'block', tests);
    assert.match(json.reason, /package\.json has a test script and the project also has Python tests/, tests);
  }
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

test('when the hook itself is stopped, it stops every process its tests started', async (t) => {
  for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130], ['SIGHUP', 129]]) {
    const dir = project(t, { 'app.js': '1;\n' }, 'x');
    const started = path.join(dir, 'started-marker');
    const late = path.join(dir, 'late-marker');
    // The late marker comes from a background process of the test command, not from its shell.
    const testCommand = `touch ${JSON.stringify(started)}; (sleep 1; touch ${JSON.stringify(late)}) & sleep 30`;
    write(dir, { '.greenwashing.json': JSON.stringify({ testCommand }) });
    git(dir, 'commit', '-qam', 'config');
    const gate = session(t, dir);
    gate.prompt();
    write(dir, { 'app.js': '2;\n' });
    const hook = spawn(process.execPath, [HOOK, 'stop'], { env: gate.env, stdio: ['pipe', 'ignore', 'ignore'] });
    const exited = new Promise((resolve) => hook.on('exit', (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal })));
    hook.stdin.end(JSON.stringify(gate.stopInput(false, dir)));
    for (let i = 0; i < 100 && !fs.existsSync(started); i += 1) await sleep(100);
    assert.ok(fs.existsSync(started), `${signal}: the tests never started`);
    hook.kill(signal);
    assert.deepEqual(await exited, { code, signal: null }, signal);
    await sleep(2000);
    assert.equal(fs.existsSync(late), false, `${signal}: a process of the tests kept running after the hook was stopped`);
  }
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
  const { json } = gate.stop();
  assert.equal(json.decision, 'block');
  assert.match(json.reason, /the tests failed/);
});

test('a stop with no recorded start: the tests run, the checks do not, and no file counts as the turn\'s', (t) => {
  const dir = project(t, { 'a.test.js': `${JEST_OK}test.skip('old', () => {});\n` }, GREEN_ECHO);
  const gate = session(t, dir);
  // Every stop: the first one leaves the tree it saw without a start, which is still no start.
  for (const active of [false, true, false]) {
    assert.deepEqual(gate.stop(active).json, {
      systemMessage: "greenwashing: tests passed - printf 'Ran 1 test in 0.1s\\n\\nOK\\n': 1 passed, 0 failed, 0 skipped; quick checks of changed tests not run (no start of the turn was recorded)",
    });
  }
});

// The quick checks on the test lines a turn added or changed. The test command only prints green
// counts, so what decides is the checks alone.
const JEST_OK = "test('adds', () => {\n  expect(add(1, 2)).toBe(3);\n});\n";
const PY_OK = 'def test_adds():\n    assert add(1, 2) == 3\n';

test('the block for a failing run names the failed tests', (t) => {
  const dir = project(t, { 't.test.js': NODE_PASS });
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 't.test.js': NODE_FAIL });
  assert.match(gate.stop().json.reason, /\nFailed tests \(1\):\n- ok\nLast 20 lines of output:/);
});

test('GW-17, GW-18, GW-01: each problem in the added test lines blocks, with file, line and entry', (t) => {
  const cases = {
    'a.test.js': [`${JEST_OK}test.skip('saves', () => {\n  expect(save()).toBe(true);\n});\n`, /- a\.test\.js:4: test\.skip - the test does not run \(GW-17\)/],
    'b.test.js': [`${JEST_OK}it('saves the user', async () => {\n  await save(user);\n});\n`, /- b\.test\.js:4: the test 'saves the user' has no assertion \(GW-18\)/],
    'c.test.js': [`${JEST_OK}test('limit', () => {\n  expect(result.limit).toBe(result.limit);\n});\n`, /- c\.test\.js:5: expect\(result\.limit\)\.toBe\(result\.limit\) - both sides are the same \(GW-01\)/],
    'test_d.py': [`${PY_OK}\n\n@pytest.mark.skip(reason="later")\ndef test_saves():\n    assert save()\n`, /- test_d\.py:5: pytest\.mark\.skip - the test does not run \(GW-17\)/],
    'test_e.py': [`${PY_OK}\n\ndef test_saves():\n    save(user)\n`, /- test_e\.py:5: test_saves has no assertion \(GW-18\)/],
    'test_f.py': [`${PY_OK}\n\ndef test_limit():\n    assert result.limit == result.limit\n`, /- test_f\.py:6: assert result\.limit == result\.limit - both sides are the same \(GW-01\)/],
  };
  for (const [name, [text, finding]] of Object.entries(cases)) {
    const start = name.endsWith('.py') ? PY_OK : JEST_OK;
    const dir = project(t, { [name]: start }, GREEN_ECHO);
    const gate = session(t, dir);
    gate.prompt();
    write(dir, { [name]: text });
    const { json } = gate.stop();
    assert.equal(json.decision, 'block', name);
    assert.match(json.reason, /the changed tests can pass without testing anything/, name);
    assert.match(json.reason, finding, name);
    // The honest version of the same file passes.
    gate.prompt();
    write(dir, { [name]: `${start}${name.endsWith('.py') ? '\n\ndef test_saves():\n    assert save(user) is True\n' : "test('saves', () => {\n  expect(save(user)).toBe(true);\n});\n"}` });
    assert.match(gate.stop().json.systemMessage, /^greenwashing: tests passed/, name);
  }
});

test('honest cases: an old skip, a test with an assertion and different sides pass', (t) => {
  const old = `it.skip('old', () => {});\n${JEST_OK}`;
  const dir = project(t, { 'a.test.js': old, 'test_b.py': `import pytest\n\n\n@pytest.mark.skip\ndef test_old():\n    pass\n\n\n${PY_OK}` }, GREEN_ECHO);
  const gate = session(t, dir);
  gate.prompt();
  write(dir, {
    'a.test.js': `${old}test('sums', () => {\n  expect(x).toBe(y);\n});\n`,
    'test_b.py': `import pytest\n\n\n@pytest.mark.skip\ndef test_old():\n    pass\n\n\n${PY_OK}\n\ndef test_sums():\n    assert x == y\n`,
  });
  assert.match(gate.stop().json.systemMessage, /^greenwashing: tests passed/);
});

test('a check turned off in .greenwashing.json does not block', (t) => {
  const config = (checks) => JSON.stringify({ testCommand: GREEN_ECHO, checks });
  const change = `${JEST_OK}it.skip('a', () => { run(); });\ntest('b', () => { expect(x).toBe(x); });\n`;
  const found = (checks) => {
    const dir = project(t, { 'a.test.js': JEST_OK, '.greenwashing.json': config(checks) }, null);
    const gate = session(t, dir);
    gate.prompt();
    write(dir, { 'a.test.js': change });
    const { json } = gate.stop();
    return json.decision === 'block' ? [...json.reason.matchAll(/\((GW-\d+)\)$/gm)].map((m) => m[1]).sort() : [];
  };
  assert.deepEqual(found({}), ['GW-01', 'GW-17']);
  assert.deepEqual(found({ skips: false }), ['GW-01']);
  assert.deepEqual(found({ selfComparisons: false }), ['GW-17']);
  assert.deepEqual(found({ skips: false, selfComparisons: false }), []);
});

test('GW-114: .greenwashing.json changed during the turn blocks; changed between turns it does not', (t) => {
  const dir = project(t, { 'a.test.js': JEST_OK }, GREEN_ECHO);
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { '.greenwashing.json': JSON.stringify({ testCommand: GREEN_ECHO, checks: { skips: false } }), 'a.test.js': `${JEST_OK}// more\n` });
  const { json } = gate.stop();
  assert.equal(json.decision, 'block');
  assert.match(json.reason, /the gate's settings changed during this turn - you cannot finish yet\.\nChanged: \.greenwashing\.json\n/);
  assert.match(json.reason, /See GW-114 in /);
  // Reverted in the same turn: nothing changed.
  write(dir, { '.greenwashing.json': JSON.stringify({ testCommand: GREEN_ECHO }) });
  assert.match(gate.stop(true).json.systemMessage, /^greenwashing: tests passed/);
  // The user edits it between turns, before the next prompt: the turn after it is not blocked.
  write(dir, { '.greenwashing.json': JSON.stringify({ testCommand: GREEN_ECHO, checks: { skips: false } }) });
  gate.prompt();
  write(dir, { 'a.test.js': `${JEST_OK}it.skip('later', () => {});\n` });
  assert.match(gate.stop().json.systemMessage, /^greenwashing: tests passed/);
});

test('a test file moved in the turn is read against the file it was: an old skip in it is not new, a new one is', (t) => {
  const old = `${JEST_OK}it.skip('old', () => {});\n`;
  const py = `import pytest\n\n\n@pytest.mark.skip\n${PY_OK}`;
  const other = "test('subtracts', () => {\n  expect(sub(3, 2)).toBe(1);\n});\nit.skip('other old', () => {});\n";
  const dir = project(t, { 'a.test.js': old, 'd.test.js': other, 'test_a.py': py }, GREEN_ECHO);
  const gate = session(t, dir);
  gate.prompt();
  // Two moved at once: each is read against its own old file.
  fs.mkdirSync(path.join(dir, 'src', '__tests__'), { recursive: true });
  fs.renameSync(path.join(dir, 'a.test.js'), path.join(dir, 'src', '__tests__', 'a.test.js'));
  fs.renameSync(path.join(dir, 'd.test.js'), path.join(dir, 'src', '__tests__', 'd.test.js'));
  fs.renameSync(path.join(dir, 'test_a.py'), path.join(dir, 'src', 'test_b.py'));
  assert.match(gate.stop().json.systemMessage, /^greenwashing: tests passed/);
  gate.prompt();
  git(dir, 'add', '-A');
  git(dir, 'mv', 'src/__tests__/a.test.js', 'b.test.js');
  write(dir, { 'b.test.js': `${old}it.only('new', () => { expect(f()).toBe(1); });\n` });
  const { json } = gate.stop();
  assert.match(json.reason, /\n- b\.test\.js:5: it\.only - only this test runs \(GW-17\)\nSee each/);
  // Mostly new lines: a new file, not a moved one. The test 'adds' of the deleted file is gone too.
  fs.unlinkSync(path.join(dir, 'b.test.js'));
  write(dir, { 'c.test.js': "it.skip('old', () => {});\ntest('more', () => {\n  expect(add(2, 2)).toBe(4);\n}, 5000);\n" });
  const moved = gate.stop(true).json.reason;
  assert.match(moved, /\n- c\.test\.js:1: it\.skip - the test does not run \(GW-17\)\nRemoved tests /);
  assert.match(moved, /\n- src\/__tests__\/a\.test\.js: 'adds' \(GW-17\)\nSee each/);
});

test('a test the turn brings into an old skipped suite by moving the suite around it blocks, in JS and Python', (t) => {
  const js = (body) => `describe.skip('old', () => {\n  test('a', () => { expect(f()).toBe(1); });\n${body}});\n`;
  const failing = "test('fails', () => {\n  expect(g()).toBe(2);\n});\n";
  const py = (body) => `import pytest\n\n\n@pytest.mark.skip\nclass TestOld:\n    def test_a(self):\n        assert f()\n${body}`;
  const dir = project(t, { 'a.test.js': `${js('')}${failing}`, 'test_b.py': `${py('')}\n\ndef test_fails():\n    assert g()\n` }, GREEN_ECHO);
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 'a.test.js': js(failing), 'test_b.py': py('\n    def test_fails(self):\n        assert g()\n') });
  const { json } = gate.stop();
  assert.match(json.reason, /\n- a\.test\.js:3: a test inside describe\.skip - the test does not run \(GW-17\)\n/);
  assert.match(json.reason, /\n- test_b\.py:9: a test inside a class marked pytest\.mark\.skip - the test does not run \(GW-17\)\n/);
});

test('a copied test file is new: the file it came from is still there, so its old skip counts', (t) => {
  const old = `${JEST_OK}it.skip('old', () => {});\n`;
  const dir = project(t, { 'a.test.js': old }, GREEN_ECHO);
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 'a.test.js': `${old}// more\n`, 'e.test.js': old });
  assert.match(gate.stop().json.reason, /\n- e\.test\.js:4: it\.skip - the test does not run \(GW-17\)\nSee each/);
});

test('GW-114 for a .greenwashing.json git ignores: changed or created during the turn blocks, alone too', (t) => {
  const dir = project(t, { 'a.test.js': JEST_OK, '.gitignore': '.greenwashing.json\n', 'package.json': '{"scripts": {"test": "jest"}}' }, null);
  const settings = (checks) => ({ '.greenwashing.json': JSON.stringify({ testCommand: GREEN_ECHO, ...(checks ? { checks } : {}) }) });
  const gate = session(t, dir);
  // Created during the turn, with nothing else changed; removed again, nothing changed.
  gate.prompt();
  write(dir, settings());
  assert.match(gate.stop().json.reason, /the gate's settings changed during this turn - you cannot finish yet\.\nChanged: \.greenwashing\.json\n/);
  fs.unlinkSync(path.join(dir, '.greenwashing.json'));
  assert.equal(gate.stop(true).json.systemMessage, 'greenwashing: no files changed this turn - tests not run');
  // The user creates it between turns; the agent changes it during the next one.
  write(dir, settings());
  gate.prompt();
  write(dir, { ...settings({ skips: false }), 'a.test.js': `${JEST_OK}// more\n` });
  assert.match(gate.stop().json.reason, /Changed: \.greenwashing\.json\n/);
  write(dir, settings());
  assert.match(gate.stop(true).json.systemMessage, /^greenwashing: tests passed/);
  // A project in a subfolder: its own settings file.
  const repo = project(t, { 'app/a.test.js': JEST_OK, '.gitignore': '.greenwashing.json\n' }, null);
  const app = path.join(repo, 'app');
  write(app, settings());
  const sub = session(t, app);
  sub.prompt();
  write(app, settings({ skips: false }));
  assert.match(sub.stop().json.reason, /Changed: \.greenwashing\.json\n/);
});

test('Python test checks that cannot run are did not run: no python3 on PATH, or a file Python cannot read', (t) => {
  const bin = tempDir(t);
  for (const tool of ['git', 'sh']) fs.symlinkSync(spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim(), path.join(bin, tool));
  const dir = project(t, { 'test_a.py': PY_OK }, GREEN_ECHO);
  const gate = session(t, dir, { env: { PATH: bin } });
  gate.prompt();
  write(dir, { 'test_a.py': `${PY_OK}# more\n` });
  const { json } = gate.stop();
  assert.equal(json.decision, 'block');
  assert.match(json.reason, /the checks of the changed tests did not run/);
  assert.match(json.reason, /Result: did not run - the Python test checks could not run: python3 was not found on PATH; a human sets \{"python": /);

  const broken = project(t, { 'test_a.py': PY_OK }, GREEN_ECHO);
  const other = session(t, broken);
  other.prompt();
  write(broken, { 'test_a.py': 'def test_a(:\n' });
  const reason = other.stop().json.reason;
  assert.match(reason, /the Python test checks could not read test_a\.py - Python could not read it \(SyntaxError/);
  // How to fix it when the file is right and python3 is too old for it.
  assert.match(reason, /; if the project's Python reads it, a human sets \{"python": "<the project's Python, for example \.venv\/bin\/python>"\} in \.greenwashing\.json in the project root, or turns the checks off there/);
});

test('every check turned off: the Python checks do not run, so no python3 on PATH or a file Python cannot read leaves the tests to decide', (t) => {
  const bin = tempDir(t);
  for (const tool of ['git', 'sh']) fs.symlinkSync(spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim(), path.join(bin, tool));
  const off = JSON.stringify({ testCommand: GREEN_ECHO, checks: { skips: false, assertions: false, selfComparisons: false } });
  for (const [change, env] of [[`${PY_OK}# more\n`, { PATH: bin }], ['def test_a(:\n', {}]]) {
    const dir = project(t, { 'test_a.py': PY_OK, '.greenwashing.json': off }, null);
    const gate = session(t, dir, { env });
    gate.prompt();
    write(dir, { 'test_a.py': change });
    assert.match(gate.stop().json.systemMessage || '', /^greenwashing: tests passed - /, change);
  }
});

test('"python" in .greenwashing.json runs the Python checks: a path from the project folder or a name, not python3 from PATH', (t) => {
  const real = spawnSync('sh', ['-c', 'command -v python3'], { encoding: 'utf8' }).stdout.trim();
  const bin = tempDir(t);
  for (const tool of ['git', 'sh']) fs.symlinkSync(spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim(), path.join(bin, tool));
  // No python3 on PATH: only the configured Python can run the checks. It leaves a mark when it runs.
  const mark = path.join(tempDir(t), 'ran');
  const shim = `#!/bin/sh\n: > ${JSON.stringify(mark)}\nexec ${JSON.stringify(real)} "$@"\n`;
  const config = (python) => JSON.stringify({ testCommand: GREEN_ECHO, python });
  for (const [python, files] of [['tools/py', { 'tools/py': shim }], [path.join(bin, 'py'), {}], ['py', {}]]) {
    fs.rmSync(mark, { force: true });
    fs.writeFileSync(path.join(bin, 'py'), shim, { mode: 0o755 });
    const dir = project(t, { 'test_a.py': PY_OK, '.greenwashing.json': config(python), ...files }, null);
    if (files['tools/py']) fs.chmodSync(path.join(dir, 'tools/py'), 0o755);
    const gate = session(t, dir, { env: { PATH: bin } });
    gate.prompt();
    write(dir, { 'test_a.py': `${PY_OK}\n\ndef test_saves():\n    save(user)\n` });
    assert.match(gate.stop().json.reason, /- test_a\.py:5: test_saves has no assertion \(GW-18\)/, python);
    assert.ok(fs.existsSync(mark), python);
  }
  // A configured Python that fails at once is named as it is, also when it exits before it reads its
  // input (a request larger than a pipe holds makes that certain).
  fs.writeFileSync(path.join(bin, 'failing'), '#!/bin/sh\necho boom >&2\nexit 3\n', { mode: 0o755 });
  const failing = project(t, { 'test_a.py': PY_OK, '.greenwashing.json': config(path.join(bin, 'failing')) }, null);
  const other = session(t, failing);
  other.prompt();
  write(failing, { 'test_a.py': `${PY_OK}${'# more\n'.repeat(40000)}` });
  assert.match(other.stop().json.reason, new RegExp(`the Python test checks could not run: ${path.join(bin, 'failing').replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} exited with code 3: boom`));
  // A configured Python that is not there: did not run, with its name and how to fix it.
  const dir = project(t, { 'test_a.py': PY_OK, '.greenwashing.json': config('.venv/bin/python') }, null);
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 'test_a.py': `${PY_OK}# more\n` });
  assert.match(gate.stop().json.reason, new RegExp(`the Python test checks could not run: ${path.join(dir, '.venv/bin/python').replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')} was not found; a human sets`));
});

test('the checks read every tree the turn changed: a worktree, a removed worktree\'s commit, a tree entered during the turn', (t) => {
  // The agent works in a worktree.
  const { dir, tree } = withWorktree(t, { 'a.test.js': JEST_OK });
  write(dir, { '.greenwashing.json': JSON.stringify({ testCommand: GREEN_ECHO }) });
  git(dir, 'commit', '-qam', 'green echo');
  git(tree, 'merge', '-q', 'master');
  const gate = session(t, dir);
  gate.prompt(tree);
  write(tree, { 'a.test.js': `${JEST_OK}xit('later', () => {});\n` });
  assert.match(gate.stop(false, tree).json.reason, /- \.claude\/worktrees\/feat\/a\.test\.js:4: xit - the test does not run \(GW-17\)/);

  // The same skip, committed in the worktree, which is then removed.
  const seen = seenWorktree(t, { 'a.test.js': JEST_OK }, GREEN_ECHO);
  write(seen.tree, { 'a.test.js': `${JEST_OK}xit('later', () => {});\n` });
  git(seen.tree, 'commit', '-qam', 'skip');
  git(seen.dir, 'worktree', 'remove', seen.tree);
  assert.match(seen.gate.stop(false, seen.dir).json.reason,
    /- a\.test\.js \(last commit of the removed worktree \.claude\/worktrees\/feat\):4: xit - the test does not run \(GW-17\)/);

  // A worktree the agent enters after the prompt: an old skip on its branch is not the turn's, the new one is.
  const old = project(t, { 'a.test.js': JEST_OK, '.gitignore': '.claude/worktrees/\n' }, GREEN_ECHO);
  git(old, 'branch', 'old');
  const late = path.join(old, '.claude', 'worktrees', 'old');
  git(old, 'worktree', 'add', '-q', late, 'old');
  write(late, { 'a.test.js': `xit('before', () => {});\n${JEST_OK}` });
  git(late, 'commit', '-qam', 'an old skip');
  const entered = session(t, old);
  entered.prompt();
  write(late, { 'a.test.js': `xit('before', () => {});\n${JEST_OK}test.only('new', () => { expect(a).toBe(1); });\n` });
  git(late, 'commit', '-qam', 'focus');
  const { json } = entered.stop(false, late);
  assert.match(json.reason, /a\.test\.js:5: test\.only - only this test runs \(GW-17\)/);
  assert.doesNotMatch(json.reason, /xit/);
});

test('a finding blocks like a failed test: three times in a row, then the stop is let go as not accepted', (t) => {
  const dir = project(t, { 'a.test.js': JEST_OK }, GREEN_ECHO);
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 'a.test.js': `${JEST_OK}it.only('mine', () => { expect(a).toBe(1); });\n` });
  for (const active of [false, true, true]) assert.equal(gate.stop(active).json.decision, 'block');
  assert.match(gate.stop(true).json.systemMessage, /^greenwashing: CHECKS DID NOT PASS - WORK NOT ACCEPTED\./);
});

test('a project in a subfolder: its own .greenwashing.json turns a check off; a broken checks setting is did not run', (t) => {
  const repo = project(t, { 'app/a.test.js': JEST_OK, 'app/.greenwashing.json': JSON.stringify({ testCommand: GREEN_ECHO, checks: { skips: false } }) }, null);
  const app = path.join(repo, 'app');
  const gate = session(t, app);
  gate.prompt();
  write(app, { 'a.test.js': `${JEST_OK}it.skip('later', () => {});\n` });
  assert.match(gate.stop().json.systemMessage, /^greenwashing: tests passed/);
  const dir = project(t, { 'a.test.js': JEST_OK, '.greenwashing.json': JSON.stringify({ testCommand: GREEN_ECHO, checks: { skips: 'no' } }) }, null);
  const broken = session(t, dir);
  broken.prompt();
  write(dir, { 'a.test.js': `${JEST_OK}// more\n` });
  assert.match(broken.stop().json.reason, /^greenwashing gate: the checks of the changed tests did not run - you cannot finish yet\.\n(.*\n)*Result: did not run - \.greenwashing\.json: checks must be an object of true or false/);
});

test('GW-114 in a project in a subfolder: its own .greenwashing.json counts', (t) => {
  const repo = project(t, { 'app/a.test.js': JEST_OK, 'app/.greenwashing.json': JSON.stringify({ testCommand: GREEN_ECHO }) }, null);
  const app = path.join(repo, 'app');
  const gate = session(t, app);
  gate.prompt();
  write(app, { '.greenwashing.json': JSON.stringify({ testCommand: GREEN_ECHO, timeoutSeconds: 5 }) });
  assert.match(gate.stop().json.reason, /Changed: \.greenwashing\.json\n/);
});

test('a test file that was dirty when the turn started: only the lines the turn changed count', (t) => {
  const dir = project(t, { 'a.test.js': JEST_OK }, GREEN_ECHO);
  // The user's own skip, not committed, before the prompt.
  write(dir, { 'a.test.js': `${JEST_OK}it.skip('mine', () => {});\n` });
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 'a.test.js': `${JEST_OK}it.skip('mine', () => {});\ntest('b', () => {\n  expect(b()).toBe(2);\n});\n` });
  assert.match(gate.stop().json.systemMessage, /^greenwashing: tests passed/);
});

// Tests the turn removes (GW-17). Two tests in each language; the turns remove the second.
const TWO_JS = `${JEST_OK}test('subtracts', () => {\n  expect(sub(3, 2)).toBe(1);\n});\n`;
const MUL_JS = "test('multiplies', () => {\n  expect(mul(2, 3)).toBe(6);\n});\n";
const TWO_PY = 'import unittest\n\n\nclass TestMath(unittest.TestCase):\n    def test_adds(self):\n        self.assertEqual(add(1, 2), 3)\n\n'
  + '    def test_subtracts(self):\n        self.assertEqual(sub(3, 2), 1)\n';
const ONE_PY = TWO_PY.replace(/\n\n {4}def test_subtracts[^]*$/, '\n');

test('a test the turn removes blocks, named with its file, GW-17 and how the user allows it, in JS and Python', (t) => {
  const dir = project(t, { 'a.test.js': TWO_JS, 'test_m.py': TWO_PY }, GREEN_ECHO);
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 'a.test.js': JEST_OK, 'test_m.py': ONE_PY });
  const { json } = gate.stop();
  assert.equal(json.decision, 'block');
  assert.match(json.reason, /^greenwashing gate: this turn removed tests - you cannot finish yet\.\nRemoved tests /);
  assert.match(json.reason, /\n- a\.test\.js: 'subtracts' \(GW-17\)\n- test_m\.py: TestMath\.test_subtracts \(GW-17\)\nSee each entry in /);
  assert.match(json.reason, /a turn whose prompt from the user says "allow test removal" may remove tests/);
  assert.match(json.reason, /turn the check off with \{"checks": \{"skips": false\}\}/);
});

test('a whole test file removed blocks with each of its tests; a test moved to a file no runner collects is removed too', (t) => {
  const dir = project(t, { 'a.test.js': TWO_JS, 'b.test.js': MUL_JS, 'app.js': '1;\n' }, GREEN_ECHO);
  const gate = session(t, dir);
  gate.prompt();
  fs.unlinkSync(path.join(dir, 'a.test.js'));
  assert.match(gate.stop().json.reason, /\n- a\.test\.js: 'adds' \(GW-17\)\n- a\.test\.js: 'subtracts' \(GW-17\)\nSee each/);
  write(dir, { 'a.test.js': TWO_JS, 'cases.js': MUL_JS });
  fs.unlinkSync(path.join(dir, 'b.test.js'));
  const reason = gate.stop(true).json.reason;
  assert.match(reason, /\nRemoved tests [^\n]*\n- b\.test\.js: 'multiplies' \(GW-17\)\nSee each/);
});

test('a test renamed with the same body, or moved to another test file, is not removed; moved into a skipped suite it is a new skip', (t) => {
  const old = "describe.skip('old', () => {\n  test('a', () => { expect(f()).toBe(1); });\n});\n";
  const dir = project(t, { 'a.test.js': TWO_JS, 'test_m.py': TWO_PY, 'old.test.js': old }, GREEN_ECHO);
  const gate = session(t, dir);
  gate.prompt();
  write(dir, {
    'a.test.js': JEST_OK.replace("'adds'", "'adds two numbers'"),
    'math/sub.test.js': "describe('sub', () => {\n  test('subtracts', () => {\n    expect(sub(3, 2)).toBe(1);\n  });\n});\n",
    'test_m.py': TWO_PY.replace('class TestMath', 'class TestArithmetic').replace('def test_adds', 'def test_adds_two'),
  });
  assert.match(gate.stop().json.systemMessage, /^greenwashing: tests passed/);
  gate.prompt();
  write(dir, { 'math/sub.test.js': '', 'old.test.js': old.replace('});\n', "});\n  test('subtracts', () => {\n    expect(sub(3, 2)).toBe(1);\n  });\n") });
  const { json } = gate.stop();
  assert.match(json.reason, /\n- old\.test\.js:3: a test inside describe\.skip - the test does not run \(GW-17\)\nSee each/);
  assert.doesNotMatch(json.reason, /Removed tests/);
});

test('the words "allow test removal" in the user\'s prompt let that turn remove tests, and its line names them; nothing else lets it', (t) => {
  const dir = project(t, { 'a.test.js': TWO_JS, 'notes.txt': 'x\n' }, GREEN_ECHO);
  const gate = session(t, dir);
  gate.prompt(dir, 'Drop sub() and its test. Allow  Test\nRemoval, please.');
  write(dir, { 'a.test.js': JEST_OK });
  assert.match(gate.stop().json.systemMessage, /^greenwashing: tests passed - .*: 1 passed, 0 failed, 0 skipped; tests removed with the user's permission \(1\): a\.test\.js: 'subtracts'$/);
  // Only for that turn, and only the user's prompt: words the agent writes into a file do not count.
  gate.prompt(dir, 'Tidy up the notes.');
  write(dir, { 'a.test.js': '', 'notes.txt': 'allow test removal\n' });
  assert.match(gate.stop().json.reason, /\n- a\.test\.js: 'adds' \(GW-17\)\nSee each/);
  // A word that only contains them is not them.
  gate.prompt(dir, 'We disallow test removals here.');
  assert.match(gate.stop().json.reason, /\n- a\.test\.js: 'adds' \(GW-17\)\nSee each/);
});

test('after WORK NOT ACCEPTED a removal still blocks at the next prompt without the words, and the words then let it go', (t) => {
  const dir = project(t, { 'a.test.js': TWO_JS }, GREEN_ECHO);
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 'a.test.js': JEST_OK });
  for (const active of [false, true, true]) assert.match(gate.stop(active).json.reason, /\n- a\.test\.js: 'subtracts' \(GW-17\)\n/);
  assert.match(gate.stop(true).json.systemMessage, /^greenwashing: CHECKS DID NOT PASS - WORK NOT ACCEPTED\. .*Last result: failed - 1 test removed/);
  gate.prompt(dir, 'go on');
  assert.match(gate.stop().json.reason, /\n- a\.test\.js: 'subtracts' \(GW-17\)\n/);
  gate.prompt(dir, 'allow test removal');
  assert.match(gate.stop().json.systemMessage, /; tests removed with the user's permission \(1\): a\.test\.js: 'subtracts'$/);
});

test('a test the user removes between turns does not block, while the agent\'s removal carried from the turn before does', (t) => {
  const dir = project(t, { 'a.test.js': TWO_JS, 'b.test.js': MUL_JS, 'test_m.py': TWO_PY }, GREEN_ECHO);
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 'a.test.js': JEST_OK });
  for (const active of [false, true, true]) assert.equal(gate.stop(active).json.decision, 'block');
  assert.match(gate.stop(true).json.systemMessage, /WORK NOT ACCEPTED/);
  // The agent stopped: between turns the user deletes b.test.js and a Python test.
  fs.unlinkSync(path.join(dir, 'b.test.js'));
  write(dir, { 'test_m.py': ONE_PY });
  gate.prompt();
  const reason = gate.stop().json.reason;
  assert.match(reason, /\nRemoved tests [^\n]*\n- a\.test\.js: 'subtracts' \(GW-17\)\nSee each/);
  // Turns cut off before their Stop after it: the user's removals stay theirs.
  gate.prompt();
  gate.prompt();
  assert.match(gate.stop().json.reason, /\nRemoved tests [^\n]*\n- a\.test\.js: 'subtracts' \(GW-17\)\nSee each/);
  // The agent removes another test of a file the user changed: that one blocks.
  write(dir, { 'test_m.py': ONE_PY.replace(/ {4}def test_adds[^]*$/, '    pass\n') });
  assert.match(gate.stop(true).json.reason, /\n- a\.test\.js: 'subtracts' \(GW-17\)\n- test_m\.py: TestMath\.test_adds \(GW-17\)\nSee each/);
  write(dir, { 'test_m.py': ONE_PY });
  // After a release, the user edits the file the agent removed a test from: the file as it is now is theirs.
  assert.equal(gate.stop(true).json.decision, 'block');
  assert.match(gate.stop(true).json.systemMessage, /WORK NOT ACCEPTED/);
  write(dir, { 'a.test.js': `${JEST_OK}// kept as it is\n` });
  gate.prompt();
  assert.match(gate.stop().json.systemMessage, /^greenwashing: tests passed/);
});

test('a test removed after a turn the gate only blocked, or cut off before its Stop, counts as the agent\'s: the agent may have removed it', (t) => {
  const dir = project(t, { 'a.test.js': TWO_JS, 'b.test.js': MUL_JS, 'app.js': '1;\n' }, GREEN_ECHO);
  const gate = session(t, dir);
  // Blocked once, then the turn is interrupted: the removal made after that Stop blocks at the next turn.
  gate.prompt();
  write(dir, { 'app.js': '2;\n', 'a.test.js': "test('adds', () => {\n  expect(add(1, 2)).toBe(3);\n});\ntest.skip('x', () => {});\n" });
  assert.match(gate.stop().json.reason, /a\.test\.js:4: test\.skip/);
  write(dir, { 'a.test.js': JEST_OK });
  gate.prompt();
  assert.match(gate.stop().json.reason, /\nRemoved tests [^\n]*\n- a\.test\.js: 'subtracts' \(GW-17\)\nSee each/);
  // A turn cut off before any Stop: the same.
  write(dir, { 'a.test.js': TWO_JS });
  assert.match(gate.stop(true).json.systemMessage, /^greenwashing: tests passed/);
  gate.prompt();
  fs.unlinkSync(path.join(dir, 'b.test.js'));
  gate.prompt();
  assert.match(gate.stop().json.reason, /\n- b\.test\.js: 'multiplies' \(GW-17\)\nSee each/);
  // A killed Stop records nothing either: still the agent's.
  gate.prompt();
  assert.match(gate.stop().json.reason, /\n- b\.test\.js: 'multiplies' \(GW-17\)\nSee each/);
});


test('"skips": false turns the check of removed tests off', (t) => {
  const dir = project(t, { 'a.test.js': TWO_JS, '.greenwashing.json': JSON.stringify({ testCommand: GREEN_ECHO, checks: { skips: false } }) }, null);
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 'a.test.js': JEST_OK });
  assert.match(gate.stop().json.systemMessage, /^greenwashing: tests passed - [^;]*$/);
});

test('a test removed in a worktree the agent works in, or in the last commit of a removed worktree, blocks', (t) => {
  const { dir, tree, gate } = seenWorktree(t, { 'a.test.js': TWO_JS }, GREEN_ECHO);
  write(tree, { 'a.test.js': JEST_OK });
  assert.match(gate.stop(false, tree).json.reason, /\n- \.claude\/worktrees\/feat\/a\.test\.js: 'subtracts' \(GW-17\)\n/);
  git(tree, 'commit', '-qam', 'drop a test');
  git(dir, 'worktree', 'remove', tree);
  assert.match(gate.stop(true, dir).json.reason, /\n- a\.test\.js \(last commit of the removed worktree \.claude\/worktrees\/feat\): 'subtracts' \(GW-17\)\n/);
  assert.deepEqual(leftovers(gate, dir), []);
});

// A project the gate cannot check: no test command, or one of another kind, when the work started.
const MOCHA_PKG = '{"scripts": {"test": "mocha"}}';

test('a project with no test command, or a test script of another kind, ends each turn with a line saying it was not checked', (t) => {
  const none = project(t, { 'main.go': 'package main\n' }, null);
  const gate = session(t, none);
  gate.prompt();
  write(none, { 'main.go': 'package main\n\nfunc main() {}\n' });
  assert.deepEqual(gate.stop().json, { systemMessage: NOT_CHECKED('no test command was found') });
  // Also a turn that changed nothing: the gate says it is not checking.
  gate.prompt();
  assert.deepEqual(gate.stop().json, { systemMessage: NOT_CHECKED('no test command was found') });
  // Tests the agent adds in the turn do not make that turn checked: the start decides. The line names
  // the command the next turn is checked with.
  gate.prompt();
  write(none, { 'a.test.js': NODE_FAIL, 'package.json': '{"scripts": {"test": "node --test"}}' });
  assert.deepEqual(gate.stop().json, { systemMessage: FIRST_COMMAND('npm test (package.json scripts.test)') });
  // From the next turn on the project has them, so the gate checks it, with that command.
  gate.prompt();
  write(none, { 'a.test.js': `${NODE_FAIL}// more\n` });
  const { reason } = gate.stop().json;
  assert.match(reason, /the tests failed/);
  assert.match(reason, /\nCommand: npm test \(package\.json scripts\.test\)\n/);

  const mocha = project(t, { 'package.json': MOCHA_PKG, 'test/cart.js': "it('adds', () => {});\n", 'cart.js': '1;\n' }, null);
  const other = session(t, mocha);
  other.prompt();
  write(mocha, { 'cart.js': '2;\n' });
  assert.deepEqual(other.stop().json, { systemMessage: NOT_CHECKED('the test command npm test runs "mocha"') });
});

test('a turn that adds a test command the gate cannot check, or that started with one of another kind, keeps the line that says how to set testCommand', (t) => {
  // No test command at the start, and a mocha script added: the next turn is not checked either.
  const none = project(t, { 'main.go': 'package main\n' }, null);
  const gate = session(t, none);
  gate.prompt();
  write(none, { 'package.json': MOCHA_PKG, 'test/a.js': "it('a', () => {});\n" });
  assert.deepEqual(gate.stop().json, { systemMessage: NOT_CHECKED('no test command was found') });
  // A mocha script at the start, swapped for node --test: the project had a test command when the turn started.
  const mocha = project(t, { 'package.json': MOCHA_PKG, 'cart.js': '1;\n' }, null);
  const other = session(t, mocha);
  other.prompt();
  write(mocha, { 'package.json': '{"scripts": {"test": "node --test"}}', 'a.test.js': NODE_PASS });
  assert.deepEqual(other.stop().json, { systemMessage: NOT_CHECKED('the test command npm test runs "mocha"') });
});

test('outside git too, a turn that adds the first test command is not checked, and its line names the command the next turn is checked with', (t) => {
  const dir = tempDir(t);
  write(dir, { 'main.go': 'package main\n' });
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 'test_a.py': PY_FAIL });
  assert.deepEqual(gate.stop().json, { systemMessage: FIRST_COMMAND('python3 -m unittest discover (Python project)') });
  gate.prompt();
  const { reason } = gate.stop().json;
  assert.match(reason, /the tests failed/);
  assert.match(reason, /\nCommand: python3 -m unittest discover \(Python project\)\n/);
});

test('a test script that runs one of the five kinds through another script is checked; emptied or removed by the agent it is did not run', (t) => {
  const pkg = (unit) => JSON.stringify({ scripts: { test: 'npm run unit', unit } });
  const dir = project(t, { 'package.json': pkg('node --test --test-reporter=tap'), 't.test.js': NODE_PASS, 'app.js': '1;\n' }, null);
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 'package.json': pkg('exit 0'), 'app.js': '2;\n' });
  const { json } = gate.stop();
  assert.equal(json.decision, 'block');
  assert.match(json.reason, /Command: npm test \(package\.json scripts\.test\)\nResult: did not run - no test counts/);
  // The test script removed: no test command, still did not run.
  write(dir, { 'package.json': '{"scripts": {}}' });
  assert.match(gate.stop(true).json.reason, /Result: did not run - no test command found/);
  // After WORK NOT ACCEPTED the next turn keeps what the work started with.
  gate.stop(true);
  assert.match(gate.stop(true).json.systemMessage, /WORK NOT ACCEPTED/);
  gate.prompt();
  assert.match(gate.stop().json.reason, /Result: did not run - no test command found/);
});

test('a test command a human set in .greenwashing.json is always checked: output with no counts is did not run', (t) => {
  const dir = project(t, { 'main.go': 'package main\n' }, 'go-test-that-is-not-installed ./...');
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 'main.go': 'package main\n\nfunc main() {}\n' });
  assert.match(gate.stop().json.reason, /Result: did not run - the command was not found \(exit code 127\)/);
});

test('in a project the gate cannot check, a .greenwashing.json the agent writes during the turn still blocks (GW-114)', (t) => {
  const dir = project(t, { 'package.json': MOCHA_PKG, 'cart.js': '1;\n' }, null);
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { '.greenwashing.json': JSON.stringify({ testCommand: GREEN_ECHO }) });
  for (const active of [false, true, true]) assert.match(gate.stop(active).json.reason, /Changed: \.greenwashing\.json\n/);
  assert.match(gate.stop(true).json.systemMessage, /WORK NOT ACCEPTED/);
  // Left as the gate last saw it, it is still the agent's in the next turn: the project stays one the
  // gate cannot check, and the change still blocks.
  gate.prompt();
  assert.match(gate.stop().json.reason, /Changed: \.greenwashing\.json\n/);
  // Put back: the turn is not checked, as before.
  fs.unlinkSync(path.join(dir, '.greenwashing.json'));
  assert.deepEqual(gate.stop(true).json, { systemMessage: NOT_CHECKED('the test command npm test runs "mocha"') });
  // A human who sets it between turns makes the project one the gate checks.
  write(dir, { '.greenwashing.json': JSON.stringify({ testCommand: GREEN_ECHO }) });
  gate.prompt();
  write(dir, { 'cart.js': '2;\n' });
  assert.match(gate.stop().json.systemMessage, /^greenwashing: tests passed - printf/);
});

test('outside git, a test command the work started with and the turn removes is did not run, not "no test command"', (t) => {
  const dir = tempDir(t);
  write(dir, { 'package.json': '{"scripts": {"test": "node --test"}}', 't.test.js': NODE_PASS });
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 'package.json': '{}' });
  assert.match(gate.stop().json.reason, /Result: did not run - no test command found/);
});

test('on a Node older than the gate needs, no turn is blocked: the session start and each Stop tell the user, the prompt says nothing', (t) => {
  const dir = project(t, { 't.test.js': NODE_PASS });
  // The hook runs with this Node claiming to be 18.20.8 (process.versions.node can be redefined).
  const preload = path.join(tempDir(t), 'old-node.js');
  fs.writeFileSync(preload, "Object.defineProperty(process.versions, 'node', { value: '18.20.8' });\n");
  const gate = session(t, dir, { env: { NODE_OPTIONS: `--require ${preload}` } });
  const off = { systemMessage: 'greenwashing: the gate is OFF - the node on PATH is v18.20.8. It needs Node.js 20 or newer on PATH; '
    + 'no turn is checked until a human sets that up and restarts Claude Code.' };
  const started = gate.raw('session', { session_id: 's', cwd: dir, hook_event_name: 'SessionStart', source: 'startup' });
  assert.deepEqual([started.code, started.json, started.stderr], [0, off, '']);
  const prompt = gate.prompt();
  assert.deepEqual([prompt.code, prompt.stdout, prompt.stderr], [0, '', '']);
  write(dir, { 't.test.js': NODE_FAIL });
  assert.deepEqual(gate.stop().json, off);
  assert.deepEqual(gate.stop(true).json, off);
  // On a Node it runs on, the session hook says nothing and the same turn blocks.
  const fine = session(t, dir, { tmp: gate.tmp });
  assert.deepEqual(fine.raw('session', { session_id: 's', cwd: dir, hook_event_name: 'SessionStart', source: 'startup' }).stdout, '');
});

// Round 1 of the review: where a moved test still runs, which projects stay checked, and when the
// user's permission ends.
test('a test moved to a test file the project\'s runner does not collect is removed; to one it collects, it is kept', (t) => {
  const moveOut = (files, from, to, testCommand) => {
    const dir = project(t, files, testCommand);
    const gate = session(t, dir);
    gate.prompt();
    to(dir);
    return gate.stop().json;
  };
  const sub = "test('subtracts', () => {\n  expect(sub(3, 2)).toBe(1);\n});\n";
  // node --test does not collect *.spec.js (also when the runner is not known: every runner counts).
  for (const command of [null, `${GREEN_ECHO} # node --test`, GREEN_ECHO]) {
    const files = command === null ? { 'package.json': '{"scripts": {"test": "node --test"}}', 'a.test.js': TWO_JS } : { 'a.test.js': TWO_JS };
    const json = moveOut(files, 'a.test.js', (dir) => write(dir, { 'a.test.js': JEST_OK, 'a.spec.js': sub }), command);
    assert.match(json.reason, /\n- a\.test\.js: 'subtracts' \(GW-17\)\nSee each/, String(command));
  }
  // jest collects both *.test.js and __tests__/: kept.
  const jest = moveOut({ 'a.test.js': TWO_JS }, 'a.test.js', (dir) => write(dir, { 'a.test.js': JEST_OK, '__tests__/sub.js': sub }), `${GREEN_ECHO} # jest`);
  assert.match(jest.systemMessage, /^greenwashing: tests passed/);
  // unittest discover does not collect *_test.py; pytest does.
  const moved = (dir) => write(dir, { 'test_m.py': ONE_PY, 'm_test.py': `import unittest\n\n\nclass TestMath(unittest.TestCase):\n${TWO_PY.slice(TWO_PY.indexOf('    def test_subtracts'))}` });
  assert.match(moveOut({ 'test_m.py': TWO_PY }, 'test_m.py', moved, `${GREEN_ECHO} # python3 -m unittest`).reason, /\n- test_m\.py: TestMath\.test_subtracts \(GW-17\)\nSee each/);
  assert.match(moveOut({ 'test_m.py': TWO_PY }, 'test_m.py', moved, `${GREEN_ECHO} # python3 -m pytest`).systemMessage, /^greenwashing: tests passed/);
});

test('a test file moved with a test edited in it keeps its tests; moved where the runner does not collect it, they are removed', (t) => {
  const dir = project(t, { 'math.test.js': TWO_JS }, `${GREEN_ECHO} # node --test`);
  const gate = session(t, dir);
  gate.prompt();
  fs.mkdirSync(path.join(dir, 'test'));
  git(dir, 'mv', 'math.test.js', 'test/math.test.js');
  write(dir, { 'test/math.test.js': TWO_JS.replace('toBe(1);', 'toBe(1);\n  expect(sub(2, 2)).toBe(0);') });
  assert.match(gate.stop().json.systemMessage, /^greenwashing: tests passed/);
  gate.prompt();
  git(dir, 'add', '-A');
  git(dir, 'mv', 'test/math.test.js', 'math.spec.js');
  assert.match(gate.stop().json.reason, /\n- test\/math\.test\.js: 'adds' \(GW-17\)\n- test\/math\.test\.js: 'subtracts' \(GW-17\)\nSee each/);
});

test('a project the gate checked stays checked for the session, also after an accepted turn changed its test script', (t) => {
  const runner = "require('node:child_process').execSync('node --test --test-reporter=tap t.test.js', { stdio: 'inherit' });\n";
  const dir = project(t, { 'package.json': '{"scripts": {"test": "node --test --test-reporter=tap"}}', 't.test.js': NODE_PASS, 'run-tests.js': runner }, null);
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 'package.json': '{"scripts": {"test": "node run-tests.js"}}' });
  assert.match(gate.stop().json.systemMessage, /^greenwashing: tests passed - npm test: 1 passed/);
  gate.prompt();
  write(dir, { 't.test.js': NODE_FAIL });
  assert.match(gate.stop().json.reason, /the tests failed/);
});

test('a human who sets testCommand between turns makes the project checked from the next turn, also after WORK NOT ACCEPTED', (t) => {
  const dir = project(t, { 'package.json': MOCHA_PKG, 'cart.js': '1;\n' }, null);
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { '.greenwashing.json': JSON.stringify({ testCommand: 'echo agent' }) });
  for (const active of [false, true, true]) assert.equal(gate.stop(active).json.decision, 'block');
  assert.match(gate.stop(true).json.systemMessage, /WORK NOT ACCEPTED/);
  write(dir, { '.greenwashing.json': JSON.stringify({ testCommand: GREEN_ECHO }) });
  gate.prompt();
  write(dir, { 'cart.js': '2;\n' });
  assert.match(gate.stop().json.systemMessage, /^greenwashing: tests passed - printf/);
});

test('the user\'s permission ends with the turn: a removal after the turn ended, with no new prompt, blocks', (t) => {
  const dir = project(t, { 'a.test.js': TWO_JS }, GREEN_ECHO);
  const gate = session(t, dir);
  gate.prompt(dir, 'allow test removal');
  write(dir, { 'a.test.js': JEST_OK });
  assert.match(gate.stop().json.systemMessage, /tests removed with the user's permission \(1\)/);
  // The removal the user allowed is not reported again; the new one is.
  write(dir, { 'a.test.js': '' });
  assert.match(gate.stop().json.reason, /\nRemoved tests [^\n]*\n- a\.test\.js: 'adds' \(GW-17\)\nSee each/);
});

test('the permission is only the words themselves; allowed removals are not listed as a problem next to other findings, nor on a release', (t) => {
  const dir = project(t, { 'a.test.js': TWO_JS }, GREEN_ECHO);
  const gate = session(t, dir);
  for (const prompt of ['We disallow test removal here.', 'No allow test removals.']) {
    gate.prompt(dir, prompt);
    write(dir, { 'a.test.js': JEST_OK });
    assert.match(gate.stop().json.reason, /\n- a\.test\.js: 'subtracts' \(GW-17\)\nSee each/, prompt);
  }
  // Allowed, with a new skip in the same turn: the block is for the skip only.
  gate.prompt(dir, 'allow test removal');
  write(dir, { 'a.test.js': `${JEST_OK}test.skip('later', () => {});\n` });
  const skipped = gate.stop().json.reason;
  assert.match(skipped, /a\.test\.js:4: test\.skip/);
  assert.doesNotMatch(skipped, /Removed tests|Put the tests back/);
  assert.equal(gate.stop(true).json.decision, 'block');
  assert.equal(gate.stop(true).json.decision, 'block');
  const released = gate.stop(true).json.systemMessage;
  assert.match(released, /WORK NOT ACCEPTED/);
  assert.doesNotMatch(released, /with the user's permission/);
});

test('a test file the user changed after a release is theirs only until a turn is accepted', (t) => {
  const dir = project(t, { 'a.test.js': TWO_JS }, GREEN_ECHO);
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 'a.test.js': JEST_OK });
  for (const active of [false, true, true]) assert.equal(gate.stop(active).json.decision, 'block');
  assert.match(gate.stop(true).json.systemMessage, /WORK NOT ACCEPTED/);
  write(dir, { 'a.test.js': `${JEST_OK}// the user keeps it\n` });
  gate.prompt();
  assert.match(gate.stop().json.systemMessage, /^greenwashing: tests passed/);
  // The user adds a test between turns; the agent removes it in the next turn: blocked.
  write(dir, { 'a.test.js': `${JEST_OK}${MUL_JS}` });
  gate.prompt();
  write(dir, { 'a.test.js': JEST_OK });
  assert.match(gate.stop().json.reason, /\n- a\.test\.js: 'multiplies' \(GW-17\)\nSee each/);
});

test('a Python test file Python could not read at the start is not did not run once the agent fixes it', (t) => {
  const dir = project(t, { 'test_m.py': 'def test_(:\n' }, GREEN_ECHO);
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 'test_m.py': TWO_PY });
  assert.match(gate.stop().json.systemMessage, /^greenwashing: tests passed/);
});

test('the Python checks must list the tests asked for: a Python that prints no list is did not run', (t) => {
  const fake = '#!/bin/sh\ncat > /dev/null\necho \'{"findings": [], "errors": []}\'\n';
  const dir = project(t, { 'test_m.py': TWO_PY, 'fakepy': fake, '.greenwashing.json': JSON.stringify({ testCommand: GREEN_ECHO, python: './fakepy' }) }, null);
  fs.chmodSync(path.join(dir, 'fakepy'), 0o755);
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 'test_m.py': ONE_PY });
  assert.match(gate.stop().json.reason, /Result: did not run - the Python test checks could not run: \.\/fakepy printed no findings list|Result: did not run - the Python test checks could not run: .*fakepy printed no findings list/);
});

test('Node 20.0.0 is new enough: the gate runs', (t) => {
  const dir = project(t, { 't.test.js': NODE_PASS });
  const preload = path.join(tempDir(t), 'node-20.js');
  fs.writeFileSync(preload, "Object.defineProperty(process.versions, 'node', { value: '20.0.0' });\n");
  const gate = session(t, dir, { env: { NODE_OPTIONS: `--require ${preload}` } });
  assert.equal(gate.raw('session', { session_id: 's', cwd: dir, hook_event_name: 'SessionStart' }).stdout, '');
  gate.prompt();
  write(dir, { 't.test.js': NODE_FAIL });
  assert.match(gate.stop().json.reason, /the tests failed/);
});

test('a Python test file split in two keeps every test; a part that loses one is a removal', (t) => {
  const head = 'import unittest\n\n\nclass TestMath(unittest.TestCase):\n';
  const method = (name, n) => `    def test_${name}(self):\n        self.assertEqual(f(${n}), ${n})\n`;
  const all = `${head}${method('a', 1)}\n${method('b', 2)}\n${method('c', 3)}\n${method('d', 4)}`;
  const dir = project(t, { 'test_m.py': all }, `${GREEN_ECHO} # python3 -m unittest`);
  const gate = session(t, dir);
  gate.prompt(dir, 'Split test_m.py in two files.');
  fs.unlinkSync(path.join(dir, 'test_m.py'));
  write(dir, { 'test_small.py': `${head}${method('a', 1)}\n${method('b', 2)}`, 'test_big.py': `${head}${method('c', 3)}\n${method('d', 4)}` });
  assert.match(gate.stop().json.systemMessage, /^greenwashing: tests passed/);
  gate.prompt();
  write(dir, { 'test_big.py': `${head}${method('c', 3)}` });
  assert.match(gate.stop().json.reason, /\n- test_big\.py: TestMath\.test_d \(GW-17\)\nSee each/);
});

test('a failing test\'s body pasted into a test that stays skipped, or a test renamed onto a later one of the same name, is removed', (t) => {
  const later = "test.skip('currency, later', () => {\n  assert.equal(1, 1);\n});\n";
  const skipPy = '    @unittest.skip("later")\n    def test_currency(self):\n        self.assertEqual(1, 1)\n';
  const dir = project(t, { 'a.test.js': `${TWO_JS}${later}`, 'test_m.py': `${TWO_PY}\n${skipPy}` }, GREEN_ECHO);
  const gate = session(t, dir);
  gate.prompt();
  write(dir, {
    'a.test.js': `${JEST_OK}${later.replace('assert.equal(1, 1);', 'expect(sub(3, 2)).toBe(1);')}`,
    'test_m.py': `${ONE_PY}\n${skipPy.replace('self.assertEqual(1, 1)', 'self.assertEqual(sub(3, 2), 1)')}`,
  });
  const reason = gate.stop().json.reason;
  assert.match(reason, /\n- a\.test\.js: 'subtracts' \(GW-17\)\n- test_m\.py: TestMath\.test_subtracts \(GW-17\)\nSee each/);
  // Python keeps only the later of two methods of one name: the failing one renamed onto it is gone.
  write(dir, { 'a.test.js': TWO_JS + later, 'test_m.py': `${TWO_PY.replace('def test_subtracts', 'def test_adds')}\n${skipPy}` });
  assert.match(gate.stop(true).json.reason, /\nRemoved tests [^\n]*\n- test_m\.py: TestMath\.test_subtracts \(GW-17\)\nSee each/);
  // Control: renamed to a new name, it is kept.
  write(dir, { 'test_m.py': `${TWO_PY.replace('def test_subtracts', 'def test_takes_away')}\n${skipPy}` });
  assert.match(gate.stop(true).json.systemMessage, /^greenwashing: tests passed/);
});

test('tests given only a function: deleting one is removed, renaming one is not', (t) => {
  const fns = 'test(function emptyCart() {\n  assert.equal(total([]), 0);\n});\ntest(function sumsPrices() {\n  assert.equal(total([2, 4]), 6);\n});\n';
  const dir = project(t, { 'cart.test.js': fns }, GREEN_ECHO);
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 'cart.test.js': fns.replace('sumsPrices', 'addsPrices') });
  assert.match(gate.stop().json.systemMessage, /^greenwashing: tests passed/);
  gate.prompt();
  write(dir, { 'cart.test.js': fns.split('test(function sumsPrices')[0] });
  assert.match(gate.stop().json.reason, /\n- cart\.test\.js: addsPrices \(GW-17\)\nSee each/);
});

test('honest reshaping keeps the tests: quotes a formatter changed, pytest functions grouped into a class', (t) => {
  const js = "test('joins first and last name', () => {\n  assert.equal(label('Ada', 'Lovelace'), 'Ada Lovelace');\n});\n";
  const py = 'from cart import total\n\n\ndef test_empty():\n    assert total([]) == 0\n\n\ndef test_sums():\n    assert total([2, 4]) == 6\n';
  const dir = project(t, { 'label.test.js': js, 'test_cart.py': py }, `${GREEN_ECHO} # python3 -m pytest`);
  const gate = session(t, dir);
  gate.prompt();
  write(dir, {
    'label.test.js': js.replace(/'/g, '"'),
    'test_cart.py': 'from cart import total\n\n\nclass TestTotal:\n    def test_empty(self):\n        assert total([]) == 0\n\n    def test_sums(self):\n        assert total([2, 4]) == 6\n',
  });
  assert.match(gate.stop().json.systemMessage, /^greenwashing: tests passed/);
  // Control: grouped, with one of them gone.
  write(dir, { 'test_cart.py': 'from cart import total\n\n\nclass TestTotal:\n    def test_empty(self):\n        assert total([]) == 0\n' });
  assert.match(gate.stop().json.reason, /\n- test_cart\.py: test_sums \(GW-17\)\nSee each/);
});

test('a test moved where the runner does not look is removed: a dot folder (node --test on Node 21+, pytest), a folder pytest skips, a name unittest cannot import', (t) => {
  const moveOut = (files, move, testCommand) => {
    const dir = project(t, files, testCommand);
    const gate = session(t, dir);
    gate.prompt();
    move(dir);
    return gate.stop().json;
  };
  const sub = "test('subtracts', () => {\n  expect(sub(3, 2)).toBe(1);\n});\n";
  const dotted = moveOut({ 'a.test.js': TWO_JS }, (dir) => write(dir, { 'a.test.js': JEST_OK, '.ci/sub.test.js': sub }), `${GREEN_ECHO} # node --test`);
  if (Number(process.versions.node.split('.')[0]) >= 21) assert.match(dotted.reason, /\n- a\.test\.js: 'subtracts' \(GW-17\)\nSee each/);
  else assert.match(dotted.systemMessage, /^greenwashing: tests passed/);
  // jest looks in dot folders: kept.
  assert.match(moveOut({ 'a.test.js': TWO_JS }, (dir) => write(dir, { 'a.test.js': JEST_OK, '.ci/sub.test.js': sub }), `${GREEN_ECHO} # jest`).systemMessage, /^greenwashing: tests passed/);
  const subPy = `import unittest\n\n\nclass TestMath(unittest.TestCase):\n${TWO_PY.slice(TWO_PY.indexOf('    def test_subtracts'))}`;
  for (const [to, command] of [['build/test_sub.py', 'pytest'], ['.ci/test_sub.py', 'pytest'], ['test-sub.py', 'python3 -m unittest']]) {
    const json = moveOut({ 'test_m.py': TWO_PY }, (dir) => write(dir, { 'test_m.py': ONE_PY, [to]: subPy }), `${GREEN_ECHO} # ${command}`);
    assert.match(json.reason, /\n- test_m\.py: TestMath\.test_subtracts \(GW-17\)\nSee each/, to);
  }
  assert.match(moveOut({ 'test_m.py': TWO_PY }, (dir) => write(dir, { 'test_m.py': ONE_PY, 'tests/test_sub.py': subPy }), `${GREEN_ECHO} # pytest`).systemMessage, /^greenwashing: tests passed/);
});

test('node --test and TypeScript: where Node strips types, a .test.ts test moved to .spec.ts is removed and a .js test file moved to .ts is kept', (t) => {
  const strips = Boolean(process.features.typescript);
  const two = "import test from 'node:test';\nimport assert from 'node:assert';\ntest('empty', () => { assert.equal(total([]), 0); });\ntest('sums', () => { assert.equal(total([2, 4]), 6); });\n";
  const dir = project(t, { 'cart.test.ts': two, 'cart.test.js': two.replace("test('empty'", "test('none'") }, `${GREEN_ECHO} # node --test`);
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 'cart.test.ts': two.replace(/test\('sums'[^\n]*\n/, ''), 'cart.spec.ts': "import test from 'node:test';\ntest('sums', () => { assert.equal(total([2, 4]), 6); });\n" });
  const spec = gate.stop().json;
  // On a Node that runs no .ts, the tests of cart.test.ts never ran: moving them is no removal.
  if (strips) assert.match(spec.reason, /\n- cart\.test\.ts: 'sums' \(GW-17\)\nSee each/);
  else assert.match(spec.systemMessage, /^greenwashing: tests passed/);
  write(dir, { 'cart.test.ts': two });
  fs.unlinkSync(path.join(dir, 'cart.spec.ts'));
  assert.deepEqual(gate.stop(true).json, NO_CHANGES);
  gate.prompt(dir, 'Move the cart tests to TypeScript.');
  git(dir, 'mv', 'cart.test.js', 'cart2.test.ts');
  const migrated = gate.stop().json;
  if (strips) assert.match(migrated.systemMessage, /^greenwashing: tests passed/);
  else assert.match(migrated.reason, /\n- cart\.test\.js: 'none' \(GW-17\)\n/);
});

test('after a turn whose prompt allowed test removal, the removal does not block the next turn, however the turn ended', (t) => {
  for (const end of ['release', 'interrupt']) {
    const dir = project(t, { 'a.test.js': TWO_JS, 'app.js': '1;\n', 't.test.js': NODE_PASS }, NODE_CMD);
    const gate = session(t, dir);
    gate.prompt(dir, 'The subtraction is gone: allow test removal, drop its test.');
    write(dir, { 'a.test.js': JEST_OK, 't.test.js': NODE_FAIL });
    if (end === 'release') {
      for (const active of [false, true, true]) assert.match(gate.stop(active).json.reason, /the tests failed/, end);
      const released = gate.stop(true).json.systemMessage;
      assert.match(released, /WORK NOT ACCEPTED/, end);
      assert.doesNotMatch(released, /removed tests still block/, end);
    }
    gate.prompt(dir, 'Fix the failing test.');
    write(dir, { 't.test.js': NODE_PASS });
    assert.match(gate.stop().json.systemMessage, /^greenwashing: tests passed/, end);
    // Without the words, a removal made in the next turn blocks.
    gate.prompt(dir, 'go on');
    write(dir, { 'a.test.js': '' });
    assert.match(gate.stop().json.reason, /\n- a\.test\.js: 'adds' \(GW-17\)\nSee each/, end);
  }
  // Control: the same turn without the words blocks the next turn too.
  const dir = project(t, { 'a.test.js': TWO_JS, 't.test.js': NODE_PASS }, NODE_CMD);
  const gate = session(t, dir);
  gate.prompt(dir, 'Drop the subtraction test.');
  write(dir, { 'a.test.js': JEST_OK, 't.test.js': NODE_FAIL });
  gate.prompt(dir, 'Fix the failing test.');
  write(dir, { 't.test.js': NODE_PASS });
  assert.match(gate.stop().json.reason, /\n- a\.test\.js: 'subtracts' \(GW-17\)\nSee each/);
});

test('outside git, a .greenwashing.json the agent writes in a project the gate cannot check blocks (GW-114), and stays the agent\'s after WORK NOT ACCEPTED', (t) => {
  const dir = tempDir(t);
  write(dir, { 'package.json': MOCHA_PKG, 'cart.js': '1;\n' });
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { '.greenwashing.json': JSON.stringify({ testCommand: GREEN_ECHO }) });
  for (const active of [false, true, true]) assert.match(gate.stop(active).json.reason, /Changed: \.greenwashing\.json\n/);
  assert.match(gate.stop(true).json.systemMessage, /WORK NOT ACCEPTED/);
  gate.prompt();
  assert.match(gate.stop().json.reason, /Changed: \.greenwashing\.json\n/);
  // A human who changes it between turns makes it theirs: the project is checked with their command.
  write(dir, { '.greenwashing.json': JSON.stringify({ testCommand: GREEN_ECHO, timeoutSeconds: 60 }) });
  gate.prompt();
  assert.match(gate.stop().json.systemMessage, /^greenwashing: tests passed - printf/);
});

test('outside git, after WORK NOT ACCEPTED the tests keep the settings the work started with while the agent\'s change is left as it was', (t) => {
  const dir = tempDir(t);
  write(dir, { '.greenwashing.json': JSON.stringify({ testCommand: NODE_CMD }), 't.test.js': NODE_FAIL });
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { '.greenwashing.json': JSON.stringify({ testCommand: GREEN_ECHO }) });
  for (const active of [false, true, true]) assert.match(gate.stop(active).json.reason, /Command: node --test --test-reporter=tap t\.test\.js/);
  assert.match(gate.stop(true).json.systemMessage, /WORK NOT ACCEPTED/);
  gate.prompt();
  assert.match(gate.stop().json.reason, /Command: node --test --test-reporter=tap t\.test\.js/);
  // Changed by a human between turns: theirs.
  write(dir, { '.greenwashing.json': JSON.stringify({ testCommand: GREEN_ECHO, timeoutSeconds: 60 }) });
  gate.prompt();
  assert.match(gate.stop().json.systemMessage, /^greenwashing: tests passed - printf/);
});

test('hooks added in the middle of a session: a .greenwashing.json the agent writes before a start is recorded still blocks (GW-114)', (t) => {
  // A project the gate cannot check: the first Stop has no prompt and blocks; the next prompt keeps its null start.
  const unchecked = project(t, { 'main.go': 'package main\n', 'a.test.js': NODE_FAIL }, null);
  const one = session(t, unchecked);
  write(unchecked, { 'main.go': 'package main\n\nfunc main() {}\n' });
  assert.equal(one.stop().json.decision, 'block');
  one.prompt();
  write(unchecked, { '.greenwashing.json': JSON.stringify({ testCommand: GREEN_ECHO }) });
  assert.match(one.stop().json.reason, /Changed: \.greenwashing\.json\n/);
  // A project the gate checks: the agent fixes the tests and swaps the command in the same turn.
  const checked = project(t, { 't.test.js': NODE_PASS, 'app.js': '1;\n' });
  const two = session(t, checked);
  write(checked, { 't.test.js': NODE_FAIL });
  assert.match(two.stop().json.reason, /the tests failed/);
  two.prompt();
  write(checked, { 't.test.js': NODE_PASS, '.greenwashing.json': JSON.stringify({ testCommand: GREEN_ECHO }) });
  assert.match(two.stop().json.reason, /Changed: \.greenwashing\.json\n/);
  // Control: the same turn without the settings change passes, with the note that the checks did not run.
  write(checked, { '.greenwashing.json': JSON.stringify({ testCommand: NODE_CMD }) });
  assert.match(two.stop(true).json.systemMessage, /^greenwashing: tests passed - .*; quick checks of changed tests not run \(no start of the turn was recorded\)$/);
});

test('outside git, the line of a project the gate cannot check says why: a test script of another kind', (t) => {
  const dir = tempDir(t);
  write(dir, { 'package.json': MOCHA_PKG, 'cart.js': '1;\n' });
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 'cart.js': '2;\n' });
  assert.deepEqual(gate.stop().json, { systemMessage: NOT_CHECKED('the test command npm test runs "mocha"') });
});

test('a project the gate cannot check is decided again only after a turn the gate let end, not after one cut off', (t) => {
  const dir = project(t, { 'main.go': 'package main\n' }, null);
  const gate = session(t, dir);
  gate.prompt();
  // Cut off before its Stop: tests and a test script added; the next turn is still not checked, and its
  // line names the command the turn after it is checked with.
  write(dir, { 'package.json': '{"scripts": {"test": "node --test --test-reporter=tap"}}', 't.test.js': NODE_FAIL });
  gate.prompt();
  assert.deepEqual(gate.stop().json, { systemMessage: FIRST_COMMAND('npm test (package.json scripts.test)') });
  // Let end: the next turn is checked.
  gate.prompt();
  write(dir, { 'main.go': 'package main\n\nfunc main() {}\n' });
  assert.match(gate.stop().json.reason, /the tests failed/);
});

test('after WORK NOT ACCEPTED of a turn with the words, a Stop with no prompt before it has no permission', (t) => {
  const dir = project(t, { 'a.test.js': TWO_JS, 't.test.js': NODE_PASS }, NODE_CMD);
  const gate = session(t, dir);
  gate.prompt(dir, 'allow test removal');
  write(dir, { 'a.test.js': JEST_OK, 't.test.js': NODE_FAIL });
  for (const active of [false, true, true]) assert.match(gate.stop(active).json.reason, /the tests failed/);
  assert.match(gate.stop(true).json.systemMessage, /WORK NOT ACCEPTED/);
  // A turn a background task starts: no prompt of the user, so the words do not count, for the removal of
  // the turn before (its permission is used up) and for a new one.
  write(dir, { 'a.test.js': '', 't.test.js': NODE_PASS });
  assert.match(gate.stop().json.reason, /\nRemoved tests [^\n]*\n- a\.test\.js: 'adds' \(GW-17\)\n- a\.test\.js: 'subtracts' \(GW-17\)\nSee each/);
});

test('a test file moved with exactly half of its lines new is a move: its tests keep their names', (t) => {
  const dir = project(t, { 'a.test.js': TWO_JS }, GREEN_ECHO);
  const gate = session(t, dir);
  gate.prompt();
  // The 6 lines of a.test.js and 6 new ones (both tests edited), with no line break at the end: 12 lines, half new.
  fs.unlinkSync(path.join(dir, 'a.test.js'));
  const moved = TWO_JS.replace('expect(add(1, 2)).toBe(3);', 'expect(add(1, 2)).toBe(3);\n  expect(add(0, 0)).toBe(0);\n  expect(add(1, 0)).toBe(1);\n  expect(add(0, 1)).toBe(1);')
    .replace('expect(sub(3, 2)).toBe(1);', 'expect(sub(3, 2)).toBe(1);\n  expect(sub(0, 0)).toBe(0);\n  expect(sub(5, 5)).toBe(0);\n  expect(sub(2, 1)).toBe(1);').trimEnd();
  assert.equal(moved.split('\n').length, 12);
  write(dir, { 'b.test.js': moved });
  assert.match(gate.stop().json.systemMessage, /^greenwashing: tests passed/);
  // One more new line: a new file, so the tests of the deleted one are removed.
  write(dir, { 'b.test.js': moved.replace('expect(add(0, 0)).toBe(0);', 'expect(add(0, 0)).toBe(0);\n  expect(add(2, 0)).toBe(2);') });
  assert.match(gate.stop(true).json.reason, /\n- a\.test\.js: 'adds' \(GW-17\)\n- a\.test\.js: 'subtracts' \(GW-17\)\nSee each/);
});

test('the Stop that let the agent stop is used by the next prompt only: a removal after a later blocked, cut-off turn stays the agent\'s', (t) => {
  const three = `${TWO_JS}${MUL_JS}`;
  const dir = project(t, { 'a.test.js': three }, GREEN_ECHO);
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 'a.test.js': three.replace(/test\('subtracts'[^]*?\}\);\n/, '') });
  for (const active of [false, true, true]) assert.equal(gate.stop(active).json.decision, 'block');
  assert.match(gate.stop(true).json.systemMessage, /WORK NOT ACCEPTED/);
  // No edit of the user; the next turn removes another test, is blocked, and is cut off.
  gate.prompt();
  write(dir, { 'a.test.js': JEST_OK });
  assert.match(gate.stop().json.reason, /\n- a\.test\.js: 'subtracts' \(GW-17\)\n- a\.test\.js: 'multiplies' \(GW-17\)\nSee each/);
  gate.prompt();
  assert.match(gate.stop().json.reason, /\n- a\.test\.js: 'subtracts' \(GW-17\)\n- a\.test\.js: 'multiplies' \(GW-17\)\nSee each/);
});

test('the words must stand alone: "auto-allow test removal" is not them; the line of a turn let go never names the permission', (t) => {
  const dir = project(t, { 'a.test.js': TWO_JS, 't.test.js': NODE_PASS }, NODE_CMD);
  const gate = session(t, dir);
  gate.prompt(dir, 'Our policy: never auto-allow test removal.');
  write(dir, { 'a.test.js': JEST_OK });
  assert.match(gate.stop().json.reason, /\n- a\.test\.js: 'subtracts' \(GW-17\)\nSee each/);
  // Allowed, but the tests fail until the gate lets the agent stop: the release line does not list the removal.
  gate.prompt(dir, 'allow test removal');
  write(dir, { 't.test.js': NODE_FAIL });
  for (const active of [false, true, true]) assert.match(gate.stop(active).json.reason, /the tests failed/);
  const released = gate.stop(true).json.systemMessage;
  assert.match(released, /WORK NOT ACCEPTED.*\(node --test --test-reporter=tap t\.test\.js\)\.$/);
  assert.doesNotMatch(released, /permission/);
});

test('a test the user removes in a worktree after WORK NOT ACCEPTED stays theirs when the agent commits and removes the worktree', (t) => {
  const { dir, tree, gate } = seenWorktree(t, { 'a.test.js': `${TWO_JS}${MUL_JS}`, 't.test.js': NODE_PASS });
  write(tree, { 't.test.js': NODE_FAIL });
  for (const active of [false, true, true]) assert.match(gate.stop(active, tree).json.reason, /the tests failed/);
  assert.match(gate.stop(true, tree).json.systemMessage, /WORK NOT ACCEPTED/);
  // Between turns the user removes a test there; the agent fixes the tests, commits and removes the worktree.
  write(tree, { 'a.test.js': TWO_JS });
  gate.prompt(tree);
  write(tree, { 't.test.js': NODE_PASS });
  git(tree, 'commit', '-qam', 'fix');
  git(dir, 'worktree', 'remove', tree);
  assert.match(gate.stop(false, dir).json.systemMessage, /^greenwashing: tests passed - .*the last commit of the removed worktree/);
  assert.deepEqual(leftovers(gate, dir), []);
});

test('a project in a subfolder: a test moved out of the project\'s folder is removed; moves are judged from that folder', (t) => {
  const moveIn = (sub, dest, runner = 'node --test') => {
    const dir = tempDir(t);
    const place = path.join(dir, sub);
    write(place, { '.greenwashing.json': JSON.stringify({ testCommand: `${GREEN_ECHO} # ${runner}` }), 'cart.test.js': TWO_JS });
    project(t, {}, null, dir);
    const gate = session(t, place);
    gate.prompt(place);
    write(place, { 'cart.test.js': JEST_OK });
    write(dir, { [dest]: "test('subtracts', () => {\n  expect(sub(3, 2)).toBe(1);\n});\n" });
    return gate.stop(false, place).json;
  };
  assert.match(moveIn('app', 'lib/cart.test.js').reason, /\n- cart\.test\.js: 'subtracts' \(GW-17\)\nSee each/);
  assert.match(moveIn('app', 'lib/cart.test.js', 'jest').reason, /\n- cart\.test\.js: 'subtracts' \(GW-17\)\nSee each/);
  assert.match(moveIn('app', 'app/test/cart.js').systemMessage, /^greenwashing: tests passed/);
  // The folders above the project do not count: node --test run in the project collects neither.
  assert.match(moveIn('.github/actions/cart', '.github/actions/cart/cart.spec.js').reason, /\n- cart\.test\.js: 'subtracts' \(GW-17\)\nSee each/);
  assert.match(moveIn('test/e2e', 'test/e2e/cart-cases.js').reason, /\n- cart\.test\.js: 'subtracts' \(GW-17\)\nSee each/);
});

test('after WORK NOT ACCEPTED, a turn with no prompt of the user uses up what the gate kept for the next prompt: its removal stays the agent\'s', (t) => {
  const dir = project(t, { 'a.test.js': TWO_JS, 't.test.js': NODE_PASS }, NODE_CMD);
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 't.test.js': NODE_FAIL });
  for (const active of [false, true, true]) assert.match(gate.stop(active).json.reason, /the tests failed/);
  assert.match(gate.stop(true).json.systemMessage, /WORK NOT ACCEPTED/);
  // A turn a background task starts removes a test; its Stop blocks it.
  write(dir, { 'a.test.js': JEST_OK });
  assert.match(gate.stop().json.reason, /\n- a\.test\.js: 'subtracts' \(GW-17\)\nSee each/);
  // The user's next prompt does not take that removal as the user's.
  gate.prompt();
  write(dir, { 't.test.js': NODE_PASS });
  assert.match(gate.stop().json.reason, /\n- a\.test\.js: 'subtracts' \(GW-17\)\nSee each/);
});

test('a turn with the words blocked and then cut off: a later Stop with no prompt of the user has no permission', (t) => {
  const three = `${TWO_JS}${MUL_JS}`;
  const dir = project(t, { 'a.test.js': three, 't.test.js': NODE_PASS }, NODE_CMD);
  const gate = session(t, dir);
  gate.prompt(dir, 'Drop the multiplication test. allow test removal');
  write(dir, { 'a.test.js': TWO_JS, 't.test.js': NODE_FAIL });
  assert.match(gate.stop().json.reason, /the tests failed/);
  // Cut off. A turn with no prompt removes another test and makes the tests pass.
  write(dir, { 'a.test.js': JEST_OK, 't.test.js': NODE_PASS });
  assert.match(gate.stop().json.reason, /\n- a\.test\.js: 'subtracts' \(GW-17\)\n- a\.test\.js: 'multiplies' \(GW-17\)\nSee each/);
  // Control: a continuation after the block (stop_hook_active) keeps the permission.
  const other = project(t, { 'a.test.js': three, 't.test.js': NODE_PASS }, NODE_CMD);
  const again = session(t, other);
  again.prompt(other, 'Drop the multiplication test. allow test removal');
  write(other, { 'a.test.js': TWO_JS, 't.test.js': NODE_FAIL });
  assert.match(again.stop().json.reason, /the tests failed/);
  write(other, { 't.test.js': NODE_PASS });
  assert.match(again.stop(true).json.systemMessage, /tests removed with the user's permission \(1\): a\.test\.js: 'multiplies'$/);
});

test('a project the gate cannot check is decided again after WORK NOT ACCEPTED: tests the human adds between turns are checked', (t) => {
  const dir = project(t, { 'main.go': 'package main\n' }, null);
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { '.greenwashing.json': JSON.stringify({ testCommand: GREEN_ECHO }) });
  for (const active of [false, true, true]) assert.match(gate.stop(active).json.reason, /Changed: \.greenwashing\.json\n/);
  assert.match(gate.stop(true).json.systemMessage, /WORK NOT ACCEPTED/);
  // Between turns the human removes the agent's file and adds tests and a test script.
  fs.unlinkSync(path.join(dir, '.greenwashing.json'));
  write(dir, { 'package.json': '{"scripts": {"test": "node --test --test-reporter=tap"}}', 't.test.js': NODE_PASS });
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'tests');
  gate.prompt();
  write(dir, { 't.test.js': NODE_FAIL });
  assert.match(gate.stop().json.reason, /the tests failed/);
});

test('Python tests a class inherits from a class of its file: removing the class that runs them is a removal', (t) => {
  const mixin = 'import unittest\n\n\nclass CartTests:\n    backend = None\n\n    def test_total(self):\n        self.assertEqual(total([1, 2], self.backend), 3)\n\n\n'
    + 'class TestMemoryCart(CartTests, unittest.TestCase):\n    backend = "memory"\n\n\nclass TestSqlCart(CartTests, unittest.TestCase):\n    backend = "sql"\n';
  const dir = project(t, { 'test_cart.py': mixin }, GREEN_ECHO);
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 'test_cart.py': mixin.replace('class TestSqlCart', 'class TestSqlStoreCart') });
  assert.match(gate.stop().json.systemMessage, /^greenwashing: tests passed/);
  gate.prompt();
  write(dir, { 'test_cart.py': mixin.split('\n\n\nclass TestSqlCart')[0] + '\n' });
  assert.match(gate.stop().json.reason, /\n- test_cart\.py: TestSqlStoreCart\.test_total \(GW-17\)\nSee each/);
});

test('outside git, a settings change the agent makes in a turn the gate accepts does not become the user\'s at the next prompt', (t) => {
  const dir = tempDir(t);
  write(dir, { '.greenwashing.json': JSON.stringify({ testCommand: NODE_CMD }), 't.test.js': NODE_PASS });
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { '.greenwashing.json': JSON.stringify({ testCommand: GREEN_ECHO }) });
  assert.match(gate.stop().json.systemMessage, /^greenwashing: tests passed - node --test/);
  gate.prompt();
  write(dir, { 't.test.js': NODE_FAIL });
  assert.match(gate.stop().json.reason, /Command: node --test --test-reporter=tap t\.test\.js/);
});

test('Node 19 is too old: the gate says it is off', (t) => {
  const dir = project(t, { 't.test.js': NODE_PASS });
  const preload = path.join(tempDir(t), 'node-19.js');
  fs.writeFileSync(preload, "Object.defineProperty(process.versions, 'node', { value: '19.9.0' });\n");
  const gate = session(t, dir, { env: { NODE_OPTIONS: `--require ${preload}` } });
  gate.prompt();
  write(dir, { 't.test.js': NODE_FAIL });
  assert.match(gate.stop().json.systemMessage, /^greenwashing: the gate is OFF - the node on PATH is v19\.9\.0\./);
});

test('outside git, a .greenwashing.json the agent deletes stays the agent\'s change after WORK NOT ACCEPTED', (t) => {
  const dir = tempDir(t);
  write(dir, { '.greenwashing.json': JSON.stringify({ testCommand: NODE_CMD }), 't.test.js': NODE_PASS });
  const gate = session(t, dir);
  gate.prompt();
  fs.unlinkSync(path.join(dir, '.greenwashing.json'));
  write(dir, { 't.test.js': NODE_FAIL });
  for (const active of [false, true, true]) assert.match(gate.stop(active).json.reason, /Command: node --test --test-reporter=tap t\.test\.js/);
  assert.match(gate.stop(true).json.systemMessage, /WORK NOT ACCEPTED/);
  gate.prompt();
  assert.match(gate.stop().json.reason, /Command: node --test --test-reporter=tap t\.test\.js/);
});

test('a Python test file moved with a test edited in it keeps its tests', (t) => {
  const dir = project(t, { 'test_m.py': TWO_PY }, `${GREEN_ECHO} # pytest`);
  const gate = session(t, dir);
  gate.prompt();
  git(dir, 'mv', 'test_m.py', 'test_math.py');
  write(dir, { 'test_math.py': TWO_PY.replace('self.assertEqual(add(1, 2), 3)', 'self.assertEqual(add(1, 2), 3)\n        self.assertEqual(add(0, 0), 0)') });
  assert.match(gate.stop().json.systemMessage, /^greenwashing: tests passed/);
});

test('the Python checks must list every text asked for: a list without the asked keys is did not run', (t) => {
  const fake = '#!/bin/sh\ncat > /dev/null\necho \'{"findings": [], "errors": [], "tests": {}}\'\n';
  const dir = project(t, { 'test_m.py': TWO_PY, 'fakepy': fake, '.greenwashing.json': JSON.stringify({ testCommand: GREEN_ECHO, python: './fakepy' }) }, null);
  fs.chmodSync(path.join(dir, 'fakepy'), 0o755);
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 'test_m.py': ONE_PY });
  assert.match(gate.stop().json.reason, /Result: did not run - the Python test checks could not run: .*fakepy printed no findings list/);
});

test('the words followed by a hyphen are not them; the permission of a turn that ended with no code change does not reach a later Stop with no prompt', (t) => {
  const dir = project(t, { 'a.test.js': TWO_JS, 'notes.md': 'x\n' }, GREEN_ECHO);
  const gate = session(t, dir);
  gate.prompt(dir, 'No allow test removal-style shortcuts here.');
  write(dir, { 'a.test.js': JEST_OK });
  assert.match(gate.stop().json.reason, /\n- a\.test\.js: 'subtracts' \(GW-17\)\nSee each/);
  write(dir, { 'a.test.js': TWO_JS });
  assert.deepEqual(gate.stop(true).json, NO_CHANGES);
  gate.prompt(dir, 'allow test removal');
  assert.deepEqual(gate.stop().json, NO_CHANGES);
  write(dir, { 'a.test.js': JEST_OK });
  assert.match(gate.stop().json.reason, /\n- a\.test\.js: 'subtracts' \(GW-17\)\nSee each/);
});

test('an existing test file that takes in a deleted file\'s tests is not that file moved: its own tests keep its name', (t) => {
  const six = `${MUL_JS}test('divides', () => {\n  expect(div(6, 3)).toBe(2);\n});\n`;
  const dir = project(t, { 'a.test.js': "it.todo('later');\n", 'b.test.js': six }, GREEN_ECHO);
  const gate = session(t, dir);
  gate.prompt();
  fs.unlinkSync(path.join(dir, 'b.test.js'));
  write(dir, { 'a.test.js': `it.todo('later');\n${six}` });
  assert.match(gate.stop().json.systemMessage, /^greenwashing: tests passed/);
});

test('a turn accepted with removals the user allowed: later Stops before the next prompt do not report them again', (t) => {
  const dir = project(t, { 'a.test.js': TWO_JS }, GREEN_ECHO);
  const gate = session(t, dir);
  gate.prompt(dir, 'Drop the subtraction test. allow test removal');
  write(dir, { 'a.test.js': JEST_OK });
  assert.match(gate.stop().json.systemMessage, /tests removed with the user's permission \(1\): a\.test\.js: 'subtracts'$/);
  // A continuation after another hook's block, then a turn with no prompt: nothing new, nothing reported.
  assert.match(gate.stop(true).json.systemMessage, /^greenwashing: tests passed - [^;]*$/);
  assert.match(gate.stop().json.systemMessage, /^greenwashing: tests passed - [^;]*$/);
});

test('after WORK NOT ACCEPTED of a turn with the words, a continuation after another hook\'s block keeps the permission', (t) => {
  const three = `${TWO_JS}${MUL_JS}`;
  const dir = project(t, { 'a.test.js': three, 't.test.js': NODE_PASS }, NODE_CMD);
  const gate = session(t, dir);
  gate.prompt(dir, 'Drop the multiplication test. allow test removal');
  write(dir, { 'a.test.js': TWO_JS, 't.test.js': NODE_FAIL });
  for (const active of [false, true, true]) assert.match(gate.stop(active).json.reason, /the tests failed/);
  assert.match(gate.stop(true).json.systemMessage, /WORK NOT ACCEPTED/);
  write(dir, { 't.test.js': NODE_PASS });
  assert.match(gate.stop(true).json.systemMessage, /tests removed with the user's permission \(1\): a\.test\.js: 'multiplies'$/);
});

test('inherited Python tests: an empty class in between removed is no removal; a test switched off in a subclass by an assignment is', (t) => {
  const cases = 'import unittest\n\n\nclass StoreCases:\n    def test_roundtrip(self):\n        self.assertTrue(store())\n\n\n';
  const dir = project(t, { 'test_store.py': `${cases}class MemoryCases(StoreCases):\n    pass\n\n\nclass TestMemory(MemoryCases, unittest.TestCase):\n    pass\n` }, GREEN_ECHO);
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 'test_store.py': `${cases}class TestMemory(StoreCases, unittest.TestCase):\n    pass\n` });
  assert.match(gate.stop().json.systemMessage, /^greenwashing: tests passed/);
  gate.prompt();
  write(dir, { 'test_store.py': `${cases}class TestMemory(StoreCases, unittest.TestCase):\n    test_roundtrip = None\n` });
  assert.match(gate.stop().json.reason, /\n- test_store\.py: TestMemory\.test_roundtrip \(GW-17\)\nSee each/);
});

test('a project in a subfolder: a whole test file moved out of its folder or to a name its runner does not collect is removed; moves outside the folder are judged in the tree', (t) => {
  const setup = (sub, runner, files) => {
    const dir = tempDir(t);
    const place = path.join(dir, sub);
    write(place, { '.greenwashing.json': JSON.stringify({ testCommand: `${GREEN_ECHO} # ${runner}` }), 'cart.test.js': TWO_JS });
    write(dir, files);
    project(t, {}, null, dir);
    const gate = session(t, place);
    gate.prompt(place);
    return { dir, place, gate };
  };
  const jest = setup('app', 'jest', {});
  fs.mkdirSync(path.join(jest.dir, 'lib'));
  git(jest.dir, 'mv', 'app/cart.test.js', 'lib/cart.test.js');
  assert.match(jest.gate.stop(false, jest.place).json.reason, /\n- cart\.test\.js: 'adds' \(GW-17\)\n- cart\.test\.js: 'subtracts' \(GW-17\)\nSee each/);
  const node = setup('test/e2e', 'node --test', {});
  git(node.dir, 'mv', 'test/e2e/cart.test.js', 'test/e2e/cart-cases.js');
  assert.match(node.gate.stop(false, node.place).json.reason, /\n- cart\.test\.js: 'adds' \(GW-17\)\n- cart\.test\.js: 'subtracts' \(GW-17\)\nSee each/);
  // Both files outside the project's folder: judged by their paths in the tree.
  const outside = setup('app', 'node --test', { 'lib/a.test.js': TWO_JS });
  write(outside.dir, { 'lib/a.test.js': JEST_OK, 'lib/b.test.js': "test('subtracts', () => {\n  expect(sub(3, 2)).toBe(1);\n});\n" });
  assert.match(outside.gate.stop(false, outside.place).json.systemMessage, /^greenwashing: tests passed/);
});

