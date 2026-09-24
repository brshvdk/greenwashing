'use strict';
// Turns a finished test run into one of three outcomes, and an outcome into the gate's
// decision. Pure functions: no files, processes or hook JSON here.

const { parseSummaries, lines } = require('./parse');

const CATALOG = 'https://github.com/brshvdk/greenwashing/blob/main/CATALOG.md';
const MAX_BLOCKS = 3;
const TAIL_LINES = 20;
// Claude Code caps a hook's text fields at 10,000 characters; a tail line can be a whole file.
const TAIL_LINE_CHARS = 300;

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

// run: {command, source, timeoutSeconds, configError, startError, timedOut, outputTooLarge, exitCode, output}.
// Returns {outcome: 'passed' | 'failed' | 'did not run', why, gw, counts}.
function verdict(run) {
  const didNotRun = (why, gw = 'GW-50', counts = null) => ({ outcome: 'did not run', why, gw, counts });
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

function tail(output) {
  const all = lines(output);
  while (all.length && all[all.length - 1] === '') all.pop();
  return all.slice(-TAIL_LINES)
    .map((line) => (line.length > TAIL_LINE_CHARS ? `${line.slice(0, TAIL_LINE_CHARS)}... (${line.length} characters)` : line))
    .join('\n');
}

// The reason the agent reads when the gate sends it back.
function blockReason(run, result) {
  const parts = [
    `greenwashing gate: the tests ${result.outcome === 'failed' ? 'failed' : 'did not run'} - you cannot finish yet.`,
    `Command: ${run.command} (${run.source})`,
    `Result: ${result.outcome}${result.why ? ` - ${result.why}` : ''}`,
  ];
  if (result.counts) parts.push(`Counts: ${countsText(result.counts)}`);
  if (result.gw) parts.push(`See ${result.gw} in ${CATALOG}`);
  const last = tail(run.output || '');
  parts.push(last ? `Last ${TAIL_LINES} lines of output:\n${last}` : 'The command printed nothing.');
  return parts.join('\n');
}

// state: {blocks} - how many times in a row the gate sent the agent back in this turn.
// stopHookActive: the Stop input says the agent is already continuing because a stop hook
// blocked; when it is false this stop starts a new chain.
// Returns {action: 'allow' | 'block' | 'release', reason?, message?, state}.
function decide(run, result, state, stopHookActive) {
  if (result.outcome === 'passed') {
    return {
      action: 'allow',
      message: `greenwashing: tests passed - ${run.command}: ${countsText(result.counts)}`,
      state: { blocks: 0 },
    };
  }
  const blocks = stopHookActive ? state.blocks : 0;
  if (blocks >= MAX_BLOCKS) {
    return {
      action: 'release',
      message: `greenwashing: TESTS DID NOT PASS - WORK NOT ACCEPTED. The gate sent the agent back ${blocks} times in a row `
        + `and now lets it stop so it does not loop. Last result: ${result.outcome}`
        + `${result.why ? ` - ${result.why}` : ''} (${run.command}).`,
      state: { blocks: 0 },
    };
  }
  return { action: 'block', reason: blockReason(run, result), state: { blocks: blocks + 1 } };
}

module.exports = { verdict, decide, blockReason, MAX_BLOCKS, TAIL_LINES, TAIL_LINE_CHARS, CATALOG };
