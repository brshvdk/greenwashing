'use strict';
// The README check (bench/readme): each rule on a small README and run made here, red when broken, the
// command's exit codes, and the real README against the committed results.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { check, main, slug, cells } = require('../readme');

const ROOT = path.join(__dirname, '..', '..');
const CATALOG = '# The catalog\n\n### GW-01 Self-referential assertion\n- x\n\n### GW-08 "0 of 0 problems"\n- x\n\n### GW-17 A skip that buys green\n- x\n\n'
  + '### GW-18 A test with nothing to check\n- x\n';
const SCENE_REPLY = "greenwashing gate: this turn removed tests - you cannot finish yet.\nRemoved tests:\n- todo.test.js: 'search ignores case' (GW-17)\nPut the tests back.";
const REPLIES = {
  'fake-deleted-test-js': SCENE_REPLY,
  'fake-skip-js': 'greenwashing gate: the changed tests can pass without testing anything - you cannot finish yet.\n- todo.test.js:9: test.skip - the test does not run (GW-17)',
  'fake-no-assertion-js': "greenwashing gate: the changed tests can pass without testing anything - you cannot finish yet.\n- todo.test.js:9: the test 'tag' has no assertion (GW-18)",
  'fake-dummy-command-js': 'greenwashing gate: the tests did not run - you cannot finish yet.\nResult: did not run - no test counts in the output\nLast 20 lines of output:\n\n- all tests passed',
};
const SUMMARY = '| Cases | Tests only | Gate | Gate + mutation check |\n| --- | --- | --- | --- |\n| All fakes (4) | 0 of 4 caught | 4 of 4 caught | 4 of 4 caught |'
  + '\n| Honest twins (4) | 0 false alarms in 4 | 0 false alarms in 4 | 1 false alarm in 4 |';
const RESULTS_MD = `# Benchmark\n\n- Commit: abc\n\n## Summary\n\n${SUMMARY}\n\nTests only: the command.\n\n## Cases\n\n| Case | Entry |\n| --- | --- |\n| x | GW-17 |\n`;
const caseOf = (id, tests = 'green', gate = 'red') => ({ id, tests: { outcome: tests, why: 't' }, gate: { outcome: gate, why: 'g' }, mutants: { outcome: gate, why: 'm' } });
const run = (edit = {}) => ({
  resultsMd: edit.resultsMd || RESULTS_MD,
  results: { cases: Object.keys(REPLIES).map((id) => caseOf(id, ...(edit[id] || []))) },
  replies: { ...REPLIES, ...(edit.replies || {}) },
});
const SKIP_ROW = '| Marked the failing test `skip` | ✅ green | ❌ todo.test.js:9: test.skip - the test does not run ([GW-17](CATALOG.md#gw-17-a-skip-that-buys-green)) |';
const NONE_ROW = "| Wrote a test that checks nothing | ✅ green | ❌ todo.test.js:9: the test 'tag' has no assertion ([GW-18](CATALOG.md#gw-18-a-test-with-nothing-to-check)) |";
const DUMMY_ROW = '| Made the test command print a pass without running tests | ✅ green | ❌ did not run - no test counts in the output |';
const README = '# greenwashing\n\n[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)\n\nIt runs them itself.\n\n```\n> Make search look in the notes too.\n\n'
  + '● Done. ✅ All tests pass.\n\n● Ran 1 stop hook\n  ⎿  Stop hook error: greenwashing gate: this turn removed tests - you cannot finish yet.\n  Removed tests:\n'
  + "  - todo.test.js: 'search ignores case' (GW-17)\n  Put the tests\n  back.\n```\n\n```\n/plugin install greenwashing@greenwashing\n```\n\n## What else it catches\n\n"
  + `| What the agent did | Plain test run | greenwashing |\n|---|---|---|\n${SKIP_ROW}\n${NONE_ROW}\n${DUMMY_ROW}\n\n`
  + `## Numbers\n\nEvery fake has a twin.\n\n${SUMMARY}\n\nRun it with \`node bench/run\`.\n\n## Where it works\n\n- **Node 20+** on PATH.\n- Not [GW-01](CATALOG.md#gw-01-self-referential-assertion) or \`GW-99\`.\n\nThe end.\n`;

const problemsOf = (readme, r = run()) => check(readme, r, CATALOG).problems;
const red = (readme, pattern, r) => assert.match(problemsOf(readme, r).join('\n'), pattern, readme);
const green = (readme, r) => assert.deepEqual(problemsOf(readme, r), [], readme);
const after = (line, extra, readme = README) => readme.replace(`${line}\n`, `${line}\n${extra}\n`);

test('a README that is what the run gave passes, and says what it checked', () => {
  const { problems, notRun, checked } = check(README, run(), CATALOG);
  assert.deepEqual(problems, []);
  assert.deepEqual(notRun, []);
  assert.deepEqual(checked, ['the scene', 'fake-skip-js', 'fake-no-assertion-js', 'fake-dummy-command-js', 'the numbers', '3 catalog links']);
  // Line ends of Windows, a code block that names an entry or the oldest Node, a fence inside a line and a
  // heading inside a code block are no difference.
  green(README.replace(/\n/g, '\r\n'));
  green(README.replace('/plugin install greenwashing@greenwashing', '# see GW-17 and Node 20+\n/plugin install greenwashing@greenwashing'));
  green(README.replace('It runs them itself.', 'It runs them itself; a block opens with ```.'));
  green(README.replace('Every fake has a twin.', 'Every fake has a twin.\n\n```\n# run it\n```'));
});

test('the scene: a word the run did not say is red, a line wrapped at another space is not; it must be one closed block, on a caught case', () => {
  red(README.replace("'search ignores case'", "'search ignores cases'"), /^the scene: the gate's reply on fake-deleted-test-js differs from this run's: the README has .*ignores cases/);
  red(README.replace('  Put the tests\n  back.', '  Put the tests back. Done.'), /^the scene: /);
  red(README.replace('  Put the tests\n  back.', '  Put the tests'), /^the scene: /);
  green(README.replace('  Put the tests\n  back.', '  Put the\ntests back. '));
  // A line breaks at a space: a word broken in two is two words.
  red(README.replace('  Put the tests\n  back.', '  Put the te\n  sts back.'), /^the scene: /);
  red(README.replace('Stop hook error: ', 'Stop hook said: '), /^the scene: 0 code blocks hold "Stop hook error:", not 1/);
  red(README.replace('/plugin install greenwashing@greenwashing', '/plugin install greenwashing@greenwashing\nStop hook error: x'), /^the scene: 2 code blocks hold/);
  red(README, /^the scene: the gate does not stop fake-deleted-test-js in this run \(green\)/, run({ 'fake-deleted-test-js': ['green', 'green'] }));
  assert.match(check(README, run({ replies: { 'fake-deleted-test-js': null } }), CATALOG).notRun.join('\n'), /^the scene: this run has no reply of the gate on fake-deleted-test-js/);
  // A number in the lines around the reply is no number of the run; the frame's own line is Claude Code's.
  red(README.replace('✅ All tests pass.', '✅ All 48 tests pass.'), /: a number no bench run gives: ● Done\. ✅ All 48 tests pass\./);
  red(README.replace('● Ran 1 stop hook', '● Ran 2 stop hooks'), /: a number no bench run gives: ● Ran 2 stop hooks/);
  red(`${README}\n\`\`\`\nnever closed\n`, /: a code block that is never closed/);
});

test('the table: its header, each row its case and text, the plain run the tests-only outcome, the reason a finding or result of the gate', () => {
  red(README, /^the table, fake-skip-js: "Plain test run" says "✅ green", this run "❌ red"/, run({ 'fake-skip-js': ['red'] }));
  assert.match(check(README, run({ 'fake-skip-js': ['did not run'] }), CATALOG).notRun.join('\n'), /^the table, fake-skip-js: the tests-only column did not run/);
  red(README, /^the table, fake-no-assertion-js: the gate does not stop it in this run \(green\)/, run({ 'fake-no-assertion-js': ['green', 'green'] }));
  // A gate that did not run is no catch, also with a reply.
  red(README, /^the table, fake-no-assertion-js: the gate does not stop it in this run \(did not run\)/, run({ 'fake-no-assertion-js': ['green', 'did not run'] }));
  red(README.replace('the test does not run ([GW-17]', 'the test is skipped ([GW-17]'), /^the table, fake-skip-js: "todo\.test\.js:9: test\.skip - the test is skipped \(GW-17\)" is not a finding or result line/);
  red(README.replace('| ✅ green | ❌ did not run', '| ✅ green | did not run'), /^the table, fake-dummy-command-js: /);
  // Only the gate's findings and result, each without its "- " or "Result: ", and not the test output it quotes.
  for (const reason of ['no test counts in the output', 'Result: did not run - no test counts in the output', 'all tests passed', '- all tests passed',
    'greenwashing gate: the tests did not run - you cannot finish yet.', '', '[](CATALOG.md)', '![did not run - no test counts in the output](x.svg)']) {
    red(README.replace('❌ did not run - no test counts in the output |', `❌ ${reason} |`), /^the table, fake-dummy-command-js: /);
  }
  // The rows go in the order of the cases, each with its own text, under the header, three cells each.
  red(README.replace(`${SKIP_ROW}\n${NONE_ROW}`, `${NONE_ROW}\n${SKIP_ROW}`), /^the table, fake-skip-js: /);
  red(README.replace('| Marked the failing test `skip` |', '| Wrote a test that checks nothing |'), /^the table, fake-skip-js: its row says "Wrote a test that checks nothing"/);
  red(README.replace('| What the agent did | Plain test run | greenwashing |', '| What the agent did | greenwashing | Plain test run |'), /^the table: its header is /);
  red(README.replace('|---|---|---|\n', ''), /^the table: no delimiter row of 3 cells/);
  red(README.replace('|---|---|---|\n', '|---|---|\n'), /^the table: no delimiter row of 3 cells/);
  red(README.replace(DUMMY_ROW, `${DUMMY_ROW} 3 runs |`), /^the table, fake-dummy-command-js: 4 cells, not 3/);
  red(README.replace(`${SKIP_ROW}\n`, ''), /^the table: 2 rows of cases, not 3/);
  red(after(DUMMY_ROW, '| Deleted the test file | ✅ green | ❌ caught |'), /^the table: 4 rows of cases, not 3/);
  // GitHub reads a line with no outer pipes right after a row as a row too.
  red(after(DUMMY_ROW, 'Deleted the test file | ✅ green | ❌ caught'), /^the table: 4 rows of cases, not 3/);
  red(README.replace(`${DUMMY_ROW}\n`, `\`\`\`\n${DUMMY_ROW}\n\`\`\`\n`), /^the table: 2 rows of cases, not 3/);
  red(README.replace('## What else it catches', '## What it catches'), /^the table: no section "## What else it catches"/);
  red(after(DUMMY_ROW, '\n| a | b |\n|---|---|\n| c | d |'), /^the table: 2 tables in "What else it catches", not 1/);
  assert.match(check(README, run({ replies: { 'fake-skip-js': null } }), CATALOG).notRun.join('\n'), /^the table: this run has no outcome or no reply of the gate on fake-skip-js/);
  // A finding line with nothing after its start is no reason to show.
  red(README.replace('❌ did not run - no test counts in the output |', '❌ [](CATALOG.md) |'), /^the table, fake-dummy-command-js: /,
    run({ replies: { 'fake-dummy-command-js': `${REPLIES['fake-dummy-command-js'].split('\n')[0]}\n- \nResult: did not run - no test counts in the output` } }));
  assert.deepEqual(cells('| a | b \\| c | d |'), ['a', 'b | c', 'd']);
});

test('the numbers: the run\'s summary table as it is, and no other number anywhere but catalog entries and the oldest Node', () => {
  const allFakes = '| All fakes (4) | 0 of 4 caught | 4 of 4 caught | 4 of 4 caught |';
  red(README.replace(allFakes, allFakes.replace('| 4 of 4 caught | 4 of 4', '| 3 of 4 caught | 4 of 4')), /^the numbers: the table in "Numbers" is not this run's summary table: \| All fakes \(4\) \| 0 of 4 caught \| 3 of 4 caught/);
  red(README.replace(`${allFakes}\n`, ''), /^the numbers: /);
  red(README.replace('\n| Honest twins (4) | 0 false alarms in 4 | 0 false alarms in 4 | 1 false alarm in 4 |', ''), /^the numbers: /);
  red(README.replace(`${allFakes}\n`, `${allFakes}\n| Honest (2) | 0 | 0 | 0 |\n`), /^the numbers: /);
  red(README.replace(`${allFakes}\n`, `${allFakes}\nFakes in real projects | all caught | all caught | all caught |\n`), /^the numbers: /);
  red(README.replace('Run it with', '| Real projects | all |\n|---|---|\n\nRun it with'), /^the numbers: 2 tables in "Numbers", not 1/);
  red(README.replace(SUMMARY, `\`\`\`\n${SUMMARY}\n\`\`\``), /^the numbers: 0 tables in "Numbers", not 1/);
  red(README.replace('## Numbers', '## Figures'), /^the numbers: no section "## Numbers"/);
  for (const resultsMd of ['# Benchmark\n', `# Benchmark\n\n## Summary\n\n${SUMMARY.split('\n').slice(0, 2).join('\n')}\n`]) {
    assert.match(check(README, run({ resultsMd }), CATALOG).notRun.join('\n'), /^the numbers: no summary table in this run's RESULTS\.md/);
  }
  red(README.replace('Every fake has a twin.', 'Every one of 32 fakes has a twin.'), /^line \d+: a number no bench run gives: Every one of 32 fakes/);
  red(README.replace('Every fake has a twin.', 'Every one of ３２ fakes has a twin².'), /: a number no bench run gives: Every one of ３２/);
  red(README.replace('Node 20+', 'Node 22+'), /: a number no bench run gives: - \*\*Node 22\+\*\* on PATH\./);
  red(README.replace('Node 20+', 'Node 20'), /: a number no bench run gives: - \*\*Node 20\*\* on PATH\./);
  red(README.replace('/plugin install greenwashing@greenwashing', '/greenwashing:mutants --timeout 900'), /: a number no bench run gives: \/greenwashing:mutants --timeout 900/);
  red(README.replace('| Marked the failing test `skip` |', '| Marked 2 failing tests `skip` |'), /: a number no bench run gives: \| Marked 2 failing/);
  red(README.replace('## Where it works', '## Where it works in 2026'), /: a number no bench run gives: ## Where it works in 2026/);
  red(README.replace('[GW-01](CATALOG.md#gw-01-self-referential-assertion)', '[GW-01](https://example.com/v2)'), /a number no bench run gives: - Not \[GW-01\]\(https:\/\/example\.com\/v2\)/);
});

test('images: the license badge, once and alone', () => {
  red(README.replace('(LICENSE)\n', '(LICENSE) ![caught](https://img.shields.io/badge/caught-all-green)\n'), /: an image other than the license badge: /);
  red(README.replace('It runs them itself.', '![demo](demo.gif)'), /: an image other than the license badge: !\[demo\]/);
  red(README.replace('[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)\n', ''), /^the license badge: not once on a line of its own/);
  red(README.replace('license-MIT-blue', 'license-MIT-2026-blue'), /: a number no bench run gives: \[!\[License: MIT\]/);
});

test('catalog links: every GW-NN outside code links to its entry\'s heading', () => {
  red(README.replace('#gw-01-self-referential-assertion', '#gw-01-self-referential'), /^line \d+: GW-01 links to CATALOG\.md#gw-01-self-referential, not CATALOG\.md#gw-01-self-referential-assertion/);
  red(README.replace('(CATALOG.md#gw-01-self-referential-assertion)', '(README.md#gw-01-self-referential-assertion)'), /\bline \d+: GW-01 links to README\.md#/);
  red(README.replace('[GW-01](CATALOG.md#gw-01-self-referential-assertion)', '[GW-02](CATALOG.md#gw-02-x)'), /^line \d+: GW-02 is no entry of CATALOG\.md/);
  red(README.replace('[GW-01](CATALOG.md#gw-01-self-referential-assertion)', 'GW-01'), /^line \d+: a catalog entry that is no link to it: - Not GW-01/);
  red(README.replace('([GW-17](CATALOG.md#gw-17-a-skip-that-buys-green))', '(GW-17)'), /^line \d+: a catalog entry that is no link to it: \| Marked the failing test/);
  red(README.replace('[GW-01](CATALOG.md#gw-01-self-referential-assertion)', 'GW-０１'), /a catalog entry that is no link to it: - Not GW-０１/);
  assert.equal(slug('GW-08 "0 of 0 problems"'), 'gw-08-0-of-0-problems');
  assert.equal(slug('GW-62 "Passes locally, three times"'), 'gw-62-passes-locally-three-times');
  assert.equal(slug('GW-41 The expected_value fitted'), 'gw-41-the-expected_value-fitted');
});

test('the command: passed, failed and did not run, as exit codes 0, 1 and 2', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-readme-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folder = path.join(root, 'bench');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(root, 'CATALOG.md'), CATALOG);
  const write = (readme, edit = {}, replies = null) => {
    fs.writeFileSync(path.join(root, 'README.md'), readme);
    const r = run(edit);
    fs.writeFileSync(path.join(folder, 'RESULTS.md'), r.resultsMd);
    fs.writeFileSync(path.join(folder, 'results.json'), JSON.stringify(r.results));
    fs.writeFileSync(path.join(folder, 'replies.json'), replies === null ? JSON.stringify(r.replies) : replies);
  };
  const missing = main([path.join(root, 'none')], root);
  assert.equal(missing.code, 2);
  assert.match(missing.text, /^README check: did not run - ENOENT/);
  write(README);
  // The folder bench/run writes to by default.
  const passed = main([], root);
  assert.equal(passed.code, 0, passed.text);
  assert.match(passed.text, /^README check: passed - the scene, fake-skip-js, fake-no-assertion-js, fake-dummy-command-js, the numbers, 3 catalog links match this bench run/);
  assert.equal(main([folder, 'more'], root).code, 2);
  assert.match(main([folder, 'more'], root).text, /^usage: /);
  // One difference is enough.
  write(README.replace('Node 20+', 'Node 22+'));
  assert.equal(main([folder], root).code, 1);
  // A case with no reply did not run; with a difference too, it failed, and both are said.
  write(README, { replies: { 'fake-deleted-test-js': null } });
  const notRun = main([folder], root);
  assert.equal(notRun.code, 2, notRun.text);
  assert.match(notRun.text, /^README check: did not run\n- the scene: this run has no reply of the gate on fake-deleted-test-js$/);
  write(README.replace('Node 20+', 'Node 22+'), { replies: { 'fake-deleted-test-js': null } });
  const both = main([folder], root);
  assert.equal(both.code, 1);
  assert.match(both.text, /a number no bench run gives[^]*- the scene: this run has no reply of the gate/);
  write(README, {}, '{not json');
  assert.equal(main([folder], root).code, 2);
  write(README, {}, 'null');
  assert.match(main([folder], root).text, /^README check: did not run - the run's files cannot be read as bench\/run writes them: /);
  assert.equal(main([folder], root).code, 2);
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
