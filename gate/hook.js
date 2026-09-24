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
const { chooseCommand, ROOT_FILES } = require('./lib/command');
const { verdict, decide } = require('./lib/verdict');

const OUTPUT_LIMIT = 64 * 1024 * 1024;
const GRACE_MS = 5000;
const SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'];

// One file per session and project in a per-user folder of the temp directory: the snapshot the
// turn is measured against, how many times in a row the gate has sent the agent back, and whether
// a Stop has judged the turn (allowed or released it).
function stateFile(input, dir) {
  const key = crypto.createHash('sha256').update(`${input.session_id || 'no-session'}\0${dir}`).digest('hex');
  const user = typeof process.getuid === 'function' ? process.getuid() : 'user';
  return path.join(os.tmpdir(), `greenwashing-gate-${user}`, `${key.slice(0, 32)}.json`);
}

function loadState(file) {
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      snapshot: state.snapshot || null,
      blocks: Number.isInteger(state.blocks) ? state.blocks : 0,
      judged: state.judged === true,
    };
  } catch {
    return { snapshot: null, blocks: 0, judged: false };
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

// Runs the command in a shell, in its own process group, with CI=true (so test scripts do not
// start a watch mode), and collects stdout and stderr together. If the hook itself is stopped,
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

// project: where the session started (CLAUDE_PROJECT_DIR). tree: the git tree the agent works in -
// the input's cwd follows Claude into another worktree of the project's repository, but not into
// another repository (a submodule, a clone). testDir: where the tests run and .greenwashing.json is
// read - the project's place inside that tree.
function places(input) {
  const project = realpath(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd());
  const home = repoRoot(project);
  const here = input.cwd ? repoRoot(input.cwd) : null;
  const tree = here && home && commonDir(here) === commonDir(home) ? here : home;
  return { project, tree, testDir: tree ? path.join(tree, path.relative(home, project)) : project };
}

// The turn ends without running the tests: the user sees one line.
function allow(file, state, message) {
  saveState(file, { snapshot: state.snapshot, blocks: 0, judged: true });
  return { systemMessage: message };
}

async function onStop(input) {
  const { project, tree, testDir } = places(input);
  const file = stateFile(input, project);
  const state = loadState(file);
  let changed = null;
  try {
    // A snapshot of another tree (the agent moved into a worktree) says nothing about this one.
    if (state.snapshot && state.snapshot.root === tree) changed = changedSince(state.snapshot);
  } catch {
    changed = null;
  }
  if (changed !== null) {
    const { code, docs } = classify(changed);
    if (changed.length === 0) return allow(file, state, 'greenwashing: no files changed this turn - tests not run');
    if (code.length === 0) {
      return allow(file, state, `greenwashing: only documentation changed (${docs.length} file${docs.length === 1 ? '' : 's'}) - tests not run`);
    }
  }
  const choice = chooseCommand(readRootFiles(testDir), hasPythonFiles(testDir));
  if (!tree && choice.none) return allow(file, state, 'greenwashing: not a git repository and no test command - tests not run');
  const run = choice.error
    ? { command: '(none)', source: 'no test command', timeoutSeconds: choice.timeoutSeconds, configError: choice.error, output: '' }
    : await runTests(testDir, choice);
  return settle(file, state, run, verdict(run), input.stop_hook_active === true);
}

function settle(file, state, run, result, stopHookActive) {
  const decision = decide(run, result, state, stopHookActive);
  saveState(file, { snapshot: state.snapshot, blocks: decision.state.blocks, judged: decision.action !== 'block' });
  if (decision.action === 'block') return { decision: 'block', reason: decision.reason };
  return { systemMessage: decision.message };
}

function onPrompt(input) {
  const { project, tree } = places(input);
  const file = stateFile(input, project);
  const state = loadState(file);
  if (state.snapshot && !state.judged) {
    // No Stop judged the last turn (the user interrupted it, or the API failed): its changes
    // still count, so the start stays where it was. A new prompt still restarts the block count.
    saveState(file, { ...state, blocks: 0 });
    return;
  }
  // First forget the last turn, so a snapshot cut short by the hook timeout reads as "unknown".
  saveState(file, { snapshot: null, blocks: 0, judged: false });
  saveState(file, { snapshot: snapshot(tree), blocks: 0, judged: false });
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
    output = settle(file, loadState(file), run, verdict(run), input.stop_hook_active === true);
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

main().catch((error) => {
  process.stderr.write(`greenwashing gate failed: ${error.stack || error}\n`);
  process.exit(2);
});
