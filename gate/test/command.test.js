'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseCommand, readConfig, isPythonTest, ROOT_FILES, CHECKS } = require('../lib/command');

// Every root file the rules look at is absent unless the case names it.
const files = (present = {}) => ({ ...Object.fromEntries(ROOT_FILES.map((name) => [name, null])), ...present });
// hasTests: the project has Python test files (test_*.py, *_test.py).
const pick = (present, hasTests = false) => chooseCommand(files(present), hasTests);

test('the command in .greenwashing.json wins over everything else', () => {
  const choice = pick({ '.greenwashing.json': '{"testCommand": "make check", "timeoutSeconds": 30}', 'package.json': '{"scripts": {"test": "jest"}}', 'pytest.ini': '' }, true);
  assert.deepEqual(choice, { command: 'make check', source: '.greenwashing.json', timeoutSeconds: 30 });
});

test('without it, the test script of package.json runs through npm', () => {
  assert.deepEqual(pick({ 'package.json': '{"scripts": {"test": "vitest run"}}' }),
    { command: 'npm test', source: 'package.json scripts.test', timeoutSeconds: 600 });
});

test('a package.json test script next to Python tests or Python test settings needs an explicit command', () => {
  const npm = { 'package.json': '{"scripts": {"test": "jest"}}' };
  const both = [
    [npm, true],
    [{ ...npm, 'pytest.ini': '' }, false],
    [{ ...npm, 'conftest.py': '' }, false],
    [{ ...npm, 'tests/conftest.py': '' }, false],
    [{ ...npm, 'pyproject.toml': '[tool.pytest.ini_options]\naddopts = "-q"\n' }, false],
    [{ ...npm, 'setup.cfg': '[tool:pytest]\n' }, false],
    [{ ...npm, 'tox.ini': '[pytest]\n' }, false],
  ];
  for (const [present, hasTests] of both) {
    const choice = pick(present, hasTests);
    assert.equal(choice.command, undefined, JSON.stringify(present));
    assert.match(choice.error, /package\.json has a test script and the project also has Python tests.*add \{"testCommand"/, JSON.stringify(present));
    assert.equal(choice.none, undefined);
  }
});

test('Python code that is not tests, or Python packaging files, leave a JavaScript project on npm test', () => {
  const npm = { 'package.json': '{"scripts": {"test": "jest"}}' };
  for (const extra of [{}, { 'requirements.txt': 'requests\n' }, { 'setup.py': '' }, { 'Pipfile': '' },
    { 'pyproject.toml': '[project]\nname = "x"\n' }, { 'setup.cfg': '[metadata]\n' }, { 'tox.ini': '[tox]\n' }]) {
    assert.equal(pick({ ...npm, ...extra }).command, 'npm test', JSON.stringify(extra));
  }
});

test("npm's placeholder or an empty test script is no test script", () => {
  const placeholder = '{"scripts": {"test": "echo \\"Error: no test specified\\" && exit 1"}}';
  assert.equal(JSON.parse(placeholder).scripts.test, 'echo "Error: no test specified" && exit 1');
  assert.equal(pick({ 'package.json': placeholder }, true).command, 'python3 -m unittest discover');
  assert.equal(pick({ 'package.json': placeholder }).none, true);
  assert.equal(pick({ 'package.json': '{"scripts": {"test": " "}}' }).none, true);
});

test('a byte order mark before the JSON is ignored', () => {
  assert.equal(pick({ '.greenwashing.json': '\uFEFF{"testCommand": "make check"}' }).command, 'make check');
  assert.equal(pick({ 'package.json': '\uFEFF{"scripts": {"test": "jest"}}' }).command, 'npm test');
  // Only the mark is dropped: other characters JSON does not allow there stay an error.
  assert.match(pick({ '.greenwashing.json': '\u00A0{"testCommand": "make check"}' }).error, /is not valid JSON/);
});

test('a package.json without a test script falls through to Python', () => {
  assert.equal(pick({ 'package.json': '{"scripts": {"build": "tsc"}}' }, true).command, 'python3 -m unittest discover');
  assert.equal(pick({ 'package.json': '{"name": "x"}' }).error, 'no test command found; add {"testCommand": "<the command that runs your tests>"} to .greenwashing.json in the project root');
});

test('pytest runs when the project configures it', () => {
  const configured = [
    { 'pytest.ini': '[pytest]\n' },
    { 'pytest.ini': '' },
    { 'pytest.toml': '[pytest]\n' },
    { '.pytest.toml': '[pytest]\n' },
    { 'conftest.py': '' },
    { 'tests/conftest.py': 'import pytest\n' },
    { 'test/conftest.py': 'import pytest\n' },
    { 'pyproject.toml': '[project]\nname = "x"\n\n[tool.pytest.ini_options]\naddopts = "-q"\n' },
    { 'pyproject.toml': '[tool.pytest]\nminversion = "9.0"\n' },
    { 'setup.cfg': '[metadata]\nname = x\n[tool:pytest]\n' },
    { 'tox.ini': '[tox]\n[pytest]\naddopts = -q\n' },
  ];
  for (const present of configured) {
    assert.deepEqual(pick(present, true), { command: 'python3 -m pytest', source: 'pytest configured', timeoutSeconds: 600 }, JSON.stringify(present));
  }
});

test("a Python test file is named test_*.py or *_test.py, in any folder", () => {
  for (const file of ['test_x.py', 'tests/test_x.py', 'x_test.py', 'pkg/sub/x_test.py', 'test_.py']) {
    assert.equal(isPythonTest(file), true, file);
  }
  for (const file of ['helper.py', 'scripts/helper.py', 'setup.py', 'conftest.py', 'latest_x.py', 'test.py', 'testing.py',
    'contest.py', 'x_tests.py', 'test_x.pyc', 'test_x.py.bak', 'x_test.py.bak', 'Test_x.py', 'tests/helper.py', 'test_dir/helper.py']) {
    assert.equal(isPythonTest(file), false, file);
  }
});

test('Python tests with no pytest settings run under unittest; packaging files alone are no tests', () => {
  assert.equal(pick({}, true).command, 'python3 -m unittest discover');
  assert.equal(pick({ 'requirements.txt': 'requests\n' }, true).command, 'python3 -m unittest discover');
  for (const present of [{ 'pyproject.toml': '[project]\nname = "x"\n' }, { 'setup.py': '' }, { 'requirements.txt': 'requests\n' }, { 'Pipfile': '' }, { 'setup.cfg': '[metadata]\n' }, { 'tox.ini': '[tox]\n' }]) {
    assert.equal(pick(present).none, true, JSON.stringify(present));
  }
});

test('an explicit timeout also applies to a command found on its own', () => {
  assert.deepEqual(pick({ '.greenwashing.json': '{"timeoutSeconds": 30}', 'package.json': '{"scripts": {"test": "jest"}}' }),
    { command: 'npm test', source: 'package.json scripts.test', timeoutSeconds: 30 });
});

test('nothing to run: the reason says how to set the command', () => {
  const choice = pick({});
  assert.equal(choice.none, true);
  assert.match(choice.error, /no test command found; add \{"testCommand": .*\} to \.greenwashing\.json in the project root/);
  assert.equal(choice.command, undefined);
});

test('a broken package.json is reported, not skipped', () => {
  assert.match(pick({ 'package.json': '{"scripts": ' }, true).error, /package\.json is not valid JSON/);
});

const ON = { skips: true, assertions: true, selfComparisons: true };

test('.greenwashing.json: the timeout defaults to 10 minutes and goes up to an hour', () => {
  assert.deepEqual(readConfig(null), { timeoutSeconds: 600, checks: ON });
  assert.deepEqual(readConfig('{"testCommand": "make test"}'), { testCommand: 'make test', timeoutSeconds: 600, checks: ON });
  assert.deepEqual(readConfig('{"timeoutSeconds": 3600}'), { testCommand: undefined, timeoutSeconds: 3600, checks: ON });
  assert.deepEqual(readConfig('{"timeoutSeconds": 1}'), { testCommand: undefined, timeoutSeconds: 1, checks: ON });
});

test('.greenwashing.json: every quick check is on unless the file turns it off', () => {
  assert.deepEqual(Object.keys(CHECKS), ['skips', 'assertions', 'selfComparisons']);
  assert.deepEqual(readConfig('{"checks": {}}').checks, ON);
  assert.deepEqual(readConfig('{"checks": {"skips": false}}').checks, { ...ON, skips: false });
  assert.deepEqual(readConfig('{"checks": {"assertions": false, "selfComparisons": true}}').checks, { ...ON, assertions: false });
  assert.deepEqual(readConfig('{"checks": {"skips": false, "assertions": false, "selfComparisons": false}}').checks,
    { skips: false, assertions: false, selfComparisons: false });
});

test('.greenwashing.json: a config that cannot be trusted is an error, not a default', () => {
  const bad = {
    '{"testCommand": ': /not valid JSON/,
    '[]': /must hold a JSON object/,
    'null': /must hold a JSON object/,
    '"make"': /must hold a JSON object/,
    '{"testcommand": "make"}': /unknown keys: testcommand/,
    '{"testCommand": ""}': /testCommand must be a non-empty string/,
    '{"testCommand": "   "}': /testCommand must be a non-empty string/,
    '{"testCommand": ["make"]}': /testCommand must be a non-empty string/,
    '{"timeoutSeconds": 0}': /timeoutSeconds must be a whole number from 1 to 3600/,
    '{"timeoutSeconds": -5}': /timeoutSeconds must be a whole number from 1 to 3600/,
    '{"timeoutSeconds": 1.5}': /timeoutSeconds must be a whole number from 1 to 3600/,
    '{"timeoutSeconds": "600"}': /timeoutSeconds must be a whole number from 1 to 3600/,
    '{"timeoutSeconds": 3601}': /timeoutSeconds must be a whole number from 1 to 3600/,
    '{"checks": false}': /checks must be an object of true or false for skips, assertions, selfComparisons/,
    '{"checks": null}': /checks must be an object/,
    '{"checks": ["skips"]}': /checks must be an object/,
    '{"checks": {"skip": false}}': /checks must be an object/,
    '{"checks": {"skips": "false"}}': /checks must be an object/,
    '{"checks": {"skips": 0}}': /checks must be an object/,
  };
  for (const [text, message] of Object.entries(bad)) {
    assert.match(readConfig(text).error, message, text);
    assert.equal(pick({ '.greenwashing.json': text }).none, undefined, text);
    assert.match(pick({ '.greenwashing.json': text, 'package.json': '{"scripts": {"test": "jest"}}' }).error, message, text);
  }
});
