'use strict';
// Runs mutate.js the way a person or the plugin command does, on real temporary git projects with
// real test runs (node --test, python3 -m unittest).
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MUTATE = path.join(__dirname, '..', 'mutate.js');
const NODE_CMD = 'node --test --test-reporter=tap';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function tempDir(t, prefix = 'gw-mutate-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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

// A project whose main branch holds files, on a branch feat made from it; testCommand goes to
// .greenwashing.json unless it is null.
function project(t, files, testCommand = NODE_CMD, dir = tempDir(t)) {
  write(dir, { ...(testCommand === null ? {} : { '.greenwashing.json': JSON.stringify({ testCommand }) }), ...files });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'gate@example.invalid');
  git(dir, 'config', 'user.name', 'gate');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'start');
  git(dir, 'checkout', '-qb', 'feat');
  return dir;
}

// The command in dir, with its own temp folder (where its copy goes); NODE_TEST_CONTEXT is dropped,
// or the node --test it starts refuses to run inside this one.
function mutate(t, dir, args = [], tmp = tempDir(t)) {
  const env = { ...process.env, TMPDIR: tmp };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [MUTATE, ...args], { cwd: dir, env, encoding: 'utf8' });
  return { code: result.status, out: result.stdout + result.stderr, tmp, copies: fs.readdirSync(tmp).filter((name) => name.startsWith('greenwashing-mutants-')) };
}

// Every file under dir, .git and links included, with its bytes (a link: its target).
function snapshot(dir) {
  const files = {};
  const walk = (at) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      const stat = fs.lstatSync(full);
      if (stat.isDirectory()) walk(full);
      else files[path.relative(dir, full)] = crypto.createHash('sha256').update(stat.isSymbolicLink() ? `link ${fs.readlinkSync(full)}` : fs.readFileSync(full)).digest('hex') + stat.mode;
    }
  };
  walk(dir);
  return files;
}

const CART = "function total(items) {\n  return items.reduce((sum, item) => sum + item.price, 0);\n}\nmodule.exports = { total };\n";
const ADD = "function add(items, item, max) {\n  if (items.length >= max) throw new RangeError('full');\n  return [...items, item];\n}\nmodule.exports.add = add;\n";
const CART_TEST = "const test = require('node:test');\nconst assert = require('node:assert');\nconst { total, add } = require('./cart');\n"
  + "test('total', () => assert.equal(total([{ price: 2 }, { price: 3 }]), 5));\n";
const ADDS = "test('adds', () => assert.deepEqual(add([], { price: 1 }, 5), [{ price: 1 }]));\n";
const STOPS = "test('stops at max', () => assert.throws(() => add([1, 2], 3, 2), RangeError));\n";

test('a guard no test reaches survives (exit 1, GW-02); a test for it kills every break (exit 0)', (t) => {
  const dir = project(t, { 'cart.js': CART, 'cart.test.js': CART_TEST });
  write(dir, { 'cart.js': `${CART}${ADD}`, 'cart.test.js': `${CART_TEST}${ADDS}` });
  const weak = mutate(t, dir);
  assert.equal(weak.code, 1, weak.out);
  assert.match(weak.out, /^greenwashing mutants: the code lines changed since [0-9a-f]{12} \(the merge base with main\), committed or not\n1 code file, 5 changed lines, 4 places to break; 4 tried at most \(limit 20\)\n/);
  assert.match(weak.out, /\nControl: node --test --test-reporter=tap \(\.greenwashing\.json\) on the unchanged copy: passed \(2 passed, 0 failed, 0 skipped\)\n/);
  assert.match(weak.out, /\nMutants: 4 tried - 3 killed, 1 survived, 0 did not run\n/);
  assert.match(weak.out, /\nSurvived - the tests passed with the code broken:\n- cart\.js:6: removed: if \(items\.length >= max\) throw new RangeError\('full'\);\n {2}the tests pass without this guard: .* See GW-02 in https:\/\/\S+CATALOG\.md\n/);
  assert.match(weak.out, /\nResult: 1 mutant survived$/m);
  assert.deepEqual(weak.copies, []);
  write(dir, { 'cart.test.js': `${CART_TEST}${ADDS}${STOPS}` });
  const strong = mutate(t, dir);
  assert.equal(strong.code, 0, strong.out);
  assert.match(strong.out, /\nMutants: 4 tried - 4 killed, 0 survived, 0 did not run\n/);
  assert.match(strong.out, /\nResult: every mutant was killed$/m);
});

test('Python: breaks in the changed lines of a module, judged by unittest', (t) => {
  const base = 'def total(prices):\n    return sum(prices)\n';
  const tests = 'import unittest\n\nfrom shop import total, discount\n\n\nclass T(unittest.TestCase):\n    def test_total(self):\n        self.assertEqual(total([2, 3]), 5)\n';
  const dir = project(t, { 'shop.py': base, 'test_shop.py': tests.replace(', discount', '') }, null);
  write(dir, {
    'shop.py': `${base}\n\ndef discount(price, rate):\n    if rate > 1:\n        raise ValueError("rate")\n    return price * (1 - rate)\n`,
    'test_shop.py': `${tests}\n    def test_discount(self):\n        self.assertEqual(discount(10, 0.5), 5)\n`,
  });
  const run = mutate(t, dir);
  assert.equal(run.code, 1, run.out);
  assert.match(run.out, /Control: python3 -m unittest discover \(Python project\) on the unchanged copy: passed \(2 passed, 0 failed, 0 skipped\)/);
  assert.match(run.out, /- survived: shop\.py:6: removed: if rate > 1: \(2 lines\)\n/);
  assert.match(run.out, /- killed: shop\.py:8: return price \* \(1 - rate\) {2}-> {2}return None\n/);
  assert.match(run.out, /- survived: shop\.py:6: if rate > 1: {2}-> {2}if rate > 2:\n/);
  // A break of the same size as the code, written in the same second: no bytecode cached for the
  // earlier text runs instead of it.
  assert.match(run.out, /- killed: shop\.py:8: return price \* \(1 - rate\) {2}-> {2}return price \* \(2 - rate\)\n/);
  assert.match(run.out, /See GW-11 in /);
});

test('did not run: a command with no counts, a red control, a break past the run timeout - never a kill', (t) => {
  const echo = project(t, { 'cart.js': CART, 'cart.test.js': CART_TEST }, 'echo ok');
  write(echo, { 'cart.js': `${CART}${ADD}` });
  const noCounts = mutate(t, echo);
  assert.equal(noCounts.code, 2, noCounts.out);
  assert.match(noCounts.out, /\nControl: echo ok \(\.greenwashing\.json\) on the unchanged copy: did not run - no test counts from pytest, unittest, jest, vitest or node --test in the output \(no counts\)\n {2}\| ok\n/);
  assert.match(noCounts.out, /\nMutants: 0 tried - 0 killed, 0 survived, 0 did not run; 4 not tried\n/);
  assert.match(noCounts.out, /\nDid not run: the tests are not green on an unchanged copy of the working tree, so no break can be judged/);
  assert.match(noCounts.out, /\nResult: did not run$/m);

  const red = project(t, { 'cart.js': CART, 'cart.test.js': CART_TEST });
  write(red, { 'cart.js': `${CART}${ADD}`, 'cart.test.js': `${CART_TEST}test('red', () => assert.equal(1, 2));\n` });
  const redRun = mutate(t, red);
  assert.equal(redRun.code, 2, redRun.out);
  assert.match(redRun.out, /on the unchanged copy: failed - 1 failed/);
  assert.doesNotMatch(redRun.out, /killed: /);

  // Two steps at a time from an odd number never reach zero: that break runs until its timeout.
  const down = "function down(n) {\n  let i = n;\n  while (i !== 0) i -= 1;\n  return i;\n}\nmodule.exports = { down };\n";
  const loop = project(t, { 'down.test.js': "const test = require('node:test');\nconst assert = require('node:assert');\nconst { down } = require('./down');\ntest('down', () => assert.equal(down(3), 0));\n" });
  write(loop, { 'down.js': down });
  const slow = mutate(t, loop, ['--run-timeout', '3']);
  assert.equal(slow.code, 2, slow.out);
  assert.match(slow.out, /- did not run: down\.js:3: while \(i !== 0\) i -= 1; {2}-> {2}while \(i !== 0\) i -= 2; \(the command did not finish in 3 s and was stopped\)\n/);
  assert.match(slow.out, /\nMutants: 4 tried - 3 killed, 0 survived, 1 did not run\n/);
  assert.match(slow.out, /"Did not run" is never counted as caught \(GW-61 in /);
  assert.deepEqual([noCounts.copies, redRun.copies, slow.copies], [[], [], []]);
});

test("the user's files stay byte for byte; node_modules, .venv and venv are linked into the copy, which is removed", (t) => {
  const dir = project(t, {
    '.gitignore': 'node_modules/\n.venv/\nvenv/\n',
    'cart.js': "const { rate } = require('dep');\nconst { round } = require('./round');\n" + CART.replace('return items.reduce((sum, item) => sum + item.price, 0);', 'return round(items.reduce((sum, item) => sum + item.price, 0) * rate);'),
    'cart.test.js': CART_TEST,
  }, `test -L node_modules/dep && test -L .venv && test -L venv && test -L link.js && mkdir -p node_modules/.vite node_modules/.cache && echo run > node_modules/.vite/results.json && echo run > node_modules/.cache/x && ${NODE_CMD}`);
  write(dir, {
    'node_modules/dep/index.js': 'module.exports = { rate: 1 };\n', 'node_modules/dep/package.json': '{"name": "dep", "main": "index.js"}\n',
    '.venv/pyvenv.cfg': 'home = /usr/bin\n', 'venv/pyvenv.cfg': 'home = /usr/bin\n', 'cart.js': `${fs.readFileSync(path.join(dir, 'cart.js'), 'utf8')}${ADD}`,
    'cart.test.js': `${CART_TEST}${ADDS}`, 'notes.txt': 'untracked\n', 'round.js': 'module.exports = { round: (x) => x };\n',
  });
  fs.symlinkSync('cart.js', path.join(dir, 'link.js'));
  // Another repository inside the project that git does not know (a worktree of a tool, a clone).
  write(dir, { 'nested/readme.txt': 'nested\n' });
  git(path.join(dir, 'nested'), 'init', '-q');
  // Stat data in the index that is out of date: git diff would refresh it and rewrite the index.
  git(dir, 'status', '--porcelain');
  spawnSync('sleep', ['1.1']);
  write(dir, { 'cart.test.js': fs.readFileSync(path.join(dir, 'cart.test.js'), 'utf8'), '.gitignore': fs.readFileSync(path.join(dir, '.gitignore'), 'utf8') });
  const before = snapshot(dir);
  const run = mutate(t, dir);
  assert.match(run.out, /Control: .* on the unchanged copy: passed \(2 passed/);
  assert.equal(run.code, 1, run.out);
  assert.deepEqual(snapshot(dir), before);
  assert.deepEqual(run.copies, []);
});

test('Python runs no cached bytecode: none from the user\'s tree, none of an earlier break of the same size', (t) => {
  const tests = 'import unittest\n\nfrom shop import double\n\n\nclass T(unittest.TestCase):\n    def test_double(self):\n        self.assertEqual(double(2), 4)\n';
  const dir = project(t, { 'test_shop.py': tests, 'shop.py': 'def double(n):\n    return n + n\n' }, null);
  // Two breaks of the same size one after the other: the first survives, the second must be killed.
  write(dir, { 'shop.py': 'LIMIT = 5\nSCALE = 2\n\n\ndef double(n):\n    return n * SCALE\n' });
  // A bytecode file that Python loads without looking at the source, in a folder git does not ignore.
  const compiled = spawnSync('python3', ['-I', '-c', 'import py_compile as p; print(p.compile("shop.py", invalidation_mode=p.PycInvalidationMode.UNCHECKED_HASH))'], { cwd: dir, encoding: 'utf8' });
  assert.equal(compiled.status, 0, compiled.stderr);
  const run = mutate(t, dir);
  assert.match(run.out, /\n- survived: shop\.py:1: LIMIT = 5 {2}-> {2}LIMIT = 6\n- killed: shop\.py:2: SCALE = 2 {2}-> {2}SCALE = 3\n/);
  assert.match(run.out, /\n- killed: shop\.py:6: return n \* SCALE {2}-> {2}return None\n/);
});

test('each break runs alone: its file is back as it was before the next break runs', (t) => {
  const tested = "module.exports = { one: () => 1 };\n";
  const dir = project(t, { 'a.js': tested, 'z.js': 'module.exports = { two: () => 2 };\n',
    'a.test.js': "const test = require('node:test');\nconst assert = require('node:assert');\ntest('one', () => assert.equal(require('./a').one(), 1));\n" });
  write(dir, { 'a.js': tested.replace('1', '3'), 'z.js': 'module.exports = { two: () => 4 };\n' });
  write(dir, { 'a.test.js': fs.readFileSync(path.join(dir, 'a.test.js'), 'utf8').replace('one(), 1', 'one(), 3') });
  const run = mutate(t, dir);
  assert.match(run.out, /\n- killed: a\.js:1: .*\n- survived: z\.js:1: .*\n/);
});

test('a workspace package linked in node_modules is the copy\'s: its breaks reach the tests', (t) => {
  const dir = project(t, {
    '.gitignore': 'node_modules/\n', 'packages/pkg/package.json': '{"name": "@w/pkg", "main": "index.js"}\n', 'packages/pkg/index.js': 'module.exports = { rate: () => 1 };\n',
    'app/rate.test.js': "const test = require('node:test');\nconst assert = require('node:assert');\nconst { rate } = require('@w/pkg');\ntest('rate', () => assert.equal(rate(), 2));\n",
  });
  fs.mkdirSync(path.join(dir, 'node_modules', '@w'), { recursive: true });
  fs.symlinkSync('../../packages/pkg', path.join(dir, 'node_modules', '@w', 'pkg'));
  write(dir, { 'packages/pkg/index.js': 'module.exports = { rate: () => 2 };\n' });
  const run = mutate(t, dir);
  assert.match(run.out, /\n- killed: packages\/pkg\/index\.js:1: module\.exports = \{ rate: \(\) => 2 \}; {2}-> {2}module\.exports = \{ rate: \(\) => 3 \};\n/);
  assert.equal(run.code, 0, run.out);
});

test('a folder the tests leave read-only goes with the copy, and the report is still printed', (t) => {
  const dir = project(t, { 'cart.js': CART, 'cart.test.js': CART_TEST }, `mkdir -p ro && echo x > ro/keep.txt && chmod 0500 ro && ${NODE_CMD}`);
  write(dir, { 'cart.js': `${CART}${ADD}`, 'cart.test.js': `${CART_TEST}${ADDS}` });
  const tmp = tempDir(t);
  const env = { ...process.env, TMPDIR: tmp, HOME: tmp };
  delete env.NODE_TEST_CONTEXT;
  let run;
  if (process.getuid() === 0) {
    // Nothing is read-only to root: the command runs as nobody.
    for (const folder of [dir, tmp]) assert.equal(spawnSync('chown', ['-R', '65534:65534', folder]).status, 0);
    run = spawnSync('setpriv', ['--reuid=65534', '--regid=65534', '--clear-groups', process.execPath, MUTATE], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(run.error, undefined, 'setpriv is needed to run this test as root');
  } else {
    run = spawnSync(process.execPath, [MUTATE], { cwd: dir, env, encoding: 'utf8' });
  }
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stdout, /\nResult: 1 mutant survived\n$/);
  assert.deepEqual(fs.readdirSync(tmp).filter((name) => name.startsWith('greenwashing-mutants-')), []);
});

test('a signal stops the tests and removes the copy', async (t) => {
  const tmp = tempDir(t);
  const started = path.join(tmp, 'started');
  const late = path.join(tmp, 'late');
  const dir = project(t, { 'cart.js': CART, 'cart.test.js': CART_TEST },
    `touch ${JSON.stringify(started)}; (sleep 4; touch ${JSON.stringify(late)}) & sleep 30; ${NODE_CMD}`);
  write(dir, { 'cart.js': `${CART}${ADD}` });
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT']) {
    fs.rmSync(started, { force: true });
    const env = { ...process.env, TMPDIR: tmp };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, [MUTATE], { cwd: dir, env, stdio: 'ignore' });
    const exited = new Promise((resolve) => child.on('exit', (code, sig) => resolve([code, sig])));
    for (let i = 0; i < 200 && !fs.existsSync(started); i += 1) await sleep(50);
    assert.ok(fs.existsSync(started), 'the control run did not start');
    assert.equal(fs.readdirSync(tmp).filter((name) => name.startsWith('greenwashing-mutants-')).length, 1);
    child.kill(signal);
    const [code] = await exited;
    assert.equal(code, 128 + os.constants.signals[signal], signal);
    assert.deepEqual(fs.readdirSync(tmp).filter((name) => name.startsWith('greenwashing-mutants-')), [], signal);
  }
  await sleep(5000);
  assert.equal(fs.existsSync(late), false, 'a process of the stopped tests kept running');
});

test('the limits: --limit, then "mutants" in .greenwashing.json, then 20; the time for everything; the same breaks every run', (t) => {
  const numbers = `const LIMITS = [${Array.from({ length: 30 }, (_, i) => i + 1).join(', ')}];\nmodule.exports = { LIMITS };\n`;
  const check = "const test = require('node:test');\nconst assert = require('node:assert');\nconst { LIMITS } = require('./limits');\ntest('first', () => assert.equal(LIMITS[0], 1));\n";
  const dir = project(t, { 'limits.test.js': check }, null);
  write(dir, { 'limits.js': numbers, '.greenwashing.json': JSON.stringify({ testCommand: NODE_CMD, mutants: { limit: 4 } }) });
  git(dir, 'add', '.greenwashing.json');
  git(dir, 'commit', '-qm', 'limit 4');
  const tried = (run) => run.out.split('\n').filter((line) => /^- (killed|survived|did not run): /.test(line));
  const four = mutate(t, dir);
  assert.match(four.out, /30 places to break; 4 tried at most \(limit 4\)/);
  assert.equal(tried(four).length, 4);
  assert.deepEqual(tried(mutate(t, dir)), tried(four));
  const three = mutate(t, dir, ['--limit', '3']);
  assert.equal(tried(three).length, 3);
  // Spread over the file: its middle, then the middles of its halves (numbers 8, 16 and 24).
  assert.deepEqual(tried(three).map((line) => /->.*?(\d+), \1,/.exec(line)[1]), ['9', '17', '25']);
  write(dir, { '.greenwashing.json': JSON.stringify({ testCommand: NODE_CMD }) });
  git(dir, 'commit', '-qam', 'no limit');
  assert.match(mutate(t, dir).out, /30 places to break; 20 tried at most \(limit 20\)/);
  // The time for everything: runs that would start after it are not tried, and that is did not run.
  write(dir, { '.greenwashing.json': JSON.stringify({ testCommand: `sleep 1; ${NODE_CMD}` }) });
  git(dir, 'commit', '-qam', 'slow');
  const late = mutate(t, dir, ['--timeout', '3', '--limit', '5']);
  // Never 0: breaks were not tried (1 when one of those that ran survived).
  assert.notEqual(late.code, 0, late.out);
  assert.match(late.out, /; [1-4] not tried\n/);
  assert.match(late.out, /\nDid not run: no time was left for [1-4] of the breaks: the time for everything is 3 s \(--timeout\)\n/);
  // A long line is shown around the place of the break.
  assert.match(mutate(t, dir, ['--limit', '5']).out, /\n- survived: limits\.js:1: \.\.\.\[?[\d, ]*23, 24, 25, .*30\]; {2}-> {2}\.\.\.\[?[\d, ]*23, 25, 25, .*30\];\n/);
});

test('the changed lines: since the merge base with main, committed or not, untracked too; --base; only the project folder', (t) => {
  const one = (name) => `module.exports = { ${name}: () => 1 };\n`;
  const files = { 'a.js': one('a'), 'b.js': one('b'), 'd.js': one('d'), 'app/e.js': one('e'), 'pass.test.js': "require('node:test')('ok', () => {});\n" };
  const dir = project(t, files);
  write(dir, { 'a.js': one('a').replace('1', '2') });
  git(dir, 'commit', '-qam', 'a on the branch');
  write(dir, { 'b.js': one('b').replace('1', '2'), 'c.js': one('c'), 'app/e.js': one('e').replace('1', '2') });
  // Main moves on after the branch: its new commits, a changed file the branch did not touch too,
  // are not the branch's change.
  git(dir, 'checkout', '-q', 'main');
  write(dir, { 'd2.js': one('d2'), 'd.js': one('d').replace('1', '5') });
  git(dir, 'add', 'd2.js', 'd.js');
  git(dir, 'commit', '-qm', 'main moves');
  git(dir, 'checkout', '-q', 'feat');
  const files_ = (run) => [...new Set(run.out.split('\n').map((line) => /^- \w[\w ]*: ([\w/.]+):\d+:/.exec(line)).filter(Boolean).map((m) => m[1]))].sort();
  assert.deepEqual(files_(mutate(t, dir)), ['a.js', 'app/e.js', 'b.js', 'c.js']);
  assert.deepEqual(files_(mutate(t, dir, ['--base', 'HEAD'])), ['app/e.js', 'b.js', 'c.js']);
  // A project in a subfolder: only its files.
  write(dir, { 'app/.greenwashing.json': JSON.stringify({ testCommand: `cd .. && ${NODE_CMD}` }) });
  assert.deepEqual(files_(mutate(t, path.join(dir, 'app'))), ['e.js']);
  // With no origin/HEAD, origin/main or origin/master, the main branch is main, else master.
  git(dir, 'branch', '-m', 'main', 'master');
  assert.match(mutate(t, dir).out, /\(the merge base with master\)/);
});

test('a break that would not parse is not tried: node --test would count the file that cannot load as a failed test', (t) => {
  // A method named if: its "condition" turned around is no parameter list.
  const code = 'class A {\n  if(x) {\n    return x;\n  }\n}\nmodule.exports = { A };\n';
  const dir = project(t, { 'f.test.js': "require('node:test')('loads', () => { require('./f'); });\n" });
  write(dir, { 'f.js': code });
  const run = mutate(t, dir);
  assert.match(run.out, /\n1 code file, 6 changed lines, 2 places to break; 2 tried at most \(limit 20\)\n/);
  assert.match(run.out, /\n- survived: f\.js:3: return x; {2}-> {2}return null;\n/);
  assert.doesNotMatch(run.out, /- killed|if\(!\(x\)\)/);
});

test('a file of many tested numbers does not crowd out an untested guard in another file', (t) => {
  const dir = project(t, { 'a.test.js': "require('node:test')('ok', () => {});\n" });
  write(dir, {
    'a.js': `module.exports = [${Array.from({ length: 200 }, (_, i) => i + 1).join(', ')}];\n`,
    'a.test.js': "const test = require('node:test');\nconst assert = require('node:assert');\ntest('table', () => assert.deepEqual(require('./a'), Array.from({ length: 200 }, (_, i) => i + 1)));\n",
    'z.js': "module.exports = (x) => {\n  if (x > 100) throw new Error('big');\n  return x;\n};\n",
  });
  const run = mutate(t, dir);
  assert.equal(run.code, 1, run.out);
  assert.match(run.out, /\n2 code files, 5 changed lines, 205 places to break; 20 tried at most \(limit 20\)\n/);
  assert.match(run.out, /\n- survived: z\.js:2: removed: if \(x > 100\) throw new Error\('big'\);\n/);
});

test('the changed lines as git sees them, whatever the file and the settings: a lone CR, -diff, context inside a hunk', (t) => {
  const check = "const test = require('node:test');\nconst assert = require('node:assert');\nconst c = require('./calc');\ntest('a', () => { assert.equal(c.A, 1); assert.equal(c.C, 3); });\n";
  const cr = project(t, { 'calc.js': '/* h */\nconst A = 1;\nconst C = 3;\nmodule.exports = { A, C };\n', 'calc.test.js': check });
  write(cr, { 'calc.js': '/* h\r\r */\nconst A = 1;\nconst C = 3;\nconst B = 7;\nmodule.exports = { A, B, C };\n' });
  const lone = mutate(t, cr);
  assert.match(lone.out, /\n- survived: calc\.js:6: const B = 7; {2}-> {2}const B = 8;\n/);
  assert.doesNotMatch(lone.out, /const [AC] = \d; {2}->/);
  const binary = project(t, { 'calc.js': 'module.exports = {};\n', 'calc.test.js': "require('node:test')('ok', () => {});\n" });
  write(binary, { '.gitattributes': 'calc.js -diff\n', 'calc.js': 'module.exports = { A: 1 };\n' });
  git(binary, 'add', '-A');
  git(binary, 'commit', '-qm', 'hidden from diff');
  assert.match(mutate(t, binary).out, /\n- survived: calc\.js:1: module\.exports = \{ A: 1 \}; {2}-> {2}module\.exports = \{ A: 2 \};\n/);
  const wide = project(t, { 'calc.js': 'const A = 1;\nconst B = 2;\nconst C = 3;\nmodule.exports = { A, B, C };\n', 'calc.test.js': "require('node:test')('ok', () => {});\n" });
  git(wide, 'config', 'diff.interHunkContext', '10');
  write(wide, { 'calc.js': 'const A = 10;\nconst B = 2;\nconst C = 30;\nmodule.exports = { A, B, C };\n' });
  const run = mutate(t, wide);
  assert.match(run.out, /\n1 code file, 2 changed lines, 2 places to break;/);
  assert.doesNotMatch(run.out, /const B = 3/);
});

test('the files of a change: new ones committed on the branch; files that are not UTF-8 or that Python cannot read are did not run', (t) => {
  const dir = project(t, { 'pass.test.js': "require('node:test')('ok', () => {});\n" });
  write(dir, { 'new.js': 'module.exports = 1;\n' });
  git(dir, 'add', 'new.js');
  git(dir, 'commit', '-qm', 'a new file on the branch');
  const added = mutate(t, dir);
  assert.match(added.out, /\n- survived: new\.js:1: module\.exports = 1; {2}-> {2}module\.exports = 2;\n/);
  fs.writeFileSync(path.join(dir, 'latin.js'), Buffer.from('module.exports = "caf\xe9";\n', 'latin1'));
  write(dir, { 'newer.py': 'def f[T](x: T) -> T:\n    return x\n', 'broken.py': 'def f(:\n' });
  const unread = mutate(t, dir);
  assert.equal(unread.code, 1, unread.out);
  assert.match(unread.out, /\nDid not run: latin\.js is not UTF-8 text\n/);
  assert.match(unread.out, /\nDid not run: broken\.py: Python could not read it \(SyntaxError/);
});

test('breaks from the Python interpreter are checked: a known kind on a changed line, or not tried', (t) => {
  const bin = tempDir(t);
  const fake = (out) => {
    const file = path.join(bin, `py-${crypto.randomBytes(4).toString('hex')}`);
    fs.writeFileSync(file, `#!/bin/sh\ncat > /dev/null\nprintf '%s' ${JSON.stringify(out)}\n`, { mode: 0o755 });
    return file;
  };
  const dir = project(t, { 'shop.py': 'A = 1\nB = 2\n', 'test_shop.py': 'import unittest\n\n\nclass T(unittest.TestCase):\n    def test_a(self):\n        self.assertTrue(True)\n' }, null);
  write(dir, { 'shop.py': 'A = 1\nB = 3\n' });
  const config = (python) => write(dir, { '.greenwashing.json': JSON.stringify({ testCommand: 'python3 -m unittest discover', python }) });
  // One break on the unchanged line 1, one of no kind, one past the file, one on another file.
  config(fake(JSON.stringify({ mutants: [
    { file: 'shop.py', op: 'number', start: [1, 4], end: [1, 5], text: '9' }, { file: 'shop.py', op: 'rm -rf', start: [2, 4], end: [2, 5], text: '9' },
    { file: 'shop.py', op: 'number', start: [9, 0], end: [9, 1], text: '9' }, { file: 'other.py', op: 'number', start: [1, 0], end: [1, 1], text: '9' },
    { file: 'shop.py', op: 'number', start: [2, 4], end: [2, 5], text: '4' }], errors: [] })));
  const run = mutate(t, dir);
  assert.equal(run.code, 1, run.out);
  assert.match(run.out, /\n- survived: shop\.py:2: B = 3 {2}-> {2}B = 4\n/);
  assert.match(run.out, /\nDid not run: 4 of the breaks \S+ gave were not of a known kind on a changed line, and were not tried\n/);
  assert.doesNotMatch(run.out, /A = 9/);
  config(fake('no json'));
  assert.match(mutate(t, dir).out, /\nDid not run: the Python files could not be read: \S+ printed no list of breaks\n/);
  config('no-such-python');
  assert.match(mutate(t, dir).out, /\nDid not run: the Python files could not be read: no-such-python could not run: not found\n/);
});

test('the base named as git names it: origin/main when origin/HEAD points there', (t) => {
  const dir = project(t, { 'a.js': 'module.exports = 1;\n', 'pass.test.js': "require('node:test')('ok', () => {});\n" });
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'main');
  git(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  write(dir, { 'a.js': 'module.exports = 2;\n' });
  assert.match(mutate(t, dir).out, /\(the merge base with origin\/main\), committed or not\n/);
});

test('a Python file that starts with a byte order mark is broken in the right place', (t) => {
  const tests = 'import unittest\n\nfrom shop import LIMIT\n\n\nclass T(unittest.TestCase):\n    def test_limit(self):\n        self.assertEqual(LIMIT, 7)\n';
  const dir = project(t, { 'shop.py': '\uFEFFLIMIT = 5\n', 'test_shop.py': tests }, null);
  write(dir, { 'shop.py': '\uFEFFLIMIT = 7\n' });
  const run = mutate(t, dir);
  assert.match(run.out, /\n- killed: shop\.py:1: \uFEFF?LIMIT = 7 {2}-> {2}\uFEFF?LIMIT = 8\n/);
  assert.equal(run.code, 0, run.out);
});

test('test files, test helpers and runner config are never broken', (t) => {
  const dir = project(t, { 'pass.test.js': "require('node:test')('ok', () => {});\n" });
  write(dir, {
    'x.test.js': "require('node:test')('a', () => { if (1 < 2) return true; });\n", 'test/helper.js': 'module.exports = 1 < 2;\n',
    'tests/helper.js': 'module.exports = true;\n', 'jest.config.js': 'module.exports = { bail: true };\n', 'conftest.py': 'X = 1\n', 'test_x.py': 'X = 1\n',
  });
  const run = mutate(t, dir);
  assert.equal(run.code, 2, run.out);
  assert.match(run.out, /\n0 code files, 0 changed lines, 0 places to break; 0 tried at most \(limit 20\)\n/);
  assert.match(run.out, /\nDid not run: no place to break in the changed code lines of JavaScript, TypeScript or Python\n/);
});

test('did not run before any test: no main branch, a base that is no commit, an unknown option, a broken setting, outside git', (t) => {
  const dir = project(t, { 'a.js': 'module.exports = 1;\n' });
  git(dir, 'branch', '-m', 'main', 'trunk');
  const cases = [
    [[], /Did not run: no main branch found \(origin\/main, origin\/master, main, master\); give one with --base/],
    [['--base', 'nope'], /Did not run: nope is not a commit/],
    [['--limit', '0'], /^--limit takes a whole number from 1 to 86400\nusage: /],
    [['--frobnicate', '1'], /^unknown or incomplete option --frobnicate\nusage: /],
    [['--base'], /^unknown or incomplete option --base\nusage: /],
    [['--limit', '2', '--limit', '3'], /^--limit given twice/],
    [['--timeout', '86401'], /^--timeout takes a whole number from 1 to 86400\nusage: /],
    [['--run-timeout', '99999999999'], /^--run-timeout takes a whole number from 1 to 86400/],
  ];
  for (const [args, message] of cases) {
    const run = mutate(t, dir, args);
    assert.equal(run.code, 2, `${args} ${run.out}`);
    assert.match(run.out, message, args.join(' '));
  }
  write(dir, { '.greenwashing.json': JSON.stringify({ mutants: { limit: 0 } }) });
  assert.match(mutate(t, dir, ['--base', 'trunk']).out, /Did not run: \.greenwashing\.json: mutants must be an object of whole numbers from 1 to 86400 for limit, timeoutSeconds, runTimeoutSeconds/);
  const outside = tempDir(t);
  const run = mutate(t, outside);
  assert.equal(run.code, 2);
  assert.match(run.out, /is not in a git repository: the changed lines come from git/);
});
