#!/usr/bin/env node
'use strict';
// The mutation command: it breaks the code lines a change added, one break at a time, in a
// temporary copy of the working tree, and runs the project's tests after each one. A break the tests
// do not notice shows code they do not protect.
//
//   node gate/mutate.js [--base <ref>] [--limit <n>] [--timeout <seconds>] [--run-timeout <seconds>] [--project <folder>]
//
// Exit 0: every break was caught; 1: a break survived; 2: nothing survived, but something did not
// run (a break, the unchanged control run, or the command itself). This file does the I/O (git, the
// copy, the test runs, signals); lib/mutants.js decides.

const { spawnSync, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  chooseCommand, readConfig, pythonOf, CONFIG_FILE, MUTANT_LIMITS,
} = require('./lib/command');
const { verdict } = require('./lib/verdict');
const { lines: outputLines } = require('./lib/parse');
const {
  codeKind, addedLines, jsMutants, fromLines, apply, stillParses, describe, choose, report, OUTCOMES, DEPENDENCY_FOLDERS,
} = require('./lib/mutants');
const { rootFiles, readRootFiles, hasPythonTests, runTests, stopTests, OUTPUT_LIMIT } = require('./runner');

const PYTHON_MUTANTS = path.join(__dirname, 'lib', 'python_mutants.py');
const SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'];
// The default branches a change is measured against, in this order, when --base is not given.
const MAIN_BRANCHES = ['origin/main', 'origin/master', 'main', 'master'];
const USAGE = 'usage: node mutate.js [--base <ref>] [--limit <n>] [--timeout <seconds>] [--run-timeout <seconds>] [--project <folder>]';
const OPTIONS = { '--base': 'base', '--limit': 'limit', '--timeout': 'timeoutSeconds', '--run-timeout': 'runTimeoutSeconds', '--project': 'project' };
// Python leaves no bytecode in the copy: a cached .pyc of the same size and second as a broken file
// would run instead of it.
const RUN_ENV = { PYTHONDONTWRITEBYTECODE: '1' };

// The temporary copy, removed in every outcome: at the end, on an error, and on a signal.
let copy = null;

function removeCopy() {
  if (copy) {
    // rm does not follow the links to the dependency folders: it removes the links.
    fs.rmSync(copy, { recursive: true, force: true });
    copy = null;
  }
}

function onSignal(signal) {
  stopTests();
  removeCopy();
  process.exit(128 + (os.constants.signals[signal] || 0));
}

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: OUTPUT_LIMIT });
}

const nulList = (buffer) => buffer.toString('utf8').split('\0').filter(Boolean);

// The options, or {error}. Numbers are whole and at least 1.
function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = OPTIONS[argv[i]];
    if (!name || argv[i + 1] === undefined) return { error: `unknown or incomplete option ${argv[i]}` };
    if (name in options) return { error: `${argv[i]} given twice` };
    const value = argv[i + 1];
    if (['limit', 'timeoutSeconds', 'runTimeoutSeconds'].includes(name)) {
      if (!/^[1-9]\d*$/.test(value)) return { error: `${argv[i]} takes a whole number from 1` };
      options[name] = Number(value);
    } else options[name] = value;
  }
  return options;
}

function commitOf(root, name) {
  try {
    return git(root, ['rev-parse', '--verify', '--quiet', `${name}^{commit}`]).toString('utf8').trim() || null;
  } catch {
    return null;
  }
}

// The commit the change is measured from: the merge base of HEAD with --base, or with the
// repository's main branch (origin/HEAD, else the first of MAIN_BRANCHES that exists).
function baseOf(home, given) {
  let name = given;
  if (!name) {
    try {
      name = git(home, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']).toString('utf8').trim();
    } catch {
      name = MAIN_BRANCHES.find((branch) => commitOf(home, branch));
    }
  }
  if (!name) return { error: `no main branch found (${MAIN_BRANCHES.join(', ')}); give one with --base` };
  if (!commitOf(home, name)) return { error: `${name} is not a commit` };
  if (!commitOf(home, 'HEAD')) return { error: 'the repository has no commit yet' };
  try {
    const commit = git(home, ['merge-base', name, 'HEAD']).toString('utf8').trim();
    return { name: name.replace(/^refs\/remotes\//, ''), commit };
  } catch {
    return { error: `${name} and HEAD have no common commit` };
  }
}

// The code files the change added lines to, under the project's folder (rel), with those lines:
// [{file (from the repository root), kind, text, lines}], and the files that could not be read.
function changedCode(home, rel, base) {
  const where = rel || '.';
  const tracked = nulList(git(home, ['diff', '--name-only', '-z', '--no-renames', '--diff-filter=AMT', base, '--', where]));
  const untracked = new Set(nulList(git(home, ['ls-files', '-z', '--others', '--exclude-standard', '--', where])));
  const files = [];
  const unread = [];
  for (const file of [...new Set([...tracked, ...untracked])].sort()) {
    const kind = codeKind(file);
    if (!kind) continue;
    let bytes;
    try {
      const stat = fs.lstatSync(path.join(home, file));
      if (!stat.isFile()) continue;
      bytes = fs.readFileSync(path.join(home, file));
    } catch {
      continue;
    }
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) {
      unread.push(`${file} is not UTF-8 text`);
      continue;
    }
    const lines = untracked.has(file) ? new Set(text.split(/\r\n|\r|\n/).map((_, i) => i + 1))
      : addedLines(git(home, ['diff', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', base, '--', file]).toString('utf8'));
    if (lines.size) files.push({ file, kind, text, lines });
  }
  return { files, unread };
}

// Python's breaks of the Python files ([{file, op, start, end, text}] as offsets), or {error}.
function pythonMutants(files, python) {
  if (files.length === 0) return { mutants: [], errors: [] };
  const request = { files: files.map(({ file, text, lines }) => ({ file, text, lines: [...lines] })) };
  const result = spawnSync(python, ['-I', PYTHON_MUTANTS], {
    input: JSON.stringify(request), cwd: os.tmpdir(), timeout: 120000, maxBuffer: OUTPUT_LIMIT, stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.error) return { error: `${python} could not run: ${result.error.code === 'ENOENT' ? 'not found' : result.error.message}` };
  if (result.status !== 0) return { error: `${python} exited with code ${result.status}: ${result.stderr.toString('utf8').trim().split('\n').slice(-2).join(' ')}` };
  let out;
  try {
    out = JSON.parse(result.stdout.toString('utf8'));
  } catch {
    return { error: `${python} printed no list of breaks` };
  }
  const text = Object.fromEntries(files.map((f) => [f.file, f.text.replace(/^﻿/, '')]));
  const bom = Object.fromEntries(files.map((f) => [f.file, f.text.startsWith('﻿') ? 1 : 0]));
  const mutants = out.mutants.map((edit) => ({ file: edit.file, ...fromLines(text[edit.file], [edit])[0] }))
    .map((m) => ({ ...m, start: m.start + bom[m.file], end: m.end + bom[m.file] }));
  return { mutants, errors: out.errors };
}

// A copy of the repository's working tree in a new temporary folder: every file git lists (tracked
// as it is now, and untracked files git does not ignore), symbolic links as links. Dependency folders
// (node_modules, .venv, venv) and submodules are linked, not copied: the same code, the same
// dependencies. No bytecode caches.
function makeCopy(home) {
  copy = fs.mkdtempSync(path.join(os.tmpdir(), 'greenwashing-mutants-'));
  const links = new Set();
  for (const file of new Set(nulList(git(home, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])))) {
    const parts = file.split('/');
    const dependency = parts.findIndex((part) => DEPENDENCY_FOLDERS.has(part));
    if (dependency !== -1) {
      links.add(parts.slice(0, dependency + 1).join('/'));
      continue;
    }
    if (parts.includes('__pycache__') || file.endsWith('.pyc')) continue;
    const from = path.join(home, file);
    const to = path.join(copy, file);
    let stat;
    try {
      stat = fs.lstatSync(from);
    } catch {
      // Deleted in the working tree.
      continue;
    }
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (stat.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(from), to);
    else if (stat.isDirectory()) fs.symlinkSync(from, to);
    else if (stat.isFile()) fs.copyFileSync(from, to);
  }
  for (const entry of nulList(git(home, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory']))) {
    const folder = entry.replace(/\/$/, '');
    if (DEPENDENCY_FOLDERS.has(path.basename(folder))) links.add(folder);
  }
  for (const folder of links) {
    const to = path.join(copy, folder);
    if (fs.existsSync(to) || !fs.existsSync(path.join(home, folder))) continue;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.symlinkSync(path.join(home, folder), to);
  }
  return copy;
}

// The last lines of a run's output, for a control run that was not green.
function tail(output) {
  const all = outputLines(output || '');
  while (all.length && all[all.length - 1] === '') all.pop();
  return all.slice(-20).map((line) => (line.length > 300 ? `${line.slice(0, 300)}...` : line));
}

async function run(argv) {
  const options = parseArgs(argv);
  if (options.error) return { text: `${options.error}\n${USAGE}`, code: 2 };
  const stop = (why) => report({ header: ['greenwashing mutants'], control: 'Control: not run', results: [], notTried: 0, problems: [why] });
  const project = fs.realpathSync(path.resolve(options.project || '.'));
  let home;
  try {
    home = git(project, ['rev-parse', '--show-toplevel']).toString('utf8').trim();
  } catch {
    return stop(`${project} is not in a git repository: the changed lines come from git`);
  }
  const rel = path.relative(home, project);
  const settings = readRootFiles(project)[CONFIG_FILE];
  const config = readConfig(settings);
  if (config.error) return stop(config.error);
  const limits = { ...MUTANT_LIMITS, ...config.mutants };
  for (const key of Object.keys(MUTANT_LIMITS)) if (options[key]) limits[key] = options[key];
  const deadline = Date.now() + limits.timeoutSeconds * 1000;
  const base = baseOf(home, options.base);
  if (base.error) return stop(base.error);

  const { files, unread } = changedCode(home, rel, base.commit);
  const problems = [...unread];
  const all = [];
  for (const { file, text, lines } of files.filter((f) => f.kind === 'js')) {
    for (const m of jsMutants(text, lines)) if (stillParses(file, text, apply(text, m))) all.push({ file, ...m });
  }
  const python = pythonMutants(files.filter((f) => f.kind === 'python'), pythonOf(config, project));
  if (python.error) problems.push(`the Python files could not be read: ${python.error}`);
  else {
    all.push(...python.mutants);
    for (const e of python.errors) problems.push(`${e.file}: ${e.error}`);
  }
  const lineCount = files.reduce((sum, f) => sum + f.lines.size, 0);
  const header = [
    `greenwashing mutants: the code lines changed since ${base.commit.slice(0, 12)} (the merge base with ${base.name}), committed or not`,
    `${files.length} code file${files.length === 1 ? '' : 's'}, ${lineCount} changed line${lineCount === 1 ? '' : 's'}, `
      + `${all.length} place${all.length === 1 ? '' : 's'} to break; ${Math.min(all.length, limits.limit)} tried at most (limit ${limits.limit})`,
  ];
  if (all.length === 0) {
    return report({ header, control: 'Control: not run', results: [], notTried: 0, problems: [...problems, 'no place to break in the changed code lines of JavaScript, TypeScript or Python'] });
  }
  const chosen = choose(all, limits.limit);
  const choice = chooseCommand(rootFiles(project, settings), hasPythonTests(project));
  if (choice.error) return report({ header, control: 'Control: not run', results: [], notTried: 0, problems: [...problems, choice.error] });

  const dir = makeCopy(home);
  const at = path.join(dir, rel);
  const runIn = (seconds) => runTests(at, { ...choice, timeoutSeconds: seconds }, RUN_ENV);
  const left = () => Math.min(limits.runTimeoutSeconds, Math.ceil((deadline - Date.now()) / 1000));
  if (left() < 1) {
    return report({ header, control: 'Control: not run', results: [], notTried: chosen.length, problems: [...problems, `no time was left for the control run: the time for everything is ${limits.timeoutSeconds} s (--timeout)`] });
  }
  // The control: the tests on the unchanged copy must be green, or no break can be judged.
  const control = await runIn(left());
  const green = verdict(control);
  const counts = green.counts ? `${green.counts.passed} passed, ${green.counts.failed} failed, ${green.counts.skipped} skipped` : 'no counts';
  const controlLine = `Control: ${choice.command} (${choice.source}) on the unchanged copy: ${green.outcome}${green.why ? ` - ${green.why}` : ''} (${counts})`;
  if (green.outcome !== 'passed') {
    const why = 'the tests are not green on an unchanged copy of the working tree, so no break can be judged'
      + ' (the copy holds the files git lists, with node_modules, .venv and venv linked)';
    return report({ header, control: [controlLine, ...tail(control.output).map((line) => `  | ${line}`)].join('\n'), results: [], notTried: chosen.length, problems: [...problems, why] });
  }
  const results = [];
  let notTried = 0;
  for (const mutant of chosen) {
    const seconds = left();
    if (seconds < 1) {
      notTried += 1;
      continue;
    }
    const source = files.find((f) => f.file === mutant.file).text;
    const target = path.join(dir, mutant.file);
    fs.writeFileSync(target, apply(source, mutant));
    let outcome;
    try {
      outcome = await runIn(seconds);
    } finally {
      fs.writeFileSync(target, source);
    }
    const result = verdict(outcome);
    results.push({
      file: path.relative(project, path.join(home, mutant.file)), op: mutant.op, ...describe(source, mutant),
      outcome: OUTCOMES[result.outcome], why: result.outcome === 'did not run' ? result.why : '',
    });
  }
  if (notTried) problems.push(`no time was left for ${notTried} of the breaks: the time for everything is ${limits.timeoutSeconds} s (--timeout)`);
  return report({ header, control: controlLine, results, notTried, problems });
}

async function main() {
  for (const signal of SIGNALS) process.on(signal, onSignal);
  let outcome;
  try {
    outcome = await run(process.argv.slice(2));
  } catch (error) {
    outcome = { text: `greenwashing mutants: did not run - the command failed: ${error.message}`, code: 2 };
  } finally {
    removeCopy();
  }
  process.stdout.write(`${outcome.text}\n`);
  process.exitCode = outcome.code;
}

main();
