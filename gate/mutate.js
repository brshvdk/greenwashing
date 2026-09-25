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
  chooseCommand, readConfig, pythonOf, CONFIG_FILE, MUTANT_LIMITS, MUTANT_MAX,
} = require('./lib/command');
const { verdict } = require('./lib/verdict');
const { lines: outputLines } = require('./lib/parse');
const {
  codeKind, addedLines, ownLines, jsMutants, fromLines, touches, apply, stillParses, describe, choose, report, OUTCOMES, OPERATORS, DEPENDENCY_FOLDERS,
} = require('./lib/mutants');
const { rootFiles, readRootFiles, hasPythonTests, runTests, stopTests, OUTPUT_LIMIT } = require('./runner');

const PYTHON_MUTANTS = path.join(__dirname, 'lib', 'python_mutants.py');
const SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT'];
// The default branches a change is measured against, in this order, when --base is not given.
const MAIN_BRANCHES = ['origin/main', 'origin/master', 'main', 'master'];
const USAGE = 'usage: node mutate.js [--base <ref>] [--limit <n>] [--timeout <seconds>] [--run-timeout <seconds>] [--project <folder>]';
const OPTIONS = { '--base': 'base', '--limit': 'limit', '--timeout': 'timeoutSeconds', '--run-timeout': 'runTimeoutSeconds', '--project': 'project' };
// Python leaves no bytecode in the copy: a cached .pyc of the same size and second as a broken file
// would run instead of it.
const RUN_ENV = { PYTHONDONTWRITEBYTECODE: '1' };

// The temporary copy, removed in every outcome: at the end, on an error, and on a signal.
let copy = null;

// Returns null, or why the copy could not be removed.
function removeCopy() {
  if (!copy) return null;
  const dir = copy;
  copy = null;
  try {
    // rm does not follow the links to the dependency folders: it removes the links.
    fs.rmSync(dir, { recursive: true, force: true });
    return null;
  } catch {
    // A folder the tests left without write permission: made writable again, never through a link.
    const open = (at) => {
      try {
        if (!fs.lstatSync(at).isDirectory()) return;
        fs.chmodSync(at, 0o700);
        for (const name of fs.readdirSync(at)) open(path.join(at, name));
      } catch {
        // Said below if the copy still cannot be removed.
      }
    };
    open(dir);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return null;
    } catch (error) {
      return `the copy could not be removed: ${error.message}`;
    }
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
      if (!/^[1-9]\d*$/.test(value) || Number(value) > MUTANT_MAX) return { error: `${argv[i]} takes a whole number from 1 to ${MUTANT_MAX}` };
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
  // git diff refreshes the stat data in the user's index unless told not to.
  const diff = ['-c', 'diff.autoRefreshIndex=false', 'diff', '--no-renames', '--no-ext-diff', '--no-textconv', '--no-color'];
  const tracked = nulList(git(home, [...diff, '--name-only', '-z', '--diff-filter=AMT', base, '--', where]));
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
    // As text, whatever .gitattributes says (-diff, binary).
    const lines = untracked.has(file) ? new Set(text.replace(/(?:\r\n|\r|\n)$/, '').split(/\r\n|\r|\n/).map((_, i) => i + 1))
      : ownLines(text, addedLines(git(home, [...diff, '-U0', '--text', base, '--', file]).toString('utf8')));
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
  // EPIPE: it exited before it read the request; its exit code and message say why.
  if (result.error && !(result.error.code === 'EPIPE' && result.status !== null)) {
    return { error: `${python} could not run: ${result.error.code === 'ENOENT' ? 'not found' : result.error.message}` };
  }
  if (result.status !== 0) return { error: `${python} exited with code ${result.status}: ${result.stderr.toString('utf8').trim().split('\n').slice(-2).join(' ')}` };
  let out;
  try {
    out = JSON.parse(result.stdout.toString('utf8'));
  } catch {
    // Said below.
  }
  if (!out || !Array.isArray(out.mutants) || !Array.isArray(out.errors)) return { error: `${python} printed no list of breaks` };
  const text = Object.fromEntries(files.map((f) => [f.file, f.text.replace(/^\uFEFF/, '')]));
  const bom = Object.fromEntries(files.map((f) => [f.file, f.text.startsWith('\uFEFF') ? 1 : 0]));
  const place = (at) => Array.isArray(at) && at.length === 2 && at.every(Number.isInteger) && at[0] >= 1;
  // An edit that names no file of the list or no place is kept as one of no kind: touches() drops it.
  const mutants = out.mutants.map((edit) => (edit && Object.hasOwn(text, edit.file) && place(edit.start) && place(edit.end)
    ? { file: edit.file, ...fromLines(text[edit.file], [edit])[0] } : { file: null, op: null }))
    .map((m) => (m.file === null ? m : { ...m, start: m.start + bom[m.file], end: m.end + bom[m.file] }));
  return { mutants, errors: out.errors };
}

// A copy of the repository's working tree in a new temporary folder: every file git lists (tracked
// as it is now, and untracked files git does not ignore), symbolic links as links. Dependency folders
// (.venv, venv, the entries of node_modules), submodules and nested repositories are linked, not
// copied: the same code, the same dependencies. No bytecode caches.
function makeCopy(home) {
  copy = fs.mkdtempSync(path.join(os.tmpdir(), 'greenwashing-mutants-'));
  const links = new Set();
  // A nested repository comes as its folder, with a slash at the end.
  for (const file of new Set(nulList(git(home, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])).map((entry) => entry.replace(/\/$/, '')))) {
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
    if (path.basename(folder) === 'node_modules') linkModules(home, path.join(home, folder), to);
    else fs.symlinkSync(path.join(home, folder), to);
  }
  return copy;
}

// The tools' caches in node_modules: the copy keeps its own, so the runs never write into the user's.
const MODULE_CACHES = new Set(['.cache', '.vite', '.vitest']);

// node_modules as a folder of the copy's own with a link to each entry of the user's (in a scope
// folder, @name, each entry of it): the caches stay out (MODULE_CACHES), and an entry that links into
// the repository (a workspace package) links to the copy's files, so its breaks reach the tests.
function linkModules(home, from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (MODULE_CACHES.has(entry.name)) continue;
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.name.startsWith('@') && entry.isDirectory()) {
      linkModules(home, source, target);
      continue;
    }
    let inside = null;
    if (entry.isSymbolicLink()) {
      try {
        const rel = path.relative(home, fs.realpathSync(source));
        if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) inside = path.join(copy, rel);
      } catch {
        // A broken link stays one.
      }
    }
    fs.symlinkSync(inside || source, target);
  }
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
  const interpreter = pythonOf(config, project);
  const python = pythonMutants(files.filter((f) => f.kind === 'python'), interpreter);
  if (python.error) problems.push(`the Python files could not be read: ${python.error}`);
  else {
    // Only breaks of a known kind on a changed line: the interpreter is the project's to choose.
    const known = python.mutants.filter((m) => files.some((f) => f.file === m.file && touches(f.text, m, f.lines)));
    all.push(...known);
    if (known.length < python.mutants.length) {
      problems.push(`${python.mutants.length - known.length} of the breaks ${interpreter} gave were not of a known kind on a changed line, and were not tried`);
    }
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
  // The report once the copy is gone: a copy that cannot be removed is said, and is did not run.
  const done = (fields) => {
    const left = removeCopy();
    return report({ header, results: [], notTried: 0, ...fields, problems: [...problems, ...(fields.problems || []), ...(left ? [left] : [])] });
  };
  const left = () => Math.min(limits.runTimeoutSeconds, Math.ceil((deadline - Date.now()) / 1000));
  if (left() < 1) {
    return done({ control: 'Control: not run', notTried: chosen.length, problems: [`no time was left for the control run: the time for everything is ${limits.timeoutSeconds} s (--timeout)`] });
  }
  // The control: the tests on the unchanged copy must be green, or no break can be judged.
  const control = await runIn(left());
  const green = verdict(control);
  const counts = green.counts ? `${green.counts.passed} passed, ${green.counts.failed} failed, ${green.counts.skipped} skipped` : 'no counts';
  const controlLine = `Control: ${choice.command} (${choice.source}) on the unchanged copy: ${green.outcome}${green.why ? ` - ${green.why}` : ''} (${counts})`;
  if (green.outcome !== 'passed') {
    const why = 'the tests are not green on an unchanged copy of the working tree, so no break can be judged'
      + ' (the copy holds the files git lists, with node_modules, .venv and venv linked)';
    return done({ control: [controlLine, ...tail(control.output).map((line) => `  | ${line}`)].join('\n'), notTried: chosen.length, problems: [why] });
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
  return done({ control: controlLine, results, notTried });
}

async function main() {
  for (const signal of SIGNALS) process.on(signal, onSignal);
  let outcome;
  try {
    outcome = await run(process.argv.slice(2));
  } catch (error) {
    outcome = { text: `greenwashing mutants: did not run - the command failed: ${error.message}`, code: 2 };
  } finally {
    // Gone already, but for an error on the way.
    removeCopy();
  }
  process.stdout.write(`${outcome.text}\n`);
  process.exitCode = outcome.code;
}

main();
