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

// Every file under dir, .git and links included, with its bytes (a link: its target), its mode and its
// modification time: a file written and then restored during the run counts as changed.
function snapshot(dir) {
  const files = {};
  const walk = (at) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      const stat = fs.lstatSync(full);
      if (stat.isDirectory()) walk(full);
      else files[path.relative(dir, full)] = `${crypto.createHash('sha256').update(stat.isSymbolicLink() ? `link ${fs.readlinkSync(full)}` : fs.readFileSync(full)).digest('hex')} ${stat.mode} ${stat.mtimeMs}`;
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
  // The estimate is printed as soon as the control run has run, and again in the report.
  const estimate = /^Estimate: one test run takes [\d.]+ s \(the control run\); 5 runs to go \(1 control break, 4 mutants\), up to \d+ s each \(the control run x 1\.5 \+ 10 s, as --run-timeout is not set\): about [\d.]+ s in all, within the 600 s for everything \(--timeout\): all of them fit$/m;
  assert.match(weak.out, new RegExp(`^${estimate.source.slice(1, -1)}\ngreenwashing mutants: the code lines changed since [0-9a-f]{12} \\(the merge base with main\\), committed or not\n`
    + '1 code file, 5 changed lines, 4 places to break; 4 tried at most \\(limit 20\\)\n'));
  assert.match(weak.out, new RegExp(`\nControl: node --test --test-reporter=tap \\(\\.greenwashing\\.json\\) on the unchanged copy: passed \\(2 passed, 0 failed, 0 skipped\\)\n${estimate.source.slice(1, -1)}\nControl breaks: `));
  assert.match(weak.out, /\nTime: [\d.]+ s in all \(estimated: about [\d.]+ s\)\nResult: 1 mutant survived\n$/);
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

test('an order no test depends on survives (GW-04), and a case with items out of order kills it: JavaScript', (t) => {
  const base = 'function ids(orders) {\n  return orders.map((o) => o.id);\n}\nmodule.exports = { ids };\n';
  const newest = 'function newestFirst(orders) {\n  return [...orders].sort((a, b) => b.placed - a.placed);\n}\nmodule.exports.newestFirst = newestFirst;\n';
  const head = "const test = require('node:test');\nconst assert = require('node:assert');\nconst { ids, newestFirst } = require('./orders');\n"
    + "test('ids', () => assert.deepEqual(ids([{ id: 4 }]), [4]));\n";
  const dir = project(t, { 'orders.js': base, 'orders.test.js': head });
  write(dir, { 'orders.js': `${base}${newest}`, 'orders.test.js': `${head}test('newest first', () => assert.deepEqual(ids(newestFirst([{ id: 1, placed: 5 }])), [1]));\n` });
  const weak = mutate(t, dir);
  assert.equal(weak.code, 1, weak.out);
  assert.match(weak.out, /\n- survived: orders\.js:6: return \[\.\.\.orders\]\.sort\(\(a, b\) => b\.placed - a\.placed\); {2}-> {2}return \[\.\.\.orders\];\n/);
  assert.match(weak.out, /\nSurvived - the tests passed with the code broken:\n- orders\.js:6: .*\n {2}the tests pass with this sort or reverse removed: in no case does the result depend on the order; add a case with two or more items out of order\. See GW-04 in /);
  write(dir, { 'orders.test.js': `${head}test('newest first', () => assert.deepEqual(ids(newestFirst([{ id: 1, placed: 5 }, { id: 2, placed: 9 }, { id: 3, placed: 7 }])), [2, 3, 1]));\n` });
  const strong = mutate(t, dir);
  assert.equal(strong.code, 0, strong.out);
  assert.match(strong.out, /\n- killed: orders\.js:6: return \[\.\.\.orders\]\.sort\(.*\); {2}-> {2}return \[\.\.\.orders\];\n/);
});

test('an order no test depends on survives (GW-04), and a case with items out of order kills it: Python, sorted in place and reversed', (t) => {
  const base = 'def order_ids(orders):\n    return [order["id"] for order in orders]\n';
  const newest = '\n\ndef newest_first(orders):\n    orders = list(orders)\n    orders.sort(key=lambda order: order["placed"])\n    orders.reverse()\n    return orders\n';
  const head = 'import unittest\n\nfrom orders import newest_first, order_ids\n\n\nclass T(unittest.TestCase):\n    def test_ids(self):\n        self.assertEqual(order_ids([{"id": 4}]), [4])\n';
  const dir = project(t, { 'orders.py': base, 'test_orders.py': head.replace('newest_first, ', '') }, null);
  const check = (orders, ids) => `\n    def test_newest_first(self):\n        self.assertEqual(order_ids(newest_first(${orders})), ${ids})\n`;
  write(dir, { 'orders.py': `${base}${newest}`, 'test_orders.py': `${head}${check('[{"id": 1, "placed": 5}]', '[1]')}` });
  const weak = mutate(t, dir);
  assert.equal(weak.code, 1, weak.out);
  assert.match(weak.out, /\n- survived: orders\.py:7: orders\.sort\(key=lambda order: order\["placed"\]\) {2}-> {2}pass\n- survived: orders\.py:8: orders\.reverse\(\) {2}-> {2}pass\n/);
  assert.match(weak.out, /\n {2}the tests pass with this sort or reverse removed: .* See GW-04 in /);
  write(dir, { 'test_orders.py': `${head}${check('[{"id": 1, "placed": 5}, {"id": 2, "placed": 9}, {"id": 3, "placed": 7}]', '[2, 3, 1]')}` });
  const strong = mutate(t, dir);
  assert.equal(strong.code, 0, strong.out);
  assert.match(strong.out, /\n- killed: orders\.py:7: orders\.sort\(.*\) {2}-> {2}pass\n- killed: orders\.py:8: orders\.reverse\(\) {2}-> {2}pass\n/);
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
  // The estimate says no break runs, at once and in the report, and there is no time to compare with.
  assert.equal(redRun.out.match(/^Estimate: one test run takes [\d.]+ s \(the control run\), which is not green, so no break runs$/gm).length, 2, redRun.out);
  assert.match(redRun.out, /\nTime: [\d.]+ s in all\nResult: did not run\n$/);

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
  }, `test -L node_modules/dep && test -L .venv && test -L venv && test -L link.js && test ! -L cart.js && test ! -L round.js && mkdir -p node_modules/.vite node_modules/.cache && echo run > node_modules/.vite/results.json && echo run > node_modules/.cache/x && ${NODE_CMD}`);
  write(dir, {
    'node_modules/dep/index.js': 'module.exports = { rate: 1 };\n', 'node_modules/dep/package.json': '{"name": "dep", "main": "index.js"}\n',
    // The caches the user's own runs left: the copy's runs must not write into them.
    'node_modules/.vite/results.json': '{}\n', 'node_modules/.cache/x': 'old\n',
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
    'a.test.js': "const test = require('node:test');\nconst assert = require('node:assert');\nrequire('./z');\ntest('one', () => assert.equal(require('./a').one(), 1));\n" });
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
  // Nothing is read-only to root: then the command runs as nobody, from a folder of /tmp that nobody
  // can read (the temp folder of these tests and this repository may be closed to it).
  const root = process.getuid() === 0;
  const base = root ? fs.mkdtempSync('/tmp/gw-mutate-nobody-') : tempDir(t);
  if (root) {
    fs.chmodSync(base, 0o755);
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  }
  const dir = project(t, { 'cart.js': CART, 'cart.test.js': CART_TEST }, `mkdir -p ro && echo x > ro/keep.txt && chmod 0500 ro && ${NODE_CMD}`, path.join(base, 'project'));
  write(dir, { 'cart.js': `${CART}${ADD}`, 'cart.test.js': `${CART_TEST}${ADDS}` });
  const tmp = path.join(base, 'tmp');
  fs.mkdirSync(tmp);
  const env = { ...process.env, TMPDIR: tmp, HOME: tmp };
  delete env.NODE_TEST_CONTEXT;
  let run;
  if (root) {
    fs.cpSync(path.join(__dirname, '..'), path.join(base, 'gate'), { recursive: true });
    for (const folder of [dir, tmp]) assert.equal(spawnSync('chown', ['-R', '65534:65534', folder]).status, 0);
    run = spawnSync('setpriv', ['--reuid=65534', '--regid=65534', '--clear-groups', process.execPath, path.join(base, 'gate', 'mutate.js')], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(run.error, undefined, 'setpriv is needed to run this test as root');
  } else {
    run = spawnSync(process.execPath, [MUTATE], { cwd: dir, env, encoding: 'utf8' });
  }
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.match(run.stdout, /\nResult: 1 mutant survived\n$/);
  assert.deepEqual(fs.readdirSync(tmp).filter((name) => name.startsWith('greenwashing-mutants-')), []);
});

test('a reader that goes away does not stop the command halfway: the copy is still removed, the exit code kept', async (t) => {
  const dir = project(t, { 'cart.js': CART, 'cart.test.js': CART_TEST });
  write(dir, { 'cart.js': `${CART}${ADD}`, 'cart.test.js': `${CART_TEST}${ADDS}${STOPS}` });
  const tmp = tempDir(t);
  const env = { ...process.env, TMPDIR: tmp };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [MUTATE], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  // Nobody reads the estimate, printed while the copy is there, or the report.
  child.stdout.destroy();
  let errors = '';
  child.stderr.on('data', (data) => { errors += data; });
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 0, errors);
  assert.equal(errors, '');
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
  // The estimate said so, with what to change for every break to get its time: with that, it tries them all.
  const proposed = /^Estimate: one test run takes [\d.]+ s \(the control run\); 6 runs to go \(1 control break, 5 mutants\), up to \d+ s each \([^)]*\): about [\d.]+ s in all, past the 3 s for everything \(--timeout\): the time left starts \d+ of them, so about \d of the 5 mutants will be tried\. For all of them, run it again with --timeout (\d+)$/m.exec(late.out);
  assert.ok(proposed, late.out);
  const all = mutate(t, dir, ['--limit', '5', '--timeout', proposed[1]]);
  assert.match(all.out, /\nMutants: 5 tried - \d killed, \d survived, 0 did not run\n/);
  assert.doesNotMatch(all.out, /not tried|no time was left/);
  assert.match(all.out, /\nTime: [\d.]+ s in all \(estimated: about [\d.]+ s\)\n/);
  // A long line is shown around the place of the break.
  assert.match(mutate(t, dir, ['--limit', '5']).out, /\n- survived: limits\.js:1: \.\.\.\[?[\d, ]*23, 24, 25, .*30\]; {2}-> {2}\.\.\.\[?[\d, ]*23, 25, 25, .*30\];\n/);
});

test('when the time runs out, the breaks go in the order chosen - each file before any gets a second - and the estimate comes at once', async (t) => {
  // Runs past the fifth (the control, two control breaks and two breaks) take past the time for everything.
  const count = path.join(tempDir(t), 'runs');
  const command = `n=$(cat ${count} 2>/dev/null || echo 0); n=$((n + 1)); echo $n > ${count}; if [ $n -gt 5 ]; then sleep 60; fi; ${NODE_CMD}`;
  const check = "const test = require('node:test');\nrequire('./a');\nrequire('./b');\ntest('loads', () => {});\n";
  const dir = project(t, { 'ab.test.js': check, 'a.js': 'module.exports = [];\n', 'b.js': 'module.exports = [];\n' }, command);
  write(dir, { 'a.js': 'module.exports = [1, 2, 3, 4, 5, 6];\n', 'b.js': 'module.exports = [7, 8];\n' });
  const env = { ...process.env, TMPDIR: tempDir(t) };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [MUTATE, '--timeout', '10'], { cwd: dir, env });
  let out = '';
  let early = null;
  let estimatedAt = null;
  child.stdout.on('data', (data) => {
    out += data;
    if (early === null && /^Estimate: .*\n/m.test(out)) [early, estimatedAt] = [out, Date.now()];
  });
  const code = await new Promise((resolve) => child.on('close', resolve));
  const closedAt = Date.now();
  assert.equal(code, 1, out);
  // Printed while the breaks were still to run: seconds before the sixth run was stopped and the report came.
  assert.match(early, /^Estimate: one test run takes [\d.]+ s \(the control run\); 10 runs to go \(2 control breaks, 8 mutants\), [^\n]*\n$/);
  assert.ok(closedAt - estimatedAt > 3000, `${closedAt - estimatedAt} ms`);
  // Spread over a.js (4, then 2) and b.js (8) - not 1, 2 and 3 of a.js, as the order of place would have it - and shown in that order.
  assert.match(out, /\nMutants: 3 tried - 0 killed, 2 survived, 1 did not run; 5 not tried\n- did not run: a\.js:1: module\.exports = \[1, 2, 3, 4, 5, 6\]; {2}-> {2}module\.exports = \[1, 3, 3, 4, 5, 6\]; \(the command did not finish in \d+ s and was stopped\)\n- survived: a\.js:1: module\.exports = \[1, 2, 3, 4, 5, 6\]; {2}-> {2}module\.exports = \[1, 2, 3, 5, 5, 6\];\n- survived: b\.js:1: module\.exports = \[7, 8\]; {2}-> {2}module\.exports = \[7, 9\];\n/);
  assert.match(out, /\nDid not run: no time was left for 5 of the breaks: the time for everything is 10 s \(--timeout\)\n/);
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
  const files_ = (run) => [...new Set(run.out.split('\n').map((line) => /^- \w[\w ]*: ([\w/.]+):/.exec(line)).filter(Boolean).map((m) => m[1]))].sort();
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
    'a.test.js': "const test = require('node:test');\nconst assert = require('node:assert');\ntest('table', () => assert.deepEqual(require('./a'), Array.from({ length: 200 }, (_, i) => i + 1)));\n"
      + "test('small', () => assert.equal(require('./z')(1), 1));\n",
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
  const binary = project(t, { 'calc.js': 'module.exports = {};\n', 'calc.test.js': "require('node:test')('loads', () => { require('./calc'); });\n" });
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
  write(dir, { 'new.js': 'module.exports = 1;\n', 'new.test.js': "require('node:test')('loads', () => { require('./new'); });\n" });
  git(dir, 'add', 'new.js', 'new.test.js');
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
  const dir = project(t, { 'shop.py': 'A = 1\nB = 2\n', 'test_shop.py': 'import unittest\n\nimport shop\n\n\nclass T(unittest.TestCase):\n    def test_a(self):\n        self.assertTrue(shop.A)\n' }, null);
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
  // One that exits before it reads a request larger than a pipe holds: named with its exit code.
  const failing = path.join(bin, 'failing');
  fs.writeFileSync(failing, '#!/bin/sh\necho boom >&2\nexit 3\n', { mode: 0o755 });
  config(failing);
  write(dir, { 'shop.py': `A = 1\nB = 3\n${'# more\n'.repeat(40000)}` });
  assert.match(mutate(t, dir).out, /\nDid not run: the Python files could not be read: \S+failing exited with code 3: boom\n/);
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
  assert.match(run.out, /\nDid not run: no place to break in the changed code lines of JavaScript, TypeScript or Python\n[^]*\nTime: [\d.]+ s in all\nResult: did not run\n$/);
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
  assert.match(run.out, /is not in a git repository: the changed lines come from git\n[^]*\nTime: [\d.]+ s in all\nResult: did not run\n$/);
});

test('a file the tests do not run - a built copy loaded instead of it: its breaks are not exercised, did not run, never survived', (t) => {
  const tests = (factor) => "const test = require('node:test');\nconst assert = require('node:assert');\nconst { total } = require('./build/cart');\n"
    + `const price = require('./price');\ntest('total', () => assert.equal(total([{ price: 2 }, { price: 3 }]), 5));\ntest('price', () => assert.equal(price(3), ${3 * factor}));\n`;
  const dir = project(t, { 'src/cart.js': CART, 'build/cart.js': CART, 'price.js': 'module.exports = (n) => n * 2;\n', 'cart.test.js': tests(2) });
  write(dir, { 'src/cart.js': `${CART}${ADD}`, 'price.js': 'module.exports = (n) => n * 3;\n', 'cart.test.js': tests(3) });
  const run = mutate(t, dir);
  assert.equal(run.code, 2, run.out);
  assert.match(run.out, /\nControl: .* on the unchanged copy: passed \(2 passed, 0 failed, 0 skipped\)\nEstimate: [^\n]*\nControl breaks: 2 files, each made to fail as soon as it runs - 1 run by the tests, 1 not exercised\n/);
  assert.match(run.out, /\nMutants: 5 tried - 1 killed, 0 survived, 4 did not run \(4 not exercised\)\n/);
  assert.match(run.out, /\n- killed: price\.js:1: .*\n- not exercised: src\/cart\.js: 4 mutants not run - the tests passed with this file failing as soon as it runs, so they do not run it: /);
  assert.doesNotMatch(run.out, /survived: |Survived/);
  assert.match(run.out, /\nResult: did not run$/m);
  // Loaded by the tests, the same file's breaks are judged: its guard survives.
  write(dir, { 'cart.test.js': `${tests(3).replace('./build/cart', './src/cart')}test('adds', () => require('./src/cart').add([], 1, 5));\n` });
  const loaded = mutate(t, dir);
  assert.equal(loaded.code, 1, loaded.out);
  assert.match(loaded.out, /\nControl breaks: 2 files, each made to fail as soon as it runs - 2 run by the tests, 0 not exercised\n/);
  assert.match(loaded.out, /\n- survived: src\/cart\.js:6: removed: if \(items\.length >= max\)/);
  assert.deepEqual([run.copies, loaded.copies], [[], []]);
});

test('Python with an editable install: the tests import the user\'s files, not the copy\'s, so its breaks are not exercised', (t) => {
  const dir = project(t, {
    '.gitignore': '.venv/\n',
    'src/shop/__init__.py': 'def total(prices):\n    return sum(prices)\n',
    'tests/test_shop.py': 'import unittest\n\nfrom shop import total\n\n\nclass T(unittest.TestCase):\n    def test_total(self):\n        self.assertEqual(total([2, 3]), 5)\n',
  }, '.venv/bin/python -m unittest discover -s tests');
  const venv = spawnSync('python3', ['-m', 'venv', '--without-pip', path.join(dir, '.venv')], { encoding: 'utf8' });
  assert.equal(venv.status, 0, venv.stderr);
  const site = spawnSync(path.join(dir, '.venv', 'bin', 'python'), ['-c', 'import sysconfig; print(sysconfig.get_paths()["purelib"])'], { encoding: 'utf8' });
  assert.equal(site.status, 0, site.stderr);
  // What pip install -e writes for a src layout: a .pth file that puts the user's src folder on the path.
  fs.writeFileSync(path.join(site.stdout.trim(), '__editable__.shop-0.1.pth'), `${path.join(dir, 'src')}\n`);
  write(dir, { 'src/shop/__init__.py': 'def total(prices):\n    if not prices:\n        raise ValueError("empty")\n    return sum(prices)\n' });
  const run = mutate(t, dir);
  assert.equal(run.code, 2, run.out);
  assert.match(run.out, /\nControl breaks: 1 file, each made to fail as soon as it runs - 0 run by the tests, 1 not exercised\n/);
  assert.match(run.out, /\n- not exercised: src\/shop\/__init__\.py: 2 mutants not run - .*: an editable install \(pip install -e\)/);
  assert.doesNotMatch(run.out, /survived: /);
  // With the copy's own src on the path, the breaks are judged: the guard no test reaches survives.
  write(dir, { '.greenwashing.json': JSON.stringify({ testCommand: 'PYTHONPATH=src python3 -m unittest discover -s tests' }) });
  const own = mutate(t, dir);
  assert.equal(own.code, 1, own.out);
  assert.match(own.out, /\nControl breaks: 1 file, each made to fail as soon as it runs - 1 run by the tests, 0 not exercised\n/);
  assert.match(own.out, /\n- survived: src\/shop\/__init__\.py:2: removed: if not prices: \(2 lines\)\n/);
});

test('without --run-timeout, a run with a break gets the control run\'s length x 1.5 + 10 s; the estimate counts the time before the control run', (t) => {
  // A Python that takes 3 s to list the breaks: time spent before the control run, not part of it.
  const slow = path.join(tempDir(t), 'slow-python');
  fs.writeFileSync(slow, '#!/bin/sh\nsleep 3\nexec python3 "$@"\n', { mode: 0o755 });
  const tests = 'import unittest\n\nfrom down import down\n\n\nclass T(unittest.TestCase):\n    def test_down(self):\n        self.assertEqual(down(3), 0)\n';
  const dir = project(t, { 'down.py': 'def down(n):\n    return 0\n', 'test_down.py': tests }, null);
  // i -= 2 from 3 never reaches 0: that break runs until its time is up.
  write(dir, { 'down.py': 'def down(n):\n    i = n\n    while i != 0:\n        i -= 1\n    return i\n', '.greenwashing.json': JSON.stringify({ python: slow }) });
  const run = mutate(t, dir);
  assert.equal(run.code, 2, run.out);
  const [, control, runs, each, total] = /^Estimate: one test run takes ([\d.]+) s \(the control run\); (\d+) runs to go \(1 control break, \d+ mutants\), up to (\d+) s each \(the control run x 1\.5 \+ 10 s, as --run-timeout is not set\): about ([\d.]+) s in all, within the 600 s for everything \(--timeout\): all of them fit$/m.exec(run.out) || [];
  assert.ok(control, run.out);
  // The control run's own length, not the 3 s before it; the time in all counts those 3 s.
  assert.ok(Number(control) < 3, control);
  assert.ok(Number(total) >= 3 + Number(runs) * Number(control) - 0.1, `${total} for ${runs} runs of ${control} s`);
  assert.ok([Math.ceil((Number(control) - 0.05) * 1.5 + 10), Math.ceil((Number(control) + 0.05) * 1.5 + 10)].includes(Number(each)), `${each} for ${control}`);
  // The break that loops is stopped at that time and did not run; the others were killed.
  assert.match(run.out, new RegExp(`\n- did not run: down\\.py:4: i -= 1 {2}-> {2}i -= 2 \\(the command did not finish in ${each} s and was stopped\\)\n`));
  assert.doesNotMatch(run.out, /survived: /);
});

test('a --run-timeout a human set is kept: shorter than the control run, no break runs, and the estimate says what to set', (t) => {
  const dir = project(t, { 'cart.js': CART, 'cart.test.js': CART_TEST }, `sleep 1; ${NODE_CMD}`);
  write(dir, { 'cart.js': `${CART}${ADD}`, 'cart.test.js': `${CART_TEST}${ADDS}` });
  const short = mutate(t, dir, ['--run-timeout', '1']);
  assert.equal(short.code, 2, short.out);
  const [, control, needed] = /^Estimate: one test run takes ([\d.]+) s \(the control run\), more than the 1 s --run-timeout gives a run with a break, so no break runs\. For all of them, run it again with --run-timeout (\d+)$/m.exec(short.out) || [];
  assert.ok(control, short.out);
  assert.ok([Math.ceil((Number(control) - 0.05) * 1.5 + 10), Math.ceil((Number(control) + 0.05) * 1.5 + 10)].includes(Number(needed)), `${needed} for ${control}`);
  assert.match(short.out, /\nMutants: 0 tried - 0 killed, 0 survived, 0 did not run; 4 not tried\n/);
  assert.match(short.out, /\nDid not run: one test run takes longer than the 1 s --run-timeout gives a run with a break, so no break was run\n/);
  assert.doesNotMatch(short.out, /Control breaks:/);
  // The same from .greenwashing.json.
  write(dir, { '.greenwashing.json': JSON.stringify({ testCommand: `sleep 1; ${NODE_CMD}`, mutants: { runTimeoutSeconds: 1 } }) });
  assert.match(mutate(t, dir).out, /\nDid not run: one test run takes longer than the 1 s --run-timeout gives a run with a break, so no break was run\n/);
  // With what it said to set, every break runs, each with that time.
  const all = mutate(t, dir, ['--run-timeout', needed]);
  assert.equal(all.code, 1, all.out);
  assert.match(all.out, new RegExp(`^Estimate: [^\n]*, up to ${needed} s each \\(--run-timeout\\): [^\n]*: all of them fit$`, 'm'));
  assert.match(all.out, /\nMutants: 4 tried - 3 killed, 1 survived, 0 did not run\n/);
});

test('a control run the time for everything stops: its length is not known, and no break runs', (t) => {
  const dir = project(t, { 'cart.js': CART, 'cart.test.js': CART_TEST }, `sleep 5; ${NODE_CMD}`);
  write(dir, { 'cart.js': `${CART}${ADD}` });
  const run = mutate(t, dir, ['--timeout', '2']);
  assert.equal(run.code, 2, run.out);
  assert.match(run.out, /^Estimate: one test run takes more than [\d.]+ s: the control run did not finish in the 2 s for everything \(--timeout\), so no break runs\. For all of them, run it again with a longer --timeout$/m);
  assert.match(run.out, /\nControl: .* on the unchanged copy: did not run - the command did not finish in \d s and was stopped \(no counts\)\n/);
  assert.match(run.out, /\nTime: [\d.]+ s in all\nResult: did not run\n$/);
});

test('a control break whose run does not finish tells nothing: its file\'s breaks did not run', (t) => {
  // The tests wait for ever when the module cannot load.
  const tests = "const test = require('node:test');\nconst assert = require('node:assert');\nlet ok;\ntry {\n  ok = require('./ok');\n} catch {\n  for (;;);\n}\n"
    + "test('ok', () => assert.equal(ok(), 1));\n";
  const dir = project(t, { 'ok.js': 'module.exports = () => 1;\n', 'ok.test.js': tests });
  write(dir, { 'ok.js': 'module.exports = () => 1;\nmodule.exports.limit = 10;\n' });
  const run = mutate(t, dir, ['--run-timeout', '3']);
  assert.equal(run.code, 2, run.out);
  assert.match(run.out, /\nControl breaks: 1 file, each made to fail as soon as it runs - 0 run by the tests, 0 not exercised, 1 did not finish\n/);
  assert.match(run.out, /\nMutants: 1 tried - 0 killed, 0 survived, 1 did not run\n- did not run: ok\.js: 1 mutant not run - its control break did not run \(the command did not finish in 3 s and was stopped\), so whether the tests run this file is not known\n/);
});

test('a control break that leaves the tests without counts: the tests run the file, and its breaks are judged', (t) => {
  // The command loads the module before the runner starts: failing there, it prints no counts.
  const dir = project(t, { 'cart.js': CART, 'cart.test.js': CART_TEST }, `node -e "require('./cart')" && ${NODE_CMD}`);
  write(dir, { 'cart.js': `${CART}${ADD}`, 'cart.test.js': `${CART_TEST}${ADDS}${STOPS}` });
  const run = mutate(t, dir);
  assert.equal(run.code, 0, run.out);
  assert.match(run.out, /\nControl breaks: 1 file, each made to fail as soon as it runs - 1 run by the tests, 0 not exercised\n/);
  assert.match(run.out, /\nMutants: 4 tried - 4 killed, 0 survived, 0 did not run\n/);
});

test('a Python control break goes after the __future__ imports: a compile step before the tests does not read it as run', (t) => {
  const shop = '"""Prices."""\nfrom __future__ import annotations\n\n\ndef total(prices: list[int]) -> int:\n    return sum(prices)\n';
  const tests = 'import unittest\n\n\nclass T(unittest.TestCase):\n    def test_nothing_of_shop(self):\n        self.assertEqual(1 + 1, 2)\n';
  const dir = project(t, { 'shop.py': shop, 'test_other.py': tests }, 'python3 -m py_compile shop.py && python3 -m unittest discover');
  write(dir, { 'shop.py': shop.replace('return sum(prices)', 'return sum(prices) + 0') });
  const run = mutate(t, dir);
  assert.equal(run.code, 2, run.out);
  assert.match(run.out, /\nControl breaks: 1 file, each made to fail as soon as it runs - 0 run by the tests, 1 not exercised\n/);
  assert.match(run.out, /\n- not exercised: shop\.py: /);
});
