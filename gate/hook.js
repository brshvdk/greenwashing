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

// One file per session and project in the temp directory: the snapshot of the turn's start
// and how many times in a row the gate has sent the agent back.
function stateFile(input, dir) {
  const key = crypto.createHash('sha256').update(`${input.session_id || 'no-session'}\0${dir}`).digest('hex');
  return path.join(os.tmpdir(), 'greenwashing-gate', `${key.slice(0, 32)}.json`);
}

function loadState(file) {
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { snapshot: state.snapshot || null, blocks: Number.isInteger(state.blocks) ? state.blocks : 0 };
  } catch {
    return { snapshot: null, blocks: 0 };
  }
}

function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
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

function snapshot(dir) {
  const root = repoRoot(dir);
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

// Runs the command in a shell, in its own process group, and collects stdout and stderr together.
function runTests(dir, choice) {
  return new Promise((resolve) => {
    const run = { command: choice.command, source: choice.source, timeoutSeconds: choice.timeoutSeconds, exitCode: null, output: '' };
    const chunks = [];
    let size = 0;
    let child;
    try {
      child = spawn(choice.command, { cwd: dir, shell: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ ...run, startError: error.message });
      return;
    }
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

function projectDir(input) {
  return process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
}

async function onStop(input) {
  const dir = projectDir(input);
  const file = stateFile(input, dir);
  const state = loadState(file);
  let changed = null;
  try {
    changed = changedSince(state.snapshot);
  } catch {
    changed = null;
  }
  if (changed !== null) {
    const { code, docs } = classify(changed);
    if (changed.length === 0 || code.length === 0) {
      saveState(file, { snapshot: state.snapshot, blocks: 0 });
      return {
        systemMessage: changed.length === 0
          ? 'greenwashing: no files changed this turn - tests not run'
          : `greenwashing: only documentation changed (${docs.length} file${docs.length === 1 ? '' : 's'}) - tests not run`,
      };
    }
  }
  const choice = chooseCommand(readRootFiles(dir), hasPythonFiles(dir));
  const run = choice.error
    ? { command: '(none)', source: 'no test command', timeoutSeconds: choice.timeoutSeconds, configError: choice.error, output: '' }
    : await runTests(dir, choice);
  return settle(file, state, run, verdict(run), input.stop_hook_active === true);
}

function settle(file, state, run, result, stopHookActive) {
  const decision = decide(run, result, state, stopHookActive);
  saveState(file, { snapshot: state.snapshot, blocks: decision.state.blocks });
  if (decision.action === 'block') return { decision: 'block', reason: decision.reason };
  return { systemMessage: decision.message };
}

function onPrompt(input) {
  const dir = projectDir(input);
  const file = stateFile(input, dir);
  // First forget the last turn, so a snapshot cut short by the hook timeout reads as "unknown".
  saveState(file, { snapshot: null, blocks: 0 });
  saveState(file, { snapshot: snapshot(dir), blocks: 0 });
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
    const dir = projectDir(input);
    const file = stateFile(input, dir);
    const run = { command: '(gate)', source: 'greenwashing gate', timeoutSeconds: 0, configError: `the gate failed: ${error.message}`, output: '' };
    output = settle(file, loadState(file), run, verdict(run), input.stop_hook_active === true);
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

main().catch((error) => {
  process.stderr.write(`greenwashing gate failed: ${error.stack || error}\n`);
  process.exit(2);
});
