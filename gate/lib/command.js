'use strict';
// Which command runs the project's tests. Pure functions over file texts the hook read.

const CONFIG_FILE = '.greenwashing.json';
const DEFAULT_TIMEOUT_SECONDS = 600;
// The Stop hook's own timeout in hooks/hooks.json and .claude/settings.json is this plus 60 s:
// Claude Code cancels a hook that runs longer and lets the agent stop (gate/test/plugin.test.js).
const MAX_TIMEOUT_SECONDS = 3600;
const CONFIG_KEYS = ['testCommand', 'timeoutSeconds', 'checks', 'python'];
// The gate's quick checks on changed test lines (gate/lib/checks.js) and the catalog entry each
// reports; a project turns one off with "checks": {"skips": false}.
const CHECKS = { skips: 'GW-17', assertions: 'GW-18', selfComparisons: 'GW-01' };
const CHECK_NAMES = Object.keys(CHECKS);
// Said to the agent too, which must not change the settings during a turn (GW-114).
const HOW_TO = `a human adds {"testCommand": "<the command that runs your tests>"} to ${CONFIG_FILE} in the project root, between turns`;
// How to make the Python checks run when python3 cannot read the project's syntax, or is missing.
const PYTHON_HOW_TO = `a human sets {"python": "<the project's Python, for example .venv/bin/python>"} in ${CONFIG_FILE} in the project root, `
  + 'or turns the checks off there ({"checks": {"skips": false, "assertions": false, "selfComparisons": false}}, JavaScript too), between turns';
// What `npm init` writes when there are no tests.
const NPM_PLACEHOLDER = 'echo "Error: no test specified" && exit 1';
const PYTEST_FILES = ['pytest.ini', 'pytest.toml', '.pytest.toml', 'conftest.py', 'tests/conftest.py', 'test/conftest.py'];
// Files that can hold a pytest section.
const PYTEST_SECTION_FILES = ['pyproject.toml', 'setup.cfg', 'tox.ini'];

// A Python test file, by pytest's default names: test_*.py or *_test.py. Other Python files (a
// helper script, setup.py) do not make a project Python (owner decision, PR 4b).
const isPythonTest = (file) => /^test_.*\.py$|_test\.py$/.test(file.split('/').pop());

// A byte order mark at the start is not part of the JSON (JSON.parse refuses it).
const withoutBom = (text) => text.replace(/^\uFEFF/, '');

const ALL_CHECKS = Object.fromEntries(CHECK_NAMES.map((name) => [name, true]));

// Reads .greenwashing.json text (or null when the file is absent).
// Returns {testCommand?, timeoutSeconds, checks, python?} or {error}.
function readConfig(text) {
  if (text === null) return { timeoutSeconds: DEFAULT_TIMEOUT_SECONDS, checks: ALL_CHECKS };
  let config;
  try {
    config = JSON.parse(withoutBom(text));
  } catch (error) {
    return { error: `${CONFIG_FILE} is not valid JSON (${error.message})` };
  }
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return { error: `${CONFIG_FILE} must hold a JSON object` };
  }
  const unknown = Object.keys(config).filter((key) => !CONFIG_KEYS.includes(key));
  if (unknown.length) return { error: `${CONFIG_FILE} has unknown keys: ${unknown.join(', ')}` };
  if ('testCommand' in config && (typeof config.testCommand !== 'string' || !config.testCommand.trim())) {
    return { error: `${CONFIG_FILE}: testCommand must be a non-empty string` };
  }
  if ('timeoutSeconds' in config && !(Number.isInteger(config.timeoutSeconds) && config.timeoutSeconds > 0
    && config.timeoutSeconds <= MAX_TIMEOUT_SECONDS)) {
    return { error: `${CONFIG_FILE}: timeoutSeconds must be a whole number from 1 to ${MAX_TIMEOUT_SECONDS}` };
  }
  if ('python' in config && (typeof config.python !== 'string' || !config.python.trim())) {
    return { error: `${CONFIG_FILE}: python must be a non-empty string (the Python for the checks: a path from the project folder or a name on PATH)` };
  }
  const checks = config.checks === undefined ? {} : config.checks;
  if (checks === null || typeof checks !== 'object' || Array.isArray(checks)
    || Object.entries(checks).some(([name, on]) => !CHECK_NAMES.includes(name) || typeof on !== 'boolean')) {
    return { error: `${CONFIG_FILE}: checks must be an object of true or false for ${CHECK_NAMES.join(', ')}` };
  }
  const python = 'python' in config ? { python: config.python } : {};
  return { testCommand: config.testCommand, timeoutSeconds: config.timeoutSeconds || DEFAULT_TIMEOUT_SECONDS, checks: { ...ALL_CHECKS, ...checks }, ...python };
}

function pytestConfigured(files) {
  return PYTEST_FILES.some((name) => files[name] !== null)
    || /^\[tool\.pytest(\.ini_options)?\]/m.test(files['pyproject.toml'] || '')
    || /^\[tool:pytest\]/m.test(files['setup.cfg'] || '')
    || /^\[pytest\]/m.test(files['tox.ini'] || '');
}

// files: {name: text, or null when absent} for the root files the rules look at;
// hasPythonTests: the project has a Python test file (isPythonTest).
// Returns {command, source, timeoutSeconds} or {error, timeoutSeconds}; `none` marks the one
// error that means "nothing here to test" rather than a broken setup.
function chooseCommand(files, hasPythonTests) {
  const config = readConfig(files[CONFIG_FILE]);
  if (config.error) return { error: config.error, timeoutSeconds: DEFAULT_TIMEOUT_SECONDS };
  const { timeoutSeconds } = config;
  if (config.testCommand) return { command: config.testCommand, source: CONFIG_FILE, timeoutSeconds };
  let npmTest = false;
  if (files['package.json'] !== null) {
    let scripts;
    try {
      scripts = JSON.parse(withoutBom(files['package.json'])).scripts;
    } catch (error) {
      return { error: `package.json is not valid JSON (${error.message}); ${HOW_TO}`, timeoutSeconds };
    }
    npmTest = Boolean(scripts) && typeof scripts.test === 'string' && ![NPM_PLACEHOLDER, ''].includes(scripts.test.trim());
  }
  const python = hasPythonTests || pytestConfigured(files);
  if (npmTest && python) {
    return { error: `package.json has a test script and the project also has Python tests, so npm test alone would leave one of them untested; ${HOW_TO}`, timeoutSeconds };
  }
  if (npmTest) return { command: 'npm test', source: 'package.json scripts.test', timeoutSeconds };
  if (pytestConfigured(files)) return { command: 'python3 -m pytest', source: 'pytest configured', timeoutSeconds };
  if (python) return { command: 'python3 -m unittest discover', source: 'Python project', timeoutSeconds };
  return { error: `no test command found; ${HOW_TO}`, none: true, timeoutSeconds };
}

const ROOT_FILES = [CONFIG_FILE, 'package.json', ...PYTEST_FILES, ...PYTEST_SECTION_FILES];

module.exports = {
  chooseCommand, readConfig, pytestConfigured, isPythonTest, ROOT_FILES, CHECKS, CHECK_NAMES, CONFIG_FILE, DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS, HOW_TO,
  PYTHON_HOW_TO,
};
