'use strict';
// Which command runs the project's tests. Pure functions over file texts the hook read.

const CONFIG_FILE = '.greenwashing.json';
const DEFAULT_TIMEOUT_SECONDS = 600;
// The Stop hook's own timeout in hooks/hooks.json and .claude/settings.json is this plus 60 s:
// Claude Code cancels a hook that runs longer and lets the agent stop (gate/test/plugin.test.js).
const MAX_TIMEOUT_SECONDS = 3600;
const CONFIG_KEYS = ['testCommand', 'timeoutSeconds'];
const HOW_TO = `add {"testCommand": "<the command that runs your tests>"} to ${CONFIG_FILE} in the project root`;

// Reads .greenwashing.json text (or null when the file is absent).
// Returns {testCommand?, timeoutSeconds} or {error}.
function readConfig(text) {
  if (text === null) return { timeoutSeconds: DEFAULT_TIMEOUT_SECONDS };
  let config;
  try {
    config = JSON.parse(text);
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
  return files['pytest.ini'] !== null
    || files['conftest.py'] !== null
    || /^\[tool\.pytest(\.ini_options)?\]/m.test(files['pyproject.toml'] || '')
    || /^\[tool:pytest\]/m.test(files['setup.cfg'] || '')
    || /^\[pytest\]/m.test(files['tox.ini'] || '');
}

const PYTHON_MARKERS = ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile', 'tox.ini'];

// files: {name: text, or null when absent} for the root files the rules look at;
// hasPythonFiles: the project has any .py file.
// Returns {command, source, timeoutSeconds} or {error, timeoutSeconds}.
function chooseCommand(files, hasPythonFiles) {
  const config = readConfig(files[CONFIG_FILE]);
  if (config.error) return { error: config.error, timeoutSeconds: DEFAULT_TIMEOUT_SECONDS };
  const { timeoutSeconds } = config;
  if (config.testCommand) return { command: config.testCommand, source: CONFIG_FILE, timeoutSeconds };
  if (files['package.json'] !== null) {
    let scripts;
    try {
      scripts = JSON.parse(files['package.json']).scripts;
    } catch (error) {
      return { error: `package.json is not valid JSON (${error.message}); ${HOW_TO}`, timeoutSeconds };
    }
    if (scripts && typeof scripts.test === 'string') {
      return { command: 'npm test', source: 'package.json scripts.test', timeoutSeconds };
    }
  }
  if (pytestConfigured(files)) return { command: 'python3 -m pytest', source: 'pytest configured', timeoutSeconds };
  if (hasPythonFiles || PYTHON_MARKERS.some((name) => files[name] !== null)) {
    return { command: 'python3 -m unittest discover', source: 'Python project', timeoutSeconds };
  }
  return { error: `no test command found; ${HOW_TO}`, timeoutSeconds };
}

const ROOT_FILES = [CONFIG_FILE, 'package.json', 'pytest.ini', 'conftest.py', ...PYTHON_MARKERS];

module.exports = {
  chooseCommand, readConfig, pytestConfigured, ROOT_FILES, CONFIG_FILE, DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS, HOW_TO,
};
