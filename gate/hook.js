#!/usr/bin/env node
'use strict';
// The gate's Claude Code hook. `node hook.js prompt` runs on UserPromptSubmit: it records what
// the working tree looks like at the start of the turn. `node hook.js stop` runs on Stop: when
// the turn changed code, it runs the tests and blocks the stop unless they passed. This file only
// does I/O (hook JSON, git, files, the test process); every decision is made in lib/.

const { spawn, execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { candidatePaths, changedPaths, classify } = require('./lib/changes');
const { chooseCommand, readConfig, ROOT_FILES, CONFIG_FILE, DEFAULT_TIMEOUT_SECONDS } = require('./lib/command');
const { verdict, decide } = require('./lib/verdict');

const OUTPUT_LIMIT = 64 * 1024 * 1024;
const GRACE_MS = 5000;
const SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'];

// One file per session and project in a per-user folder of the temp directory. starts: the start of
// the turn in every git tree the turn has seen - a snapshot, or null for a tree the agent entered
// after the start; known: the commits the worktrees and branches of the repository pointed at when
// the turn started; blocks: how many times in a row the gate has sent the agent back; judged: a Stop
// has allowed or released the turn.
const NO_STATE = { starts: {}, known: [], blocks: 0, judged: false };

function stateFile(input, dir) {
  const key = crypto.createHash('sha256').update(`${input.session_id || 'no-session'}\0${dir}`).digest('hex');
  const user = typeof process.getuid === 'function' ? process.getuid() : 'user';
  return path.join(os.tmpdir(), `greenwashing-gate-${user}`, `${key.slice(0, 32)}.json`);
}

function loadState(file) {
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
    if (!isObject(state.starts) || !Array.isArray(state.known)) return NO_STATE;
    return {
      starts: state.starts,
      known: state.known,
      blocks: Number.isInteger(state.blocks) ? state.blocks : 0,
      judged: state.judged === true,
    };
  } catch {
    return NO_STATE;
  }
}

function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(state));
}

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: OUTPUT_LIMIT });
}

function repoRoot(dir) {
  try {
    return git(dir, ['rev-parse', '--show-toplevel']).toString('utf8').trim();
  } catch {
    return null;
  }
}

function headCommit(root) {
  try {
    return git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']).toString('utf8').trim();
  } catch {
    return null;
  }
}

const nulList = (buffer) => buffer.toString('utf8').split('\0').filter(Boolean);

// Every path git reports as different from HEAD: staged, unstaged, deleted, untracked.
function dirtyPaths(root) {
  return nulList(git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames']))
    .map((entry) => entry.slice(3));
}

function committedPaths(root, from, to) {
  if (from === to) return [];
  if (!from || !to) return nulList(git(root, ['ls-tree', '-r', '-z', '--name-only', from || to]));
  return nulList(git(root, ['diff', '--name-only', '-z', '--no-renames', from, to]));
}

const hash = (data) => crypto.createHash('sha256').update(data).digest('hex');

function worktreeHash(root, file) {
  const full = path.join(root, file);
  try {
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) return hash(fs.readlinkSync(full));
    if (stat.isFile()) return hash(fs.readFileSync(full));
    return `not a file: ${stat.mode}`;
  } catch {
    return null;
  }
}

function committedHash(root, commit, file) {
  if (!commit) return null;
  try {
    return hash(git(root, ['cat-file', 'blob', `${commit}:${file}`]));
  } catch {
    return null;
  }
}

function snapshot(root) {
  if (!root) return null;
  const head = headCommit(root);
  const dirty = {};
  for (const file of dirtyPaths(root)) dirty[file] = worktreeHash(root, file);
  return { root, head, dirty };
}

// The files whose content differs from the start of the turn, or null when that cannot be told.
function changedSince(start) {
  if (!start || repoRoot(start.root) !== start.root) return null;
  const head = headCommit(start.root);
  const now = candidatePaths(Object.keys(start.dirty), dirtyPaths(start.root), committedPaths(start.root, start.head, head));
  const before = {};
  const after = {};
  for (const file of now) {
    before[file] = file in start.dirty ? start.dirty[file] : committedHash(start.root, start.head, file);
    after[file] = worktreeHash(start.root, file);
  }
  return changedPaths(before, after);
}

function readRootFiles(dir) {
  const files = {};
  for (const name of ROOT_FILES) {
    try {
      files[name] = fs.readFileSync(path.join(dir, name), 'utf8');
    } catch (error) {
      files[name] = error.code === 'ENOENT' ? null : '';
    }
  }
  return files;
}

function hasPythonFiles(dir) {
  try {
    return git(dir, ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.py']).length > 0;
  } catch {
    return fs.readdirSync(dir).some((name) => name.endsWith('.py'));
  }
}

function killGroup(child) {
  try {
    if (process.platform === 'win32') child.kill('SIGKILL');
    else process.kill(-child.pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

// Runs the command in a shell, in its own process group, with CI=true (test scripts that check it
// skip their watch mode), and collects stdout and stderr together. If the hook itself is stopped,
// the command's whole process group is stopped with it.
function runTests(dir, choice) {
  return new Promise((resolve) => {
    const run = { command: choice.command, source: choice.source, timeoutSeconds: choice.timeoutSeconds, exitCode: null, output: '' };
    const chunks = [];
    let size = 0;
    let child;
    try {
      child = spawn(choice.command, {
        cwd: dir, shell: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: 'true' },
      });
    } catch (error) {
      resolve({ ...run, startError: error.message });
      return;
    }
    const onSignal = (signal) => {
      killGroup(child);
      process.exit(128 + (os.constants.signals[signal] || 0));
    };
    for (const signal of SIGNALS) process.once(signal, onSignal);
    const collect = (chunk) => {
      size += chunk.length;
      if (size <= OUTPUT_LIMIT) chunks.push(chunk);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    let done = false;
    let grace;
    const finish = (fields) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(grace);
      for (const signal of SIGNALS) process.removeListener(signal, onSignal);
      killGroup(child);
      resolve({ ...run, output: Buffer.concat(chunks).toString('utf8'), ...fields });
    };
    const timer = setTimeout(() => finish({ timedOut: true }), choice.timeoutSeconds * 1000);
    child.on('error', (error) => finish({ startError: error.message }));
    child.on('exit', (code, signal) => {
      if (done) return;
      run.exitCode = code !== null ? code : 128 + (os.constants.signals[signal] || 0);
      // Something the tests started may keep the output pipes open after the command ended.
      grace = setTimeout(() => finish({}), GRACE_MS);
    });
    child.on('close', () => finish(size > OUTPUT_LIMIT ? { outputTooLarge: OUTPUT_LIMIT } : {}));
  });
}

function realpath(dir) {
  try {
    return fs.realpathSync(dir);
  } catch {
    return dir;
  }
}

// The git folder that every worktree of one repository shares; a submodule or a nested clone has its own.
function commonDir(root) {
  try {
    return realpath(path.resolve(root, git(root, ['rev-parse', '--git-common-dir']).toString('utf8').trim()));
  } catch {
    return null;
  }
}

// The commits the worktrees and the branches of the repository point at: content that existed
// before the turn.
function knownCommits(root) {
  try {
    const heads = nulList(git(root, ['worktree', 'list', '--porcelain', '-z']))
      .filter((line) => line.startsWith('HEAD ')).map((line) => line.slice('HEAD '.length));
    const tips = git(root, ['for-each-ref', '--format=%(objectname)', 'refs/heads']).toString('utf8').split('\n').filter(Boolean);
    return [...new Set([...heads, ...tips])];
  } catch {
    // None known: a worktree the agent enters later counts as changed.
    return [];
  }
}

// project: the folder the session started in (CLAUDE_PROJECT_DIR). home: its git tree. here: the
// tree of the input's cwd when that is another worktree of the same repository - the agent works
// there now; a submodule or a nested clone is another repository and never counts.
function places(input) {
  const project = realpath(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd());
  const home = repoRoot(project);
  const tree = home && input.cwd ? repoRoot(input.cwd) : null;
  return { project, home, here: tree && tree !== home && commonDir(tree) === commonDir(home) ? tree : null };
}

// The trees a turn is measured in, with the ones it has not seen before joining without a start.
function entered(starts, trees) {
  const all = { ...starts };
  for (const tree of trees) if (tree && !(tree in all)) all[tree] = null;
  return all;
}

// The files of one tree whose content differs from the start of the turn, or null when that cannot
// be told. A tree the agent entered after the start counts as unchanged only while it is clean and
// on a commit a worktree or a branch pointed at when the turn started.
function changesIn(tree, start, known) {
  try {
    if (start) return changedSince(start);
    return known.includes(headCommit(tree)) && dirtyPaths(tree).length === 0 ? [] : null;
  } catch {
    return null;
  }
}

// A .git at or above the folder - a file pointing to a repository, or a folder with a HEAD: it is
// in a git checkout even when git cannot read it.
function inCheckout(dir) {
  for (let at = dir; ; at = path.dirname(at)) {
    const dotGit = path.join(at, '.git');
    try {
      if (fs.statSync(dotGit).isFile() || fs.existsSync(path.join(dotGit, 'HEAD'))) return true;
    } catch {
      // No .git here.
    }
    if (path.dirname(at) === at) return false;
  }
}

// Runs the tests in each folder in turn and stops at the first result that is not green. All runs
// of one Stop share the project's timeout (and each keeps its own), so a Stop never spends more
// than MAX_TIMEOUT_SECONDS on tests - the Stop hook's own timeout is 60 s above it.
async function runAll(dirs, project, budgetSeconds) {
  const runs = [];
  const deadline = Date.now() + budgetSeconds * 1000;
  for (const dir of dirs) {
    const where = path.relative(project, dir);
    const none = (fields) => ({ command: '(none)', source: 'no test command', where, timeoutSeconds: 0, output: '', ...fields });
    let run;
    if (!fs.existsSync(dir)) {
      run = none({ configError: `the project's folder ${where} does not exist in this tree` });
    } else {
      const choice = chooseCommand(readRootFiles(dir), hasPythonFiles(dir));
      const timeoutSeconds = Math.min(choice.timeoutSeconds, Math.ceil((deadline - Date.now()) / 1000));
      if (choice.error) run = none({ configError: choice.error });
      else if (timeoutSeconds < 1) run = { ...none({ configError: 'no time was left for these tests: the runs before them used the whole timeout' }), command: choice.command, source: choice.source };
      else run = { ...(await runTests(dir, { ...choice, timeoutSeconds })), where };
    }
    runs.push(run);
    if (verdict(run).outcome !== 'passed') break;
  }
  return runs;
}

// The turn ends without running the tests: the user sees one line.
function allow(file, state, message) {
  saveState(file, { ...state, blocks: 0, judged: true });
  return { systemMessage: message };
}

async function onStop(input) {
  const { project, home, here } = places(input);
  const file = stateFile(input, project);
  const state = loadState(file);
  const active = input.stop_hook_active === true;
  if (!home) {
    // Outside git nothing tells what changed, so the tests run whenever there are any.
    const choice = chooseCommand(readRootFiles(project), hasPythonFiles(project));
    if (!choice.none) return settle(file, state, await runAll([project], project, choice.timeoutSeconds), active);
    if (!inCheckout(project)) return allow(file, state, 'greenwashing: not a git repository and no test command - tests not run');
    const configError = 'git cannot read the repository this folder is in, so the gate cannot tell what changed (run git status here to see why)';
    return settle(file, state, [{ command: '(none)', source: 'git', timeoutSeconds: 0, configError, output: '' }], active);
  }
  // Every tree the turn has seen, with the project's and the one the agent is in now.
  const starts = entered(state.starts, [home, here]);
  const pending = [];
  let docs = 0;
  for (const [tree, start] of Object.entries(starts)) {
    if (!fs.existsSync(tree)) {
      // A worktree removed during the turn: nothing is left there to test.
      delete starts[tree];
      continue;
    }
    const changed = changesIn(tree, start, state.known);
    const split = changed === null ? null : classify(changed);
    if (split === null || split.code.length > 0) pending.push(tree);
    else docs += split.docs.length;
  }
  const next = { ...state, starts };
  if (pending.length === 0) {
    return allow(file, next, docs === 0 ? 'greenwashing: no files changed this turn - tests not run'
      : `greenwashing: only documentation changed (${docs} file${docs === 1 ? '' : 's'}) - tests not run`);
  }
  // The tests run at the project's place in each tree (the project can be a subfolder of its
  // repository), within the timeout the project sets.
  const budget = readConfig(readRootFiles(project)[CONFIG_FILE]).timeoutSeconds || DEFAULT_TIMEOUT_SECONDS;
  const dirs = pending.map((tree) => path.join(tree, path.relative(home, project)));
  return settle(file, next, await runAll(dirs, project, budget), active);
}

function settle(file, state, runs, stopHookActive) {
  const decision = decide(runs, runs.map(verdict), state, stopHookActive);
  saveState(file, { ...state, blocks: decision.state.blocks, judged: decision.action !== 'block' });
  if (decision.action === 'block') return { decision: 'block', reason: decision.reason };
  return { systemMessage: decision.message };
}

function onPrompt(input) {
  const { project, home, here } = places(input);
  const file = stateFile(input, project);
  const state = loadState(file);
  if (!state.judged && Object.keys(state.starts).length > 0) {
    // No Stop judged the last turn (the user interrupted it, or the API failed): its changes still
    // count, so its starts stay and a tree the agent is in now joins without one. A new prompt
    // still restarts the block count.
    saveState(file, { ...state, starts: entered(state.starts, [home, here]), blocks: 0 });
    return;
  }
  // First forget the last turn, so a snapshot cut short by the hook timeout reads as "unknown".
  saveState(file, NO_STATE);
  const starts = {};
  for (const tree of [home, here]) if (tree) starts[tree] = snapshot(tree);
  saveState(file, { starts, known: home ? knownCommits(home) : [], blocks: 0, judged: false });
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

async function main() {
  const event = process.argv[2];
  if (event !== 'prompt' && event !== 'stop') {
    process.stderr.write('usage: hook.js prompt|stop (hook JSON on stdin)\n');
    process.exit(2);
  }
  let input = {};
  let inputError = null;
  try {
    input = JSON.parse(await readStdin());
  } catch (error) {
    inputError = `the hook input is not JSON (${error.message})`;
  }
  if (event === 'prompt') {
    // Never exit 2 here: on UserPromptSubmit that would block and erase the user's prompt.
    try {
      if (inputError) throw new Error(inputError);
      onPrompt(input);
    } catch (error) {
      process.stderr.write(`greenwashing gate: could not record the start of the turn: ${error.message}\n`);
    }
    return;
  }
  let output;
  try {
    if (inputError) throw new Error(inputError);
    output = await onStop(input);
  } catch (error) {
    // The gate itself failing is "did not run": block like any other red result.
    const file = stateFile(input, realpath(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd()));
    const run = { command: '(gate)', source: 'greenwashing gate', timeoutSeconds: 0, configError: `the gate failed: ${error.message}`, output: '' };
    output = settle(file, loadState(file), [run], input.stop_hook_active === true);
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

main().catch((error) => {
  process.stderr.write(`greenwashing gate failed: ${error.stack || error}\n`);
  process.exit(2);
});
