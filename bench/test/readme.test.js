'use strict';
// The README check (bench/readme): each rule on a small README and run made here, red when broken, and
// the real README against the committed results.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { check, main, slug, cells } = require('../readme');

const ROOT = path.join(__dirname, '..', '..');
const CATALOG = '# The catalog\n\n### GW-01 Self-referential assertion\n- x\n\n### GW-08 "0 of 0 problems"\n- x\n\n### GW-17 A skip that buys green\n- x\n\n'
  + '### GW-18 A test with nothing to check\n- x\n';
const SCENE_REPLY = "greenwashing gate: this turn removed tests - you cannot finish yet.\nRemoved tests:\n- todo.test.js: 'search ignores case' (GW-17)\nPut the tests back.";
const REPLIES = {
  'fake-deleted-test-js': SCENE_REPLY,
  'fake-skip-js': 'greenwashing gate: the changed tests can pass without testing anything - you cannot finish yet.\n- todo.test.js:9: test.skip - the test does not run (GW-17)',
  'fake-no-assertion-js': "greenwashing gate: the changed tests can pass without testing anything - you cannot finish yet.\n- todo.test.js:9: the test 'tag' has no assertion (GW-18)",
  'fake-dummy-command-js': 'greenwashing gate: the tests did not run - you cannot finish yet.\nResult: did not run - no test counts in the output\nLast 20 lines of output:\nall tests passed',
};
const SUMMARY = '| Cases | Tests only | Gate | Gate + mutation check |\n| --- | --- | --- | --- |\n| All fakes (4) | 0 of 4 caught | 4 of 4 caught | 4 of 4 caught |';
const RESULTS_MD = `# Benchmark\n\n- Commit: abc\n\n## Summary\n\n${SUMMARY}\n\nTests only: the command.\n\n## Cases\n\n| Case | Entry |\n| --- | --- |\n| x | GW-17 |\n`;
const caseOf = (id, tests = 'green', gate = 'red') => ({ id, tests: { outcome: tests, why: 't' }, gate: { outcome: gate, why: 'g' }, mutants: { outcome: gate, why: 'm' } });
const run = (edit = {}) => ({
  resultsMd: RESULTS_MD,
  results: { cases: Object.keys(REPLIES).map((id) => caseOf(id, ...(edit[id] || []))) },
  replies: { ...REPLIES, ...(edit.replies || {}) },
});
const README = '# greenwashing\n\n[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)\n\nIt runs them itself.\n\n```\n> Make search look in the notes too.\n\n'
  + '● Ran 1 stop hook\n  ⎿  Stop hook error: greenwashing gate: this turn removed tests - you cannot finish yet.\n  Removed tests:\n'
  + "  - todo.test.js: 'search ignores case' (GW-17)\n  Put the tests\n  back.\n```\n\n```\n/plugin install greenwashing@greenwashing\n```\n\n## What else it catches\n\n"
  + '| What the agent did | Plain test run | greenwashing |\n|---|---|---|\n'
  + '| Marked the failing test `skip` | ✅ green | ❌ todo.test.js:9: test.skip - the test does not run ([GW-17](CATALOG.md#gw-17-a-skip-that-buys-green)) |\n'
  + "| Wrote a test that checks nothing | ✅ green | ❌ todo.test.js:9: the test 'tag' has no assertion ([GW-18](CATALOG.md#gw-18-a-test-with-nothing-to-check)) |\n"
  + '| Made the test command print a pass | ✅ green | ❌ did not run - no test counts in the output |\n\n'
  + `## Numbers\n\nEvery fake has a twin.\n\n${SUMMARY}\n\nRun it with \`node bench/run\`.\n\n## Where it works\n\n- **Node 20+** on PATH.\n- Not [GW-01](CATALOG.md#gw-01-self-referential-assertion) or \`GW-99\`.\n\nThe end.\n`;

const problemsOf = (readme, r = run()) => check(readme, r, CATALOG).problems;

test('a README that is what the run gave passes, and says what it checked', () => {
  const { problems, notRun, checked } = check(README, run(), CATALOG);
  assert.deepEqual(problems, []);
  assert.deepEqual(notRun, []);
  assert.deepEqual(checked, ['the scene', 'fake-skip-js', 'fake-no-assertion-js', 'fake-dummy-command-js', 'the numbers', '3 catalog links']);
});

test('the scene: a word the run did not say is red, a line wrapped elsewhere is not; it must be one block, on a caught case', () => {
  assert.match(problemsOf(README.replace("'search ignores case'", "'search ignores cases'")).join('\n'),
    /^the scene: the gate's reply on fake-deleted-test-js differs from this run's: the README has .*ignores cases/);
  assert.match(problemsOf(README.replace('  Put the tests\n  back.', '  Put the tests back. Done.')).join('\n'), /^the scene: /);
  assert.match(problemsOf(README.replace('  Put the tests\n  back.', '  Put the tests')).join('\n'), /^the scene: /);
  assert.deepEqual(problemsOf(README.replace('  Put the tests\n  back.', '  Put the\n  tests back.')), []);
  assert.match(problemsOf(README.replace('Stop hook error: ', 'Stop hook said: ')).join('\n'), /^the scene: 0 code blocks hold "Stop hook error:", not 1/);
  assert.match(problemsOf(README.replace('/plugin install', 'Stop hook error: x\n/plugin install')).join('\n'), /^the scene: 2 code blocks hold/);
  assert.match(problemsOf(README, run({ 'fake-deleted-test-js': ['green', 'green'] })).join('\n'), /^the scene: the gate does not stop fake-deleted-test-js in this run \(green\)/);
  assert.match(check(README, run({ replies: { 'fake-deleted-test-js': null } }), CATALOG).notRun.join('\n'), /^the scene: this run has no reply of the gate on fake-deleted-test-js/);
});

test('the table: each row is its case, its plain run the tests-only outcome and its reason a line of the gate\'s reply', () => {
  assert.match(problemsOf(README, run({ 'fake-skip-js': ['red'] })).join('\n'), /^the table, fake-skip-js: "Plain test run" says "✅ green", this run "❌ red"/);
  assert.match(check(README, run({ 'fake-skip-js': ['did not run'] }), CATALOG).notRun.join('\n'), /^the table, fake-skip-js: the tests-only column did not run/);
  assert.match(problemsOf(README, run({ 'fake-no-assertion-js': ['green', 'green'] })).join('\n'), /^the table, fake-no-assertion-js: the gate does not stop it in this run \(green\)/);
  assert.match(problemsOf(README.replace('the test does not run ([GW-17]', 'the test is skipped ([GW-17]')).join('\n'),
    /^the table, fake-skip-js: "todo\.test\.js:9: test\.skip - the test is skipped \(GW-17\)" is not a line of the gate's reply in this run/);
  assert.match(problemsOf(README.replace('| ✅ green | ❌ did not run', '| ✅ green | did not run')).join('\n'), /^the table, fake-dummy-command-js: /);
  // Only one leading "- " or "Result: " comes off a line of the reply; a part of a line is not one.
  assert.match(problemsOf(README.replace('❌ did not run - no test counts in the output', '❌ no test counts in the output')).join('\n'), /^the table, fake-dummy-command-js: /);
  assert.match(problemsOf(README.replace('❌ did not run - no test counts in the output', '❌ Result: did not run - no test counts in the output')).join('\n'), /^the table, fake-dummy-command-js: /);
  // The rows go in the order of the cases, and there are as many.
  const [skip, none] = README.split('\n').filter((line) => line.startsWith('| Marked') || line.startsWith('| Wrote'));
  assert.match(problemsOf(README.replace(`${skip}\n${none}`, `${none}\n${skip}`)).join('\n'), /^the table, fake-skip-js: /);
  assert.match(problemsOf(README.replace(`${skip}\n`, '')).join('\n'), /^the table: 2 rows of cases, not 3/);
  assert.match(problemsOf(README.replace('## What else it catches', '## What it catches')).join('\n'), /^the table: no section "## What else it catches"/);
  assert.match(check(README, run({ replies: { 'fake-skip-js': null } }), CATALOG).notRun.join('\n'), /^the table: this run has no outcome or no reply of the gate on fake-skip-js/);
  assert.deepEqual(cells('| a | b \\| c | d |'), ['a', 'b | c', 'd']);
});

test('the numbers: the run\'s summary table as it is, and no other number anywhere but catalog entries and the oldest Node', () => {
  assert.match(problemsOf(README.replace('| All fakes (4) | 0 of 4 caught | 4 of 4 caught |', '| All fakes (4) | 0 of 4 caught | 3 of 4 caught |')).join('\n'),
    /^the numbers: the table in "Numbers" is not this run's summary table: \| All fakes \(4\) \| 0 of 4 caught \| 3 of 4 caught/);
  assert.match(problemsOf(README.replace('| --- | --- | --- | --- |\n| All fakes', '| --- | --- | --- | --- |\n| Honest (4) | 0 | 0 | 0 |\n| All fakes')).join('\n'), /^the numbers: /);
  assert.match(problemsOf(README.replace('## Numbers', '## Figures')).join('\n'), /^the numbers: no section "## Numbers"/);
  assert.match(check(README, { ...run(), resultsMd: '# Benchmark\n' }, CATALOG).notRun.join('\n'), /^the numbers: no summary table in this run's RESULTS\.md/);
  assert.match(problemsOf(README.replace('Every fake has a twin.', 'Every one of 32 fakes has a twin.')).join('\n'), /^line \d+: a number no bench run gives: Every one of 32 fakes/);
  assert.match(problemsOf(README.replace('Node 20+', 'Node 22+')).join('\n'), /: a number no bench run gives: - \*\*Node 22\+\*\* on PATH\./);
  assert.match(problemsOf(README.replace('/plugin install greenwashing@greenwashing', '/greenwashing:mutants --timeout 900')).join('\n'), /: a number no bench run gives: \/greenwashing:mutants --timeout 900/);
  assert.match(problemsOf(README.replace('| Marked the failing test `skip` |', '| Marked 2 failing tests `skip` |')).join('\n'), /: a number no bench run gives: \| Marked 2 failing/);
  assert.match(problemsOf(README.replace('## Where it works', '## Where it works in 2026')).join('\n'), /: a number no bench run gives: ## Where it works in 2026/);
});

test('catalog links: every GW-NN outside code links to its entry\'s heading', () => {
  assert.match(problemsOf(README.replace('#gw-01-self-referential-assertion', '#gw-01-self-referential')).join('\n'),
    /^line \d+: GW-01 links to CATALOG\.md#gw-01-self-referential, not CATALOG\.md#gw-01-self-referential-assertion/);
  assert.match(problemsOf(README.replace('[GW-01](CATALOG.md#gw-01-self-referential-assertion)', '[GW-02](CATALOG.md#gw-02-x)')).join('\n'), /^line \d+: GW-02 is no entry of CATALOG\.md/);
  assert.match(problemsOf(README.replace('[GW-01](CATALOG.md#gw-01-self-referential-assertion)', 'GW-01')).join('\n'), /^line \d+: a catalog entry that is no link to it: - Not GW-01/);
  assert.equal(slug('GW-08 "0 of 0 problems"'), 'gw-08-0-of-0-problems');
  assert.equal(slug('GW-62 "Passes locally, three times"'), 'gw-62-passes-locally-three-times');
});

test('the command: passed, failed and did not run, as exit codes 0, 1 and 2', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-readme-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const command = (folder) => spawnSync(process.execPath, [path.join(ROOT, 'bench', 'readme'), ...(folder ? [folder] : [])], { encoding: 'utf8' });
  const missing = command(path.join(dir, 'none'));
  assert.equal(missing.status, 2);
  assert.match(missing.stdout, /^README check: did not run - ENOENT/);
  fs.writeFileSync(path.join(dir, 'RESULTS.md'), RESULTS_MD);
  fs.writeFileSync(path.join(dir, 'results.json'), JSON.stringify(run().results));
  fs.writeFileSync(path.join(dir, 'replies.json'), '{not json');
  assert.equal(command(dir).status, 2);
  fs.writeFileSync(path.join(dir, 'replies.json'), 'null');
  const odd = command(dir);
  assert.equal(odd.status, 2, odd.stdout);
  assert.match(odd.stdout, /^README check: did not run - the run's files cannot be read as bench\/run writes them: /);
  fs.writeFileSync(path.join(dir, 'replies.json'), JSON.stringify(REPLIES));
  // The real README against this small run: its numbers and replies differ.
  const differs = command(dir);
  assert.equal(differs.status, 1, differs.stdout);
  assert.match(differs.stdout, /^README check: failed - the README is not what this bench run gave\n- the scene: /);
  assert.equal(main(['a', 'b']).code, 2);
});

test('the real README: its numbers are the committed summary, its links point at their entries, and its scene and rows wait for a run', () => {
  const committed = {
    resultsMd: fs.readFileSync(path.join(ROOT, 'bench', 'RESULTS.md'), 'utf8'),
    results: JSON.parse(fs.readFileSync(path.join(ROOT, 'bench', 'results.json'), 'utf8')),
    replies: {},
  };
  const { problems, notRun, checked } = check(fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8'), committed, fs.readFileSync(path.join(ROOT, 'CATALOG.md'), 'utf8'));
  assert.deepEqual(problems, []);
  assert.deepEqual(notRun.map((line) => line.split(':')[0]), ['the scene', 'the table', 'the table', 'the table']);
  assert.match(checked.join(', '), /^the numbers, [1-9]\d* catalog links$/);
});
