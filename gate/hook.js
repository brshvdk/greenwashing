#!/usr/bin/env node
'use strict';
// The gate's Claude Code hook. `node hook.js prompt` runs on UserPromptSubmit: it records what
// the working tree looks like at the start of the turn. `node hook.js stop` runs on Stop: when
// the turn changed code, it runs the tests and blocks the stop unless they passed. This file only
// does I/O (hook JSON, git, files, the test process); every decision is made in lib/.

const { spawnSync, execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { candidatePaths, changedPaths, classify } = require('./lib/changes');
const { checkJs, jsTests, removedTests, testFileKind } = require('./lib/checks');
const {
  chooseCommand, readConfig, pythonOf, CONFIG_FILE, CHECKS, DEFAULT_TIMEOUT_SECONDS, PYTHON_HOW_TO,
} = require('./lib/command');
const { lineChanges, splitLines } = require('./lib/diff');
const {
  verdict, decide, removedNote, PERMISSION_WORDS,
} = require('./lib/verdict');
const {
  readRootFiles, rootFiles, hasPythonTests, runTests, stopTests, OUTPUT_LIMIT,
} = require('./runner');

// The start text of a test file that is dirty when the turn starts is kept up to this size; past it
// every line of the file counts as changed.
const TEXT_LIMIT = 1024 * 1024;
const PYTHON_CHECKS = path.join(__dirname, 'lib', 'python_checks.py');
const PYTHON_CHECKS_SECONDS = 60;
const SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP'];
// The words in the user's prompt that let the turn remove tests (GW-17): in any case, any spaces between.
const PERMISSION = new RegExp(`(?<![\\w-])${PERMISSION_WORDS.split(' ').join('\\s+')}(?![\\w-])`, 'i');

// While a Stop runs: the temporary checkouts (folder -> repository), so that a signal to the hook
// removes them too, as it stops the test command running now.
const checkouts = new Map();

function onSignal(signal) {
  stopTests();
  for (const [dir, root] of checkouts) removeWorktree(root, dir);
  process.exit(128 + (os.constants.signals[signal] || 0));
}

// One file per session and project in a per-user folder of the temp directory. starts: in every git
// tree the turn has seen, the last state the gate accepted - a snapshot taken at the prompt after an
// accepted turn, or null for a tree the agent entered after it; turn: the gate's settings files of
// each tree at the latest prompt, a file the agent changed in a turn before and left as it was kept
// at its earlier state (a snapshot of those files only); settings: the project's .greenwashing.json
// text taken with them (null: none; missing: no prompt recorded); stopped: the gate's settings files of
// each tree as the gate last saw them, at the latest prompt or Stop; seen: the branch and commit each
// tree had when the gate last saw it; known: the commits the worktrees and branches of the repository
// pointed at when the starts were taken; blocks: how many times in a row the gate has sent the agent
// back; accepted: a Stop has let the turn end with green tests or with no code changed. stopped also
// holds the test files, and adopted, per tree, the test files the user changed between turns the
// gate did not accept, as they were at the prompt after (text, or null: gone): tests they no longer
// have were removed by the user, not the agent. allowRemoval: the user's prompt for this turn lets it
// remove tests (PERMISSION).
const NO_STATE = { starts: {}, turn: {}, stopped: {}, adopted: {}, seen: {}, known: [], blocks: 0, accepted: false, allowRemoval: false };

function stateFile(input, dir) {
  const key = crypto.createHash('sha256').update(`${input.session_id || 'no-session'}\0${dir}`).digest('hex');
  const user = typeof process.getuid === 'function' ? process.getuid() : 'user';
  return path.join(os.tmpdir(), `greenwashing-gate-${user}`, `${key.slice(0, 32)}.json`);
}

function loadState(file) {
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
    if (!isObject(state.starts) || !isObject(state.seen) || !Array.isArray(state.known)) return NO_STATE;
    return {
      starts: state.starts,
      turn: isObject(state.turn) ? state.turn : {},
      ...(typeof state.settings === 'string' || state.settings === null ? { settings: state.settings } : {}),
      stopped: isObject(state.stopped) ? state.stopped : {},
      adopted: isObject(state.adopted) ? state.adopted : {},
      seen: state.seen,
      known: state.known,
      blocks: Number.isInteger(state.blocks) ? state.blocks : 0,
      accepted: state.accepted === true,
      allowRemoval: state.allowRemoval === true,
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
  const text = committedBlob(root, commit, file);
  return text === null ? null : hash(text);
}

function committedBlob(root, commit, file) {
  if (!commit) return null;
  try {
    return git(root, ['cat-file', 'blob', `${commit}:${file}`]);
  } catch {
    return null;
  }
}

// A file's text in the working tree, or null when it is not a regular file of at most `limit` bytes.
function worktreeText(root, file, limit = OUTPUT_LIMIT) {
  const full = path.join(root, file);
  try {
    const stat = fs.lstatSync(full);
    return stat.isFile() && stat.size <= limit ? fs.readFileSync(full, 'utf8') : null;
  } catch {
    return null;
  }
}

// The branch a tree has checked out (null when its HEAD is detached) and its commit.
function sighting(root) {
  let branch = null;
  try {
    branch = git(root, ['symbolic-ref', '-q', 'HEAD']).toString('utf8').trim();
  } catch {
    // Detached HEAD.
  }
  return { branch, head: headCommit(root) };
}

// A settings file of the gate, in any folder.
const isSettings = (file) => path.basename(file) === CONFIG_FILE;
// What the gate records of a tree as it last saw it: its settings files and its test files.
const isWatched = (file) => isSettings(file) || testFileKind(file) !== null;

// The state of one tree: HEAD, a hash of every dirty file (of those `only` keeps), and the text of
// each dirty test file (a clean one's is in HEAD), for the lines a turn changes in it. settings: the
// project's settings file in the project's own tree (null in another worktree, whose own is ignored);
// it counts as dirty whatever git says: git does not list it when it is ignored.
function snapshot(root, settings, only = () => true) {
  if (!root) return null;
  const head = headCommit(root);
  const dirty = {};
  const texts = {};
  for (const file of dirtyPaths(root).filter(only)) {
    dirty[file] = worktreeHash(root, file);
    const text = testFileKind(file) ? worktreeText(root, file, TEXT_LIMIT) : null;
    if (text !== null) texts[file] = text;
  }
  if (settings) dirty[settings] = worktreeHash(root, settings);
  return { root, head, dirty, texts };
}

// What differs from a start ({head, dirty, texts}) in a working tree ({tree}) or a commit
// ({commit}), among the files `only` keeps; git runs in root. Returns {files, before(file),
// after(file)}: the changed files and their texts then and now (null: the file did not exist, or its
// start text was not kept).
function turnDiff(root, start, now, only = () => true) {
  const head = now.tree ? headCommit(now.tree) : now.commit;
  const texts = start.texts || {};
  const candidates = candidatePaths(Object.keys(start.dirty), now.tree ? dirtyPaths(now.tree) : [], committedPaths(root, start.head, head)).filter(only);
  const before = {};
  const after = {};
  for (const file of candidates) {
    before[file] = file in start.dirty ? start.dirty[file] : committedHash(root, start.head, file);
    after[file] = now.tree ? worktreeHash(now.tree, file) : committedHash(root, now.commit, file);
  }
  const text = (blob) => (blob === null ? null : blob.toString('utf8'));
  return {
    files: changedPaths(before, after),
    before: (file) => (file in start.dirty ? texts[file] ?? null : text(committedBlob(root, start.head, file))),
    after: (file) => (now.tree ? worktreeText(now.tree, file) : text(committedBlob(root, now.commit, file))),
  };
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
    const tips = git(root, ['for-each-ref', '--format=%(objectname)', 'refs/heads', 'refs/remotes']).toString('utf8').split('\n').filter(Boolean);
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

const NO_DIFF = { files: [], before: () => null, after: () => null };

// The project's settings file in its tree; rel: the project's place in its repository.
const settingsPath = (rel) => (rel ? `${rel}/${CONFIG_FILE}` : CONFIG_FILE);

// What changed in one tree since the start of the turn ({files, before, after} of turnDiff), or
// null when that cannot be told. A tree the agent entered after the start counts as unchanged only
// while it is clean and on a commit a worktree or a branch pointed at when the turn started.
function changesIn(tree, start, known) {
  try {
    if (start) return repoRoot(start.root) === start.root ? turnDiff(start.root, start, { tree: start.root }) : null;
    return known.includes(headCommit(tree)) && dirtyPaths(tree).length === 0 ? NO_DIFF : null;
  } catch {
    return null;
  }
}

// For a tree or commit the gate has no start for: what differs from the newest commit on its
// first-parent line that existed when the turn started (reachable from a commit in known), or from
// nothing when there is none. Null when git cannot tell.
function sinceKnown(root, now, known) {
  // A folder that is not the top of its own checkout any more would be read as its parent repository.
  if (now.tree && repoRoot(now.tree) !== now.tree) return null;
  try {
    const head = now.tree ? headCommit(now.tree) : now.commit;
    let base = null;
    if (head) {
      const input = known.map((commit) => `^${commit}\n`).join('');
      const fresh = execFileSync('git', ['-C', root, 'rev-list', '--first-parent', '--count', '--ignore-missing', '--stdin', head],
        { input, stdio: ['pipe', 'pipe', 'ignore'] }).toString('utf8').trim();
      base = commitOf(root, `${head}~${fresh}`);
    }
    return turnDiff(root, { head: base, dirty: {} }, now);
  } catch {
    return null;
  }
}

// What a worktree removed during the turn left behind: the tip of the branch it had when the gate
// last saw it (or, with that branch gone too, the commit it had then). Nothing to test when that
// commit existed when the turn started, is already in the project's HEAD, or - its branch gone - no
// branch or tag holds it any more (the work was thrown away).
function leftBehind(home, last, known) {
  const tip = last && last.branch && commitOf(home, last.branch);
  const commit = tip || commitOf(home, last && last.head);
  if (!commit) return { error: 'the commit it left cannot be found' };
  if (known.includes(commit) || isAncestor(home, commit, 'HEAD')) return { nothing: true };
  if (!tip && !isReferenced(home, commit)) return { nothing: true };
  return { commit, branch: tip ? last.branch : null };
}

// A branch, remote branch or tag contains the commit.
function isReferenced(root, commit) {
  try {
    return git(root, ['for-each-ref', '--contains', commit, '--count=1', '--format=%(refname)']).length > 0;
  } catch {
    return true;
  }
}

function commitOf(root, name) {
  if (!name) return null;
  try {
    return git(root, ['rev-parse', '--verify', '--quiet', `${name}^{commit}`]).toString('utf8').trim() || null;
  } catch {
    return null;
  }
}

function isAncestor(root, commit, of) {
  try {
    git(root, ['merge-base', '--is-ancestor', commit, of]);
    return true;
  } catch {
    return false;
  }
}

// Removes the gate's own temporary checkout and nothing else: `git worktree prune` would also drop
// the user's worktrees whose folder is away.
function removeWorktree(root, dir) {
  try {
    git(root, ['worktree', 'remove', '--force', dir]);
  } catch {
    // Not a worktree: git never made it, or removed it itself when the checkout failed.
  }
  checkouts.delete(dir);
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

// A run that did not start: the reason says why.
const notRun = (where, configError, fields = {}) => ({ command: '(none)', source: 'no test command', where, timeoutSeconds: 0, output: '', configError, ...fields });

// The tests at dir, with the gate's settings (the project's .greenwashing.json text at the start of
// the turn), within the deadline. A folder of another tree that has a .greenwashing.json of its own
// that differs is told so: that one is ignored.
async function runIn(dir, where, deadline, settings) {
  if (!fs.existsSync(dir)) return notRun(where, "the project's folder is missing there");
  const own = readRootFiles(dir)[CONFIG_FILE];
  const note = where && own !== null && own !== settings ? { ignoredSettings: true } : {};
  const choice = chooseCommand(rootFiles(dir, settings), hasPythonTests(dir));
  if (choice.error) return notRun(where, choice.error, note);
  const timeoutSeconds = Math.min(choice.timeoutSeconds, Math.ceil((deadline - Date.now()) / 1000));
  if (timeoutSeconds < 1) {
    return notRun(where, 'no time was left for these tests: the runs before them used the whole timeout', { command: choice.command, source: choice.source, ...note });
  }
  return { ...(await runTests(dir, { ...choice, timeoutSeconds })), where, ...note };
}

// The tests of a commit no tree has checked out any more: in a temporary worktree of the
// repository, removed afterwards whatever the outcome.
async function runAtCommit(home, project, target, deadline, settings) {
  // A new path: git makes the folder, and removes it again when the checkout fails.
  const dir = path.join(os.tmpdir(), `greenwashing-gate-check-${crypto.randomBytes(8).toString('hex')}`);
  checkouts.set(dir, home);
  try {
    try {
      git(home, ['worktree', 'add', '--detach', '--quiet', dir, target.commit]);
    } catch {
      return notRun(target.where, `commit ${target.commit} could not be checked out`);
    }
    return await runIn(path.join(dir, path.relative(home, project)), target.where, deadline, settings);
  } finally {
    removeWorktree(home, dir);
  }
}

// Runs the tests of each target in turn and stops at the first result that is not green. A
// target is a folder to test, a commit to test in a temporary checkout, or an error. The checks and
// all runs of one Stop share the project's timeout (deadline), so a Stop never spends more than
// MAX_TIMEOUT_SECONDS - the Stop hook's own timeout is 60 s above it. settings: the gate's settings.
async function runAll(targets, project, home, deadline, settings) {
  const runs = [];
  for (const target of targets) {
    let run;
    if (target.error) run = notRun(target.where, target.error);
    else if (target.commit) run = await runAtCommit(home, project, target, deadline, settings);
    else run = await runIn(target.dir, path.relative(project, target.dir), deadline, settings);
    runs.push(run);
    if (verdict(run).outcome !== 'passed') break;
  }
  return runs;
}

// The turn ends without running the tests: the user sees one line.
function allow(file, state, message) {
  saveState(file, { ...state, blocks: 0, accepted: true });
  return { systemMessage: message };
}

async function onStop(input) {
  const { project, home, here } = places(input);
  const file = stateFile(input, project);
  const state = loadState(file);
  const active = input.stop_hook_active === true;
  // The gate's settings: the project's .greenwashing.json as it was at the start of the turn, for
  // every tree; with no prompt recorded, as it is now.
  const settings = 'settings' in state ? state.settings : readRootFiles(project)[CONFIG_FILE];
  if (!home) {
    // Outside git nothing tells what changed, so the tests run whenever there are any.
    const choice = chooseCommand(rootFiles(project, settings), hasPythonTests(project));
    if (!choice.none) {
      // Nothing tells which test lines changed either, so the quick checks cannot run: the user sees it.
      const outcome = settle(file, state, await runAll([{ dir: project }], project, null, Date.now() + choice.timeoutSeconds * 1000, settings), active);
      if (outcome.systemMessage) outcome.systemMessage += '; quick checks of changed tests not run (not a git repository)';
      return outcome;
    }
    if (!inCheckout(project)) return allow(file, state, 'greenwashing: not a git repository and no test command - tests not run');
    const configError = 'git cannot read the repository this folder is in, so the gate cannot tell what changed (run git status here to see why)';
    return settle(file, state, [{ command: '(none)', source: 'git', timeoutSeconds: 0, configError, output: '' }], active);
  }
  // With no start recorded (the prompt hook did not run, or failed), nothing tells which lines the
  // turn changed: the tests run, as for any change that cannot be told, but the checks cannot. Only
  // the prompt records a start; a Stop keeps the trees it saw with none.
  const recorded = Object.values(state.starts).some((start) => start !== null);
  // Every tree the turn has seen, with the project's and the one the agent is in now.
  const starts = entered(state.starts, [home, here]);
  const seen = { ...state.seen };
  const pending = [];
  const removed = [];
  // What the quick checks read: for each tree with code changes and each removed worktree's
  // commit, its changes since the start and its settings files changed since the start of this
  // turn (null: git cannot tell), and how to name its files.
  const checked = [];
  // The settings files of each tree as this Stop sees them: the next prompt tells by them whether a
  // settings change that is still there was the agent's (as the Stop saw it) or a human's (changed since).
  const stopped = {};
  const settingsFile = settingsPath(path.relative(home, project));
  let docs = 0;
  for (const [tree, start] of Object.entries(starts)) {
    if (!fs.existsSync(tree)) {
      // A worktree removed during the turn: what it left in its branch is tested, unless the
      // project already holds it or it is older than the turn.
      // Judged again at every Stop of the turn: the project's HEAD may still move.
      const left = leftBehind(home, seen[tree], state.known);
      const name = path.relative(project, tree);
      if (left.error) {
        removed.push({ where: name, error: `the worktree ${name} was removed and ${left.error}` });
      } else if (!left.nothing) {
        const branch = left.branch ? `branch ${left.branch.replace(/^refs\/heads\//, '')}` : 'no branch';
        removed.push({ commit: left.commit, where: `a temporary checkout of ${left.commit.slice(0, 12)} (${branch}), the last commit of the removed worktree ${name}` });
        const now = { commit: left.commit };
        let diff = null;
        try {
          diff = start ? turnDiff(home, start, now) : sinceKnown(home, now, state.known);
        } catch {
          // Stays null: git cannot tell what the commit changed.
        }
        checked.push({
          diff, settings: settingsIn(home, state.turn[tree], now, diff), adopted: state.adopted[tree] || {}, label: `the removed worktree ${name}`,
          show: (f) => `${f} (last commit of the removed worktree ${name})`,
        });
      }
      continue;
    }
    seen[tree] = sighting(tree);
    try {
      if (repoRoot(tree) === tree) stopped[tree] = { ...snapshot(tree, tree === home ? settingsFile : null, isWatched), texts: {} };
    } catch {
      // No record: the next prompt takes the settings of this tree as they are then.
    }
    const changed = changesIn(tree, start, state.known);
    const split = changed === null ? null : classify(changed.files);
    const diff = changed || sinceKnown(tree, { tree }, state.known);
    const edited = settingsIn(tree, state.turn[tree], { tree }, diff);
    // A settings file changed since the start of this turn counts too, also when it is back as it was
    // at the start of the work.
    if (split === null || split.code.length > 0 || edited === null || edited.length > 0) {
      pending.push(tree);
      checked.push({
        diff, settings: edited, adopted: state.adopted[tree] || {}, label: path.relative(project, tree) || 'the project',
        show: (f) => path.relative(project, path.join(tree, f)),
      });
    } else docs += split.docs.length;
  }
  const next = { ...state, starts, seen, stopped };
  if (pending.length === 0 && removed.length === 0) {
    return allow(file, next, docs === 0 ? 'greenwashing: no files changed this turn - tests not run'
      : `greenwashing: only documentation changed (${docs} file${docs === 1 ? '' : 's'}) - tests not run`);
  }
  // The checks, then the tests at the project's place in each tree (the project can be a subfolder
  // of its repository), within the timeout the project sets.
  const config = readConfig(settings);
  const deadline = Date.now() + (config.timeoutSeconds || DEFAULT_TIMEOUT_SECONDS) * 1000;
  const checks = recorded ? quickChecks(checked, config, project, deadline, state.allowRemoval) : { problem: null, permitted: [] };
  if (checks.problem) return settle(file, next, [checks.problem], active);
  const targets = [...pending.map((tree) => ({ dir: path.join(tree, path.relative(home, project)) })), ...removed];
  const outcome = settle(file, next, await runAll(targets, project, home, deadline, settings), active, removedNote(checks.permitted));
  if (!recorded && outcome.systemMessage) outcome.systemMessage += '; quick checks of changed tests not run (no start of the turn was recorded)';
  return outcome;
}

// The gate's settings files that differ from the start of this turn (turnStart: the snapshot of
// them the latest prompt took), in a working tree ({tree}) or a commit ({commit}); git runs in root.
// A human changes them between turns, so only a change during the turn counts, even while the start
// of the work stays older. With no such snapshot, those the diff since the start holds. Null when
// git cannot tell.
function settingsIn(root, turnStart, now, diff) {
  if (!turnStart) return diff ? diff.files.filter(isSettings) : null;
  try {
    if (now.tree && repoRoot(now.tree) !== now.tree) return null;
    return turnDiff(root, turnStart, now, isSettings).files;
  } catch {
    return null;
  }
}

const CHECKS_SOURCE = 'the gate\'s checks of the changed test lines';
const checksNotRun = (why) => ({ kind: 'checks', command: 'greenwashing checks', source: CHECKS_SOURCE, timeoutSeconds: 0, output: '', configError: why });

// The quick checks on the test lines the turn added or changed. First, no .greenwashing.json may have
// changed since the start of this turn (GW-114); then each changed test file is read for new skips
// (GW-17), tests with no assertion (GW-18) and checks whose sides are the same (GW-01), and the
// changed test files for tests the turn removed (GW-17, with the skips), as the gate's settings
// (config: the project's, read) turn them on. allowRemoval: the user's prompt lets this turn remove
// tests. Returns {problem: a red run or null, permitted: the tests removed with the user's permission}.
function quickChecks(checked, config, project, deadline, allowRemoval) {
  const clear = { problem: null, permitted: [] };
  const edited = [];
  for (const target of checked) {
    if (!target.diff || !target.settings) return { ...clear, problem: checksNotRun(`git cannot tell which lines changed in ${target.label}`) };
    for (const f of target.settings) edited.push(target.show(f));
  }
  if (edited.length) return { ...clear, problem: { kind: 'config', command: 'greenwashing checks', source: CHECKS_SOURCE, timeoutSeconds: 0, output: '', files: edited } };
  if (config.error) return { ...clear, problem: checksNotRun(config.error) };
  if (!Object.values(config.checks).includes(true)) return clear;
  const findings = [];
  const python = [];
  // The tests of the changed test files at the start (a file the user changed between turns as it was
  // then) and now, per target; Python files are listed by python_checks.py.
  const lists = checked.map(() => ({ before: [], after: [] }));
  const listed = [];
  for (const [i, target] of checked.entries()) {
    const tests = target.diff.files.filter(testFileKind)
      .map((f) => ({ f, kind: testFileKind(f), before: target.diff.before(f), text: target.diff.after(f) }));
    const deleted = tests.filter((t) => t.text === null && t.before !== null);
    for (const { f, kind, before, text } of tests) {
      if (config.checks.skips) {
        const start = Object.hasOwn(target.adopted, f) ? target.adopted[f] : before;
        for (const [side, content] of [['before', start], ['after', text]]) {
          if (content === null) continue;
          if (kind === 'js') lists[i][side].push(...jsTests(content).map((test) => ({ file: f, ...test })));
          else listed.push({ key: JSON.stringify([i, side, f]), file: target.show(f), text: content, start: side === 'before' });
        }
      }
      if (text === null) continue;
      const start = before !== null ? before : movedFrom(deleted.filter((t) => t.kind === kind).map((t) => t.before), text);
      const changes = lineChanges(start, text);
      if (kind === 'js') {
        for (const found of checkJs(text, changes, config.checks, start)) findings.push({ file: target.show(f), ...found });
      } else {
        python.push({ file: target.show(f), text, before: start, added: [...changes.added], gaps: [...changes.gaps], checks: config.checks });
      }
    }
  }
  if (python.length || listed.length) {
    const result = pythonChecks({ files: python, list: listed }, deadline, pythonOf(config, project));
    if (result.error) return { ...clear, problem: checksNotRun(`the Python test checks could not run: ${result.error}`) };
    if (result.errors.length) {
      return {
        ...clear,
        problem: checksNotRun(`the Python test checks could not read ${result.errors.map((e) => `${e.file} - ${e.error}`).join('; ')}; `
          + `if the project's Python reads it, ${PYTHON_HOW_TO}`),
      };
    }
    findings.push(...result.findings);
    for (const { key } of listed) {
      const [i, side, f] = JSON.parse(key);
      lists[i][side].push(...result.tests[key].map((test) => ({ file: f, ...test })));
    }
  }
  const removed = checked.flatMap((target, i) => removedTests(lists[i].before, lists[i].after).map((test) => `${target.show(test.file)}: ${test.name}`));
  const permitted = allowRemoval ? removed : [];
  const problem = findings.length || (removed.length && !allowRemoval)
    ? { kind: 'checks', command: 'greenwashing checks', source: CHECKS_SOURCE, timeoutSeconds: 0, output: '', findings, removed: allowRemoval ? [] : removed }
    : null;
  return { problem, permitted };
}

// A new test file that keeps, in order, at least half of its lines from a test file the turn
// deleted is that file moved: it is read against the deleted file's text (returned; null: none).
function movedFrom(deleted, text) {
  const lines = splitLines(text);
  let best = null;
  for (const old of deleted) {
    // The most lines in common, in any order, first: one line diff per new file.
    const left = new Map();
    for (const line of splitLines(old)) left.set(line, (left.get(line) || 0) + 1);
    let common = 0;
    for (const line of lines) {
      if (left.get(line) > 0) {
        left.set(line, left.get(line) - 1);
        common += 1;
      }
    }
    if (!best || common > best.common) best = { old, common };
  }
  return best && lineChanges(best.old, text).added.size * 2 <= lines.length ? best.old : null;
}

// python_checks.py under `<python> -I` (the files' own folder cannot shadow the standard library),
// asked to check files and to list the tests of texts (request: {files, list}): {findings, errors,
// tests}, or {error} when it could not run.
function pythonChecks(request, deadline, python) {
  const seconds = Math.min(PYTHON_CHECKS_SECONDS, Math.ceil((deadline - Date.now()) / 1000));
  if (seconds < 1) return { error: 'no time was left: the timeout was used up' };
  const result = spawnSync(python, ['-I', PYTHON_CHECKS], {
    input: JSON.stringify({ ...request, entries: CHECKS }), cwd: os.tmpdir(), timeout: seconds * 1000, maxBuffer: OUTPUT_LIMIT, stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (result.error && result.error.code === 'ENOENT') {
    return { error: `${python === 'python3' ? 'python3 was not found on PATH' : `${python} was not found`}; ${PYTHON_HOW_TO}` };
  }
  // EPIPE: it exited before it read the request; its exit code and message say why.
  if (result.error && !(result.error.code === 'EPIPE' && result.status !== null)) return { error: result.error.message };
  const stderr = result.stderr.toString('utf8').trim().split('\n').slice(-3).join(' ');
  if (result.status !== 0) return { error: `${python} exited with code ${result.status}${stderr ? `: ${stderr}` : ''}` };
  try {
    const out = JSON.parse(result.stdout.toString('utf8'));
    const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
    if (Array.isArray(out.findings) && Array.isArray(out.errors) && isObject(out.tests)
      && request.list.every(({ key }) => out.errors.length || Array.isArray(out.tests[key]))) return out;
  } catch {
    // Not JSON: said below.
  }
  return { error: `${python} printed no findings list` };
}

// note: added to the line of a turn the gate accepts.
function settle(file, state, runs, stopHookActive, note = '') {
  const decision = decide(runs, runs.map(verdict), state, stopHookActive);
  saveState(file, { ...state, blocks: decision.state.blocks, accepted: decision.action === 'allow' });
  if (decision.action === 'block') return { decision: 'block', reason: decision.reason };
  return { systemMessage: decision.action === 'allow' ? `${decision.message}${note}` : decision.message };
}

function onPrompt(input) {
  const { project, home, here } = places(input);
  const file = stateFile(input, project);
  const state = loadState(file);
  const settings = home ? settingsPath(path.relative(home, project)) : null;
  const own = (tree) => (tree === home ? settings : null);
  let next;
  const unaccepted = !state.accepted && Object.keys(state.starts).length > 0;
  if (unaccepted) {
    // No Stop accepted the last turn (the user interrupted it, the gate sent it back, or let it go
    // as not accepted): its changes still count, so its starts stay and a tree the agent is in now
    // joins without one. A new prompt still restarts the block count.
    const seen = { ...state.seen };
    for (const tree of [home, here]) if (tree) seen[tree] = sighting(tree);
    next = { ...state, starts: entered(state.starts, [home, here]), seen, blocks: 0 };
  } else {
    // First forget the last turn, so a snapshot cut short by the hook timeout reads as "unknown".
    saveState(file, NO_STATE);
    const starts = {};
    const seen = {};
    for (const tree of [home, here]) {
      if (tree) {
        starts[tree] = snapshot(tree, own(tree));
        seen[tree] = sighting(tree);
      }
    }
    next = { starts, seen, known: home ? knownCommits(home) : [], blocks: 0, accepted: false };
  }
  // The gate's settings as they are now, at the start of this turn: the checks and the tests of the
  // turn use the project's, and a settings file that changes from now on blocks (GW-114), while a
  // human's change between turns does not, even when the starts stay older. After a turn no Stop
  // accepted, each settings file that differs from the turn before's snapshot but is still as the gate
  // last saw it (at the last Stop, or at the prompt of a turn cut off before its Stop) keeps the
  // earlier state: a change there is the agent's, carried over. A file changed since is the user's.
  // The same goes for test files: one changed since the gate last saw it is the user's as it is now,
  // so the tests it no longer has were removed by the user (adopted, kept until a turn is accepted).
  const lastSeen = unaccepted ? state.stopped : {};
  const turn = {};
  const stopped = {};
  const adopted = unaccepted ? { ...state.adopted } : {};
  let carried = false;
  for (const tree of Object.keys(next.starts)) {
    try {
      if (!fs.existsSync(tree) || repoRoot(tree) !== tree) continue;
      const seenNow = snapshot(tree, own(tree), isWatched);
      stopped[tree] = { ...seenNow, texts: {} };
      if (lastSeen[tree]) {
        for (const f of turnDiff(tree, lastSeen[tree], { tree }, testFileKind).files) {
          adopted[tree] = { ...adopted[tree], [f]: worktreeText(tree, f, TEXT_LIMIT) };
        }
      }
      const now = { ...seenNow, dirty: Object.fromEntries(Object.entries(seenNow.dirty).filter(([f]) => isSettings(f))), texts: {} };
      const before = state.turn[tree];
      if (lastSeen[tree] && before) {
        const changed = new Set(turnDiff(tree, lastSeen[tree], { tree }, isSettings).files);
        for (const f of turnDiff(tree, before, { tree }, isSettings).files) {
          if (changed.has(f)) continue;
          now.dirty[f] = f in before.dirty ? before.dirty[f] : committedHash(tree, before.head, f);
          if (tree === home && f === settings) carried = true;
        }
      }
      turn[tree] = now;
    } catch {
      // No record for this tree: its settings files are measured from its start instead.
    }
  }
  const text = carried && 'settings' in state ? state.settings : readRootFiles(project)[CONFIG_FILE];
  // Only the user's prompt can let the turn remove tests, and only this turn.
  const allowRemoval = typeof input.prompt === 'string' && PERMISSION.test(input.prompt);
  saveState(file, { ...next, turn, stopped, adopted, settings: text, allowRemoval });
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
  for (const signal of SIGNALS) process.on(signal, onSignal);
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
