'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { verdict, decide, blockReason } = require('../lib/verdict');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', `${name}.txt`), 'utf8');
const run = (fields) => ({ command: 'npm test', source: 'package.json scripts.test', timeoutSeconds: 600, exitCode: 0, output: '', ...fields });
const brief = (result) => [result.outcome, result.gw];

// Exit codes are the ones the real runs returned.
const REAL = {
  'pytest-mixed': [1, 'failed', null],
  'pytest-green': [0, 'passed', null],
  'pytest-zero': [5, 'did not run', 'GW-08'],
  'pytest-collection-error': [2, 'failed', null],
  'unittest-mixed': [1, 'failed', null],
  'unittest-green': [0, 'passed', null],
  'unittest-zero-py311': [0, 'did not run', 'GW-08'],
  'unittest-zero-py312': [5, 'did not run', 'GW-08'],
  'jest-mixed': [1, 'failed', null],
  'jest-green': [0, 'passed', null],
  'jest-no-tests': [1, 'did not run', 'GW-50'],
  'jest-broken-suite': [1, 'did not run', 'GW-50'],
  'vitest-mixed': [1, 'failed', null],
  'vitest-green': [0, 'passed', null],
  'vitest-no-tests': [1, 'did not run', 'GW-50'],
  'vitest-broken-file': [1, 'did not run', 'GW-50'],
  'node20-tap-mixed': [1, 'failed', null],
  'node22-tap-green': [0, 'passed', null],
  'node22-tap-zero': [0, 'did not run', 'GW-08'],
  'node22-spec-mixed': [1, 'failed', null],
};

for (const [name, [exitCode, outcome, gw]] of Object.entries(REAL)) {
  test(`real run: ${name} -> ${outcome}`, () => {
    assert.deepEqual(brief(verdict(run({ exitCode, output: fixture(name) }))), [outcome, gw]);
  });
}

test('tests that failed are red even when the command exits 0', () => {
  assert.deepEqual(brief(verdict(run({ exitCode: 0, output: fixture('pytest-mixed') }))), ['failed', null]);
});

test('a command that only prints "ok" did not run', () => {
  const result = verdict(run({ exitCode: 0, output: 'ok\n' }));
  assert.deepEqual(brief(result), ['did not run', 'GW-50']);
  assert.match(result.why, /no test counts/);
});

test('a command that was not found did not run', () => {
  const result = verdict(run({ exitCode: 127, output: 'sh: 1: nosuchrunner: not found\n' }));
  assert.deepEqual(brief(result), ['did not run', 'GW-50']);
  assert.match(result.why, /not found \(exit code 127\)/);
});

test('a command that could not start did not run', () => {
  const result = verdict(run({ startError: 'spawn sh ENOENT', exitCode: null }));
  assert.deepEqual(brief(result), ['did not run', 'GW-50']);
  assert.match(result.why, /could not start: spawn sh ENOENT/);
});

test('a config error or an output too large to read did not run', () => {
  const config = verdict(run({ configError: 'no test command found; add it', exitCode: null }));
  assert.deepEqual([config.outcome, config.why, config.gw], ['did not run', 'no test command found; add it', 'GW-50']);
  const large = verdict(run({ outputTooLarge: 64, output: fixture('unittest-green') }));
  assert.deepEqual([large.outcome, large.gw], ['did not run', 'GW-50']);
  assert.match(large.why, /larger than 64 bytes and was not read/);
});

test('a timeout did not run, even with green counts printed before it', () => {
  const result = verdict(run({ timedOut: true, timeoutSeconds: 7, exitCode: null, output: fixture('unittest-green') }));
  assert.deepEqual(brief(result), ['did not run', 'GW-50']);
  assert.match(result.why, /did not finish in 7 s/);
});

test('zero tests ran in one of two runs: did not run', () => {
  const result = verdict(run({ output: `${fixture('unittest-green')}\n${fixture('node22-tap-zero')}` }));
  assert.deepEqual(brief(result), ['did not run', 'GW-08']);
  assert.match(result.why, /zero tests ran \(node --test\)/);
});

test('only skipped tests: zero tests ran', () => {
  assert.deepEqual(brief(verdict(run({ output: 'Ran 3 tests in 0.1s\n\nOK (skipped=3)\n' }))), ['did not run', 'GW-08']);
});

test('a non-zero exit with no failed test did not run', () => {
  const result = verdict(run({ exitCode: 3, output: fixture('unittest-green') }));
  assert.deepEqual(brief(result), ['did not run', 'GW-50']);
  assert.match(result.why, /exited with code 3 although no test failed/);
});

test('green: counts of every run are added up', () => {
  const result = verdict(run({ output: `${fixture('unittest-green')}\n${fixture('node22-tap-green')}` }));
  assert.equal(result.outcome, 'passed');
  assert.deepEqual(result.counts, { passed: 4, failed: 0, skipped: 0, brokenFiles: 0 });
});

const RED = { outcome: 'did not run', why: 'zero tests ran (jest)', gw: 'GW-08', counts: { passed: 0, failed: 0, skipped: 0, brokenFiles: 0 } };
const GREEN = { outcome: 'passed', why: '', gw: null, counts: { passed: 5, failed: 0, skipped: 1, brokenFiles: 0 } };

test('green lets the agent stop with one line for the user', () => {
  const decision = decide(run({}), GREEN, { blocks: 2 }, true);
  assert.equal(decision.action, 'allow');
  assert.equal(decision.message, 'greenwashing: tests passed - npm test: 5 passed, 0 failed, 1 skipped');
  assert.deepEqual(decision.state, { blocks: 0 });
});

test('red sends the agent back and counts the block', () => {
  assert.deepEqual([decide(run({}), RED, { blocks: 0 }, false).action, decide(run({}), RED, { blocks: 0 }, false).state], ['block', { blocks: 1 }]);
  assert.deepEqual(decide(run({}), RED, { blocks: 1 }, true).state, { blocks: 2 });
  assert.deepEqual(decide(run({}), RED, { blocks: 2 }, true).state, { blocks: 3 });
});

test('the fourth red stop after three blocks in a row is let go with a red message', () => {
  const decision = decide(run({}), RED, { blocks: 3 }, true);
  assert.equal(decision.action, 'release');
  assert.match(decision.message, /TESTS DID NOT PASS - WORK NOT ACCEPTED/);
  assert.match(decision.message, /3 times in a row/);
  assert.deepEqual(decision.state, { blocks: 0 });
});

test('a stop that is not continuing after a block starts the count again', () => {
  const decision = decide(run({}), RED, { blocks: 3 }, false);
  assert.deepEqual([decision.action, decision.state], ['block', { blocks: 1 }]);
});

test('the block reason names the command, the result, the counts, the catalog entry and the last 20 lines', () => {
  const output = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`).join('\n');
  const reason = blockReason(run({ output }), RED);
  assert.match(reason, /Command: npm test \(package\.json scripts\.test\)/);
  assert.match(reason, /Result: did not run - zero tests ran \(jest\)/);
  assert.match(reason, /Counts: 0 passed, 0 failed, 0 skipped/);
  assert.match(reason, /See GW-08 in https:\/\/github\.com\/brshvdk\/greenwashing\/blob\/main\/CATALOG\.md/);
  assert.match(reason, /line 6\nline 7/);
  assert.match(reason, /line 25$/);
  assert.doesNotMatch(reason, /line 5\n/);
});

test('failed tests name no catalog entry; did not run names GW-50', () => {
  const failed = { outcome: 'failed', why: '1 failed', gw: null, counts: { passed: 1, failed: 1, skipped: 0, brokenFiles: 0 } };
  assert.doesNotMatch(blockReason(run({ output: 'x' }), failed), /See GW-/);
  const notRun = verdict(run({ output: 'ok' }));
  assert.match(blockReason(run({ output: 'ok' }), notRun), /See GW-50 in /);
});

test('the catalog entries the gate cites exist in CATALOG.md', () => {
  const catalog = fs.readFileSync(path.join(__dirname, '..', '..', 'CATALOG.md'), 'utf8');
  const cited = new Set();
  for (const result of [verdict(run({ output: 'ok' })), verdict(run({ output: fixture('node22-tap-zero') }))]) cited.add(result.gw);
  assert.deepEqual([...cited].sort(), ['GW-08', 'GW-50']);
  for (const id of cited) assert.match(catalog, new RegExp(`^### ${id} `, 'm'), id);
});
