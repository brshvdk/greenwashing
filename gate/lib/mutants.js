'use strict';
// The mutation command's logic (gate/mutate.js): where to break the code lines a change added, how,
// which of those breaks to try, and what their outcomes add up to. Pure functions: texts and line
// numbers in, mutants and a report out. JavaScript and TypeScript are read here with the quick
// checks' scanner; Python files by python_mutants.py, whose edits come back through fromLines().

const vm = require('node:vm');
const { mask, closing, initializerEnd, testFileKind, JS_EXTENSION, INITIALIZER } = require('./checks');
const { CATALOG } = require('./verdict');
const { splitLines } = require('./diff');

// The kinds of break, in the order they are tried at one place.
const OPERATORS = ['guard', 'condition', 'comparison', 'return', 'boolean', 'number'];
// What a surviving break of each kind means, and what to do: the catalog entry and a hint.
const HINTS = {
  guard: ['GW-02', 'the tests pass without this guard: add a test whose input the guard must stop, and check that it is stopped'],
  condition: ['GW-04', 'the tests pass with this condition turned around: no case makes it decide the result; add one on each side'],
  comparison: ['GW-04', 'the tests pass with this comparison turned around: add cases on both sides of it, and at the edge'],
  return: ['GW-04', 'the tests pass when this returns nothing: check the value it returns'],
  boolean: ['GW-04', 'the tests pass with this true and false swapped: add a case where the value decides the result'],
  number: ['GW-11', 'the tests pass with this number one higher: the cases do not tell the two values apart; add one at the value'],
};
// Comparisons and their opposites.
const FLIP = { '<': '>=', '>=': '<', '>': '<=', '<=': '>', '==': '!=', '!=': '==', '===': '!==', '!==': '===' };
// Folders whose files are tests or their helpers, not the code they test.
const TEST_FOLDERS = new Set(['test', 'tests', '__tests__', '__mocks__', 'spec', 'e2e', 'cypress']);
// Files that set up or configure the tests, or only declare types: nothing a test runs to check.
const NOT_CODE = /^conftest\.py$|\.config\.[cm]?[jt]s$|\.d\.[cm]?ts$|\.(?:cy|test-d)\.[cm]?[jt]sx?$|^setupTests\.|\.setup\.[cm]?[jt]sx?$|^\.eslintrc\./;
// Dependency folders: linked into the copy, never broken.
const DEPENDENCY_FOLDERS = new Set(['node_modules', '.venv', 'venv']);
const PLAIN_NUMBER = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

// The kind of code a changed file holds for the mutation command: 'js', 'python', or null for a file
// that is not code under test (a test file, a file in a test folder, test setup or runner config,
// type declarations, a dependency).
function codeKind(file) {
  const parts = file.split('/');
  const name = parts[parts.length - 1];
  if (testFileKind(file) || parts.some((part) => TEST_FOLDERS.has(part) || DEPENDENCY_FOLDERS.has(part))) return null;
  if (NOT_CODE.test(name)) return null;
  if (/\.py$/.test(name)) return 'python';
  return JS_EXTENSION.test(name) ? 'js' : null;
}

// The added lines of a `git diff` of one file, numbered as git numbers them (at LF): the `+` lines
// of each hunk, so context lines that a setting such as diff.interHunkContext puts in a hunk do not
// count.
function addedLines(diff) {
  const lines = new Set();
  let line = null;
  for (const text of diff.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) line = Number(hunk[1]);
    else if (line === null || text.startsWith('-') || text.startsWith('\\')) continue;
    else if (text.startsWith('+')) lines.add(line++);
    else line += 1;
  }
  return lines;
}

// Git's line numbers (a line ends at LF) as this file's (a line ends at CRLF, CR or LF, as the
// scanner and Python count them): a lone CR splits one line of git's into several, and each of them
// counts when git's line changed.
function ownLines(text, gitLines) {
  const own = new Set();
  let git = 1;
  let line = 1;
  if (gitLines.has(1)) own.add(1);
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\r' && text[i + 1] === '\n') continue;
    if (text[i] === '\n') git += 1;
    if (text[i] === '\n' || text[i] === '\r') {
      line += 1;
      if (gitLines.has(git)) own.add(line);
    }
  }
  return own;
}

// Index of the start of each line (lines split at CRLF, CR and LF).
function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n' || (text[i] === '\r' && text[i + 1] !== '\n')) starts.push(i + 1);
  }
  return starts;
}

// The line of an index, 1-based.
function lineAt(starts, index) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (starts[mid] <= index) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

// The breaks of one JavaScript or TypeScript file on the changed lines: [{op, start, end, text}],
// each replacing source[start, end) with text. Only code counts: the scanner blanks strings,
// comments, templates and regular expressions.
function jsMutants(source, changed) {
  const { code, templates } = mask(source);
  const starts = lineStarts(source);
  const found = [];
  const add = (op, start, end, text) => {
    const first = lineAt(starts, start);
    const last = lineAt(starts, Math.max(start, end - 1));
    for (let line = first; line <= last; line += 1) {
      if (changed.has(line)) {
        found.push({ op, start, end, text });
        return;
      }
    }
  };
  const lineStart = (at) => starts[lineAt(starts, at) - 1];
  const lineEnd = (at) => {
    const next = starts[lineAt(starts, at)];
    return next === undefined ? source.length : next;
  };
  // An if: its condition turned around; a guard (one throw or return, no else) removed with its lines.
  for (const m of code.matchAll(/(?<![\w$.])if\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const close = closing(code, open);
    // A return type after the brackets: a method named if (TypeScript), not an if.
    if (close === -1 || code[skipSpace(code, close + 1)] === ':') continue;
    add('condition', open + 1, close, `!(${source.slice(open + 1, close)})`);
    // A guard fills its lines alone: nothing before it on its first line and nothing after it on its
    // last, not even a comment (checked in the source); after a statement that ends, not after a
    // label or the head of another statement.
    const guard = guardEnd(code, close + 1);
    const alone = guard !== -1 && /^[ \t]*$/.test(source.slice(lineStart(m.index), m.index))
      && /^[ \t]*(?:\r?\n|\r|$)/.test(source.slice(guard)) && /(?:^|[;{}])\s*$/.test(code.slice(0, m.index));
    if (alone && !/^\s*else\b/.test(code.slice(guard))) add('guard', lineStart(m.index), lineEnd(guard - 1), '');
  }
  // A comparison between a name, a number or a bracket and an operand, with spaces on the same line
  // (a < b): TypeScript generics, JSX tags (also a tag's > on a line of its own) and attributes before
  // a > are left alone.
  for (const m of code.matchAll(/(?<=[\w$)\]][ \t]+)(===|!==|==|!=|<=|>=|<|>)(?=[ \t]+[\w$(![\-+.'"`])/g)) add('comparison', m.index, m.index + m[1].length, FLIP[m[1]]);
  // A returned value replaced with null.
  for (const m of code.matchAll(/(?<![\w$.])return\b[ \t]*/g)) {
    const from = m.index + m[0].length;
    if (/^(?:[;})\]\r\n]|$)/.test(code.slice(from, from + 1))) continue;
    // A template the value holds may go on over lines: the value ends after it.
    let end = initializerEnd(code, from);
    for (let open = code.indexOf('`', from); open !== -1 && open < end; open = code.indexOf('`', open + 1)) {
      if (templates.get(open) >= end) end = initializerEnd(code, templates.get(open) + 1);
    }
    if (end - from >= INITIALIZER) continue;
    const value = source.slice(from, end).trimEnd();
    if (!/^(?:null|undefined)$/.test(value)) add('return', from, from + value.length, 'null');
  }
  for (const m of code.matchAll(/(?<![\w$.])(true|false)(?![\w$])/g)) add('boolean', m.index, m.index + m[1].length, m[1] === 'true' ? 'false' : 'true');
  for (const m of code.matchAll(/(?<![\w$.])(\d+(?:\.\d+)?)(?![\w$.])/g)) {
    if (PLAIN_NUMBER.test(m[1])) add('number', m.index, m.index + m[1].length, nextNumber(m[1]));
  }
  return found;
}

// The end of the one statement after an if's condition when it is a throw or a return: `throw x;`,
// `return;`, `{ return x; }` - or -1.
function guardEnd(code, from) {
  let at = from;
  while (at < code.length && /\s/.test(code[at])) at += 1;
  if (code[at] === '{') {
    const close = closing(code, at);
    if (close === -1) return -1;
    const body = code.slice(at + 1, close).trim();
    const end = /^(?:throw|return)\b/.test(body) ? initializerEnd(body, body.search(/\s|;|$/)) : -1;
    return end !== -1 && /^;?\s*$/.test(body.slice(end)) ? close + 1 : -1;
  }
  const word = /^(?:throw|return)\b/.exec(code.slice(at));
  if (!word) return -1;
  const end = initializerEnd(code, at + word[0].length);
  if (end - at >= INITIALIZER) return -1;
  return code[end] === ';' ? end + 1 : end;
}

const skipSpace = (code, at) => {
  while (at < code.length && /\s/.test(code[at])) at += 1;
  return at;
};

// A number one higher, written the same way: 9 -> 10, 1.50 -> 2.50.
function nextNumber(text) {
  const [whole, fraction] = text.split('.');
  return `${BigInt(whole) + 1n}${fraction === undefined ? '' : `.${fraction}`}`;
}

// Python's edits ({op, start: [line, column], end: [line, column], text}, columns in code points,
// lines split as splitLines() splits them) as offsets into the text.
function fromLines(source, edits) {
  const starts = lineStarts(source);
  const offset = ([line, column]) => {
    const text = source.slice(starts[line - 1]);
    let at = 0;
    for (let i = 0; i < column; i += 1) at += text.codePointAt(at) > 0xffff ? 2 : 1;
    return starts[line - 1] + at;
  };
  return edits.map((edit) => ({ op: edit.op, start: offset(edit.start), end: offset(edit.end), text: edit.text }));
}

// A break of a known kind inside the text, on a changed line: what a break from another process must
// be before it is tried.
function touches(source, mutant, changed) {
  if (!OPERATORS.includes(mutant.op) || typeof mutant.text !== 'string' || !Number.isInteger(mutant.start) || !Number.isInteger(mutant.end)
    || mutant.start < 0 || mutant.end < mutant.start || mutant.end > source.length) return false;
  const starts = lineStarts(source);
  for (let line = lineAt(starts, mutant.start); line <= lineAt(starts, Math.max(mutant.start, mutant.end - 1)); line += 1) {
    if (changed.has(line)) return true;
  }
  return false;
}

const apply = (source, mutant) => `${source.slice(0, mutant.start)}${mutant.text}${source.slice(mutant.end)}`;

// The text still compiles when the original did, read as a CommonJS module body: false means the
// break itself is a syntax error, which a test runner would report as a failed test. Only .js and
// .cjs files are checked; for others, and for a file the check cannot read (ES modules, JSX), true.
function stillParses(file, original, mutated) {
  if (!/\.c?js$/.test(file)) return true;
  const compiles = (text) => {
    try {
      new vm.Script(`(function (exports, require, module, __filename, __dirname) {${text}\n})`);
      return true;
    } catch {
      return false;
    }
  };
  return !compiles(original) || compiles(mutated);
}

// What a break changed, for the report: the first line it touches, before and after; a long line is
// shown around the place of the break.
function describe(source, mutant) {
  const starts = lineStarts(source);
  const first = lineAt(starts, mutant.start);
  const last = lineAt(starts, Math.max(mutant.start, mutant.end - 1));
  const column = mutant.start - starts[first - 1];
  const cut = (line) => {
    const from = line.length > 100 ? Math.max(0, Math.min(column - 40, line.length - 97)) : 0;
    const shown = line.slice(from).trimEnd();
    const text = from > 0 ? `...${shown}` : shown.trimStart();
    return text.length > 100 ? `${text.slice(0, 97)}...` : text;
  };
  const before = splitLines(source)[first - 1];
  if (mutant.op === 'guard') return { line: first, change: `removed: ${cut(before)}${last > first ? ` (${last - first + 1} lines)` : ''}` };
  return { line: first, change: `${cut(before)}  ->  ${cut(splitLines(apply(source, mutant))[first - 1])}` };
}

// In the order of file, place and kind.
const byPlace = (a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) || a.start - b.start
  || OPERATORS.indexOf(a.op) - OPERATORS.indexOf(b.op) || a.end - b.end;

// Round robin: the first of each list, then the second of each, and so on.
function interleave(lists) {
  const out = [];
  for (let i = 0; out.length < lists.reduce((sum, list) => sum + list.length, 0); i += 1) {
    for (const list of lists) if (i < list.length) out.push(list[i]);
  }
  return out;
}

// A list in an order whose every beginning is spread over it: the middle, then the middles of the
// halves, and so on.
function spread(list) {
  const out = [];
  const parts = [[0, list.length]];
  while (parts.length) {
    const [low, high] = parts.shift();
    if (low >= high) continue;
    const middle = low + Math.floor((high - low) / 2);
    out.push(list[middle]);
    parts.push([low, middle], [middle + 1, high]);
  }
  return out;
}

// At most limit of the breaks, the same ones for the same code, shown in the order of file and
// place. Every file gets a break before any gets a second, and in each file every kind before any
// gets a second: many numbers in one file do not crowd out a guard in another. The breaks of one kind
// in one file are spread over the file.
function choose(mutants, limit) {
  const files = [...new Set(mutants.map((m) => m.file))].sort();
  const queues = files.map((file) => interleave(OPERATORS.map((op) => spread(mutants.filter((m) => m.file === file && m.op === op).sort(byPlace)))));
  return interleave(queues).slice(0, limit).sort(byPlace);
}

// The outcome of one break from the verdict of its test run: the tests failed - killed; they passed -
// survived; they did not run - did not run, never counted as caught (GW-61).
const OUTCOMES = { failed: 'killed', passed: 'survived', 'did not run': 'did not run' };

// The report and the exit code of a finished command: 0 every break killed, 1 a break survived, 2
// nothing survived but something did not run (or nothing was tried). results: [{file, line, op,
// change, outcome, why}].
function report({ header, control, results, notTried, problems }) {
  const count = (outcome) => results.filter((r) => r.outcome === outcome).length;
  const survived = results.filter((r) => r.outcome === 'survived');
  const lines = [...header, control, `Mutants: ${results.length} tried - ${count('killed')} killed, ${survived.length} survived, ${count('did not run')} did not run`
    + `${notTried ? `; ${notTried} not tried` : ''}`];
  for (const r of results) lines.push(`- ${r.outcome}: ${r.file}:${r.line}: ${r.change}${r.why ? ` (${r.why})` : ''}`);
  if (survived.length) {
    lines.push('', 'Survived - the tests passed with the code broken:');
    for (const r of survived) {
      const [gw, hint] = HINTS[r.op];
      lines.push(`- ${r.file}:${r.line}: ${r.change}`, `  ${hint}. See ${gw} in ${CATALOG}`);
    }
  }
  for (const problem of problems) lines.push(`Did not run: ${problem}`);
  const didNotRun = count('did not run') + notTried + problems.length;
  if (didNotRun) lines.push(`"Did not run" is never counted as caught (GW-61 in ${CATALOG}).`);
  const code = survived.length ? 1 : didNotRun || results.length === 0 ? 2 : 0;
  lines.push(`Result: ${code === 0 ? 'every mutant was killed' : code === 1 ? `${survived.length} mutant${survived.length === 1 ? '' : 's'} survived` : 'did not run'}`);
  return { text: lines.join('\n'), code };
}

module.exports = {
  codeKind, addedLines, ownLines, jsMutants, fromLines, touches, apply, stillParses, describe, choose, report, OUTCOMES, OPERATORS, HINTS, FLIP, DEPENDENCY_FOLDERS,
};
