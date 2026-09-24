'use strict';
// The gate's quick checks on the test lines a turn added or changed: a new skip, focus or
// expected-failure marker (GW-17), a new or changed test with no assertion (GW-18), a check whose
// two sides are the same (GW-01). This file reads JavaScript and TypeScript with a small scanner;
// Python test files go to python_checks.py. Pure functions: texts and changed lines in, findings out.

const { isPythonTest } = require('./command');

const JS_EXTENSION = /\.(?:[cm]?[jt]s|[jt]sx)$/;

// The test files jest 30, vitest 5 and node --test (Node 20 and 22) collect by default, seen in
// live runs: *.test.* and *.spec.* (also test.js), *-test.*, *_test.*, test-*, and any file in a
// __tests__ or test folder. Python: test_*.py and *_test.py.
function testFileKind(file) {
  if (isPythonTest(file)) return 'python';
  const parts = file.split('/');
  const name = parts.pop();
  if (!JS_EXTENSION.test(name)) return null;
  const stem = name.replace(JS_EXTENSION, '');
  const test = /(?:^|\.)(?:test|spec)$/.test(stem) || /[-_]test$/.test(stem) || /^test-/.test(stem)
    || parts.includes('__tests__') || parts.includes('test');
  return test ? 'js' : null;
}

const CODE = 0;
const TEXT = 1;
const COMMENT = 2;
// After these words a slash starts a regular expression, not a division.
const BEFORE_REGEX = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case',
  'do', 'else', 'yield', 'await']);
const isBreak = (c) => c === '\n' || c === '\r';

// Blanks out comments, the text of strings and templates, and regular expression bodies; quotes,
// slashes and the code inside ${} stay. Returns {code, kinds, comments, templates}: code has the
// source's length and line breaks; kinds[i] is CODE, TEXT or COMMENT; comments: [{start, text}];
// templates: index of each opening backtick -> index of its closing one.
function mask(source) {
  const code = source.split('');
  const kinds = new Uint8Array(source.length);
  const comments = [];
  const templates = new Map();
  const n = source.length;
  const blank = (from, to, kind) => {
    for (let j = from; j < Math.min(to, n); j += 1) {
      kinds[j] = kind;
      if (!isBreak(code[j])) code[j] = ' ';
    }
  };
  // Open templates, innermost last: depth counts the braces of the ${} expression being read, and
  // is -1 while the template's text is read.
  const open = [];
  // What came last, for "is this slash a regular expression": none, word, close (`)` or `]`),
  // brace (`}`) or punct.
  let last = 'none';
  let word = '';
  let i = 0;
  while (i < n) {
    const c = source[i];
    const top = open[open.length - 1];
    if (top && top.depth === -1) {
      if (c === '\\') {
        blank(i, i + 2, TEXT);
        i += 2;
      } else if (c === '`') {
        templates.set(top.start, i);
        open.pop();
        [last, word] = ['word', ''];
        i += 1;
      } else if (c === '$' && source[i + 1] === '{') {
        top.depth = 0;
        last = 'punct';
        i += 2;
      } else {
        blank(i, i + 1, TEXT);
        i += 1;
      }
    } else if (c === '/' && source[i + 1] === '/') {
      let end = i;
      while (end < n && !isBreak(source[end])) end += 1;
      comments.push({ start: i + 2, text: source.slice(i + 2, end) });
      blank(i, end, COMMENT);
      i = end;
    } else if (c === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2);
      const end = close === -1 ? n : close + 2;
      comments.push({ start: i + 2, text: source.slice(i + 2, close === -1 ? n : close) });
      blank(i, end, COMMENT);
      i = end;
    } else if (c === '\'' || c === '"') {
      // A string ends at its quote, or at the end of the line when it is broken.
      let end = i + 1;
      while (end < n && source[end] !== c && !isBreak(source[end])) end += source[end] === '\\' ? 2 : 1;
      blank(i + 1, end, TEXT);
      i = end < n && source[end] === c ? end + 1 : end;
      [last, word] = ['word', ''];
    } else if (c === '`') {
      open.push({ start: i, depth: -1 });
      i += 1;
    } else if (c === '/' && (['none', 'punct', 'brace'].includes(last) || (last === 'word' && BEFORE_REGEX.has(word)))) {
      let end = i + 1;
      let inClass = false;
      while (end < n && !isBreak(source[end]) && (source[end] !== '/' || inClass)) {
        if (source[end] === '\\') end += 1;
        else if (source[end] === '[') inClass = true;
        else if (source[end] === ']') inClass = false;
        end += 1;
      }
      blank(i + 1, end, TEXT);
      i = end + 1;
      while (i < n && /[a-z]/i.test(source[i])) i += 1;
      [last, word] = ['word', ''];
    } else if (/[\w$]/.test(c)) {
      let end = i + 1;
      while (end < n && /[\w$]/.test(source[end])) end += 1;
      [last, word] = ['word', source.slice(i, end)];
      i = end;
    } else {
      if (top && c === '{') top.depth += 1;
      if (top && c === '}' && top.depth === 0) {
        top.depth = -1;
        i += 1;
        continue;
      }
      if (top && c === '}') top.depth -= 1;
      if (!/\s/.test(c)) last = c === ')' || c === ']' ? 'close' : c === '}' ? 'brace' : 'punct';
      i += 1;
    }
  }
  return { code: code.join(''), kinds, comments, templates };
}

// A function from an index to its 1-based line.
function lineIndex(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '\n' || (source[i] === '\r' && source[i + 1] !== '\n')) starts.push(i + 1);
  }
  return (index) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid] <= index) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
}

// The index of the bracket that closes the one at `at`, or -1.
function closing(code, at) {
  const want = { '(': ')', '[': ']', '{': '}' }[code[at]];
  let depth = 0;
  for (let i = at; i < code.length; i += 1) {
    if (code[i] === code[at]) depth += 1;
    else if (code[i] === want) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// The arguments between the brackets at open and close: [[start, end]], split at top-level commas.
function args(code, open, close) {
  const found = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open + 1; i < close; i += 1) {
    if ('([{'.includes(code[i])) depth += 1;
    else if (')]}'.includes(code[i])) depth -= 1;
    else if (code[i] === ',' && depth === 0) {
      found.push([start, i]);
      start = i + 1;
    }
  }
  if (code.slice(start, close).trim()) found.push([start, close]);
  return found;
}

// An arrow at the top level of the argument: (a, b) => ..., async x => ...
function topLevelArrow(code, from, to) {
  let depth = 0;
  for (let i = from; i < to - 1; i += 1) {
    if ('([{'.includes(code[i])) depth += 1;
    else if (')]}'.includes(code[i])) depth -= 1;
    else if (depth === 0 && code[i] === '=' && code[i + 1] === '>') return true;
  }
  return false;
}

const skipSpace = (code, i) => {
  while (i < code.length && /\s/.test(code[i])) i += 1;
  return i;
};

// Each line of a text with the index where it starts.
function* linesAt(text, start) {
  const re = /[^\r\n]*(?:\r\n|\r|\n|$)/g;
  for (let match = re.exec(text); match && match[0]; match = re.exec(text)) {
    yield { line: match[0].replace(/[\r\n]+$/, ''), at: start + match.index };
  }
}

// The markers that make a test or suite not run, run alone, or pass when it fails.
const MARKERS = new Set(['skip', 'only', 'todo', 'failing', 'fails', 'skipIf', 'runIf']);
const NOT_RUN = new Set(['skip', 'todo', 'skipIf', 'runIf']);
// t.skip() in node:test, ctx.skip() in vitest, this.skip() in mocha: the test stops as skipped.
const RUNTIME_SKIP = /(?<![\w$.])(t|ctx|context|this)\s*\.\s*(skip|todo)\s*\(/;
const TEST_OBJECTS = 'describe|it|test|context|suite|specify|bench';
const ASSERTION = /(?<![\w$])(?:expect\w*|assert\w*)\s*[.(]|\.\s*should\b|(?<![\w$.])t\s*\.\s*[A-Za-z_$]/;
// Matchers and asserts that pass whenever their two sides are the same.
const SAME_MATCHERS = new Set(['toBe', 'toEqual', 'toStrictEqual', 'toMatchObject', 'toBeCloseTo', 'toBeGreaterThanOrEqual',
  'toBeLessThanOrEqual', 'equal', 'equals', 'eql', 'eq']);
const SAME_ASSERTS = 'equal|strictEqual|deepEqual|deepStrictEqual|is|same|strictSame|like|equals|deepEquals';
const COMMENTED_TEST = /^\s*(?:\*\s*)?(?:it|test|describe)\s*(?:\.\s*[A-Za-z_$][\w$]*\s*)*\(\s*['"`]/;

// The test and suite calls: {name, members, start, chainEnd, end, list, options}, where chainEnd
// is the end of `test.only.each`, end closes the call that takes the name and the function (after
// the table of `.each`), list holds that call's arguments and options its node:test options.
function testCalls(code, templates) {
  const calls = [];
  const callRe = new RegExp(`(?<![\\w$.])(${TEST_OBJECTS})\\b`, 'g');
  const membersRe = /(?:\s*\.\s*[A-Za-z_$][\w$]*)*/y;
  for (let match = callRe.exec(code); match; match = callRe.exec(code)) {
    membersRe.lastIndex = callRe.lastIndex;
    const chain = membersRe.exec(code)[0];
    const members = chain.split('.').map((part) => part.trim()).filter(Boolean);
    let at = skipSpace(code, callRe.lastIndex + chain.length);
    if (members.includes('each')) {
      const table = code[at] === '`' ? templates.get(at) : code[at] === '(' ? closing(code, at) : undefined;
      if (table === undefined || table === -1) continue;
      at = skipSpace(code, table + 1);
    }
    if (code[at] !== '(') continue;
    const end = closing(code, at);
    if (end === -1) continue;
    const list = args(code, at, end);
    calls.push({ name: match[1], members, start: match.index, chainEnd: callRe.lastIndex + chain.length, end, list, options: options(code, list) });
  }
  return calls;
}

// node:test options in an object argument: test('name', { skip: true }, fn). Returns
// [{name, at}] for each skip, only or todo key at the top of the object whose value is not false.
function options(code, list) {
  const found = [];
  for (const [from] of list) {
    const at = skipSpace(code, from);
    const close = code[at] === '{' ? closing(code, at) : -1;
    const optionRe = /(?<![\w$])(skip|only|todo)\s*:(?!\s*false\b)/g;
    optionRe.lastIndex = at + 1;
    for (let option = optionRe.exec(code); option && option.index < close; option = optionRe.exec(code)) {
      const depth = [...code.slice(at + 1, option.index)].reduce((sum, ch) => sum + ('([{'.includes(ch) ? 1 : ')]}'.includes(ch) ? -1 : 0), 0);
      if (depth === 0) found.push({ name: option[1], at: option.index });
    }
  }
  return found;
}

// The name of a function's first parameter when it is a plain name: (t) => ..., function (t) {...}.
function firstParam(text) {
  const match = /^\s*(?:async\b\s*)?(?:function\b\s*\*?\s*[\w$]*\s*)?(\()?\s*([A-Za-z_$][\w$]*)/.exec(text);
  if (!match) return null;
  // `async` alone or `name => ...` without brackets.
  if (!match[1] && !/^\s*(?:async\s+)?[A-Za-z_$][\w$]*\s*=>/.test(text)) return null;
  return match[2];
}

// Checks one JavaScript or TypeScript test file. changes: {added, gaps} from lineChanges();
// checks: {skips, assertions, selfComparisons} (false turns one off).
// Returns [{line, gw, what}].
function checkJs(source, changes, checks) {
  const { code, kinds, comments, templates } = mask(source);
  const lineOf = lineIndex(source);
  const findings = [];
  const span = (from, to) => [lineOf(from), lineOf(Math.max(from, to - 1))];
  const added = (from, to) => {
    const [first, last] = span(from, to);
    for (let line = first; line <= last; line += 1) if (changes.added.has(line)) return true;
    return false;
  };
  // Lines added or changed in the span, or a line removed inside it.
  const touched = (from, to) => {
    const [first, last] = span(from, to);
    return added(from, to) || [...changes.gaps].some((gap) => gap > first && gap <= last);
  };
  const report = (gw, at, what) => findings.push({ line: lineOf(at), gw, what });
  // Code without its spaces and comments, the text of strings kept: how two sides are compared.
  const normal = (from, to) => {
    let text = '';
    for (let i = from; i < to; i += 1) {
      if (kinds[i] === TEXT || (kinds[i] === CODE && !/\s/.test(source[i]))) text += source[i];
    }
    return text;
  };
  const brief = (from, to) => {
    const text = normal(from, to);
    return text.length > 80 ? `${text.slice(0, 77)}...` : text;
  };
  const calls = testCalls(code, templates);

  if (checks.skips !== false) {
    for (const call of calls) {
      const marker = call.members.find((member) => MARKERS.has(member));
      if (marker && added(call.start, call.chainEnd)) report('GW-17', call.start, `${call.name}.${marker} - the test does not run as written`);
      for (const option of call.options) {
        if (added(option.at, option.at + 1)) report('GW-17', option.at, `${call.name}(..., { ${option.name}: ... }) - the test does not run as written`);
      }
    }
    for (const [re, what] of [
      [/(?<![\w$.])(xit|xtest|xdescribe|xcontext|xspecify)\s*\(/g, (m) => `${m[1]} - the test does not run`],
      [/(?<![\w$.])(fit|fdescribe|fcontext)\s*\(\s*['"`]/g, (m) => `${m[1]} - only this test runs`],
      [new RegExp(RUNTIME_SKIP.source, 'g'), (m) => `${m[1]}.${m[2]}() - the test stops as skipped`],
    ]) {
      for (let match = re.exec(code); match; match = re.exec(code)) {
        if (added(match.index, match.index + 1)) report('GW-17', match.index, what(match));
      }
    }
    for (const comment of comments) {
      for (const { line, at } of linesAt(comment.text, comment.start)) {
        if (COMMENTED_TEST.test(line) && added(at, at + 1)) report('GW-17', at, `a test in a comment: ${line.trim().slice(0, 60)}`);
      }
    }
  }

  if (checks.assertions !== false) {
    for (const call of calls) {
      // A test that does not run is a skip (above), not a test without assertions.
      const notRun = call.members.some((member) => NOT_RUN.has(member)) || call.options.some((option) => option.name !== 'only');
      if (!['it', 'test', 'specify'].includes(call.name) || notRun || !touched(call.start, call.end + 1)) continue;
      const fn = call.list.find(([from, to]) => /^(?:async\b|function\b)/.test(code.slice(from, to).trim()) || topLevelArrow(code, from, to));
      if (!fn) continue;
      const body = code.slice(fn[0], fn[1]);
      if (RUNTIME_SKIP.test(body)) continue;
      const param = firstParam(body);
      const own = param && new RegExp(`(?<![\\w$.])${param.replace(/\$/g, '\\$')}\\s*\\.\\s*[A-Za-z_$]`);
      if (ASSERTION.test(body) || (own && own.test(body))) continue;
      const name = call.list.length > 1 ? ` ${brief(...call.list[0])}` : '';
      report('GW-18', call.start, `the test${name} has no assertion`);
    }
  }

  if (checks.selfComparisons !== false) {
    const expectRe = /(?<![\w$.])expect\s*\(/g;
    const stepRe = /\s*\.\s*([A-Za-z_$][\w$]*)/y;
    for (let match = expectRe.exec(code); match; match = expectRe.exec(code)) {
      const open = expectRe.lastIndex - 1;
      const end = closing(code, open);
      if (end === -1) continue;
      const actual = args(code, open, end)[0];
      const props = [];
      let matcher = null;
      stepRe.lastIndex = end + 1;
      for (let step = stepRe.exec(code); step; step = stepRe.exec(code)) {
        const next = skipSpace(code, stepRe.lastIndex);
        if (code[next] === '(') {
          matcher = { name: step[1], open: next, end: closing(code, next) };
          break;
        }
        props.push(step[1]);
      }
      if (!actual || !matcher || matcher.end === -1 || props.includes('not') || !SAME_MATCHERS.has(matcher.name)) continue;
      const expected = args(code, matcher.open, matcher.end)[0];
      if (expected && normal(...actual) === normal(...expected) && added(match.index, matcher.end + 1)) {
        report('GW-01', match.index, `${brief(match.index, matcher.end + 1)} - both sides are the same`);
      }
    }
    const assertRe = new RegExp(`(?<![\\w$.])(?:assert(?:\\s*\\.\\s*strict)?|t(?:\\s*\\.\\s*assert)?)\\s*\\.\\s*(?:${SAME_ASSERTS})\\s*\\(`, 'g');
    for (let match = assertRe.exec(code); match; match = assertRe.exec(code)) {
      const open = assertRe.lastIndex - 1;
      const end = closing(code, open);
      if (end === -1) continue;
      const list = args(code, open, end);
      if (list.length >= 2 && normal(...list[0]) === normal(...list[1]) && added(match.index, end + 1)) {
        report('GW-01', match.index, `${brief(match.index, end + 1)} - both sides are the same`);
      }
    }
  }
  return findings;
}

module.exports = { checkJs, testFileKind, mask };
