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
const NODE_FAIL = "const test = require('node:test');\nconst assert = require('node:assert');\ntest('bad', () => assert.equal(1, 2));\n";
const NODE_EMPTY = "const test = require('node:test');\ntest.skip('later', () => {});\n";
const NODE_CMD = 'node --test --test-reporter=tap t.test.js';
const PY_PASS = 'import unittest\n\n\nclass T(unittest.TestCase):\n    def test_a(self):\n        self.assertEqual(1 + 1, 2)\n';
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
  const dir = project(t, { 'main.go': 'package main\n' }, null);
  const gate = session(t, dir);
  gate.prompt();
  write(dir, { 'main.go': 'package main\n\nfunc main() {}\n' });
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
  const gate = session(t, dir);
  gate.prompt();
  const { json } = gate.stop();
  assert.equal(json.decision, 'block');
  assert.match(json.reason, /git cannot read the repository this folder is in/);
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
  const gate = session(t, path.join(dir, 'p'));
  gate.prompt();
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
  assert.deepEqual(gate.stop().json, { systemMessage: 'greenwashing: not a git repository and no test command - tests not run' });
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
  assert.match(gate.stop().json.reason, /\nFailed tests \(1\):\n- bad\nLast 20 lines of output:/);
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
  // Mostly new lines: a new file, not a moved one.
  fs.unlinkSync(path.join(dir, 'b.test.js'));
  write(dir, { 'c.test.js': "it.skip('old', () => {});\ntest('more', () => {\n  expect(add(2, 2)).toBe(4);\n}, 5000);\n" });
  assert.match(gate.stop(true).json.reason, /\n- c\.test\.js:1: it\.skip - the test does not run \(GW-17\)\nSee each/);
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
  const dir = project(t, { 'a.test.js': JEST_OK, '.gitignore': '.greenwashing.json\n' }, null);
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
  // A configured Python that fails is named as it is.
  fs.writeFileSync(path.join(bin, 'failing'), '#!/bin/sh\necho boom >&2\nexit 3\n', { mode: 0o755 });
  const failing = project(t, { 'test_a.py': PY_OK, '.greenwashing.json': config(path.join(bin, 'failing')) }, null);
  const other = session(t, failing);
  other.prompt();
  write(failing, { 'test_a.py': `${PY_OK}# more\n` });
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
