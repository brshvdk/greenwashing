'use strict';
// The gate's quick checks on the test lines a turn added or changed: a new skip, focus or
// expected-failure marker (GW-17), a new or changed test with no assertion (GW-18), a check whose
// two sides are the same (GW-01). This file reads JavaScript and TypeScript with a small scanner;
// Python test files go to python_checks.py. Pure functions: texts and changed lines in, findings out.

const { CHECKS } = require('./command');

const JS_EXTENSION = /\.(?:[cm]?[jt]s|[jt]sx)$/;
// pytest's default test files (test_*.py, *_test.py) and unittest discover's (test*.py, which takes
// Django's tests.py).
const PYTHON_TEST = /^test.*\.py$|_test\.py$/;

// The test files jest 30, vitest 5 and node --test (Node 20 and 22) collect by default, seen in
// live runs: *.test.* and *.spec.* (also test.js), *-test.*, *_test.*, test-*, and any file in a
// __tests__ or test folder; and Python's (PYTHON_TEST).
function testFileKind(file) {
  const parts = file.split('/');
  const name = parts.pop();
  if (PYTHON_TEST.test(name)) return 'python';
  if (!JS_EXTENSION.test(name)) return null;
  const stem = name.replace(JS_EXTENSION, '');
  const test = /(?:^|\.)(?:test|spec)$/.test(stem) || /[-_]test$/.test(stem) || /^test-/.test(stem)
    || parts.includes('__tests__') || parts.includes('test');
  return test ? 'js' : null;
}

// Which runners collect a file as tests by default, seen in live runs (jest 30.5.2, vitest 5.0.2, node --test
// on Node 20.20.2, 21.7.3, 22.22.2, 22.23.3 and 24.21.0, pytest 9.1.1, unittest discover of Python 3.11): jest (*.test.*,
// *.spec.* and files in __tests__; js, jsx, ts, tsx, also with c or m), vitest (*.test.*, *.spec.*), node --test
// (*.test.*, *-test.*, *_test.*, test-*, test.*, files under test/; js, cjs, mjs, and ts, mts, cts where Node strips
// types by default), unittest discover (test*.py with a module name: not test-cart.py), pytest (test_*.py,
// *_test.py). None of them looks in node_modules; vitest skips .git, node --test from Node 21 on every folder and file
// whose name starts with a dot (and Node 21 takes no *-test.*), and pytest the folders its norecursedirs names (.*,
// build, dist, venv, *.egg, CVS, _darcs, {arch}). node: the Node the gate runs on ({major, typescript}), the one the
// project's node --test runs on.
const NODE = { major: Number(process.versions.node.split('.')[0]), typescript: Boolean(process.features.typescript) };
const hidden = (dirs, name) => [...dirs, name].some((part) => part.startsWith('.'));
const RUNNER_FILES = {
  jest: (dirs, name) => !dirs.includes('node_modules') && /\.[cm]?[jt]sx?$/.test(name)
    && (dirs.includes('__tests__') || /(?:^|\.)(?:test|spec)\.[cm]?[jt]sx?$/.test(name)),
  vitest: (dirs, name) => !dirs.includes('node_modules') && !dirs.includes('.git') && /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(name),
  'node --test': (dirs, name, node) => {
    const ext = node.typescript ? '\\.[cm]?[jt]s$' : '\\.[cm]?js$';
    return !dirs.includes('node_modules') && !(node.major >= 21 && hidden(dirs, name)) && new RegExp(ext).test(name)
      && (new RegExp(`[._${node.major === 21 ? '' : '-'}]test${ext}`).test(name) || new RegExp(`^test(?:-.*)?${ext}`).test(name) || dirs.includes('test'));
  },
  unittest: (dirs, name) => /^test\w*\.py$/.test(name),
  pytest: (dirs, name) => !dirs.some((dir) => /^(?:\..*|build|dist|venv|node_modules|CVS|_darcs|\{arch\}|.*\.egg)$/.test(dir))
    && /^test_.*\.py$|_test\.py$/.test(name),
};

function collectedBy(file, node = NODE) {
  const dirs = file.split('/');
  const name = dirs.pop();
  return Object.keys(RUNNER_FILES).filter((runner) => RUNNER_FILES[runner](dirs, name, node));
}

// A test that moves from one test file to another keeps running when every runner of the project
// (runners: the kinds support() found; null when not known, so every runner) that collects its old
// file collects the new one too: moved to a file the project's runner does not collect, it is removed.
function carries(from, to, runners, node = NODE) {
  const now = collectedBy(to, node);
  return collectedBy(from, node).filter((runner) => !runners || runners.includes(runner)).every((runner) => now.includes(runner));
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
// source's length and line breaks; kinds[i] is CODE, TEXT or COMMENT; comments: [{start, text}], with
// open and close, the indexes of /* and */, for a block comment;
// templates: index of each opening backtick -> index of its closing one. A template or a block
// comment that never closes is not one: a stray backtick or `/*` in JSX text would hide the rest
// of the file, so the backtick is read again as a plain character and the `/*` as code.
function mask(source) {
  const plain = new Set();
  for (;;) {
    const read = scan(source, plain);
    if (read.unclosed.length === 0) return read;
    for (const at of read.unclosed) plain.add(at);
  }
}

function scan(source, plain) {
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
      } else if (c === '`' && !plain.has(i)) {
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
    } else if (c === '/' && source[i + 1] === '*' && source.indexOf('*/', i + 2) !== -1) {
      const close = source.indexOf('*/', i + 2);
      comments.push({ start: i + 2, text: source.slice(i + 2, close), open: i, close });
      blank(i, close + 2, COMMENT);
      i = close + 2;
    } else if (c === '\'' || c === '"') {
      // A string ends at its quote, or at the end of the line when it is broken.
      let end = i + 1;
      while (end < n && source[end] !== c && !isBreak(source[end])) end += source[end] === '\\' ? 2 : 1;
      blank(i + 1, end, TEXT);
      i = end < n && source[end] === c ? end + 1 : end;
      [last, word] = ['word', ''];
    } else if (c === '`' && !plain.has(i)) {
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
  return { code: code.join(''), kinds, comments, templates, unclosed: open.map((template) => template.start) };
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

// The markers on describe/it/test/..., and what each does to the test (fixme and fail: Playwright).
const MARKERS = {
  skip: 'the test does not run', todo: 'the test does not run', fixme: 'the test does not run',
  skipIf: 'the test does not run while the condition holds', runIf: 'the test does not run unless the condition holds',
  only: 'only this test runs', failing: 'the test passes when it fails', fails: 'the test passes when it fails',
  fail: 'the test passes when it fails',
};
const NOT_RUN = new Set(['skip', 'todo', 'fixme', 'skipIf', 'runIf']);
// The suite markers after which no test in the suite runs, whatever the environment.
const SUITE_SKIPS = new Set(['skip', 'todo', 'fixme']);
// The members that leave a call a test: test.only(...), it.each(table)(...). Anything else is not a
// test (Playwright's test.beforeEach, test.step, test.describe, test.use).
const TEST_MODIFIERS = new Set([...Object.keys(MARKERS), 'concurrent', 'each', 'for', 'sequential', 'shuffle']);
// Jasmine and jest aliases.
const ALIASES = {
  xit: 'the test does not run', xtest: 'the test does not run', xspecify: 'the test does not run',
  xdescribe: 'the tests in it do not run', xcontext: 'the tests in it do not run',
  fit: 'only this test runs', fdescribe: 'only these tests run', fcontext: 'only these tests run',
};
const TEST_OBJECTS = 'describe|it|test|context|suite|specify|bench';
const TESTS = new Set(['it', 'test', 'specify']);
const SUITES = new Set(['describe', 'context', 'suite']);
// node:test options that stop a test from running as written (fails: vitest).
const OPTION = /(?<![\w$])(skip|only|todo|fails)\s*(?::(?!\s*false\b)|(?=\s*(?:,|$)))/g;
// node:test context members that check nothing.
const NOT_ASSERTING = new Set(['after', 'afterEach', 'before', 'beforeEach', 'diagnostic', 'mock', 'name', 'fullName',
  'filePath', 'signal', 'skip', 'todo', 'runOnly']);
// Modules whose functions are assertions.
const ASSERT_MODULE = /^(?:node:)?assert(?:\/strict)?$|^chai$|^uvu\/assert$|^power-assert$/;
// Matchers and asserts that pass whenever their two sides are the same.
const SAME_MATCHERS = new Set(['toBe', 'toEqual', 'toStrictEqual', 'toMatchObject', 'toBeCloseTo', 'toBeGreaterThanOrEqual',
  'toBeLessThanOrEqual', 'equal', 'equals', 'eql', 'eq']);
const SAME_ASSERTS = ['equal', 'strictEqual', 'deepEqual', 'deepStrictEqual', 'is', 'same', 'strictSame', 'like', 'equals', 'deepEquals'];
// A value that is always truthy, written out: true, a non-zero number, a non-empty string.
const TRUTHY = /^(?:true|[1-9][\d.]*|0\.\d*[1-9]\d*|'[^']+'|"[^"]+"|`[^`$]+`)$/;
const COMMENTED_TEST = /^\s*(?:\*\s*)?(?:it|test|describe)\s*(?:\.\s*[A-Za-z_$][\w$]*\s*)*\(\s*['"`]/;
const GENERIC = String.raw`(?:<[^<>\n]*>\s*)?`;
const escape = (name) => name.replace(/\$/g, '\\$');

// The names a file binds to assertion modules (ASSERT_MODULE): {calls: local names of imported
// functions -> the name the module gives them, spaces: default and namespace imports}.
function assertImports(source, code) {
  const calls = new Map();
  const spaces = new Set();
  const moduleAt = (quote) => source.slice(quote + 1, source.indexOf(source[quote], quote + 1));
  const bind = (list) => {
    const inner = /^\{([\s\S]*)\}$/.exec(list.trim());
    if (!inner) {
      const name = /^(?:\*\s*as\s+)?([A-Za-z_$][\w$]*)$/.exec(list.trim());
      if (name) spaces.add(name[1]);
      return;
    }
    for (const part of inner[1].split(',')) {
      const pair = /^\s*([A-Za-z_$][\w$]*)(?:\s*(?:as|:)\s*([A-Za-z_$][\w$]*))?\s*$/.exec(part);
      if (pair) calls.set(pair[2] || pair[1], pair[1]);
    }
  };
  for (const m of code.matchAll(/\bimport\s+([\w$*\s{},]+?)\s+from\s*(['"])/g)) {
    if (!ASSERT_MODULE.test(moduleAt(m.index + m[0].length - 1))) continue;
    // import assert, { equal } from '...'
    const [first, ...rest] = m[1].split(/,(?![^{]*\})/);
    bind(first);
    for (const more of rest) bind(more);
  }
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([\w$\s{},:]+?)\s*=\s*require\s*\(\s*(['"])/g)) {
    if (ASSERT_MODULE.test(moduleAt(m.index + m[0].length - 1))) bind(m[1]);
  }
  return { calls, spaces };
}

// The test and suite calls: {name, members, start, chainEnd, condStart, condEnd, end, list, options,
// fn, param, skipParam}. chainEnd: the end of `test.only.each`; condStart and condEnd: the brackets
// of the condition of skipIf/runIf; end closes the call that takes the name and the function (after the table of
// .each/.for), list holds its arguments, options its node:test options ([{name, at}]), fn the
// function argument, param the function's first parameter and skipParam whether it destructures
// `skip` ({ skip }) => ... (vitest). Subtests t.test(...) of a test whose first parameter is t count.
function testCalls(code, templates) {
  const calls = [];
  const membersRe = /(?:\s*\.\s*[A-Za-z_$][\w$]*)*/y;
  const read = (name, start, from) => {
    membersRe.lastIndex = from;
    const chain = membersRe.exec(code)[0];
    const members = chain.split('.').map((part) => part.trim()).filter(Boolean);
    const chainEnd = from + chain.length;
    let at = skipSpace(code, chainEnd);
    let condStart = null;
    let condEnd = null;
    if (members.some((member) => member === 'skipIf' || member === 'runIf') && code[at] === '(') {
      condStart = at;
      condEnd = closing(code, at);
      if (condEnd === -1) return null;
      at = skipSpace(code, condEnd + 1);
    }
    if (members.some((member) => member === 'each' || member === 'for')) {
      const table = code[at] === '`' ? templates.get(at) : code[at] === '(' ? closing(code, at) : undefined;
      if (table === undefined || table === -1) return null;
      at = skipSpace(code, table + 1);
    }
    if (code[at] !== '(') return null;
    const end = closing(code, at);
    if (end === -1) return null;
    const list = args(code, at, end);
    const fn = list.find(([a, b]) => /^(?:async\b|function\b)/.test(code.slice(a, b).trim()) || topLevelArrow(code, a, b)) || null;
    const head = fn ? code.slice(fn[0], Math.min(fn[1], fn[0] + 200)) : '';
    const destructured = /^\s*(?:async\s*)?(?:function\b[^(]*)?\(\s*\{([^}]*)\}/.exec(head);
    return {
      name, members, start, chainEnd, condStart, condEnd, end, list, options: options(code, list), fn,
      param: fn ? firstParam(head) : null,
      skipParam: Boolean(destructured && /(?<![\w$])skip(?![\w$])/.test(destructured[1])),
    };
  };
  const callRe = new RegExp(`(?<![\\w$.])(${TEST_OBJECTS})\\b`, 'g');
  for (let match = callRe.exec(code); match; match = callRe.exec(code)) {
    const call = read(match[1], match.index, callRe.lastIndex);
    if (call) calls.push(call);
  }
  for (let i = 0; i < calls.length; i += 1) {
    const parent = calls[i];
    if (!parent.param || !TESTS.has(parent.name)) continue;
    const subRe = new RegExp(`(?<![\\w$.])${escape(parent.param)}\\s*\\.\\s*test\\b`, 'g');
    const body = code.slice(parent.fn[0], parent.fn[1]);
    for (let match = subRe.exec(body); match; match = subRe.exec(body)) {
      const call = read('test', parent.fn[0] + match.index, parent.fn[0] + subRe.lastIndex);
      if (call) calls.push(call);
    }
  }
  return calls;
}

// node:test options in an object argument: test('name', { skip: true }, fn). Returns [{name, at}]
// for each skip, only, todo or fails key at the top of the object whose value is not false.
function options(code, list) {
  const found = [];
  for (const [from] of list) {
    const at = skipSpace(code, from);
    if (code[at] !== '{') continue;
    const close = closing(code, at);
    if (close === -1) continue;
    const inside = code.slice(at + 1, close);
    for (const option of inside.matchAll(OPTION)) {
      const depth = [...inside.slice(0, option.index)].reduce((sum, ch) => sum + ('([{'.includes(ch) ? 1 : ')]}'.includes(ch) ? -1 : 0), 0);
      if (depth === 0) found.push({ name: option[1], at: at + 1 + option.index });
    }
  }
  return found;
}

// The end of a declaration's initializer that starts at from: a ; or a closing bracket at its own
// depth, or a line break that neither the line before (ending in an operator: ? : = , < > | & + -
// * /) nor the line after (starting with ? : . || && ??) continues; at most INITIALIZER characters,
// so unbalanced brackets cannot make every declaration read to the end of the file.
const INITIALIZER = 2000;
function initializerEnd(code, from) {
  const stop = Math.min(code.length, from + INITIALIZER);
  let depth = 0;
  let last = '';
  for (let i = from; i < stop; i += 1) {
    const c = code[i];
    if ('([{'.includes(c)) depth += 1;
    else if (')]}'.includes(c)) {
      if (depth === 0) return i;
      depth -= 1;
    } else if (depth === 0 && c === ';') return i;
    else if (depth === 0 && c === '\n' && !'?:=,<>|&+-*/'.includes(last)
      && !/^\s*(?:[?:.]|\|\||&&|\?\?)/.test(code.slice(i + 1, i + 80))) return i;
    if (!/\s/.test(c)) last = c;
  }
  return stop;
}

// The name of a function's first parameter when it is a plain name: (t) => ..., function (t) {...}.
function firstParam(text) {
  const match = /^\s*(?:async\b\s*)?(?:function\b\s*\*?\s*[\w$]*\s*)?(\()?\s*([A-Za-z_$][\w$]*)/.exec(text);
  if (!match) return null;
  // `async` alone or `name => ...` without brackets.
  if (!match[1] && !/^\s*(?:async\s+)?[A-Za-z_$][\w$]*\s*=>/.test(text)) return null;
  return match[2];
}

// A test call: it, test or specify, with only members that leave it a test (test.only, it.each).
const isTest = (call) => TESTS.has(call.name) && call.members.every((member) => TEST_MODIFIERS.has(member));

// A name the CI variable goes by: process.env.CI, process.env['CI'], const { CI } = process.env.
const CI_WORD = /(?<![\w$])CI(?![\w$])/;

// The source between from and to with its comments blanked out: strings stay, since the name of an
// environment variable can be one (process.env['CI']).
function withoutComments(source, kinds, from, to) {
  let text = '';
  for (let i = from; i < to; i += 1) text += kinds[i] === COMMENT ? ' ' : source[i];
  return text;
}

// The condition between from and to reads the CI variable, itself or through a name the file
// declares from it (const isCI = !!process.env.CI). The gate runs the tests with CI=true, so such a
// condition decides by where the tests run, not by the code: a skip, unlike a platform or version
// condition.
function readsCi({ source, code, kinds }, from, to) {
  if (CI_WORD.test(withoutComments(source, kinds, from, to))) return true;
  for (const name of new Set(code.slice(from, to).match(/[A-Za-z_$][\w$]*/g) || [])) {
    for (const m of code.matchAll(new RegExp(`(?<![\\w$.])(?:const|let|var)\\s+${escape(name)}\\s*=(?!=)`, 'g'))) {
      const at = m.index + m[0].length;
      if (CI_WORD.test(withoutComments(source, kinds, at, initializerEnd(code, at)))) return true;
    }
  }
  return false;
}

// The suites that never run in masked code: describe.skip(...), xdescribe(...), and skipIf or runIf
// whose condition reads CI (readsCi) - not other conditions, which may let them run.
// [{start, end, head (the end of the marker), what}]; file: {source, code, kinds} (mask()).
function neverRunSuites(file, calls) {
  const { code } = file;
  const ci = (call) => call.condEnd !== null && readsCi(file, call.condStart + 1, call.condEnd);
  const suites = calls.filter((call) => SUITES.has(call.name) && call.members.some((member) => SUITE_SKIPS.has(member)))
    .map((call) => ({ start: call.start, end: call.end, head: call.chainEnd, what: `${call.name}.${call.members.find((member) => SUITE_SKIPS.has(member))}` }));
  for (const call of calls.filter((one) => SUITES.has(one.name) && ci(one))) {
    const member = call.members.find((one) => one === 'skipIf' || one === 'runIf');
    suites.push({ start: call.start, end: call.end, head: call.condEnd + 1, what: `${call.name}.${member} on CI`, ci: true });
  }
  for (const m of code.matchAll(/(?<![\w$.])(xdescribe|xcontext)\s*\(/g)) {
    const end = closing(code, m.index + m[0].length - 1);
    if (end !== -1) suites.push({ start: m.index, end, head: m.index + m[1].length, what: m[1] });
  }
  return suites;
}

// A test's name as written: its first argument ('adds two numbers'), or null.
const nameOf = (source, test) => (test.list.length ? source.slice(test.list[0][0], test.list[0][1]).trim() : null);

// The names of a file's tests outside every suite that never runs, and inside one: {outside, inside}.
function testNames(source) {
  const { code, kinds, templates } = mask(source);
  const calls = testCalls(code, templates);
  const suites = neverRunSuites({ source, code, kinds }, calls);
  const names = { outside: new Set(), inside: new Set() };
  for (const test of calls.filter(isTest)) {
    const inside = suites.some((suite) => suite.start < test.start && test.end < suite.end);
    names[inside ? 'inside' : 'outside'].add(nameOf(source, test));
  }
  return names;
}

// Code between from and to without its spaces and comments, the text of strings kept: how the two
// sides of a check, and the bodies of two tests, are compared.
function normalText(source, kinds, from, to) {
  let text = '';
  for (let i = from; i < to; i += 1) {
    if (kinds[i] === TEXT || (kinds[i] === CODE && !/\s/.test(source[i]))) text += source[i];
  }
  return text;
}

// Code between from and to as normalText() reads it, with each string, and each template with no ${}, in
// one form: 'x', "x" and `x` are the same (a formatter changes the quotes), a quote escaped in them read as the quote.
function testText(source, kinds, templates, from, to) {
  let text = '';
  for (let i = from; i < to; i += 1) {
    const c = source[i];
    if (kinds[i] === CODE && (c === '\'' || c === '"' || (c === '`' && templates.has(i)))) {
      let end = c === '`' ? templates.get(i) : i + 1;
      if (c !== '`') while (end < to && kinds[end] === TEXT) end += 1;
      if (end < to && source[end] === c && kinds.subarray(i + 1, end).every((kind) => kind === TEXT)) {
        const inside = source.slice(i + 1, end).replace(/\\([\s\S])|"/g, (m, escaped) => (escaped === undefined || escaped === '"' ? '\\"'
          : escaped === '\'' || escaped === '`' ? escaped : m));
        text += `"${inside}"`;
        i = end;
        continue;
      }
    }
    if (kinds[i] === TEXT || (kinds[i] === CODE && !/\s/.test(c))) text += c;
  }
  return text;
}

// The tests of a JavaScript or TypeScript file, as the checks see them: [{name, key, body}]. name: the
// names of the suites and tests around the test and its own, as written, joined by ' > ' (a test given
// only a function, test(function name() {...}), goes by the function's name); key: the same in testText()
// form; body: the rest of the call without its name (a skip condition, a table, options, the function), in
// testText() form, or null for a call with no function (a todo).
function jsTests(source) {
  const { code, kinds, templates } = mask(source);
  const calls = testCalls(code, templates);
  // Each test's name ([from, to] of the source, or null) and the suites and tests around it, in one pass
  // over the calls in the order of the file.
  const names = new Map();
  const title = (call) => {
    if (!names.has(call)) {
      const first = call.list[0];
      let at = first && first !== call.fn ? first : null;
      if (first && first === call.fn) {
        const fn = /^(\s*(?:async\s+)?function\s*\*?\s*)([A-Za-z_$][\w$]*)/.exec(code.slice(first[0], first[1]));
        if (fn) at = [first[0] + fn[1].length, first[0] + fn[0].length];
      }
      names.set(call, at);
    }
    return names.get(call);
  };
  const open = [];
  const tests = [];
  for (const call of calls.filter((one) => SUITES.has(one.name) || isTest(one)).sort((a, b) => a.start - b.start)) {
    while (open.length && open[open.length - 1].end < call.start) open.pop();
    const around = open.filter((one) => call.end < one.end);
    open.push(call);
    if (!isTest(call)) continue;
    const at = title(call);
    const path = [...around, call];
    const [from, to] = at || [call.end, call.end];
    tests.push({
      name: path.map((one) => (title(one) ? normalText(source, kinds, ...title(one)) : '')).join(' > '),
      key: path.map((one) => (title(one) ? testText(source, kinds, templates, ...title(one)) : '')).join(' > '),
      body: call.fn ? testText(source, kinds, templates, call.chainEnd, from) + testText(source, kinds, templates, to, call.end + 1) : null,
    });
  }
  return tests;
}

// The tests a turn removed: before and after are the tests of the changed test files at the start
// and now, [{file, name, key, body}] (jsTests(), or python_checks.py's list). A test stays when a test of
// its key is still in its file (edited in place; of several with one key, those with the same body pair
// first), or when a test left over now has its body and is in its file or in one that keeps it running
// (keeps(from, to), carries(): renamed, or moved to another test file); each test left over now stands for
// one test of before, so a body pasted into a test that stays under its own key excuses nothing. A test
// left over now that does not run is new, and the skip check reports it. Returns the tests of before that
// stay neither way.
function removedTests(before, after, keeps = () => true) {
  const byKey = (tests) => {
    const groups = new Map();
    for (const test of tests) {
      const key = `${test.file}\0${test.key}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(test);
    }
    return groups;
  };
  const now = byKey(after);
  const unmatched = [];
  const spare = [];
  for (const [key, old] of byKey(before)) {
    const left = now.get(key) || [];
    now.delete(key);
    const rest = [];
    for (const test of old) {
      const same = left.findIndex((one) => one.body === test.body);
      if (same === -1) rest.push(test);
      else left.splice(same, 1);
    }
    // The others of the key are edited in place, one for one.
    unmatched.push(...rest.slice(left.length));
    spare.push(...left.slice(rest.length));
  }
  for (const left of now.values()) spare.push(...left);
  const bodies = new Map();
  for (const test of spare) {
    if (test.body === null) continue;
    if (!bodies.has(test.body)) bodies.set(test.body, []);
    bodies.get(test.body).push(test);
  }
  return unmatched.filter((test) => {
    const same = bodies.get(test.body) || [];
    const at = same.findIndex((one) => one.file === test.file || keeps(test.file, one.file));
    if (at === -1) return true;
    same.splice(at, 1);
    return false;
  });
}

// Checks one JavaScript or TypeScript test file. changes: {added, gaps} from lineChanges();
// checks: {skips, assertions, selfComparisons} (false turns one off); before: the file's text at the
// start of the turn, or null. Returns [{line, gw, what}].
function checkJs(source, changes, checks, before = null) {
  const { code, kinds, comments, templates } = mask(source);
  const lineOf = lineIndex(source);
  const findings = [];
  const span = (from, to) => [lineOf(from), lineOf(Math.max(from, to - 1))];
  const added = (from, to) => {
    const [first, last] = span(from, to);
    for (let line = first; line <= last; line += 1) if (changes.added.has(line)) return true;
    return false;
  };
  // A test that is new here, or moved here: its first line (with its name) added, and no line removed
  // in its place - an edited or renamed test is a changed line, one removed and one added. The rest
  // of it may match other lines (a closing "});").
  const isNew = (at) => changes.added.has(lineOf(at)) && !changes.gaps.has(lineOf(at));
  // Lines added or changed in the span, or a line removed inside it.
  const touched = (from, to) => {
    const [first, last] = span(from, to);
    return added(from, to) || [...changes.gaps].some((gap) => gap > first && gap <= last);
  };
  const report = (gw, at, what) => findings.push({ line: lineOf(at), gw, what });
  const normal = (from, to) => normalText(source, kinds, from, to);
  const brief = (from, to) => {
    const text = normal(from, to);
    return text.length > 80 ? `${text.slice(0, 77)}...` : text;
  };
  const calls = testCalls(code, templates);
  const imports = assertImports(source, code);
  const tests = calls.filter(isTest);
  const skippedSuites = neverRunSuites({ source, code, kinds }, calls);
  const inSkipped = (test) => skippedSuites.find((suite) => suite.start < test.start && test.end < suite.end);
  // In a suite that never runs whatever the environment: a test there is a skip, not a test to read
  // for assertions (one in a suite skipped on CI still runs elsewhere).
  const neverRuns = (test) => skippedSuites.some((suite) => !suite.ci && suite.start < test.start && test.end < suite.end);
  // A test that was outside every suite that never runs at the start of the turn, under its name.
  let names = null;
  const wasOutside = (test) => {
    if (before === null) return false;
    names = names || testNames(before);
    const name = nameOf(source, test);
    return names.outside.has(name) && !names.inside.has(name);
  };
  // Where a test stops itself as skipped: this.skip() (mocha), t.skip() or ctx.skip() on its own
  // context (node:test, vitest), skip() destructured from it (vitest).
  const runtimeSkips = (test) => {
    if (!test.fn) return [];
    const body = code.slice(test.fn[0], test.fn[1]);
    const names = ['this', ...(test.param ? [escape(test.param)] : [])].join('|');
    const re = new RegExp(`(?<![\\w$.])(?:(${names})\\s*\\.\\s*(skip|todo)${test.skipParam ? '|(skip)' : ''})\\s*\\(`, 'g');
    return [...body.matchAll(re)].map((m) => ({ at: test.fn[0] + m.index, what: m[1] ? `${m[1]}.${m[2]}()` : 'skip()' }));
  };
  // An assertion that cannot fail: assert(true), assert.ok(1), expect('x').toBeTruthy(), expect(1).toBeDefined().
  // open: the bracket of the call; expect: whether it is expect(...).
  const cannotFail = (open, expect) => {
    const end = closing(code, open);
    const first = end === -1 ? null : args(code, open, end)[0];
    if (!first || !TRUTHY.test(normal(...first))) return false;
    return !expect || /^\s*\.\s*(?:toBeTruthy|toBeDefined)\s*\(\s*\)/.test(code.slice(end + 1, end + 40));
  };
  // The code between from and to checks something: expect(...).<matcher>, assert(...), assert.<x>,
  // a call to a helper named expect... or assert..., .should, a member of the test's context
  // (t. or its first parameter) other than NOT_ASSERTING, or a function imported from an
  // assertion module.
  const checksSomething = (from, to, param) => {
    const contexts = ['t', ...(param && param !== 't' ? [escape(param)] : [])].join('|');
    const imported = [...imports.calls.keys(), ...imports.spaces].map(escape).join('|');
    const re = new RegExp([
      `(?<![\\w$])(?<!console\\s*\\.\\s*)(expect|assert)\\s*${GENERIC}([.(])`,
      `(?<![\\w$])((?:expect|assert)[\\w$]+)\\s*${GENERIC}\\(`,
      '\\.\\s*(should)\\b',
      `(?<![\\w$.])(${contexts})\\s*\\.\\s*([A-Za-z_$][\\w$]*)`,
      ...(imported ? [`(?<![\\w$.])(${imported})\\s*[.(]`] : []),
    ].join('|'), 'g');
    const body = code.slice(from, to);
    for (const m of body.matchAll(re)) {
      const at = from + m.index + m[0].length - 1;
      const method = code.slice(0, from + m.index).trimEnd().endsWith('.');
      if (m[1] === 'expect' && m[2] === '(' && !method) {
        // expect(value) with no matcher after it checks nothing; request(app).expect(200) (supertest) does.
        const end = closing(code, at);
        if (end !== -1 && code[skipSpace(code, end + 1)] === '.' && !cannotFail(at, true)) return true;
      } else if (m[1] === 'assert' && m[2] === '(') {
        if (!cannotFail(at, false)) return true;
      } else if (m[1] === 'assert') {
        const ok = /^\s*ok\s*\(/.exec(code.slice(at + 1, at + 20));
        if (!ok || !cannotFail(at + ok[0].length, false)) return true;
      } else if (m[5]) {
        if (!NOT_ASSERTING.has(m[6])) return true;
      } else return true;
    }
    return false;
  };

  if (checks.skips !== false) {
    // Every marker on describe/it/test/..., called or not: `(ci ? it.skip : it)('name', fn)` too.
    const chainRe = new RegExp(`(?<![\\w$.])(${TEST_OBJECTS})((?:\\s*\\.\\s*[A-Za-z_$][\\w$]*)+)`, 'g');
    const markers = [];
    for (const m of code.matchAll(chainRe)) {
      const marker = m[2].split('.').map((part) => part.trim()).find((member) => MARKERS[member]);
      if (marker) markers.push({ name: m[1], marker, start: m.index, chainEnd: m.index + m[0].length });
    }
    for (const found of markers) {
      const call = calls.find((c) => c.start === found.start);
      // A todo with no function is a placeholder: nothing runs and nothing can hide a failure.
      if (found.marker === 'todo' && call && !call.fn) continue;
      // The condition of skipIf/runIf is part of the marker: a changed condition is a new skip.
      const end = call && call.condEnd !== null ? call.condEnd + 1 : found.chainEnd;
      if (added(found.start, end)) report(CHECKS.skips, found.start, `${found.name}.${found.marker} - ${MARKERS[found.marker]}`);
    }
    // A name given to a marker: const pending = ci ? it.skip : it; ... pending('name', fn), also
    // pending.each(...)(...).
    for (const m of code.matchAll(/(?<![\w$.])(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) {
      const end = initializerEnd(code, m.index + m[0].length);
      const inside = markers.find((found) => found.start > m.index && found.start < end);
      if (!inside) continue;
      for (const use of code.matchAll(new RegExp(`(?<![\\w$.])${escape(m[1])}\\s*[.(]`, 'g'))) {
        if (added(use.index, use.index + 1)) report(CHECKS.skips, use.index, `${m[1]} (${inside.name}.${inside.marker}) - ${MARKERS[inside.marker]}`);
      }
    }
    for (const m of code.matchAll(/(?<![\w$.])(xit|xtest|xdescribe|xcontext|xspecify)\s*\(|(?<![\w$.])(fit|fdescribe|fcontext)\s*\(\s*['"`]/g)) {
      const alias = m[1] || m[2];
      if (added(m.index, m.index + 1)) report(CHECKS.skips, m.index, `${alias} - ${ALIASES[alias]}`);
    }
    for (const call of calls) {
      for (const option of call.options) {
        if (option.name === 'todo' && !call.fn) continue;
        const what = option.name === 'only' ? MARKERS.only : option.name === 'fails' ? MARKERS.fails : MARKERS.skip;
        if (added(option.at, option.at + 1)) report(CHECKS.skips, option.at, `${call.name}(..., { ${option.name} }) - ${what}`);
      }
    }
    for (const test of tests) {
      for (const skip of runtimeSkips(test)) {
        if (added(skip.at, skip.at + 1)) report(CHECKS.skips, skip.at, `${skip.what} - the test stops as skipped`);
      }
      // A test new in a suite that never runs, or brought into one: moved there, or the suite moved
      // around it. A new marker of the suite is reported above, not again for each test in it.
      const suite = inSkipped(test);
      if (suite && !added(suite.start, suite.head) && (isNew(test.start) || wasOutside(test))) {
        report(CHECKS.skips, test.start, `a test inside ${suite.what} - ${suite.ci ? 'whether it runs depends on CI (the gate runs the tests with CI=true)' : 'the test does not run'}`);
      }
    }
    // mocha: this.skip() also in a hook skips the tests it runs for.
    for (const m of code.matchAll(/(?<![\w$.])this\s*\.\s*skip\s*\(/g)) {
      if (added(m.index, m.index + 1)) report(CHECKS.skips, m.index, 'this.skip() - the test stops as skipped');
    }
    // vitest and node:test: a before hook that skips through its context, beforeEach((ctx) => ctx.skip()).
    for (const m of code.matchAll(/(?<![\w$.])(?:beforeEach|beforeAll|before)\s*\(/g)) {
      const open = m.index + m[0].length - 1;
      const close = closing(code, open);
      const fn = close === -1 ? null : args(code, open, close).find(([a, b]) => /^(?:async\b|function\b)/.test(code.slice(a, b).trim()) || topLevelArrow(code, a, b));
      const param = fn && firstParam(code.slice(fn[0], Math.min(fn[1], fn[0] + 200)));
      if (!param) continue;
      for (const skip of code.slice(fn[0], fn[1]).matchAll(new RegExp(`(?<![\\w$.])${escape(param)}\\s*\\.\\s*skip\\s*\\(`, 'g'))) {
        const at = fn[0] + skip.index;
        if (added(at, at + 1)) report(CHECKS.skips, at, `${param}.skip() in a hook - the tests stop as skipped`);
      }
    }
    for (const comment of comments) {
      // A block comment whose /* or */ is new comments out the old lines inside it too.
      const wrapped = comment.open !== undefined && (added(comment.open, comment.open + 1) || added(comment.close, comment.close + 1));
      for (const { line, at } of linesAt(comment.text, comment.start)) {
        if (COMMENTED_TEST.test(line) && (wrapped || added(at, at + 1))) report(CHECKS.skips, at, `a test in a comment: ${line.trim().slice(0, 60)}`);
      }
    }
  }

  if (checks.assertions !== false) {
    for (const test of tests) {
      // A test that does not run is a skip (above), not a test without assertions.
      const notRun = test.members.some((member) => NOT_RUN.has(member)) || test.options.some((option) => option.name !== 'only')
        || runtimeSkips(test).length > 0 || neverRuns(test);
      if (notRun || !touched(test.start, test.end + 1)) continue;
      const name = test.list.length && test.list[0] !== test.fn ? ` ${brief(...test.list[0])}` : '';
      // test('name') with no function checks nothing; test.fail() or test.skip(cond) inside a test
      // (Playwright) declares no test.
      const declares = test.list.length > 0 && /^\s*['"`]/.test(code.slice(test.list[0][0], test.list[0][1]))
        && test.list.slice(1).every(([a, b]) => /^\s*\{/.test(code.slice(a, b)));
      if (!test.fn && declares) report(CHECKS.assertions, test.start, `the test${name} has no function, so it checks nothing`);
      else if (test.fn && !checksSomething(test.fn[0], test.fn[1], test.param)) report(CHECKS.assertions, test.start, `the test${name} has no assertion`);
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
        report(CHECKS.selfComparisons, match.index, `${brief(match.index, matcher.end + 1)} - both sides are the same`);
      }
    }
    // assert.equal(a, a), t.is(a, a), and the same asserts imported: strictEqual(a, a).
    const spaces = ['assert(?:\\s*\\.\\s*strict)?', 't(?:\\s*\\.\\s*assert)?', ...[...imports.spaces].map(escape)].join('|');
    const bare = [...imports.calls].filter(([, name]) => SAME_ASSERTS.includes(name)).map(([local]) => escape(local));
    const assertRe = new RegExp(`(?<![\\w$.])(?:(?:${spaces})\\s*\\.\\s*(?:${SAME_ASSERTS.join('|')})${bare.length ? `|${bare.join('|')}` : ''})\\s*\\(`, 'g');
    for (let match = assertRe.exec(code); match; match = assertRe.exec(code)) {
      const open = assertRe.lastIndex - 1;
      const end = closing(code, open);
      if (end === -1) continue;
      const list = args(code, open, end);
      if (list.length >= 2 && normal(...list[0]) === normal(...list[1]) && added(match.index, end + 1)) {
        report(CHECKS.selfComparisons, match.index, `${brief(match.index, end + 1)} - both sides are the same`);
      }
    }
  }
  // One finding per line and entry, in the order of the file.
  const seen = new Set();
  return findings.filter((f) => !seen.has(`${f.line} ${f.gw}`) && seen.add(`${f.line} ${f.gw}`)).sort((a, b) => a.line - b.line);
}

module.exports = {
  checkJs, jsTests, removedTests, carries, collectedBy, testFileKind, mask, closing, initializerEnd, JS_EXTENSION, INITIALIZER,
};
