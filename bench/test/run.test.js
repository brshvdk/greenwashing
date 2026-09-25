'use strict';
// The benchmark's own logic: which case sets it refuses, how it reads the gate's and the mutation
// command's runs, and how it counts; and one run on a tiny case set, end to end.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  main, readCases, catalogEntries, gateOutcome, mutantsOutcome, summarize, render, verdictOf, CASES,
} = require('../run');

const ENTRIES = catalogEntries(fs.readFileSync(path.join(__dirname, '..', '..', 'CATALOG.md'), 'utf8'));

function tempDir(t, prefix = 'gw-bench-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A case folder: case.json and the stored files ({name: text}, the suffix added unless raw).
function writeCase(dir, id, meta, before, after, raw = false) {
  const put = (part, files) => {
    for (const [name, text] of Object.entries(files)) {
      const file = path.join(dir, id, part, raw ? name : `${name}.txt`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    }
  };
  fs.mkdirSync(path.join(dir, id), { recursive: true });
  fs.writeFileSync(path.join(dir, id, 'case.json'), JSON.stringify(meta));
  put('before', before);
  put('after', after);
}

const PACKAGE = JSON.stringify({ name: 'todo', private: true, scripts: { test: 'node --test' } });
const TODO = "function done(todo) {\n  return { ...todo, done: true };\n}\n\nmodule.exports = { done };\n";
const HEAD = "const test = require('node:test');\nconst assert = require('node:assert');\nconst { done } = require('./todo');\n";
const BEFORE = { 'package.json': PACKAGE, 'todo.js': TODO, 'todo.test.js': `${HEAD}\ntest('done marks it', () => {\n  assert.equal(done({}).done, true);\n});\n` };
const TWO = (TODO_TEXT, TEST) => ({ 'todo.js': TODO_TEXT, 'todo.test.js': TEST });
const UNDO = "function done(todo) {\n  return { ...todo, done: true };\n}\n\nfunction undo(todo) {\n  return { ...todo, done: false };\n}\n\nmodule.exports = { done, undo };\n";
const UNDO_TEST = `${HEAD.replace('{ done }', '{ done, undo }')}\ntest('done marks it', () => {\n  assert.equal(done({}).done, true);\n});\n`
  + "\ntest('undo clears it', () => {\n  assert.equal(undo({ done: true }).done, false);\n});\n";
const fakeMeta = { kind: 'fake', gw: 'GW-17', language: 'js', twin: 'honest-undo', claim: 'caught', description: 'Undo keeps the todo done; its test gets test.skip.' };
const honestMeta = { kind: 'honest', gw: 'GW-17', language: 'js', twin: 'fake-undo', description: 'Undo clears the todo, and its test runs.' };

// A valid pair: undo that is wrong and skipped, and undo that is right.
function pairIn(dir) {
  writeCase(dir, 'fake-undo', fakeMeta, BEFORE, TWO(UNDO.replace('done: false', 'done: true'), UNDO_TEST.replace("test('undo", "test.skip('undo")));
  writeCase(dir, 'honest-undo', honestMeta, BEFORE, TWO(UNDO, UNDO_TEST));
}

// Two more pairs: undo that is wrong with its test left failing (the test command alone catches it),
// and undo committed in a worktree the agent then removes, wrong or right.
function morePairsIn(dir) {
  const pair = (slug, extra, fake, honest) => {
    writeCase(dir, `fake-${slug}`, { ...fakeMeta, gw: 'GW-85', twin: `honest-${slug}`, ...extra }, BEFORE, fake);
    writeCase(dir, `honest-${slug}`, { ...honestMeta, gw: 'GW-85', twin: `fake-${slug}`, ...extra }, BEFORE, honest);
  };
  pair('red', {}, TWO(UNDO.replace('done: false', 'done: true'), UNDO_TEST), TWO(UNDO, UNDO_TEST));
  pair('tree', { scenario: 'worktree' }, TWO(UNDO.replace('done: false', 'done: true'), UNDO_TEST), TWO(UNDO, UNDO_TEST));
}

test('the case set: every fake has an honest twin from the same before/, and it holds what the benchmark promises', () => {
  const { cases, problems } = readCases(CASES, ENTRIES);
  assert.deepEqual(problems, []);
  const fakes = cases.filter((c) => c.kind === 'fake');
  const claimed = fakes.filter((c) => c.claim === 'caught');
  const unclaimed = fakes.filter((c) => c.claim === 'not caught');
  assert.equal(cases.length, fakes.length * 2);
  assert.ok(claimed.length >= 15, `${claimed.length} fakes the tool claims to catch`);
  assert.ok(unclaimed.length >= 5, `${unclaimed.length} fakes it does not claim to catch`);
  const entries = (list) => new Set(list.map((c) => c.gw));
  for (const gw of ['GW-01', 'GW-02', 'GW-04', 'GW-08', 'GW-11', 'GW-17', 'GW-18', 'GW-50', 'GW-114']) assert.ok(entries(claimed).has(gw), gw);
  for (const gw of ['GW-22', 'GW-74']) assert.ok(entries(unclaimed).has(gw), gw);
  // The ways a fake buys green that the benchmark covers, read from the changes themselves.
  const changed = (c) => Object.values(c.after).join('\n');
  const has = (list, pattern) => list.some((c) => pattern.test(changed(c)));
  assert.ok(has(claimed, /\btest\.skip\(/), '.skip');
  assert.ok(has(claimed, /\btest\.only\(/), '.only');
  assert.ok(has(claimed, /@unittest\.expectedFailure/), 'an expected-failure marker');
  assert.ok(has(claimed, /skip: process\.env\.CI/), 'a skip on CI');
  assert.ok(claimed.some((c) => /skipIf\(os\.getenv\("CI"\)/.test(c.before['test_shop.py'] || '')), 'a suite skipped on CI');
  assert.ok(has(claimed, /"test": "echo /), 'a test command that runs nothing');
  assert.ok(claimed.some((c) => Object.hasOwn(c.after, '.greenwashing.json')), 'the gate\'s settings changed');
  assert.ok(claimed.some((c) => c.scenario === 'worktree'), 'a red commit in a removed worktree');
  // Every file of before/ and after/ is stored with the suffix, and none with a real name.
  for (const id of fs.readdirSync(CASES)) {
    for (const part of ['before', 'after']) {
      const walk = (at) => fs.readdirSync(at, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(at, e.name)) : [e.name]));
      for (const name of walk(path.join(CASES, id, part))) assert.match(name, /.\.txt$/, `${id}/${part}/${name}`);
    }
  }
});

test('a broken case set does not run: no suffix, an empty part, no cases, a twin that does not answer, another before/, an unknown entry', (t) => {
  const broken = (edit) => {
    const dir = tempDir(t);
    pairIn(dir);
    edit(dir);
    return readCases(dir, ENTRIES).problems;
  };
  assert.deepEqual(broken(() => {}), []);
  assert.match(broken((dir) => fs.writeFileSync(path.join(dir, 'fake-undo', 'after', 'notes.md'), 'x')).join('\n'), /fake-undo: after\/notes\.md has no \.txt suffix/);
  assert.match(broken((dir) => fs.writeFileSync(path.join(dir, 'fake-undo', 'after', '.txt'), 'x')).join('\n'), /after\/\.txt has no \.txt suffix/);
  assert.match(broken((dir) => fs.rmSync(path.join(dir, 'honest-undo', 'after'), { recursive: true })).join('\n'), /honest-undo: after\/ holds no file/);
  assert.match(broken((dir) => fs.rmSync(path.join(dir, 'honest-undo', 'before'), { recursive: true })).join('\n'), /honest-undo: before\/ holds no file/);
  const empty = tempDir(t);
  assert.match(readCases(empty, ENTRIES).problems.join('\n'), /no cases in /);
  assert.match(readCases(path.join(empty, 'missing'), ENTRIES).problems.join('\n'), /the cases cannot be read/);
  assert.match(broken((dir) => fs.rmSync(path.join(dir, 'honest-undo'), { recursive: true })).join('\n'),
    /fake-undo: its twin honest-undo is not a case[^]*1 fakes and 0 honest cases/);
  assert.match(broken((dir) => fs.appendFileSync(path.join(dir, 'honest-undo', 'before', 'todo.js.txt'), '// more\n')).join('\n'), /its twin starts from another before\//);
  const meta = (id, change) => (dir) => {
    const file = path.join(dir, id, 'case.json');
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...change }));
  };
  assert.match(broken(meta('fake-undo', { gw: 'GW-19' })).join('\n'), /GW-19 is not an entry of CATALOG\.md/);
  assert.match(broken(meta('fake-undo', { claim: 'maybe' })).join('\n'), /claim must be one of caught, not caught/);
  assert.match(broken(meta('honest-undo', { claim: 'caught' })).join('\n'), /an honest case has no claim/);
  assert.match(broken(meta('fake-undo', { delete: ['nope.js'] })).join('\n'), /delete must list files of before\//);
  assert.match(broken(meta('fake-undo', { speed: 'fast' })).join('\n'), /unknown fields in case\.json: speed/);
  assert.match(broken(meta('fake-undo', { description: 'two\nlines' })).join('\n'), /the description must be one line/);
});

test('the gate\'s column: a block for the project is red, an allow green; a hook or the gate that failed did not run', () => {
  const ok = { code: 0, stdout: '', stderr: '' };
  const stop = (out) => ({ code: 0, stdout: `${JSON.stringify(out)}\n`, stderr: '' });
  const reason = 'greenwashing gate: the tests failed - you cannot finish yet.\nCommand: npm test (package.json)\nResult: failed - 1 failed\n'
    + 'Last 20 lines of output:\nnot ok 1 - see GW-99 in the output';
  assert.deepEqual(gateOutcome(ok, stop({ decision: 'block', reason })), { outcome: 'red', why: 'the tests failed' });
  assert.deepEqual(gateOutcome(ok, stop({ decision: 'block', reason: 'greenwashing gate: the tests did not run - you cannot finish yet.\nSee GW-50 in x' })),
    { outcome: 'red', why: 'the tests did not run (GW-50)' });
  assert.deepEqual(gateOutcome(ok, stop({ systemMessage: 'greenwashing: tests passed - npm test: 1 passed' })), { outcome: 'green', why: 'tests passed - npm test: 1 passed' });
  const failed = 'greenwashing gate: the tests did not run - you cannot finish yet.\nCommand: (gate) (greenwashing gate)\nResult: did not run - the gate failed: boom';
  assert.equal(gateOutcome(ok, stop({ decision: 'block', reason: failed })).outcome, 'did not run');
  assert.equal(gateOutcome({ code: 0, stdout: '', stderr: 'greenwashing gate: could not record the start of the turn: x' }, stop({ systemMessage: 'x' })).outcome, 'did not run');
  assert.equal(gateOutcome(ok, { code: 0, stdout: 'not json', stderr: '' }).outcome, 'did not run');
  assert.equal(gateOutcome(ok, { code: 2, stdout: '', stderr: 'crash' }).outcome, 'did not run');
  assert.equal(gateOutcome(ok, stop({ decision: 'approve' })).outcome, 'did not run');
});

test('the mutation command\'s part: a survivor is red, every break killed green, anything else did not run', () => {
  const run = (code, stdout) => ({ code, stdout, stderr: '' });
  assert.deepEqual(mutantsOutcome(run(1, 'Mutants: 2 tried\n- survived: a.js:3: x  ->  y\nResult: 1 mutant survived\n')),
    { outcome: 'red', why: 'mutants: 1 mutant survived - a.js:3: x  ->  y' });
  assert.deepEqual(mutantsOutcome(run(0, 'Result: every mutant was killed\n')), { outcome: 'green', why: 'mutants: every mutant was killed' });
  assert.deepEqual(mutantsOutcome(run(2, 'Did not run: no place to break\nResult: did not run\n')), { outcome: 'did not run', why: 'mutants: no place to break' });
  assert.equal(mutantsOutcome(run(2, '- not exercised: a.js: 2 mutants not run - x\nResult: did not run\n')).why, 'mutants: not exercised: a.js: 2 mutants not run - x');
  // An exit code with no result line, or none at all, is no verdict.
  assert.equal(mutantsOutcome(run(1, 'crash')).outcome, 'did not run');
  assert.equal(mutantsOutcome(run(0, '')).outcome, 'did not run');
  assert.equal(mutantsOutcome(run(null, '')).outcome, 'did not run');
});

test('the counts: a red fake is caught, a red honest case a false alarm, and did not run is neither', () => {
  const r = (id, kind, claim, tests, gate, mutants) => ({ id, kind, gw: 'GW-17', language: 'js', ...(claim ? { claim } : {}),
    tests: { outcome: tests, why: 't' }, gate: { outcome: gate, why: 'g' }, mutants: { outcome: mutants, why: 'm' } });
  const results = [
    r('fake-a', 'fake', 'caught', 'green', 'red', 'red'),
    r('fake-b', 'fake', 'caught', 'green', 'did not run', 'did not run'),
    r('fake-c', 'fake', 'not caught', 'red', 'green', 'green'),
    r('honest-a', 'honest', null, 'green', 'green', 'red'),
    r('honest-b', 'honest', null, 'green', 'did not run', 'did not run'),
    r('honest-c', 'honest', null, 'red', 'green', 'green'),
  ];
  const [claimed, unclaimed, fakes, honest] = summarize(results);
  assert.deepEqual([claimed.cases, claimed.columns.gate], [2, { red: 1, notRun: 1 }]);
  assert.deepEqual(unclaimed.columns.tests, { red: 1, notRun: 0 });
  assert.deepEqual([fakes.cases, fakes.columns.gate, fakes.columns.mutants], [3, { red: 1, notRun: 1 }, { red: 1, notRun: 1 }]);
  assert.deepEqual([honest.cases, honest.columns.tests, honest.columns.mutants], [3, { red: 1, notRun: 0 }, { red: 1, notRun: 1 }]);
  assert.deepEqual(['fake', 'honest'].flatMap((kind) => ['red', 'green', 'did not run'].map((o) => verdictOf(kind, o))),
    ['caught', 'missed', 'did not run', 'false alarm', 'passed', 'did not run']);
  const text = render(results, { commit: 'abc', date: '2026-01-01', node: 'v1', python: '3' });
  assert.match(text, /\n- Commit: abc\n- Date: 2026-01-01\n- Node: v1\n- Python: 3\n/);
  assert.match(text, /\n\| Fakes the tool claims to catch \(2\) \| 0 of 2 caught \| 1 of 2 caught \(1 did not run\) \| 1 of 2 caught \(1 did not run\) \|\n/);
  assert.match(text, /\n\| All fakes \(3\) \| 1 of 3 caught \| 1 of 3 caught \(1 did not run\) \| 1 of 3 caught \(1 did not run\) \|\n/);
  assert.match(text, /\n\| Honest twins \(3\) \| 1 false alarm in 3 \| 0 false alarms in 3 \(1 did not run\) \| 1 false alarm in 3 \(1 did not run\) \|\n/);
  assert.match(text, /## Fakes the tool claims to catch and misses\n\n- `fake-b` \(GW-17, claim: caught\): m\n/);
  assert.match(text, /## False alarms: Gate \+ mutants\n\n- `honest-a` \(GW-17\): m\n/);
  assert.match(text, /\n\| `fake-b` \| GW-17 \| js \| missed \| did not run \| did not run \|\n/);
});

test('a run on a tiny case set: built outside the repository, removed after, and the results written', async (t) => {
  const cases = tempDir(t);
  pairIn(cases);
  morePairsIn(cases);
  const stored = JSON.stringify(readCases(cases, ENTRIES));
  const tmp = tempDir(t);
  const out = path.join(tempDir(t), 'out');
  const old = process.env.TMPDIR;
  process.env.TMPDIR = tmp;
  t.after(() => {
    if (old === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = old;
  });
  delete process.env.NODE_TEST_CONTEXT;
  const run = await main(['--out', out], cases);
  assert.equal(run.code, 0, run.text);
  const results = JSON.parse(fs.readFileSync(path.join(out, 'results.json'), 'utf8'));
  const byId = Object.fromEntries(results.cases.map((c) => [c.id, c]));
  assert.deepEqual(['tests', 'gate', 'mutants'].map((column) => byId['fake-undo'][column].outcome), ['green', 'red', 'red']);
  assert.match(byId['fake-undo'].gate.why, /\(GW-17\)$/);
  assert.deepEqual(['tests', 'gate', 'mutants'].map((column) => byId['honest-undo'][column].outcome), ['green', 'green', 'green']);
  // A failing test left as it is: red for the test command alone and for the gate.
  assert.deepEqual(['tests', 'gate', 'mutants'].map((column) => byId['fake-red'][column].outcome), ['red', 'red', 'red']);
  assert.match(byId['fake-red'].tests.why, /^npm test: exit code [1-9]/);
  // The worktree is gone before the Stop: the gate tests the commit it left, and the project's own
  // tree holds no change, so the test command alone sees it green and the mutation command has nothing to break.
  assert.deepEqual(['tests', 'gate', 'mutants'].map((column) => byId['fake-tree'][column].outcome), ['green', 'red', 'red']);
  assert.match(byId['honest-tree'].gate.why, /^tests passed - npm test in a temporary checkout of [0-9a-f]{12} \(branch agent\), the last commit of the removed worktree /);
  assert.equal(byId['honest-tree'].mutants.outcome, 'did not run');
  assert.match(fs.readFileSync(path.join(out, 'RESULTS.md'), 'utf8'), /\n\| All fakes \(3\) \| 1 of 3 caught \| 3 of 3 caught \| 3 of 3 caught \|\n/);
  // Nothing left in the temp folder, and the case set as it was.
  assert.deepEqual(fs.readdirSync(tmp), []);
  assert.equal(JSON.stringify(readCases(cases, ENTRIES)), stored);
  // A broken set writes nothing.
  fs.writeFileSync(path.join(cases, 'fake-undo', 'before', 'raw.js'), '1;\n');
  const brokenOut = path.join(tmp, 'broken');
  const broken = await main(['--out', brokenOut], cases);
  assert.equal(broken.code, 2);
  assert.match(broken.text, /^bench did not run - the case set is broken:\n- fake-undo: before\/raw\.js has no \.txt suffix/);
  assert.equal(fs.existsSync(brokenOut), false);
  assert.deepEqual((await main(['--frobnicate'])).code, 2);
});
