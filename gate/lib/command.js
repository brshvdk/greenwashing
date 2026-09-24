'use strict';
// Which command runs the project's tests. Pure functions over file texts the hook read.

const CONFIG_FILE = '.greenwashing.json';
const DEFAULT_TIMEOUT_SECONDS = 600;
// The Stop hook's own timeout in hooks/hooks.json and .claude/settings.json is this plus 60 s:
// Claude Code cancels a hook that runs longer and lets the agent stop (gate/test/plugin.test.js).
const MAX_TIMEOUT_SECONDS = 3600;
const CONFIG_KEYS = ['testCommand', 'timeoutSeconds'];
const HOW_TO = `add {"testCommand": "<the command that runs your tests>"} to ${CONFIG_FILE} in the project root`;
// What `npm init` writes when there are no tests.
const NPM_PLACEHOLDER = 'echo "Error: no test specified" && exit 1';
const PYTEST_FILES = ['pytest.ini', 'pytest.toml', '.pytest.toml', 'conftest.py', 'tests/conftest.py', 'test/conftest.py'];
const PYTHON_MARKERS = ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile', 'tox.ini'];

// A byte order mark at the start is not part of the JSON (JSON.parse refuses it).
const withoutBom = (text) => text.replace(/^\uFEFF/, '');

// Reads .greenwashing.json text (or null when the file is absent).
// Returns {testCommand?, timeoutSeconds} or {error}.
function readConfig(text) {
  if (text === null) return { timeoutSeconds: DEFAULT_TIMEOUT_SECONDS };
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
  return { testCommand: config.testCommand, timeoutSeconds: config.timeoutSeconds || DEFAULT_TIMEOUT_SECONDS };
}

function pytestConfigured(files) {
  return PYTEST_FILES.some((name) => files[name] !== null)
    || /^\[tool\.pytest(\.ini_options)?\]/m.test(files['pyproject.toml'] || '')
    || /^\[tool:pytest\]/m.test(files['setup.cfg'] || '')
    || /^\[pytest\]/m.test(files['tox.ini'] || '');
}

// files: {name: text, or null when absent} for the root files the rules look at;
// hasPythonFiles: the project has any .py file.
// Returns {command, source, timeoutSeconds} or {error, timeoutSeconds}; `none` marks the one
// error that means "nothing here to test" rather than a broken setup.
function chooseCommand(files, hasPythonFiles) {
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
  const python = hasPythonFiles || PYTHON_MARKERS.some((name) => files[name] !== null) || pytestConfigured(files);
  if (npmTest && python) {
    return { error: `package.json has a test script and the project also has Python code, so npm test alone would leave one of them untested; ${HOW_TO}`, timeoutSeconds };
  }
  if (npmTest) return { command: 'npm test', source: 'package.json scripts.test', timeoutSeconds };
  if (pytestConfigured(files)) return { command: 'python3 -m pytest', source: 'pytest configured', timeoutSeconds };
  if (python) return { command: 'python3 -m unittest discover', source: 'Python project', timeoutSeconds };
  return { error: `no test command found; ${HOW_TO}`, none: true, timeoutSeconds };
}

const ROOT_FILES = [...new Set([CONFIG_FILE, 'package.json', ...PYTEST_FILES, ...PYTHON_MARKERS])];

module.exports = {
  chooseCommand, readConfig, pytestConfigured, ROOT_FILES, CONFIG_FILE, DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS, HOW_TO,
};
