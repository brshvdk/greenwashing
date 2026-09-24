'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseCommand, readConfig, ROOT_FILES } = require('../lib/command');

// Every root file the rules look at is absent unless the case names it.
const files = (present = {}) => ({ ...Object.fromEntries(ROOT_FILES.map((name) => [name, null])), ...present });
const pick = (present, hasPy = false) => chooseCommand(files(present), hasPy);

test('the command in .greenwashing.json wins over everything else', () => {
  const choice = pick({ '.greenwashing.json': '{"testCommand": "make check", "timeoutSeconds": 30}', 'package.json': '{"scripts": {"test": "jest"}}', 'pytest.ini': '' }, true);
  assert.deepEqual(choice, { command: 'make check', source: '.greenwashing.json', timeoutSeconds: 30 });
});

test('without it, the test script of package.json runs through npm', () => {
  assert.deepEqual(pick({ 'package.json': '{"scripts": {"test": "vitest run"}}', 'pytest.ini': '' }, true),
    { command: 'npm test', source: 'package.json scripts.test', timeoutSeconds: 600 });
});

test('a package.json without a test script falls through to Python', () => {
  assert.equal(pick({ 'package.json': '{"scripts": {"build": "tsc"}}' }, true).command, 'python3 -m unittest discover');
  assert.equal(pick({ 'package.json': '{"name": "x"}' }).error, 'no test command found; add {"testCommand": "<the command that runs your tests>"} to .greenwashing.json in the project root');
});

test('pytest runs when the project configures it', () => {
  const configured = [
    { 'pytest.ini': '[pytest]\n' },
    { 'conftest.py': '' },
    { 'pyproject.toml': '[project]\nname = "x"\n\n[tool.pytest.ini_options]\naddopts = "-q"\n' },
    { 'pyproject.toml': '[tool.pytest]\nminversion = "9.0"\n' },
    { 'setup.cfg': '[metadata]\nname = x\n[tool:pytest]\n' },
    { 'tox.ini': '[tox]\n[pytest]\naddopts = -q\n' },
  ];
  for (const present of configured) {
    assert.deepEqual(pick(present, true), { command: 'python3 -m pytest', source: 'pytest configured', timeoutSeconds: 600 }, JSON.stringify(present));
  }
});

test('any other Python project runs unittest', () => {
  for (const present of [{ 'pyproject.toml': '[project]\nname = "x"\n' }, { 'setup.py': '' }, { 'requirements.txt': 'requests\n' }, { 'Pipfile': '' }, { 'setup.cfg': '[metadata]\n' }, { 'tox.ini': '[tox]\n' }]) {
    assert.equal(pick(present).command, 'python3 -m unittest discover', JSON.stringify(present));
  }
  assert.equal(pick({}, true).command, 'python3 -m unittest discover');
});

test('nothing to run: the reason says how to set the command', () => {
  const choice = pick({});
  assert.match(choice.error, /no test command found; add \{"testCommand": .*\} to \.greenwashing\.json in the project root/);
  assert.equal(choice.command, undefined);
});

test('a broken package.json is reported, not skipped', () => {
  assert.match(pick({ 'package.json': '{"scripts": ' }, true).error, /package\.json is not valid JSON/);
});

test('.greenwashing.json: the timeout defaults to 10 minutes and goes up to an hour', () => {
  assert.deepEqual(readConfig(null), { timeoutSeconds: 600 });
  assert.deepEqual(readConfig('{"testCommand": "make test"}'), { testCommand: 'make test', timeoutSeconds: 600 });
  assert.deepEqual(readConfig('{"timeoutSeconds": 3600}'), { testCommand: undefined, timeoutSeconds: 3600 });
  assert.deepEqual(readConfig('{"timeoutSeconds": 1}'), { testCommand: undefined, timeoutSeconds: 1 });
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
  };
  for (const [text, message] of Object.entries(bad)) {
    assert.match(readConfig(text).error, message, text);
    assert.match(pick({ '.greenwashing.json': text, 'package.json': '{"scripts": {"test": "jest"}}' }).error, message, text);
  }
});
