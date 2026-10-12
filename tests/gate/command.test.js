'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  chooseCommand, readConfig, support, notChecked, isPythonTest, ROOT_FILES, CHECKS, MUTANT_LIMITS,
} = require('../../plugin/gate/lib/command');

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
    assert.match(choice.error, /package\.json has a test script and the project also has Python tests.*a human adds \{"testCommand"/, JSON.stringify(present));
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
  assert.equal(pick({ 'package.json': '{"name": "x"}' }).error, 'no test command found; a human adds {"testCommand": "<the command that runs your tests>"} to .greenwashing.json in the project root, between turns');
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
  assert.match(choice.error, /no test command found; a human adds \{"testCommand": .*\} to \.greenwashing\.json in the project root, between turns/);
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

test('.greenwashing.json: "python" names the Python for the checks, and is absent unless set', () => {
  assert.equal(readConfig('{"python": ".venv/bin/python"}').python, '.venv/bin/python');
  assert.equal(readConfig('{"python": "python3.12", "testCommand": "make test"}').python, 'python3.12');
  assert.equal('python' in readConfig('{"testCommand": "make test"}'), false);
  assert.equal('python' in readConfig(null), false);
});

test('.greenwashing.json: "mutants" sets the mutation command\'s limits, and is absent unless set', () => {
  assert.deepEqual(MUTANT_LIMITS, { limit: 20, timeoutSeconds: 600, runTimeoutSeconds: null });
  assert.deepEqual(readConfig('{"mutants": {"limit": 5, "timeoutSeconds": 900, "runTimeoutSeconds": 30}}').mutants, { limit: 5, timeoutSeconds: 900, runTimeoutSeconds: 30 });
  assert.deepEqual(readConfig('{"mutants": {}}').mutants, {});
  assert.equal('mutants' in readConfig('{"testCommand": "make test"}'), false);
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
    '{"python": ""}': /python must be a non-empty string/,
    '{"python": "  "}': /python must be a non-empty string/,
    '{"python": ["python3.12"]}': /python must be a non-empty string/,
    '{"python": null}': /python must be a non-empty string/,
    '{"mutants": null}': /mutants must be an object of whole numbers from 1 to 86400 for limit, timeoutSeconds, runTimeoutSeconds/,
    '{"mutants": [20]}': /mutants must be an object/,
    '{"mutants": {"limit": 0}}': /mutants must be an object/,
    '{"mutants": {"limit": 2.5}}': /mutants must be an object/,
    '{"mutants": {"limit": "20"}}': /mutants must be an object/,
    '{"mutants": {"runTimeoutSeconds": -1}}': /mutants must be an object/,
    '{"mutants": {"limits": 20}}': /mutants must be an object/,
    '{"mutants": {"timeoutSeconds": 86401}}': /mutants must be an object of whole numbers from 1 to 86400/,
  };
  for (const [text, message] of Object.entries(bad)) {
    assert.match(readConfig(text).error, message, text);
    assert.equal(pick({ '.greenwashing.json': text }).none, undefined, text);
    assert.match(pick({ '.greenwashing.json': text, 'package.json': '{"scripts": {"test": "jest"}}' }).error, message, text);
  }
});

test('the gate checks a project whose test command is one of the five kinds, or one a human set; not one with none or another kind', () => {
  const scripts = (all) => support(files({ 'package.json': JSON.stringify({ scripts: all }) }), false);
  for (const [test, runners] of [['node --test', ['node --test']], ['node --import tsx --test src', ['node --test']], ['jest --coverage', ['jest']],
    ['npx vitest run', ['vitest']], ['node node_modules/.bin/jest', ['jest']], ['python3 -m pytest -q', ['pytest']], ['py.test', ['pytest']],
    ['python3 -m unittest discover', ['unittest']], ['tsc && vitest', ['vitest']], ['jest && node --test', ['jest', 'node --test']]]) {
    assert.deepEqual(scripts({ test }), { supported: true, runners }, test);
  }
  // Through the scripts it runs: npm, yarn, pnpm; a loop of scripts ends.
  for (const [all, runners] of [[{ test: 'npm run unit', unit: 'node --test' }, ['node --test']], [{ test: 'npm run-script unit', unit: 'jest' }, ['jest']],
    [{ test: 'yarn unit', unit: 'vitest' }, ['vitest']], [{ test: 'yarn run lint && pnpm run unit', lint: 'eslint .', unit: 'pytest' }, ['pytest']],
    [{ test: 'pnpm unit', unit: 'npm run deep', deep: 'node --test' }, ['node --test']]]) {
    assert.deepEqual(scripts(all), { supported: true, runners }, JSON.stringify(all));
  }
  // Another kind, a name inside a longer word or a file name, or a script that runs no runner.
  for (const all of [{ test: 'mocha' }, { test: 'go test ./...' }, { test: 'make test' }, { test: 'nodemon --test' }, { test: 'node --test-reporter=tap' },
    { test: 'eslint --plugin eslint-plugin-jest .' }, { test: 'node scripts/jest.config.js' }, { test: 'npm run unit', unit: 'mocha' },
    { test: 'npm run a', a: 'npm run b', b: 'npm run a' }, { test: 'npm test' }, { test: 'npm run missing' }]) {
    const found = scripts(all);
    assert.equal(found.supported, false, JSON.stringify(all));
    assert.equal(found.why, `the test command npm test runs ${JSON.stringify(all.test)}`);
  }
  assert.deepEqual(support(files(), false), { supported: false, why: 'no test command was found' });
  assert.deepEqual(support(files({ 'package.json': '{"scripts": {"test": "echo \\"Error: no test specified\\" && exit 1"}}' }), false),
    { supported: false, why: 'no test command was found' });
  // Found without a script: pytest settings, Python tests.
  assert.deepEqual(support(files({ 'pytest.ini': '' }), false), { supported: true, runners: ['pytest'] });
  assert.deepEqual(support(files(), true), { supported: true, runners: ['unittest'] });
  // Set by a human: whatever it is, with the runners it names, also through npm test and the scripts after it.
  const human = (command, pkg = null) => support(files({ '.greenwashing.json': JSON.stringify({ testCommand: command }), 'package.json': pkg }), false);
  assert.deepEqual(human('go test ./...', '{"scripts": {"test": "mocha"}}'), { supported: true, runners: null });
  assert.deepEqual(human('python3 -I -m unittest discover -s tests && node --test tests/gate/*.test.js'), { supported: true, runners: ['unittest', 'node --test'] });
  assert.deepEqual(human('npm test', '{"scripts": {"test": "npm run unit", "unit": "vitest"}}'), { supported: true, runners: ['vitest'] });
  assert.deepEqual(human('npm t', '{'), { supported: true, runners: null });
  // A broken setup: checked, and did not run.
  assert.deepEqual(support(files({ 'package.json': '{' }), false), { supported: true, runners: null });
  assert.deepEqual(support(files({ 'package.json': '{"scripts": {"test": "mocha"}}' }), true), { supported: true, runners: null });
});

test('the line of a turn the gate did not check names the next turn\'s command only when the project had none and has one the gate checks now', () => {
  const none = 'no test command was found';
  const first = (command) => 'greenwashing: this turn was NOT checked - the project had no test command when the work started. '
    + `The next turn will be checked with ${command}.`;
  // The line that says how to set testCommand.
  const assertUnchecked = (line, why) => assert.ok(line.startsWith(`greenwashing: this turn was NOT checked - ${why}, and the gate reads only the test `
    + 'output of pytest, unittest, jest, vitest and node --test. To have turns checked, a human sets {"testCommand"'), line);
  assert.equal(notChecked(none, files({ 'package.json': '{"scripts": {"test": "vitest run"}}' }), false), first('npm test (package.json scripts.test)'));
  assert.equal(notChecked(none, files({ 'pytest.ini': '' }), false), first('python3 -m pytest (pytest configured)'));
  assert.equal(notChecked(none, files(), true), first('python3 -m unittest discover (Python project)'));
  // Still none, a script of another kind, or a broken setup: the line says how to set testCommand.
  for (const [present, hasTests] of [[{}, false], [{ 'package.json': '{"scripts": {"test": "mocha"}}' }, false], [{ 'package.json': '{' }, false],
    [{ 'package.json': '{"scripts": {"test": "jest"}}' }, true]]) {
    assertUnchecked(notChecked(none, files(present), hasTests), none);
  }
  // A project that started with a test command of another kind had one: its line stays.
  const mocha = 'the test command npm test runs "mocha"';
  assertUnchecked(notChecked(mocha, files({ 'package.json': '{"scripts": {"test": "jest"}}' }), false), mocha);
});

test('support() reads a runner only as a word of its own and follows every form of a script call; a BOM or scripts: null in package.json', () => {
  const scripts = (all) => support(files({ 'package.json': JSON.stringify({ scripts: all }) }), false);
  for (const test of ['sh run-unittest.sh', 'node vitest.config.js', 'node build.js && echo --test', 'node build.js | tee --test', 'ts-node --test src',
    'sh run-pytest', 'sh run-vitest']) {
    assert.equal(scripts({ test }).supported, false, test);
  }
  // A script call is npm, yarn or pnpm by name: another tool's run is not followed.
  assert.equal(scripts({ test: 'cnpm run unit', unit: 'jest' }).supported, false);
  for (const [all, runners] of [[{ test: 'npm run test:unit', 'test:unit': 'jest' }, ['jest']], [{ test: 'yarn run unit', unit: 'vitest' }, ['vitest']],
    [{ test: 'npm run unit.fast', 'unit.fast': 'node --test' }, ['node --test']]]) {
    assert.deepEqual(scripts(all), { supported: true, runners }, JSON.stringify(all));
  }
  const human = (command, pkg) => support(files({ '.greenwashing.json': JSON.stringify({ testCommand: command }), 'package.json': pkg }), false);
  assert.deepEqual(human('npm t', '{"scripts": {"test": "jest"}}'), { supported: true, runners: ['jest'] });
  assert.deepEqual(human('npm tag ls && ./check', '{"scripts": {"test": "jest"}}'), { supported: true, runners: null });
  assert.deepEqual(human('npm run unit', '{"scripts": null}'), { supported: true, runners: null });
  assert.deepEqual(support(files({ 'package.json': '\ufeff{"scripts": {"test": "jest"}}' }), false), { supported: true, runners: ['jest'] });
});

