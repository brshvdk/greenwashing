'use strict';
// Turns a finished test run into one of three outcomes, and an outcome into the gate's
// decision. Pure functions: no files, processes or hook JSON here.

const { parseSummaries, failedTests, lines } = require('./parse');

const CATALOG = 'https://github.com/brshvdk/greenwashing/blob/main/CATALOG.md';
const MAX_BLOCKS = 3;
const TAIL_LINES = 20;
const FAILED_NAMES = 10;
const FINDINGS = 20;
// Claude Code caps a hook's text fields at 10,000 characters; a tail line can be a whole file.
const TAIL_LINE_CHARS = 300;
// The words the user writes in a prompt to let that turn remove tests (hook.js reads them in any case).
const PERMISSION_WORDS = 'allow test removal';

function totals(summaries) {
  const sum = { passed: 0, failed: 0, skipped: 0, brokenFiles: 0, errors: 0 };
  for (const one of summaries) {
    for (const key of Object.keys(sum)) sum[key] += one[key];
  }
  return sum;
}

function countsText(sum) {
  return `${sum.passed} passed, ${sum.failed} failed, ${sum.skipped} skipped`;
}

// Where a run was, when not in the project itself (another worktree of its repository), and whether
// that folder's own .greenwashing.json was ignored.
const IGNORED = 'its own .greenwashing.json ignored';
const place = (run) => (run.where ? ` in ${run.where}${run.ignoredSettings ? ` (${IGNORED})` : ''}` : '');

// run: {command, source, where, timeoutSeconds, configError, startError, timedOut, outputTooLarge, exitCode, output};
// the gate's checks of the changed test lines add kind 'checks' with findings [{file, line, gw, what}]
// and removed ['file: test name'] (the tests the turn removed), or kind 'config' with files: the
// .greenwashing.json files the turn changed.
// Returns {outcome: 'passed' | 'failed' | 'did not run', why, gw, counts}.
function verdict(run) {
  const didNotRun = (why, gw = 'GW-50', counts = null) => ({ outcome: 'did not run', why, gw, counts });
  if (run.kind === 'config') return { outcome: 'failed', why: `${run.files.join(', ')} changed during this turn`, gw: 'GW-114', counts: null };
  if (run.findings) {
    const count = run.findings.length;
    const removed = (run.removed || []).length;
    const why = [
      count ? `${count} problem${count === 1 ? '' : 's'} in the test lines this turn added or changed` : null,
      removed ? `${removed} test${removed === 1 ? '' : 's'} removed` : null,
    ].filter(Boolean).join('; ');
    return { outcome: 'failed', why, gw: null, counts: null };
  }
  if (run.configError) return didNotRun(run.configError);
  if (run.startError) return didNotRun(`the command could not start: ${run.startError}`);
  if (run.timedOut) return didNotRun(`the command did not finish in ${run.timeoutSeconds} s and was stopped`);
  if (run.outputTooLarge) return didNotRun(`the output was larger than ${run.outputTooLarge} bytes and was not read`);
  const summaries = parseSummaries(run.output);
  if (summaries.length === 0) {
    const notFound = run.exitCode === 127 ? 'the command was not found (exit code 127); ' : '';
    return didNotRun(`${notFound}no test counts from pytest, unittest, jest, vitest or node --test in the output`);
  }
  const counts = totals(summaries);
  if (counts.failed > 0) return { outcome: 'failed', why: `${counts.failed} failed`, gw: null, counts };
  if (summaries.some((one) => one.passed + one.failed === 0)) {
    const empty = summaries.filter((one) => one.passed + one.failed === 0).map((one) => one.runner);
    return didNotRun(`zero tests ran (${empty.join(', ')})`, 'GW-08', counts);
  }
  if (counts.brokenFiles > 0) return didNotRun(`${counts.brokenFiles} test file(s) could not run`, 'GW-50', counts);
  if (counts.errors > 0) return didNotRun(`${counts.errors} error(s) outside the tests`, 'GW-50', counts);
  if (run.exitCode !== 0) {
    return didNotRun(`the command exited with code ${run.exitCode} although no test failed`, 'GW-50', counts);
  }
  return { outcome: 'passed', why: '', gw: null, counts };
}

const cut = (line) => (line.length > TAIL_LINE_CHARS ? `${line.slice(0, TAIL_LINE_CHARS)}... (${line.length} characters)` : line);

function tail(output) {
  const all = lines(output);
  while (all.length && all[all.length - 1] === '') all.pop();
  return all.slice(-TAIL_LINES).map(cut).join('\n');
}

// The failed tests the output names, at most FAILED_NAMES of them.
function failedNames(output) {
  const names = failedTests(output);
  if (names.length === 0) return null;
  const count = names.length > FAILED_NAMES ? `${names.length}, the first ${FAILED_NAMES}` : `${names.length}`;
  return `Failed tests (${count}):\n${names.slice(0, FAILED_NAMES).map((name) => `- ${cut(name)}`).join('\n')}`;
}

// The reason the agent reads when the gate sends it back.
function blockReason(run, result) {
  if (run.kind === 'config') {
    return [
      'greenwashing gate: the gate\'s settings changed during this turn - you cannot finish yet.',
      `Changed: ${run.files.join(', ')}`,
      'A human changes the gate\'s settings between turns, not the agent during one: undo the change, or leave it to the user.',
      `See GW-114 in ${CATALOG}`,
    ].join('\n');
  }
  if (run.findings) {
    const removed = run.removed || [];
    const list = (items) => [...items.slice(0, FINDINGS), ...(items.length > FINDINGS ? [`- and ${items.length - FINDINGS} more`] : [])];
    const what = [run.findings.length ? 'the changed tests can pass without testing anything' : null, removed.length ? 'this turn removed tests' : null];
    const parts = [`greenwashing gate: ${what.filter(Boolean).join(', and ')} - you cannot finish yet.`];
    if (run.findings.length) {
      parts.push('Found in the test lines this turn added or changed:', ...list(run.findings.map((f) => `- ${f.file}:${f.line}: ${cut(f.what)} (${f.gw})`)));
    }
    if (removed.length) {
      parts.push('Removed tests (a test renamed, or moved to another test file, with the same body is not removed):',
        ...list(removed.map((name) => `- ${cut(name)} (GW-17)`)));
    }
    parts.push(`See each entry in ${CATALOG}`);
    if (run.findings.length) {
      parts.push('Fix the tests. What is meant stays red until a human accepts it: between turns, a human can turn a check off in '
        + 'the project\'s .greenwashing.json, for example {"checks": {"skips": false}} (skips - it turns off the check of removed tests too -, '
        + 'assertions, selfComparisons).');
    }
    if (removed.length) {
      parts.push(`Put the tests back, or leave the removal to the user: a turn whose prompt from the user says "${PERMISSION_WORDS}" may remove `
        + 'tests. Between turns, a human can also turn the check off with {"checks": {"skips": false}} in the project\'s .greenwashing.json '
        + '(it turns off the check of new skips too).');
    }
    return parts.join('\n');
  }
  const subject = run.kind === 'checks' ? 'checks of the changed tests' : 'tests';
  const parts = [
    `greenwashing gate: the ${subject} ${result.outcome === 'failed' ? 'failed' : 'did not run'} - you cannot finish yet.`,
    `Command: ${run.command} (${run.source})`,
  ];
  if (run.where) parts.push(`Folder: ${run.where}`);
  if (run.ignoredSettings) parts.push('Settings: the project folder\'s; the .greenwashing.json in this folder is ignored');
  parts.push(`Result: ${result.outcome}${result.why ? ` - ${result.why}` : ''}`);
  if (result.counts) parts.push(`Counts: ${countsText(result.counts)}`);
  if (result.gw) parts.push(`See ${result.gw} in ${CATALOG}`);
  // The gate's own checks print nothing: only a command of the project has output to show.
  if (run.kind) return parts.join('\n');
  const names = failedNames(run.output || '');
  if (names) parts.push(names);
  const last = tail(run.output || '');
  parts.push(last ? `Last ${TAIL_LINES} lines of output:\n${last}` : 'The command printed nothing.');
  return parts.join('\n');
}

// What the line of an accepted turn adds for the tests it removed with the user's permission.
function removedNote(names) {
  if (names.length === 0) return '';
  const shown = names.slice(0, FAILED_NAMES).map(cut).join(', ');
  return `; tests removed with the user's permission (${names.length}): ${shown}${names.length > FAILED_NAMES ? `, and ${names.length - FAILED_NAMES} more` : ''}`;
}

// runs, results: the test runs of one stop, in order, with their verdicts; the first that is not
// green decides. state: {blocks} - how many times in a row the gate sent the agent back in this turn.
// stopHookActive: the Stop input says the agent is already continuing because a stop hook
// blocked; when it is false this stop starts a new chain.
// Returns {action: 'allow' | 'block' | 'release', reason?, message?, state}.
function decide(runs, results, state, stopHookActive) {
  const red = results.findIndex((one) => one.outcome !== 'passed');
  if (red === -1) {
    const parts = runs.map((one, i) => `${one.command}${place(one)}: ${countsText(results[i].counts)}`);
    return { action: 'allow', message: `greenwashing: tests passed - ${parts.join('; ')}`, state: { blocks: 0 } };
  }
  const run = runs[red];
  const result = results[red];
  const blocks = stopHookActive ? state.blocks : 0;
  if (blocks >= MAX_BLOCKS) {
    return {
      action: 'release',
      message: `greenwashing: ${run.kind ? 'CHECKS' : 'TESTS'} DID NOT PASS - WORK NOT ACCEPTED. The gate sent the agent back ${blocks} times in a row `
        + `and now lets it stop so it does not loop. Last result: ${result.outcome}`
        + `${result.why ? ` - ${result.why}` : ''} (${run.command}${place(run)}).`
        + `${run.kind === 'config' ? ' The changed settings still block after the next prompt: undo the change, or edit the file between turns to make it yours.' : ''}`,
      state: { blocks: 0 },
    };
  }
  return { action: 'block', reason: blockReason(run, result), state: { blocks: blocks + 1 } };
}

module.exports = {
  verdict, decide, blockReason, removedNote, MAX_BLOCKS, TAIL_LINES, TAIL_LINE_CHARS, FAILED_NAMES, FINDINGS, CATALOG, PERMISSION_WORDS,
};
