'use strict';
// The I/O the gate's two entry points share (hook.js and mutate.js): which files the test command is
// chosen from, running it the way the gate does, and whether the temp folder is safe to work in.

const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isPythonTest, ROOT_FILES, CONFIG_FILE } = require('./lib/command');

const OUTPUT_LIMIT = 64 * 1024 * 1024;
const GRACE_MS = 5000;

// The test command running now, so that a signal to the process stops it too (stopTests).
let running = null;

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

// The root files the command is chosen from, with the gate's settings (the project's) in place of
// the folder's own .greenwashing.json.
function rootFiles(dir, settings) {
  return { ...readRootFiles(dir), [CONFIG_FILE]: settings };
}

// Python test files git knows of, tracked or not ignored; outside git, the folder's own files only.
// options: git's own options for this call (the gate's temporary checkouts run no fsmonitor).
function hasPythonTests(dir, options = []) {
  try {
    const listed = execFileSync('git', [...options, '-C', dir, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.py'],
      { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: OUTPUT_LIMIT });
    return listed.toString('utf8').split('\0').filter(Boolean).some(isPythonTest);
  } catch {
    return fs.readdirSync(dir).some(isPythonTest);
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

// Stops the test command running now, with every process it started.
function stopTests() {
  if (running) killGroup(running);
}

// Runs the command in a shell, in its own process group, with CI=true (test scripts that check it
// skip their watch mode) and the extra environment given, and collects stdout and stderr together.
// If the caller is stopped, it stops the command's whole process group with stopTests().
function runTests(dir, choice, env = {}) {
  return new Promise((resolve) => {
    const run = { command: choice.command, source: choice.source, timeoutSeconds: choice.timeoutSeconds, exitCode: null, output: '' };
    const chunks = [];
    let size = 0;
    let child;
    try {
      child = spawn(choice.command, {
        cwd: dir, shell: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...env, CI: 'true' },
      });
    } catch (error) {
      resolve({ ...run, startError: error.message });
      return;
    }
    running = child;
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
      running = null;
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

// The temp folder (os.tmpdir()) when other users can write to it without the sticky bit: they could
// move a folder made there away and put one of their own in its place. Null when it is not so, or on
// Windows (no permission bits). A missing folder is said where it is used.
function sharedTemp() {
  if (typeof process.getuid !== 'function') return null;
  let mode;
  try {
    ({ mode } = fs.statSync(os.tmpdir()));
  } catch {
    return null;
  }
  return (mode & 0o002) !== 0 && (mode & 0o1000) === 0 ? os.tmpdir() : null;
}

module.exports = { readRootFiles, rootFiles, hasPythonTests, runTests, stopTests, sharedTemp, OUTPUT_LIMIT };
