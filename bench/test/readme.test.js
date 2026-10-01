'use strict';
// The README check (bench/readme): each rule on a small README and run made here, red when broken, the
// command's exit codes, and the real README against the committed results.
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
  + `## Numbers\n\nEvery fake has a twin.\n\n${SUMMARY}\n\nRun it with \`node bench/run\`.\n\n## Where it works\n\n- **Node 20+** on PATH.\n- Not [GW-01](CATALOG.md#gw-01-self-referential-assertion).\n\nThe end.\n`;

const problemsOf = (readme, r = run()) => check(readme, r, CATALOG).problems;
const assertRed = (readme, pattern, r) => assert.match(problemsOf(readme, r).join('\n'), pattern, readme);
const assertGreen = (readme, r) => assert.deepEqual(problemsOf(readme, r), [], readme);
const after = (line, extra, readme = README) => readme.replace(`${line}\n`, `${line}\n${extra}\n`);

test('a README that is what the run gave passes, and says what it checked', () => {
  const { problems, notRun, checked } = check(README, run(), CATALOG);
  assert.deepEqual(problems, []);
  assert.deepEqual(notRun, []);
  assert.deepEqual(checked, ['the scene', 'fake-skip-js', 'fake-no-assertion-js', 'fake-dummy-command-js', 'the numbers', '3 catalog links']);
  // Line ends of Windows, a code block that names an entry or the oldest Node, a fence inside a line and a
  // heading inside a code block are no difference.
  assertGreen(README.replace(/\n/g, '\r\n'));
  assertGreen(README.replace('/plugin install greenwashing@greenwashing', '# see GW-17 and Node 20+\n/plugin install greenwashing@greenwashing'));
  assertGreen(README.replace('It runs them itself.', 'It runs them itself; a block opens with ```.'));
  assertGreen(README.replace('Every fake has a twin.', 'Every fake has a twin.\n\n```\n# run it\n```'));
});

test('the scene: a word the run did not say is red, a line wrapped elsewhere is not; it must be one block, on a caught case', () => {
  assertRed(README.replace("'search ignores case'", "'search ignores cases'"), /^the scene: the gate's reply on fake-deleted-test-js differs from this run's: the README has .*ignores cases/);
  assertRed(README.replace('  Put the tests\n  back.', '  Put the tests back. Done.'), /^the scene: /);
  assertRed(README.replace('  Put the tests\n  back.', '  Put the tests'), /^the scene: /);
  assertGreen(README.replace('  Put the tests\n  back.', '  Put the\ntests back. '));
  // Only spaces, tabs and line ends are where a line wraps: a character a reader does not see is a difference.
  assertRed(README.replace('  Put the tests\n  back.', '  Put the\uFEFFtests back.'), /: U\+FEFF, a character that is no plain space or does not show[^]*\nthe scene: the gate's reply/);
  assertRed(README.replace('  Put the tests\n  back.', '  Put the\u00A0tests back.'), /: U\+00A0, a character that is no plain space or does not show[^]*\nthe scene: the gate's reply/);
  // A line breaks at a space: a word broken in two is two words.
  assertRed(README.replace('  Put the tests\n  back.', '  Put the te\n  sts back.'), /^the scene: /);
  assertRed(README.replace('Stop hook error: ', 'Stop hook said: '), /^the scene: 0 code blocks hold "Stop hook error:", not 1/);
  assertRed(README.replace('/plugin install greenwashing@greenwashing', '/plugin install greenwashing@greenwashing\nStop hook error: x'), /^the scene: 2 code blocks hold/);
  assertRed(README, /^the scene: the gate does not stop fake-deleted-test-js in this run \(green\)/, run({ 'fake-deleted-test-js': ['green', 'green'] }));
  assert.match(check(README, run({ replies: { 'fake-deleted-test-js': null } }), CATALOG).notRun.join('\n'), /^the scene: this run has no reply of the gate on fake-deleted-test-js/);
  // A number in the lines around the reply is no number of the run; the frame's own line is Claude Code's.
  assertRed(README.replace('✅ All tests pass.', '✅ All 48 tests pass.'), /: a number no bench run gives: ● Done\. ✅ All 48 tests pass\./);
  assertRed(README.replace('● Ran 1 stop hook', '● Ran 2 stop hooks'), /: a number no bench run gives: ● Ran 2 stop hooks/);
  assertRed(`${README}\n\`\`\`\nnever closed\n`, /: a code block that is never closed/);
});

test('the table: each row is its case, its plain run the tests-only outcome and its reason a line of the gate\'s reply', () => {
  assertRed(README, /^the table, fake-skip-js: "Plain test run" says "✅ green", this run "❌ red"/, run({ 'fake-skip-js': ['red'] }));
  assert.match(check(README, run({ 'fake-skip-js': ['did not run'] }), CATALOG).notRun.join('\n'), /^the table, fake-skip-js: the tests-only column did not run/);
  assertRed(README, /^the table, fake-no-assertion-js: the gate does not stop it in this run \(green\)/, run({ 'fake-no-assertion-js': ['green', 'green'] }));
  // A gate that did not run is no catch, also with a reply.
  assertRed(README, /^the table, fake-no-assertion-js: the gate does not stop it in this run \(did not run\)/, run({ 'fake-no-assertion-js': ['green', 'did not run'] }));
  assertRed(README.replace('the test does not run ([GW-17]', 'the test is skipped ([GW-17]'), /^the table, fake-skip-js: "todo\.test\.js:9: test\.skip - the test is skipped \(GW-17\)" is not a finding or result line/);
  assertRed(README.replace('| ✅ green | ❌ did not run', '| ✅ green | did not run'), /^the table, fake-dummy-command-js: /);
  // Only the gate's findings and result, each without its "- " or "Result: ", and not the test output it quotes.
  for (const reason of ['no test counts in the output', 'Result: did not run - no test counts in the output', 'all tests passed', '- all tests passed',
    'greenwashing gate: the tests did not run - you cannot finish yet.', '', '[](CATALOG.md)', '![did not run - no test counts in the output](x.svg)']) {
    assertRed(README.replace('❌ did not run - no test counts in the output |', `❌ ${reason} |`), /^the table, fake-dummy-command-js: /);
  }
  // The rows go in the order of the cases, each with its own text, under the header, three cells each.
  assertRed(README.replace(`${SKIP_ROW}\n${NONE_ROW}`, `${NONE_ROW}\n${SKIP_ROW}`), /^the table, fake-skip-js: /);
  assertRed(README.replace('| Marked the failing test `skip` |', '| Wrote a test that checks nothing |'), /^the table, fake-skip-js: its row says "Wrote a test that checks nothing"/);
  assertRed(README.replace('| What the agent did | Plain test run | greenwashing |', '| What the agent did | greenwashing | Plain test run |'), /^the table: its header is /);
  assertRed(README.replace('|---|---|---|\n', ''), /^the table: no delimiter row of 3 cells/);
  assertRed(README.replace('|---|---|---|\n', '|---|---|\n'), /^the table: no delimiter row of 3 cells/);
  assertRed(README.replace(DUMMY_ROW, `${DUMMY_ROW} 3 runs |`), /^the table, fake-dummy-command-js: 4 cells, not 3/);
  assertRed(README.replace(`${SKIP_ROW}\n`, ''), /^the table: 2 rows of cases, not 3/);
  assertRed(after(DUMMY_ROW, '| Deleted the test file | ✅ green | ❌ caught |'), /^the table: 4 rows of cases, not 3/);
  // GitHub reads a line with no outer pipes right after a row as a row too.
  assertRed(after(DUMMY_ROW, 'Deleted the test file | ✅ green | ❌ caught'), /^the table: 4 rows of cases, not 3/);
  assertRed(README.replace(`${DUMMY_ROW}\n`, `\`\`\`\n${DUMMY_ROW}\n\`\`\`\n`), /^the table: 2 rows of cases, not 3/);
  assertRed(README.replace('## What else it catches', '## What it catches'), /^the table: no section "## What else it catches"/);
  assertRed(after(DUMMY_ROW, '\n| a | b |\n|---|---|\n| c | d |'), /^the table: 2 tables in "What else it catches", not 1/);
  assert.match(check(README, run({ replies: { 'fake-skip-js': null } }), CATALOG).notRun.join('\n'), /^the table: this run has no outcome or no reply of the gate on fake-skip-js/);
  // A finding line with nothing after its start is no reason to show.
  assertRed(README.replace('❌ did not run - no test counts in the output |', '❌ [](CATALOG.md) |'), /^the table, fake-dummy-command-js: /,
    run({ replies: { 'fake-dummy-command-js': `${REPLIES['fake-dummy-command-js'].split('\n')[0]}\n- \nResult: did not run - no test counts in the output` } }));
  assert.deepEqual(cells('| a | b \\| c | d |'), ['a', 'b | c', 'd']);
});

test('the numbers: the run\'s summary table as it is, and no other number anywhere but catalog entries and the oldest Node', () => {
  const allFakes = '| All fakes (4) | 0 of 4 caught | 4 of 4 caught | 4 of 4 caught |';
  assertRed(README.replace(allFakes, allFakes.replace('| 4 of 4 caught | 4 of 4', '| 3 of 4 caught | 4 of 4')), /^the numbers: the table in "Numbers" is not this run's summary table: \| All fakes \(4\) \| 0 of 4 caught \| 3 of 4 caught/);
  assertRed(README.replace(`${allFakes}\n`, ''), /^the numbers: /);
  assertRed(README.replace('\n| Honest twins (4) | 0 false alarms in 4 | 0 false alarms in 4 | 1 false alarm in 4 |', ''), /^the numbers: /);
  assertRed(README.replace(`${allFakes}\n`, `${allFakes}\n| Honest (2) | 0 | 0 | 0 |\n`), /^the numbers: /);
  assertRed(README.replace(`${allFakes}\n`, `${allFakes}\nFakes in real projects | all caught | all caught | all caught |\n`), /^the numbers: /);
  assertRed(README.replace('Run it with', '| Real projects | all |\n|---|---|\n\nRun it with'), /^the numbers: 2 tables in "Numbers", not 1/);
  assertRed(README.replace(SUMMARY, `\`\`\`\n${SUMMARY}\n\`\`\``), /^the numbers: 0 tables in "Numbers", not 1/);
  assertRed(README.replace('## Numbers', '## Figures'), /^the numbers: no section "## Numbers"/);
  for (const resultsMd of ['# Benchmark\n', `# Benchmark\n\n## Summary\n\n${SUMMARY.split('\n').slice(0, 2).join('\n')}\n`]) {
    assert.match(check(README, run({ resultsMd }), CATALOG).notRun.join('\n'), /^the numbers: no summary table in this run's RESULTS\.md/);
  }
  assertRed(README.replace('Every fake has a twin.', 'Every one of 32 fakes has a twin.'), /^line \d+: a number no bench run gives: Every one of 32 fakes/);
  assertRed(README.replace('Every fake has a twin.', 'Every one of ３２ fakes has a twin².'), /: a number no bench run gives: Every one of ３２/);
  assertRed(README.replace('Node 20+', 'Node 22+'), /: a number no bench run gives: - \*\*Node 22\+\*\* on PATH\./);
  assertRed(README.replace('Node 20+', 'Node 20'), /: a number no bench run gives: - \*\*Node 20\*\* on PATH\./);
  assertRed(README.replace('Node 20+', 'MyNode 20+'), /: a number no bench run gives: - \*\*MyNode 20\+\*\* on PATH\./);
  assertRed(README.replace('/plugin install greenwashing@greenwashing', '/greenwashing:mutants --timeout 900'), /: a number no bench run gives: \/greenwashing:mutants --timeout 900/);
  assertRed(README.replace('| Marked the failing test `skip` |', '| Marked 2 failing tests `skip` |'), /: a number no bench run gives: \| Marked 2 failing/);
  assertRed(README.replace('## Where it works', '## Where it works in 2026'), /: a number no bench run gives: ## Where it works in 2026/);
  assertRed(README.replace('[GW-01](CATALOG.md#gw-01-self-referential-assertion)', '[GW-01](https://example.com/v2)'), /a number no bench run gives: - Not \[GW-01\]\(https:\/\/example\.com\/v2\)/);
});

test('images: the license badge, once and alone', () => {
  assertRed(README.replace('(LICENSE)\n', '(LICENSE) ![caught](https://img.shields.io/badge/caught-all-green)\n'), /: an image other than the license badge: /);
  assertRed(README.replace('It runs them itself.', '![demo](demo.gif)'), /: an image other than the license badge: !\[demo\]/);
  assertRed(README.replace('[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)\n', ''), /^the license badge: not once on a line of its own/);
  assertRed(README.replace('license-MIT-blue', 'license-MIT-2026-blue'), /: a number no bench run gives: \[!\[License: MIT\]/);
});

test('catalog links: every GW-NN outside code links to its entry\'s heading', () => {
  assertRed(README.replace('#gw-01-self-referential-assertion', '#gw-01-self-referential'), /^line \d+: GW-01 links to CATALOG\.md#gw-01-self-referential, not CATALOG\.md#gw-01-self-referential-assertion/);
  assertRed(README.replace('(CATALOG.md#gw-01-self-referential-assertion)', '(README.md#gw-01-self-referential-assertion)'), /\bline \d+: GW-01 links to README\.md#/);
  assertRed(README.replace('[GW-01](CATALOG.md#gw-01-self-referential-assertion)', '[GW-02](CATALOG.md#gw-02-x)'), /^line \d+: GW-02 is no entry of CATALOG\.md/);
  assertRed(README.replace('[GW-01](CATALOG.md#gw-01-self-referential-assertion)', 'GW-01'), /^line \d+: a catalog entry that is no link to it: - Not GW-01/);
  assertRed(README.replace('([GW-17](CATALOG.md#gw-17-a-skip-that-buys-green))', '(GW-17)'), /^line \d+: a catalog entry that is no link to it: \| Marked the failing test/);
  assertRed(README.replace('[GW-01](CATALOG.md#gw-01-self-referential-assertion)', 'GW-０１'), /a catalog entry that is no link to it: - Not GW-０１/);
  assertRed(README.replace('[GW-01](CATALOG.md#gw-01-self-referential-assertion)', '`GW-01`'), /a catalog entry that is no link to it: - Not `GW-01`/);
  assert.equal(slug('GW-08 "0 of 0 problems"'), 'gw-08-0-of-0-problems');
  assert.equal(slug('GW-62 "Passes locally, three times"'), 'gw-62-passes-locally-three-times');
  assert.equal(slug('GW-41 The expected_value fitted'), 'gw-41-the-expected_value-fitted');
});

test('Markdown the check cannot read as GitHub shows it is red: HTML, other fences, indented lines, a | outside the tables, a section twice', () => {
  const close = "  back.\n```\n";
  assertRed(README.replace(close, `${close}<!-- -->\n`), /: HTML, which this check does not read: <!-- -->/);
  assertRed(README.replace('```\n> Make search', '<!--\n```\n> Make search').replace(close, `${close}-->\n`), /: HTML, which this check does not read: <!--/);
  assertRed(README.replace('**Node 20+** on PATH.', '<img src="numbers.png"> **Node 20+** on PATH.'), /: HTML, which this check does not read: /);
  assertRed(README.replace('Every fake has a twin.', '<details>\n\nEvery fake has a twin.\n\n</details>'), /: HTML, which this check does not read: <details>/);
  assertGreen(README.replace('Every fake has a twin.', 'Every fake has a twin, `<b>` in code included.'));
  // A line inside the scene that opens another fence, a fence of tildes, a fence with an info string.
  assertRed(README.replace(close, '  back.\n```text\n● Turn accepted.\n```\n``` ```\n'), /: a code fence other than a bare ```: ```text/);
  assertRed(README.replace('```\n/plugin install greenwashing@greenwashing\n```', '~~~\n/plugin install greenwashing@greenwashing\n~~~'), /: a code fence other than a bare ```: ~~~/);
  assertRed(README.replace('```\n> Make search', '```math\n> Make search'), /: a code fence other than a bare ```: ```math/);
  assertRed(README.replace('It runs them itself.', 'It runs them itself.\n\n    Stop hook error: an indented scene'), /: an indented line, which GitHub can show as code: /);
  assertGreen(README.replace('It runs them itself.', 'It runs them itself.\n    \nAnd more.'));
  // GitHub reads a table with no outer pipes too.
  assertRed(README.replace('\n## Numbers', '\nRewrote the expected value | ✅ green | ❌ caught\n--- | --- | ---\n\n## Numbers'), /: a \| outside the tables, which GitHub can show as a table row: Rewrote/);
  assertGreen(README.replace('Every fake has a twin.', 'Every fake has a twin, `a | b` in code included, and an escaped \\| too.'));
  assertRed(README.replace('## Where it works', '## Numbers\n\n| All fakes (4) | all caught |\n|---|---|\n\n## Where it works'), /the section "## Numbers" is there twice/);
  // A level 1 heading ends a section, and a line of spaces ends a table, as on GitHub.
  assertGreen(README.replace('## Where it works', '# Appendix\n\n| a | b |\n|---|---|\n\n## Where it works'));
  assertGreen(README.replace(`${SUMMARY}\n`, `${SUMMARY}\n  \n`));
});

test('the scene\'s frame and other links: no text before the label, links only to entries, the badge as it is', () => {
  assertRed(README.replace('  ⎿  Stop hook error: ', '  ⎿  (32 of 32 caught) Stop hook error: '), /^the scene: the line of "Stop hook error:" has "  ⎿  \(32 of 32 caught\) " before it, not the frame's ⎿/);
  assertRed(README.replace('  ⎿  Stop hook error: ', '  Stop hook error: '), /^the scene: the line of "Stop hook error:" has "  " before it/);
  // A number in the reply itself is the run's.
  const counted = SCENE_REPLY.replace('this turn removed tests', 'this turn removed 1 test');
  assertGreen(README.replace('this turn removed tests', 'this turn removed 1 test'), run({ replies: { 'fake-deleted-test-js': counted } }));
  // A reason cell reads only catalog links: any other link stays as it is shown.
  assertRed(README.replace('❌ todo.test.js:9: test.skip', '❌ [todo.test.js:9:](all 32 fakes caught) test.skip'), /^the table, fake-skip-js: /);
  assertRed(README.replace('([GW-17](CATALOG.md#gw-17-a-skip-that-buys-green))', '([[GW-17](CATALOG.md#gw-17-a-skip-that-buys-green)](32-of-32-caught))'), /^the table, fake-skip-js: /);
  // (CATALOG.md#...) is a link's target only right after its text.
  assertRed(README.replace('Run it with `node bench/run`.', 'Run it with `node bench/run` (CATALOG.md#all-32-fakes-caught).'), /: a number no bench run gives: Run it with/);
  assertGreen(README.replace('**Node 20+** on PATH', '_Node 20+_ on PATH'));
  assertRed(README.replace('license-MIT-blue.svg', 'dynamic/json?url=https://example.com/n.json'), /: an image other than the license badge: /);
  assertRed(README.replace('[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)\n',
    '[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)\n\n[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)\n'), /^the license badge: not once on a line of its own/);
});

test('a run without what the README shows did not run; a gate that did not run is no catch', () => {
  const without = run();
  without.results.cases = without.results.cases.filter((c) => c.id !== 'fake-deleted-test-js');
  assert.match(check(README, without, CATALOG).notRun.join('\n'), /^the scene: this run has no reply of the gate on fake-deleted-test-js/);
  assertRed(README, /^the scene: the gate does not stop fake-deleted-test-js in this run \(did not run\)/, run({ 'fake-deleted-test-js': ['green', 'did not run'] }));
  const odd = run();
  odd.results.cases.find((c) => c.id === 'fake-skip-js').gate = {};
  assert.match(check(README, odd, CATALOG).notRun.join('\n'), /^the table: this run has no outcome or no reply of the gate on fake-skip-js/);
  assert.deepEqual(problemsOf(README, odd), []);
  assert.match(check(README, run({ 'fake-skip-js': ['constructor'] }), CATALOG).notRun.join('\n'), /^the table, fake-skip-js: the tests-only column did not run/);
  // A summary heading with no table under it: the next section's table is not the summary.
  assert.match(check(README, run({ resultsMd: '# Benchmark\n\n## Summary\n\nNone.\n\n## Cases\n\n| a | b |\n| --- | --- |\n| c | d |\n' }), CATALOG).notRun.join('\n'),
    /^the numbers: no summary table in this run's RESULTS\.md/);
  // The header with spaces after it is the header; a delimiter of empty cells is none.
  assertGreen(README.replace('| What the agent did | Plain test run | greenwashing |', '| What the agent did | Plain test run | greenwashing |  '));
  assertRed(README.replace('|---|---|---|', '| | | |'), /^the table: no delimiter row of 3 cells/);
});

test('what GitHub reads another way is red: a lone CR, a character that does not show, a heading or entity it hides, the frame outside the scene', () => {
  const close = "  back.\n```\n";
  const done = '● Done. ✅ All tests pass.\n';
  // Markdown ends a line at a lone CR too: a fence and a comment that hide the reply, a row split in two.
  assertRed(README.replace(done, `${done.trim()}\r\`\`\`\r<!--\n`).replace(close, `${close}-->\n\`\`\`\n● Ran one stop hook\n  ⎿  greenwashing: all tests passed.\n\`\`\`\n`), /: HTML, which this check does not read: <!--/);
  assertRed(README.replace(SKIP_ROW, SKIP_ROW.replace('✅ green | ❌', '✅ green |\r ❌')), /^the table/);
  assertRed(README.replace('/plugin install greenwashing@greenwashing\n```', '/plugin install greenwashing@greenwashing\r```\r<!--\n```').replace('Every fake has a twin.', '-->\n\nEvery fake is caught.'), /: HTML, which this check does not read/);
  // The gate's frame where no run checks it: in a quote, or in another block with a space that is no space.
  assertRed(README.replace('It runs them itself.', '> ⎿  Stop hook error: greenwashing: all tests passed.'), /: the gate's frame outside the scene, where no run checks it: > ⎿/);
  assertRed(README.replace('It runs them itself.', '> ⎿  greenwashing: all tests passed.'), /: the gate's frame outside the scene, where no run checks it: > ⎿  greenwashing/);
  assertRed(README.replace('/plugin install greenwashing@greenwashing', '⎿  Stop hook error:\u00A0all good\n/plugin install greenwashing@greenwashing'), /: U\+00A0, a character that is no plain space or does not show/);
  assertRed(README.replace('It runs them itself.', 'It runs\u200Bthem itself.'), /: U\+200B, a character that is no plain space or does not show/);
  assertRed(README.replace(`${SUMMARY}\n`, `${SUMMARY}\n\u00A0\nEvery fake is caught.\n`), /: U\+00A0, a character/);
  // Fences, indents, headings and entities the check does not read.
  assertRed(README.replace(close, '  back.\n  ```\n<!--\n```\n'), /: a code fence other than a bare ```:/);
  assertRed(README.replace('It runs them itself.', '</details>'), /: HTML, which this check does not read: <\/details>/);
  assertRed(README.replace('It runs them itself.', 'It runs them itself.\n\n\tcode'), /: an indented line, which GitHub can show as code: code/);
  assertRed(README.replace('It runs them itself.', 'It runs \\`<!-- -->\\` itself.'), /: HTML, which this check does not read: /);
  for (const heading of ['Not caught any more\n---', 'Not caught any more\n===', '  ## Not caught any more', '##\tNot caught any more', '***']) {
    assertRed(README.replace('It runs them itself.', `It runs them itself.\n\n${heading}`), /: a (?:heading this check does not read|line of = or -)/);
  }
  assertRed(README.replace('It runs them itself.', 'It runs &half; of them itself.'), /: an HTML entity, which this check does not read: /);
  assertRed(README.replace('It runs them itself.', 'It runs &#xBE; of them itself.'), /: an HTML entity, which this check does not read: /);
  // The badge counts only where GitHub shows it: not in a code block.
  assertRed(README.replace('[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)\n', '```\n[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)\n```\n'), /^the license badge: not once on a line of its own/);
  // The oldest Node the README may name is the gate's.
  assert.match(check(README, run(), CATALOG, 22).problems.join('\n'), /: a number no bench run gives: - \*\*Node 20\+\*\* on PATH\./);
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
  // The command itself, on the real README: exit 2 with no run, 1 with this small run, which it is not.
  const cli = (where) => spawnSync(process.execPath, [path.join(ROOT, 'bench', 'readme'), where], { encoding: 'utf8' });
  assert.equal(cli(path.join(root, 'none')).status, 2);
  const differs = cli(folder);
  assert.equal(differs.status, 1, differs.stdout);
  assert.match(differs.stdout, /^README check: failed - the README is not what this bench run gave\n/);
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
