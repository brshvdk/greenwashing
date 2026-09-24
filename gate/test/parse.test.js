'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseSummaries } = require('../lib/parse');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', `${name}.txt`), 'utf8');
const counts = (list) => list.map(({ runner, passed, failed, skipped, brokenFiles, errors }) => [runner, passed, failed, skipped, brokenFiles, errors]);

// Real output of pytest 9.1.1, unittest (Python 3.11 and 3.12), jest 30.5.2, vitest 5.0.1 and
// node --test (Node 20 and 22), captured on small suites; paths replaced by /project.
// Expected: [runner, passed, failed, skipped, files that could not run, errors outside tests].
const REAL = {
  'pytest-mixed': [['pytest', 2, 2, 1, 0, 0]],
  'pytest-green': [['pytest', 2, 0, 0, 0, 0]],
  'pytest-quiet-green': [['pytest', 2, 0, 0, 0, 0]],
  'pytest-zero': [['pytest', 0, 0, 0, 0, 0]],
  'pytest-collection-error': [['pytest', 0, 1, 0, 0, 0]],
  'pytest-subtests-quiet': [['pytest', 1, 2, 0, 0, 0]],
  'pytest-one-warning': [['pytest', 1, 0, 0, 0, 0]],
  'pytest-rerun': [['pytest', 1, 1, 0, 0, 0]],
  'unittest-mixed': [['unittest', 2, 2, 1, 0, 0]],
  'unittest-green': [['unittest', 2, 0, 0, 0, 0]],
  'unittest-zero-py311': [['unittest', 0, 0, 0, 0, 0]],
  'unittest-zero-py312': [['unittest', 0, 0, 0, 0, 0]],
  'unittest-import-error': [['unittest', 0, 1, 0, 0, 0]],
  'jest-mixed': [['jest', 2, 2, 1, 0, 0]],
  'jest-green': [['jest', 2, 0, 0, 0, 0]],
  'jest-no-tests': [['jest', 0, 0, 0, 0, 0]],
  'jest-pass-with-no-tests': [['jest', 0, 0, 0, 0, 0]],
  'jest-broken-suite': [['jest', 2, 0, 0, 1, 0]],
  'vitest-mixed': [['vitest', 2, 2, 1, 0, 0]],
  'vitest-green': [['vitest', 2, 0, 0, 0, 0]],
  'vitest-mixed-color': [['vitest', 2, 2, 1, 0, 0]],
  'vitest-no-tests': [['vitest', 0, 0, 0, 0, 0]],
  'vitest-pass-with-no-tests': [['vitest', 0, 0, 0, 0, 0]],
  'vitest-unhandled-error': [['vitest', 1, 0, 0, 0, 1]],
  'vitest-expected-fail': [['vitest', 1, 0, 1, 0, 0]],
  'vitest-broken-file': [['vitest', 2, 0, 0, 1, 0]],
  'node20-tap-mixed': [['node --test', 2, 2, 2, 0, 0]],
  'node22-tap-green': [['node --test', 2, 0, 0, 0, 0]],
  'node22-tap-zero': [['node --test', 0, 0, 0, 0, 0]],
  'node22-spec-mixed': [['node --test', 2, 2, 2, 0, 0]],
  'node22-spec-mixed-color': [['node --test', 2, 2, 2, 0, 0]],
};

for (const [name, expected] of Object.entries(REAL)) {
  test(`real output: ${name}`, () => {
    assert.deepEqual(counts(parseSummaries(fixture(name))), expected);
  });
}

test('output with no summary gives nothing', () => {
  for (const text of ['', 'ok', 'OK', 'all tests passed', 'PASS', '5 passed', 'Tests: 5 passed']) {
    assert.deepEqual(parseSummaries(text), [], text);
  }
});

test('unittest: every detail of the status line counts', () => {
  const text = 'Ran 10 tests in 0.5s\n\nFAILED (failures=1, errors=2, skipped=1, expected failures=1, unexpected successes=1)\n';
  assert.deepEqual(counts(parseSummaries(text)), [['unittest', 4, 4, 2, 0, 0]]);
  assert.deepEqual(counts(parseSummaries('Ran 3 tests in 0.1s\n\nOK (skipped=2)\n')), [['unittest', 1, 0, 2, 0, 0]]);
  assert.deepEqual(counts(parseSummaries('Ran 1 test in 0.000s\n\nOK\n')), [['unittest', 1, 0, 0, 0, 0]]);
});

test('unittest: a "Ran N tests" line without its status line is not a summary', () => {
  assert.deepEqual(parseSummaries('Ran 5 tests in 0.1s\n'), []);
  assert.deepEqual(parseSummaries('Ran 5 tests in 0.1s\n\nok\n'), []);
  assert.deepEqual(parseSummaries('Ran 5 tests in 0.1s\n\nOK (bananas=2)\n'), []);
  assert.deepEqual(parseSummaries('Ran 5 tests in 0.1s\n\nFAILED\n'), []);
});

test('pytest: every outcome word counts in its place', () => {
  const text = '==== 1 failed, 1 passed, 1 xfailed, 1 xpassed, 2 warnings, 1 error, 1 skipped in 0.50s ====';
  assert.deepEqual(counts(parseSummaries(text)), [['pytest', 2, 2, 2, 0, 0]]);
  assert.deepEqual(counts(parseSummaries('3 errors in 0.1s')), [['pytest', 0, 3, 0, 0, 0]]);
  assert.deepEqual(counts(parseSummaries('5 deselected in 0.01s')), [['pytest', 0, 0, 0, 0, 0]]);
  assert.deepEqual(counts(parseSummaries('=== 4 passed in 61.02s (0:01:01) ===')), [['pytest', 4, 0, 0, 0, 0]]);
});

test('pytest: an unknown word or a half frame is not a summary', () => {
  assert.deepEqual(parseSummaries('2 passed, 1 bananas in 0.1s'), []);
  assert.deepEqual(parseSummaries('=== 2 passed in 0.1s'), []);
  assert.deepEqual(parseSummaries('2 passed in 0.1s ==='), []);
});

test('jest: todo counts as skipped, an empty run as zero', () => {
  assert.deepEqual(counts(parseSummaries('Tests:       1 todo, 2 passed, 3 total')), [['jest', 2, 0, 1, 0, 0]]);
  assert.deepEqual(counts(parseSummaries('Tests:       0 total')), [['jest', 0, 0, 0, 0, 0]]);
});

test('vitest: todo counts as skipped', () => {
  assert.deepEqual(counts(parseSummaries('      Tests  1 passed | 1 todo (2)')), [['vitest', 1, 0, 1, 0, 0]]);
});

test('node --test: cancelled counts as failed, todo as skipped', () => {
  const block = ['# tests 5', '# suites 0', '# pass 1', '# fail 1', '# cancelled 1', '# skipped 1', '# todo 1'];
  assert.deepEqual(counts(parseSummaries(block.join('\n'))), [['node --test', 1, 2, 2, 0, 0]]);
});

test('node --test: an incomplete or inconsistent block is not a summary', () => {
  assert.deepEqual(parseSummaries('# tests 5\n# pass 5\n'), []);
  const wrongTotal = ['ℹ tests 9', 'ℹ suites 0', 'ℹ pass 1', 'ℹ fail 0', 'ℹ cancelled 0', 'ℹ skipped 0', 'ℹ todo 0'];
  assert.deepEqual(parseSummaries(wrongTotal.join('\n')), []);
});

test('several runs in one output give one summary each, in order', () => {
  const text = `${fixture('unittest-green')}\n${fixture('node22-tap-green')}`;
  assert.deepEqual(counts(parseSummaries(text)), [['unittest', 2, 0, 0, 0, 0], ['node --test', 2, 0, 0, 0, 0]]);
});

test('spaces at the end of a summary line do not hide it', () => {
  assert.deepEqual(counts(parseSummaries('Ran 2 tests in 0.1s   \n\nOK  \n')), [['unittest', 2, 0, 0, 0, 0]]);
  assert.deepEqual(counts(parseSummaries('2 passed in 0.10s \t')), [['pytest', 2, 0, 0, 0, 0]]);
});

test('CRLF and CR line endings are read like LF', () => {
  assert.deepEqual(counts(parseSummaries('Ran 2 tests in 0.1s\r\n\r\nOK\r\n')), [['unittest', 2, 0, 0, 0, 0]]);
  assert.deepEqual(counts(parseSummaries('Ran 2 tests in 0.1s\r\rOK\r')), [['unittest', 2, 0, 0, 0, 0]]);
});
