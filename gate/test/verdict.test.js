'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  verdict, decide, blockReason, removedNote,
} = require('../lib/verdict');
const { CHECKS } = require('../lib/command');

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
  'jest-no-tests': [1, 'did not run', 'GW-08'],
  'jest-pass-with-no-tests': [0, 'did not run', 'GW-08'],
  'jest-broken-suite': [1, 'did not run', 'GW-50'],
  'vitest-mixed': [1, 'failed', null],
  'vitest-green': [0, 'passed', null],
  'vitest-no-tests': [1, 'did not run', 'GW-08'],
  'vitest-pass-with-no-tests': [0, 'did not run', 'GW-08'],
  'vitest-unhandled-error': [1, 'did not run', 'GW-50'],
  'vitest-expected-fail': [0, 'passed', null],
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

test('every run of several counts: zero tests or failures in the first run are not hidden by a green second', () => {
  const zeroFirst = verdict(run({ output: `${fixture('unittest-zero-py311')}\n${fixture('node22-tap-green')}` }));
  assert.deepEqual(brief(zeroFirst), ['did not run', 'GW-08']);
  const failedFirst = verdict(run({ output: `${fixture('unittest-mixed')}\n${fixture('node22-tap-green')}` }));
  assert.deepEqual(brief(failedFirst), ['failed', null]);
  const noTestsFirst = verdict(run({ output: `${fixture('jest-pass-with-no-tests')}\n${fixture('unittest-green')}` }));
  assert.deepEqual(brief(noTestsFirst), ['did not run', 'GW-08']);
  const exitWithTwo = verdict(run({ exitCode: 1, output: `${fixture('unittest-green')}\n${fixture('node22-tap-green')}` }));
  assert.deepEqual(brief(exitWithTwo), ['did not run', 'GW-50']);
});

test('an unhandled error outside the tests is red even when the command exits 0', () => {
  const result = verdict(run({ exitCode: 0, output: fixture('vitest-unhandled-error') }));
  assert.deepEqual(brief(result), ['did not run', 'GW-50']);
  assert.match(result.why, /1 error\(s\) outside the tests/);
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
  // Exit 1 with green counts: vitest after an unhandled error, jest under a coverage threshold.
  for (const exitCode of [1, 3]) {
    const result = verdict(run({ exitCode, output: fixture('unittest-green') }));
    assert.deepEqual(brief(result), ['did not run', 'GW-50']);
    assert.match(result.why, new RegExp(`exited with code ${exitCode} although no test failed`));
  }
});

test('a test file that could not run is red even when the command exits 0 (a script ending in "|| true")', () => {
  for (const name of ['jest-broken-suite', 'vitest-broken-file']) {
    const result = verdict(run({ exitCode: 0, output: fixture(name) }));
    assert.deepEqual(brief(result), ['did not run', 'GW-50'], name);
    assert.match(result.why, /1 test file\(s\) could not run/, name);
  }
});

test('green: counts of every run are added up', () => {
  const result = verdict(run({ output: `${fixture('unittest-green')}\n${fixture('node22-tap-green')}` }));
  assert.equal(result.outcome, 'passed');
  assert.deepEqual(result.counts, { passed: 4, failed: 0, skipped: 0, brokenFiles: 0, errors: 0 });
});

const RED = { outcome: 'did not run', why: 'zero tests ran (jest)', gw: 'GW-08', counts: { passed: 0, failed: 0, skipped: 0, brokenFiles: 0 } };
const GREEN = { outcome: 'passed', why: '', gw: null, counts: { passed: 5, failed: 0, skipped: 1, brokenFiles: 0 } };

test('green lets the agent stop with one line for the user', () => {
  const decision = decide([run({})], [GREEN], { blocks: 2 }, true);
  assert.equal(decision.action, 'allow');
  assert.equal(decision.message, 'greenwashing: tests passed - npm test: 5 passed, 0 failed, 1 skipped');
  assert.deepEqual(decision.state, { blocks: 0 });
});

test('red sends the agent back and counts the block', () => {
  assert.deepEqual([decide([run({})], [RED], { blocks: 0 }, false).action, decide([run({})], [RED], { blocks: 0 }, false).state], ['block', { blocks: 1 }]);
  assert.deepEqual(decide([run({})], [RED], { blocks: 1 }, true).state, { blocks: 2 });
  assert.deepEqual(decide([run({})], [RED], { blocks: 2 }, true).state, { blocks: 3 });
});

test('the fourth red stop after three blocks in a row is let go with a red message', () => {
  const decision = decide([run({})], [RED], { blocks: 3 }, true);
  assert.equal(decision.action, 'release');
  assert.match(decision.message, /TESTS DID NOT PASS - WORK NOT ACCEPTED/);
  assert.match(decision.message, /3 times in a row/);
  assert.deepEqual(decision.state, { blocks: 0 });
});

test('several runs in one stop: the first that is not green decides, and says where it ran', () => {
  const worktree = run({ where: '.claude/worktrees/feat', output: 'x' });
  const green = decide([run({}), worktree], [GREEN, GREEN], { blocks: 0 }, false);
  assert.equal(green.message, 'greenwashing: tests passed - npm test: 5 passed, 0 failed, 1 skipped; '
    + 'npm test in .claude/worktrees/feat: 5 passed, 0 failed, 1 skipped');
  const red = decide([run({}), worktree], [GREEN, RED], { blocks: 0 }, false);
  assert.equal(red.action, 'block');
  assert.match(red.reason, /\nFolder: \.claude\/worktrees\/feat\nResult: did not run - zero tests ran \(jest\)/);
  const first = decide([run({ output: 'first' }), worktree], [RED, RED], { blocks: 0 }, false);
  assert.doesNotMatch(first.reason, /Folder:/);
  assert.match(first.reason, /\nfirst$/);
  const released = decide([run({}), worktree], [GREEN, RED], { blocks: 3 }, true);
  assert.match(released.message, /\(npm test in \.claude\/worktrees\/feat\)\.$/);
});

test('a stop that is not continuing after a block starts the count again', () => {
  const decision = decide([run({})], [RED], { blocks: 3 }, false);
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

test('the block reason names the failed tests before the last lines, at most ten of them', () => {
  const failed = verdict(run({ exitCode: 1, output: fixture('pytest-mixed') }));
  const reason = blockReason(run({ exitCode: 1, output: fixture('pytest-mixed') }), failed);
  assert.match(reason, /\nFailed tests \(2\):\n- test_m\.py::T::test_c\n- test_m\.py::T::test_e\nLast 20 lines of output:\n/);
  const many = Array.from({ length: 12 }, (_, i) => `FAIL: test_${i} (m.T.test_${i})`).join('\n');
  const listed = blockReason(run({ exitCode: 1, output: `${many}\nRan 12 tests in 0.1s\n\nFAILED (failures=12)\n` }), failed);
  assert.match(listed, /Failed tests \(12, the first 10\):\n- test_0 \(m\.T\.test_0\)\n/);
  assert.match(listed, /- test_9 \(m\.T\.test_9\)\nLast 20 lines/);
  assert.doesNotMatch(listed, /- test_10 /);
  assert.doesNotMatch(blockReason(run({ output: fixture('jest-green') }), RED), /Failed tests/);
});

test('the quick checks: findings block with file, line and entry, at most twenty listed; the release says CHECKS', () => {
  const findings = Array.from({ length: 23 }, (_, i) => ({ file: 'a.test.js', line: i + 1, gw: 'GW-17', what: 'it.skip - the test does not run as written' }));
  const checks = { kind: 'checks', command: 'greenwashing checks', source: 'the checks', findings };
  const result = verdict(checks);
  assert.deepEqual([result.outcome, result.why], ['failed', '23 problems in the test lines this turn added or changed']);
  const reason = blockReason(checks, result);
  assert.match(reason, /^greenwashing gate: the changed tests can pass without testing anything - you cannot finish yet\.\n/);
  assert.match(reason, /\n- a\.test\.js:1: it\.skip - the test does not run as written \(GW-17\)\n/);
  assert.match(reason, /\n- a\.test\.js:20: .*\n- and 3 more\n/);
  assert.doesNotMatch(reason, /a\.test\.js:21:/);
  assert.match(reason, /turn a check off in the project's \.greenwashing\.json/);
  const released = decide([checks], [result], { blocks: 3 }, true);
  assert.match(released.message, /^greenwashing: CHECKS DID NOT PASS - WORK NOT ACCEPTED\./);
  assert.match(decide([run({})], [RED], { blocks: 3 }, true).message, /^greenwashing: TESTS DID NOT PASS/);
  // Checks that could not run are did not run, like tests.
  const notRun = { kind: 'checks', command: 'greenwashing checks', source: 'the checks', configError: 'python3 was not found on PATH' };
  const notRunReason = blockReason(notRun, verdict(notRun));
  assert.match(notRunReason, /^greenwashing gate: the checks of the changed tests did not run - you cannot finish yet\./);
  // No command of the project ran, so there is no output to speak of.
  assert.match(notRunReason, /\nResult: did not run - python3 was not found on PATH\nSee GW-50 in \S+$/);
});

test('removed tests block with each name and GW-17, at most twenty listed, and say how the user allows the removal', () => {
  const removed = Array.from({ length: 22 }, (_, i) => `a.test.js: 'test ${i + 1}'`);
  const checks = { kind: 'checks', command: 'greenwashing checks', source: 'the checks', findings: [], removed };
  const result = verdict(checks);
  assert.deepEqual([result.outcome, result.why], ['failed', '22 tests removed']);
  const reason = blockReason(checks, result);
  assert.match(reason, /^greenwashing gate: this turn removed tests - you cannot finish yet\.\nRemoved tests /);
  assert.match(reason, /\n- a\.test\.js: 'test 20' \(GW-17\)\n- and 2 more\nSee each entry in /);
  assert.doesNotMatch(reason, /test 21|Found in the test lines/);
  assert.match(reason, /the user says "allow test removal" may remove tests/);
  // With findings too: both lists, both how-tos, and the why counts both.
  const both = { ...checks, removed: removed.slice(0, 1), findings: [{ file: 'a.test.js', line: 3, gw: 'GW-18', what: 'the test has no assertion' }] };
  assert.equal(verdict(both).why, '1 problem in the test lines this turn added or changed; 1 test removed');
  assert.match(blockReason(both, verdict(both)),
    /^greenwashing gate: the changed tests can pass without testing anything, and this turn removed tests - you cannot finish yet\.\nFound [^\n]*\n- a\.test\.js:3: [^\n]*\nRemoved tests [^\n]*\n- a\.test\.js: 'test 1' \(GW-17\)\nSee each entry in \S+\nFix the tests\.[^\n]*it turns off the check of removed tests too[^\n]*\nPut the tests back/);
});

test('the line of an accepted turn names the tests removed with the user\'s permission, at most ten', () => {
  assert.equal(removedNote([]), '');
  assert.equal(removedNote(["a.test.js: 'x'"]), "; tests removed with the user's permission (1): a.test.js: 'x'");
  const many = removedNote(Array.from({ length: 12 }, (_, i) => `t${i + 1}`));
  assert.match(many, /\(12\): t1, t2, t3, t4, t5, t6, t7, t8, t9, t10, and 2 more$/);
});

test('the block reason stays short when a line of output is huge', () => {
  const reason = blockReason(run({ output: `start\n${'x'.repeat(5000000)}\nend` }), RED);
  assert.ok(reason.length < 10000, `${reason.length} characters`);
  assert.match(reason, /x{300}\.\.\. \(5000000 characters\)\nend$/);
  // Twenty long lines, each kept from its start and cut at 300 characters, stay under the cap too.
  const line = `a${'x'.repeat(1006)}z`;
  const many = blockReason(run({ output: Array(20).fill(line).join('\n') }), RED);
  assert.ok(many.length < 10000, `${many.length} characters`);
  assert.equal(many.split('\n').at(-1), `a${'x'.repeat(299)}... (1008 characters)`);
});

test('an empty output is said so; the tail has no terminal color codes', () => {
  assert.match(blockReason(run({ output: '' }), RED), /The command printed nothing\.$/);
  const colored = blockReason(run({ output: fixture('vitest-mixed-color') }), RED);
  assert.doesNotMatch(colored, /\x1b\[/);
  assert.match(colored, /Tests {2}2 failed \| 2 passed \| 1 skipped \(5\)/);
});

test('the release message names the last result and the command', () => {
  const decision = decide([run({})], [RED], { blocks: 3 }, true);
  assert.match(decision.message, /Last result: did not run - zero tests ran \(jest\) \(npm test\)\.$/);
  // Released on a settings change: the change still blocks after the next prompt unless the user edits the file.
  const config = { kind: 'config', command: 'greenwashing checks', files: ['.greenwashing.json'] };
  assert.match(decide([config], [verdict(config)], { blocks: 3 }, true).message,
    /\(greenwashing checks\)\. The changed settings still block after the next prompt: undo the change, or edit the file between turns to make it yours\.$/);
});

test("a run in another tree whose own .greenwashing.json differs says it was ignored, green or red", () => {
  const green = { ...run({ output: fixture('jest-green'), exitCode: 0 }), where: '.claude/worktrees/feat', ignoredSettings: true };
  assert.match(decide([green], [verdict(green)], { blocks: 0 }, false).message,
    / in \.claude\/worktrees\/feat \(its own \.greenwashing\.json ignored\): \d+ passed/);
  const red = { ...green, output: 'ok' };
  assert.match(blockReason(red, verdict(red)), /\nFolder: \.claude\/worktrees\/feat\nSettings: the project folder's; the \.greenwashing\.json in this folder is ignored\n/);
  const plain = { ...red, ignoredSettings: undefined };
  assert.doesNotMatch(blockReason(plain, verdict(plain)), /Settings:/);
});

test('failed tests name no catalog entry; did not run names GW-50', () => {
  const failed = { outcome: 'failed', why: '1 failed', gw: null, counts: { passed: 1, failed: 1, skipped: 0, brokenFiles: 0 } };
  assert.doesNotMatch(blockReason(run({ output: 'x' }), failed), /See GW-/);
  const notRun = verdict(run({ output: 'ok' }));
  assert.match(blockReason(run({ output: 'ok' }), notRun), /See GW-50 in /);
});

test('the catalog entries the gate cites exist in CATALOG.md', () => {
  const catalog = fs.readFileSync(path.join(__dirname, '..', '..', 'CATALOG.md'), 'utf8');
  const cited = new Set(Object.values(CHECKS));
  const config = { kind: 'config', command: 'greenwashing checks', files: ['.greenwashing.json'] };
  for (const result of [verdict(run({ output: 'ok' })), verdict(run({ output: fixture('node22-tap-zero') })), verdict(config)]) cited.add(result.gw);
  assert.deepEqual([...cited].sort(), ['GW-01', 'GW-08', 'GW-114', 'GW-17', 'GW-18', 'GW-50']);
  for (const id of cited) assert.match(catalog, new RegExp(`^### ${id} `, 'm'), id);
  assert.match(blockReason(config, verdict(config)), /See GW-114 in /);
});
