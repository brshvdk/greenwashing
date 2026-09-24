'use strict';
// Reads the test counts that pytest, unittest, jest, vitest and `node --test`
// print at the end of a run. Pure functions: text in, summaries out.

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

function lines(text) {
  return String(text).replace(ANSI_RE, '').split(/\r\n|\r|\n/).map((line) => line.trimEnd());
}

// "2 failed, 3 passed" or "2 failed | 3 passed" -> {failed: 2, passed: 3}, or null when
// any part is not "<number> <known word>".
function items(text, separator, words) {
  const counts = {};
  for (const part of text.split(separator)) {
    const match = /^(\d+) ([a-z ]+)$/.exec(part.trim());
    if (!match || !words.includes(match[2])) return null;
    counts[match[2]] = (counts[match[2]] || 0) + Number(match[1]);
  }
  return counts;
}

// brokenFiles: test files that could not run; errors: errors outside any test.
function summary(runner, passed, failed, skipped, brokenFiles = 0, errors = 0) {
  return { runner, passed, failed, skipped, brokenFiles, errors };
}

// unittest: "Ran 5 tests in 0.001s", then "OK", "OK (skipped=1)", "FAILED (failures=1, errors=1)"
// or "NO TESTS RAN" (Python 3.12+).
function unittest(all, i) {
  const ran = /^Ran (\d+) tests? in \d+(\.\d+)?s$/.exec(all[i]);
  if (!ran) return null;
  const status = all.slice(i + 1, i + 4).find((line) => line !== '');
  const match = /^(OK|FAILED|NO TESTS RAN)(?: \((.*)\))?$/.exec(status || '');
  if (!match) return null;
  const details = {};
  if (match[2]) {
    for (const part of match[2].split(', ')) {
      const pair = /^(failures|errors|skipped|expected failures|unexpected successes)=(\d+)$/.exec(part);
      if (!pair) return null;
      details[pair[1]] = Number(pair[2]);
    }
  }
  const total = Number(ran[1]);
  const failed = (details.failures || 0) + (details.errors || 0) + (details['unexpected successes'] || 0);
  const skipped = (details.skipped || 0) + (details['expected failures'] || 0);
  if (match[1] === 'FAILED' && failed === 0) return null;
  return summary('unittest', Math.max(total - failed - skipped, 0), failed, skipped);
}

const PYTEST_WORDS = ['passed', 'failed', 'error', 'errors', 'skipped', 'xfailed', 'xpassed', 'deselected',
  'warning', 'warnings', 'rerun', 'subtests passed'];

// pytest: "==== 2 failed, 2 passed, 1 skipped in 0.03s ====", the same without "=" under -q,
// or "no tests ran in 0.00s".
function pytest(all, i) {
  const match = /^(?:=+ )?(.+?) in \d+(\.\d+)?s(?: \([0-9:]+\))?(?: =+)?$/.exec(all[i]);
  if (!match) return null;
  const framed = all[i].startsWith('=');
  if (framed !== all[i].endsWith('=')) return null;
  if (match[1] === 'no tests ran') return summary('pytest', 0, 0, 0);
  const counts = items(match[1], ',', PYTEST_WORDS);
  if (!counts) return null;
  const passed = (counts.passed || 0) + (counts.xpassed || 0);
  const failed = (counts.failed || 0) + (counts.error || 0) + (counts.errors || 0);
  const skipped = (counts.skipped || 0) + (counts.xfailed || 0);
  return summary('pytest', passed, failed, skipped);
}

// jest: "Tests:       2 failed, 1 skipped, 2 passed, 5 total"; a file that could not run
// shows up only in "Test Suites: 1 failed, 1 passed, 2 total". "No tests found, exiting with
// code 0" (--passWithNoTests) or code 1 is a run of zero tests.
function jest(all, i) {
  if (/^No tests found, exiting with code \d+$/.test(all[i])) return summary('jest', 0, 0, 0);
  const match = /^Tests: +(?:(.+), )?(\d+) total$/.exec(all[i]);
  if (!match) return null;
  const counts = match[1] ? items(match[1], ',', ['passed', 'failed', 'skipped', 'todo']) : {};
  if (!counts) return null;
  const suites = all.slice(Math.max(i - 3, 0), i)
    .map((line) => /^Test Suites: +(\d+) failed/.exec(line)).find(Boolean);
  const failed = counts.failed || 0;
  return summary('jest', counts.passed || 0, failed, (counts.skipped || 0) + (counts.todo || 0),
    suites && failed === 0 ? Number(suites[1]) : 0);
}

// vitest: "      Tests  2 failed | 2 passed | 1 skipped (5)"; a file that could not load
// shows up only in " Test Files  1 failed | 1 passed (2)", an unhandled error only in
// "     Errors  1 error" after it. "No test files found, exiting with code 0" is zero tests.
function vitest(all, i) {
  if (/^No test files found, exiting with code \d+$/.test(all[i])) return summary('vitest', 0, 0, 0);
  const match = /^ *Tests {2}(.+) \((\d+)\)$/.exec(all[i]);
  if (!match) return null;
  const counts = items(match[1], '|', ['passed', 'failed', 'skipped', 'todo', 'expected fail']);
  if (!counts) return null;
  const files = all.slice(Math.max(i - 3, 0), i)
    .map((line) => /^ *Test Files {2}(\d+) failed/.exec(line)).find(Boolean);
  const errors = all.slice(i + 1, i + 4).map((line) => /^ *Errors {2}(\d+) errors?$/.exec(line)).find(Boolean);
  const failed = counts.failed || 0;
  return summary('vitest', counts.passed || 0, failed,
    (counts.skipped || 0) + (counts.todo || 0) + (counts['expected fail'] || 0),
    files && failed === 0 ? Number(files[1]) : 0, errors ? Number(errors[1]) : 0);
}

const NODE_KEYS = ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo'];

// node --test: "# tests 6" (TAP) or "ℹ tests 6" (spec), then suites, pass, fail, cancelled,
// skipped and todo on the next lines, in this order.
function nodeTest(all, i) {
  const counts = {};
  for (const [offset, key] of NODE_KEYS.entries()) {
    const match = new RegExp(`^(#|ℹ) ${key} (\\d+)$`).exec(all[i + offset] || '');
    if (!match) return null;
    counts[key] = Number(match[2]);
  }
  if (counts.tests !== counts.pass + counts.fail + counts.cancelled + counts.skipped + counts.todo) return null;
  return summary('node --test', counts.pass, counts.fail + counts.cancelled, counts.skipped + counts.todo);
}

const READERS = [unittest, pytest, jest, vitest, nodeTest];

// TAP from node --test: "not ok 3 - name", a subtest indented 4 spaces per level and printed before
// its parent. A failing parent's name goes in front of its failing subtests' names; a "# TODO" or
// "# SKIP" directive is not a failure.
function tapFailures(all) {
  const levels = [];
  for (const line of all) {
    const match = /^( *)(not ok|ok) \d+ - (.*)$/.exec(line);
    if (!match) continue;
    const depth = Math.floor(match[1].length / 4);
    const children = levels[depth + 1] || [];
    levels[depth + 1] = [];
    if (match[2] === 'ok' || /\s#\s*(TODO|SKIP)\b/i.test(match[3])) continue;
    const name = match[3];
    levels[depth] = [...(levels[depth] || []), ...(children.length ? children.map((child) => `${name} > ${child}`) : [name])];
  }
  return levels.flat();
}

// The names of the tests that failed, in the order the output gives them, each once: TAP "not ok",
// pytest "FAILED"/"ERROR <node id>", jest "  ● a › b", vitest " FAIL  file > a > b", unittest
// "FAIL:"/"ERROR:". A file that could not run (jest "Test suite failed to run", vitest
// " FAIL  file [ file ]") is not a test.
function failedTests(text) {
  const all = lines(text);
  const names = [...tapFailures(all)];
  for (const line of all) {
    const found = /^(?:FAILED|ERROR) (?!\()(.+?)(?: - .*)?$/.exec(line)
      || /^ {2}● (?!Test suite failed to run$)(.+)$/.exec(line)
      || /^ FAIL {2}(?!.* \[ .* \]$)(.+)$/.exec(line)
      || /^(?:FAIL|ERROR): (.+)$/.exec(line);
    if (found) names.push(found[1]);
  }
  return [...new Set(names)];
}

// Every complete summary in the output, in order. A line that only looks like the start
// of a summary (a test printing "Ran 5 tests") is skipped, not guessed at.
function parseSummaries(text) {
  const all = lines(text);
  const found = [];
  for (let i = 0; i < all.length; i += 1) {
    for (const read of READERS) {
      const result = read(all, i);
      if (result) {
        found.push(result);
        break;
      }
    }
  }
  return found;
}

module.exports = { parseSummaries, failedTests, lines };
