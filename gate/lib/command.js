'use strict';
// Which command runs the project's tests. Pure functions over file texts the hook read.

const path = require('node:path');

const CONFIG_FILE = '.greenwashing.json';
const DEFAULT_TIMEOUT_SECONDS = 600;
// The Stop hook's own timeout in hooks/hooks.json and .claude/settings.json is this plus 60 s:
// Claude Code cancels a hook that runs longer and lets the agent stop (gate/test/plugin.test.js).
const MAX_TIMEOUT_SECONDS = 3600;
// The oldest Node the gate runs on: the oldest one CI tests (.github/workflows/ci.yml). On an older one
// the gate does not run and says so (gateOff): in runs, Node 14 and 16 blocked every turn.
const MIN_NODE = 20;
// Why the gate is not running (found: what was found instead), for the user; hooks/hooks.json and
// .claude/settings.json print it with NO_NODE when node cannot start the gate at all.
const NO_NODE = 'node could not start it (node is not on PATH or too old to load it, or the files of the gate are missing)';
const gateOff = (found) => `greenwashing: the gate is OFF - ${found}. It needs Node.js ${MIN_NODE} or newer on PATH; `
  + 'no turn is checked until a human sets that up and restarts Claude Code.';
const CONFIG_KEYS = ['testCommand', 'timeoutSeconds', 'checks', 'python', 'mutants'];
// The mutation command's limits (gate/mutate.js): how many breaks, the time for everything, and the
// time for one test run with a break (none: it comes from the control run's length, estimate() in
// mutants.js); "mutants" in the settings and the command's options change them.
const MUTANT_LIMITS = { limit: 20, timeoutSeconds: 600, runTimeoutSeconds: null };
// The most any of them can be: a day (a timer past 24.8 days would fire at once).
const MUTANT_MAX = 86400;
// The gate's quick checks on changed test lines (gate/lib/checks.js) and the catalog entry each
// reports; a project turns one off with "checks": {"skips": false}.
const CHECKS = { skips: 'GW-17', assertions: 'GW-18', selfComparisons: 'GW-01' };
const CHECK_NAMES = Object.keys(CHECKS);
// Why the gate cannot check a project with no test command (support()).
const NO_TEST_COMMAND = 'no test command was found';
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
// Returns {testCommand?, timeoutSeconds, checks, python?, mutants?} or {error}.
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
  const mutants = config.mutants === undefined ? {} : config.mutants;
  if (mutants === null || typeof mutants !== 'object' || Array.isArray(mutants)
    || Object.entries(mutants).some(([name, value]) => !(name in MUTANT_LIMITS) || !Number.isInteger(value) || value < 1 || value > MUTANT_MAX)) {
    return { error: `${CONFIG_FILE}: mutants must be an object of whole numbers from 1 to ${MUTANT_MAX} for ${Object.keys(MUTANT_LIMITS).join(', ')}` };
  }
  const checks = config.checks === undefined ? {} : config.checks;
  if (checks === null || typeof checks !== 'object' || Array.isArray(checks)
    || Object.entries(checks).some(([name, on]) => !CHECK_NAMES.includes(name) || typeof on !== 'boolean')) {
    return { error: `${CONFIG_FILE}: checks must be an object of true or false for ${CHECK_NAMES.join(', ')}` };
  }
  const python = 'python' in config ? { python: config.python } : {};
  return {
    testCommand: config.testCommand, timeoutSeconds: config.timeoutSeconds || DEFAULT_TIMEOUT_SECONDS, checks: { ...ALL_CHECKS, ...checks }, ...python,
    ...('mutants' in config ? { mutants } : {}),
  };
}

// The Python for the Python checks: "python" in the settings (config: readConfig()), a path taken
// from the project folder or a name on PATH; else python3 from PATH.
function pythonOf(config, project) {
  if (!config.python) return 'python3';
  return config.python.includes('/') ? path.resolve(project, config.python) : config.python;
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

// The test runners whose output the gate reads, and how a command names each: a word of its own, not
// part of a package or file name (eslint-plugin-jest, jest.config.js); node with --test.
const RUNNERS = [
  ['pytest', /(?<![\w.-])(?:pytest|py\.test)(?![\w.-])/],
  ['unittest', /(?<![\w.-])unittest(?![\w.-])/],
  ['jest', /(?<![\w.-])jest(?![\w.-])/],
  ['vitest', /(?<![\w.-])vitest(?![\w.-])/],
  ['node --test', /(?<![\w.-])node(?![\w.-])[^;&|]*\s--test(?![\w-])/],
];
const RUNNER_NAMES = 'pytest, unittest, jest, vitest and node --test';
// A script that runs another script of package.json: npm test, npm t, npm run X, npm run-script X,
// yarn X, yarn run X, pnpm X, pnpm run X.
const SCRIPT_CALL = /(?<![\w.-])(?:npm\s+t(?:est)?(?![\w:.-])|(?:npm\s+run(?:-script)?|yarn(?:\s+run)?|pnpm(?:\s+run)?)\s+([\w:.-]+))/g;

// The runners a command names, itself or through the scripts of package.json it runs (scripts);
// seen: the scripts already read.
function runnersIn(text, scripts, seen = new Set()) {
  const found = RUNNERS.filter(([, pattern]) => pattern.test(text)).map(([kind]) => kind);
  for (const call of text.matchAll(SCRIPT_CALL)) {
    const name = call[1] || 'test';
    if (seen.has(name) || typeof scripts[name] !== 'string') continue;
    seen.add(name);
    found.push(...runnersIn(scripts[name], scripts, seen));
  }
  return [...new Set(found)];
}

// The scripts of package.json, or none when it is missing or broken.
function packageScripts(text) {
  try {
    const { scripts } = JSON.parse(withoutBom(text));
    return scripts !== null && typeof scripts === 'object' ? scripts : {};
  } catch {
    return {};
  }
}

// Whether the gate can check a project, from its files at the start of the turn (as chooseCommand()
// takes them): a command a human set in .greenwashing.json always counts (the gate reads its output as
// usual, and no counts is did not run); a command found by itself counts when it runs one of RUNNERS:
// pytest settings, Python tests (unittest), or a test script of package.json that names one, itself
// or through the scripts it runs. No test command, or a script of another kind (mocha, go test), does
// not. A broken setup counts: the gate says how to fix it. Returns {supported: true, runners} (the
// kinds the command runs, null when it names none) or {supported: false, why}.
function support(files, hasPythonTests) {
  const choice = chooseCommand(files, hasPythonTests);
  if (choice.none) return { supported: false, why: NO_TEST_COMMAND };
  const scripts = files['package.json'] === null ? {} : packageScripts(files['package.json']);
  const named = (found) => ({ supported: true, runners: found.length ? found : null });
  if (choice.error) return named([]);
  if (choice.source === CONFIG_FILE) return named(runnersIn(choice.command, scripts));
  if (choice.source === 'pytest configured') return named(['pytest']);
  if (choice.source === 'Python project') return named(['unittest']);
  const found = runnersIn(scripts.test, scripts, new Set(['test']));
  return found.length ? named(found) : { supported: false, why: `the test command npm test runs ${JSON.stringify(scripts.test)}` };
}

// The line of a turn in a project the gate cannot check: why, from support() when the turn started;
// files and hasPythonTests, the project when the turn ends (as support() takes them; none when it cannot
// be read). A project that had no test command then and has one the gate checks now is still not checked
// in this turn (the agent cannot give itself the command it is checked with), and the prompt decides
// again after a turn the gate let end: the line names the command the next turn is checked with.
function notChecked(why, files, hasPythonTests) {
  const next = why === NO_TEST_COMMAND && files && support(files, hasPythonTests).supported ? chooseCommand(files, hasPythonTests) : {};
  if (next.command) {
    return 'greenwashing: this turn was NOT checked - the project had no test command when the turn started. '
      + `The next turn will be checked with ${next.command} (${next.source}).`;
  }
  return `greenwashing: this turn was NOT checked - ${why}, and the gate reads only the test output of ${RUNNER_NAMES}. `
    + `To have turns checked, a human sets {"testCommand": "<a command that runs your tests with one of them, or prints their output>"} in ${CONFIG_FILE} `
    + 'in the project root, between turns.';
}

module.exports = {
  chooseCommand, readConfig, support, notChecked, pytestConfigured, pythonOf, isPythonTest, ROOT_FILES, CHECKS, CHECK_NAMES, CONFIG_FILE, DEFAULT_TIMEOUT_SECONDS,
  MAX_TIMEOUT_SECONDS, MIN_NODE, NO_NODE, gateOff, HOW_TO, PYTHON_HOW_TO, MUTANT_LIMITS, MUTANT_MAX,
};
