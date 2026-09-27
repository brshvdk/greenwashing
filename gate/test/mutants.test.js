'use strict';
// The mutation command's logic: which files and lines, which breaks, which of them are tried, and
// what the outcomes add up to. Python breaks come from python_mutants.py, run the way the command runs it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  codeKind, addedLines, ownLines, jsMutants, fromLines, apply, controlBreak, stillParses, describe, choose, byPlace, estimate, report, OUTCOMES, HINTS, NOT_EXERCISED, CONTROL_MESSAGE,
} = require('../lib/mutants');
const { CATALOG } = require('../lib/verdict');

const everyLine = (source) => new Set(source.split(/\r\n|\r|\n/).map((_, i) => i + 1));
// The breaks of a JavaScript text on every line: [op, the first changed line after].
const breaks = (source, lines = everyLine(source)) => jsMutants(source, lines).map((m) => [m.op, describe(source, m).change]);
const ops = (source) => jsMutants(source, everyLine(source)).map((m) => m.op);

test('code under test: JavaScript, TypeScript and Python files that are not tests, test helpers, runner config or dependencies', () => {
  for (const file of ['src/cart.js', 'cart.ts', 'lib/a.mjs', 'b.cjs', 'ui/C.tsx', 'd.jsx', 'shop/models.py', 'app/__init__.py', 'src/setup.js', 'src/d.ts.js', 'config.js']) {
    assert.notEqual(codeKind(file), null, file);
  }
  assert.equal(codeKind('src/cart.js'), 'js');
  assert.equal(codeKind('shop/models.py'), 'python');
  const none = ['cart.test.js', 'cart.spec.ts', '__tests__/a.js', 'test/helpers.js', 'tests/helpers.js', 'tests/helpers.py', 'spec/a.js',
    '__mocks__/fs.js', 'test_cart.py', 'cart_test.py', 'conftest.py', 'sub/conftest.py', 'jest.config.js', 'vitest.config.mts',
    'node_modules/x/index.js', '.venv/lib/site.py', 'venv/a.py', 'README.md', 'data.json', 'cart.go', 'e2e/login.js', 'cypress/support/a.js',
    'login.cy.js', 'src/app.test-d.ts', 'src/setupTests.js', 'jest.setup.js', 'vitest.setup.ts', '.eslintrc.js', 'index.d.ts', 'types/api.d.mts'];
  for (const file of none) assert.equal(codeKind(file), null, file);
});

test('the changed lines are the + lines of each hunk of git diff, numbered as git numbers them', () => {
  const diff = 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1,0 +2,3 @@\n+a\n+b\n+c\n@@ -10 +13 @@\n-x\n+y\n@@ -20,2 +22,0 @@\n-p\n-q\n@@ -30 +29,2 @@\n+m\n+n\n';
  assert.deepEqual([...addedLines(diff)].sort((a, b) => a - b), [2, 3, 4, 13, 29, 30]);
  assert.deepEqual([...addedLines('')], []);
  // Context lines inside a hunk (diff.interHunkContext), a blank one too, and the no-newline marker.
  const context = '@@ -1,5 +1,5 @@\n-A = 1\n+A = 10\n B = 2\n\n D = 4\n-E = 5\n+E = 50\n\\ No newline at end of file\n';
  assert.deepEqual([...addedLines(context)], [1, 5]);
  assert.deepEqual([...addedLines('--- a/x.js\n+++ b/x.js\n@@ -1 +1 @@\n-a\n+b\n')], [1]);
});

test("git's lines (split at LF) as the file's own lines (split at CRLF, CR and LF)", () => {
  // Line 1 of git holds three lines of the file: a lone CR splits it.
  assert.deepEqual([...ownLines('/* h\r\r */\nA\nC\nB\nX\n', new Set([4, 5]))], [6, 7]);
  assert.deepEqual([...ownLines('/* h\r\r */\nA\n', new Set([1]))], [1, 2, 3]);
  assert.deepEqual([...ownLines('a\r\nb\r\nc\n', new Set([2, 3]))], [2, 3]);
  assert.deepEqual([...ownLines('a\nb', new Set())], []);
});

test('each kind of break in JavaScript: comparison, condition, guard, return, boolean, number', () => {
  assert.deepEqual(breaks('const ok = a < b;'), [['comparison', 'const ok = a < b;  ->  const ok = a >= b;']]);
  for (const [from, to] of [['<', '>='], ['>=', '<'], ['>', '<='], ['<=', '>'], ['==', '!='], ['!=', '=='], ['===', '!=='], ['!==', '===']]) {
    assert.deepEqual(breaks(`x = a ${from} b;`), [['comparison', `x = a ${from} b;  ->  x = a ${to} b;`]], from);
  }
  assert.deepEqual(breaks('while (ready(a)) go();\nif (ready(a)) {\n  go();\n}'), [['condition', 'if (ready(a)) {  ->  if (!(ready(a))) {']]);
  assert.deepEqual(breaks("function f(n) {\n  if (!n) throw new Error('no');\n  go(n);\n}"), [
    ['condition', "if (!n) throw new Error('no');  ->  if (!(!n)) throw new Error('no');"], ['guard', "removed: if (!n) throw new Error('no');"]]);
  assert.deepEqual(breaks('function f(n) {\n  return n * k;\n}'), [['return', 'return n * k;  ->  return null;']]);
  assert.deepEqual(breaks('const on = true, off = false;'), [['boolean', 'const on = true, off = false;  ->  const on = false, off = false;'],
    ['boolean', 'const on = true, off = false;  ->  const on = true, off = true;']]);
  assert.deepEqual(breaks('x = f(0, 9, 1.50, 10);').map(([, change]) => change.split('  ->  ')[1]),
    ['x = f(1, 9, 1.50, 10);', 'x = f(0, 10, 1.50, 10);', 'x = f(0, 9, 2.50, 10);', 'x = f(0, 9, 1.50, 11);']);
});

test('JavaScript guards: one throw or return after an if with no else, alone on its lines, braced or not', () => {
  const guards = (source) => jsMutants(source, everyLine(source)).filter((m) => m.op === 'guard').map((m) => apply(source, m));
  assert.deepEqual(guards('function f(x) {\n  if (x) return;\n  go();\n}\n'), ['function f(x) {\n  go();\n}\n']);
  assert.deepEqual(guards('function f(x) {\n  if (x > max) {\n    throw new RangeError(`too big: ${x}`);\n  }\n  go();\n}\n'), ['function f(x) {\n  go();\n}\n']);
  assert.deepEqual(guards('function f(x) {\n  if (!x) { return null; }\n  go();\n}\n'), ['function f(x) {\n  go();\n}\n']);
  assert.deepEqual(guards('function f(x) {\n  if (!x) return {\n    a: 1,\n  };\n  go();\n}\n'), ['function f(x) {\n  go();\n}\n']);
  // Not guards: an else follows, two statements, another statement in the body, a braceless body of
  // another statement, code or a comment before it on its line or after it, a label above it.
  const none = [
    'function f(x) {\n  if (x < 0) return 0; /* note\n  more */ const y = 1;\n}\n', 'function f(x) {\n  /* a\n  */ if (x) return;\n}\n',
    'function f(x) {\n  go(x);\n  outer:\n  if (x) return;\n}\n', 'function f(x) {\n  if (x) return; // why\n}\n',
    'function f(x) {\n  if (x) return 1;\n  else return 2;\n}\n', 'function f(x) {\n  if (x) { log(); return; }\n}\n',
    'function f(x) {\n  if (x) go();\n}\n', 'function f(x) {\n  for (const y of x)\n    if (y) return y;\n}\n',
    'function f(x) {\n  a(); if (x) return;\n}\n', 'function f(x) {\n  if (x) return; a();\n}\n', 'function f(x) {\n  else if (x) return;\n}\n',
  ];
  for (const source of none) assert.deepEqual(guards(source), [], source);
});

test('JavaScript: only code on changed lines breaks - not strings, comments, templates, regular expressions, generics, JSX or arrows', () => {
  const source = "const s = 'if (a < b) return 1';\n// if (a < b) return true;\n/* x > 0 */ const t = `n < ${n > 1}`;\nconst r = /a<b/;\n"
    + 'const g = (x: Array<string>): Map<K,V> => x;\nconst el = <div a={1}>text</div>;\nconst h = (a) => a;\n';
  assert.deepEqual(breaks(source), [
    ['comparison', '/* x > 0 */ const t = `n < ${n > 1}`;  ->  /* x > 0 */ const t = `n < ${n <= 1}`;'],
    ['number', '/* x > 0 */ const t = `n < ${n > 1}`;  ->  /* x > 0 */ const t = `n < ${n > 2}`;'],
    ['number', 'const el = <div a={1}>text</div>;  ->  const el = <div a={2}>text</div>;'],
  ]);
  // Not an if: a call named ...if, a member named if.
  assert.deepEqual(ops('endif(x);\nobj.if(y);\n'), []);
  const code = 'a = 1;\nb = 2 < c;\nif (d) e();\n';
  assert.deepEqual(jsMutants(code, new Set([2])).map((m) => m.op), ['comparison', 'number']);
  assert.deepEqual(jsMutants(code, new Set()).map((m) => m.op), []);
  // A break that spans lines counts when any of its lines changed.
  assert.deepEqual(jsMutants('if (a &&\n  b) go();\n', new Set([2])).map((m) => m.op), ['condition']);
});

test('JavaScript comparisons: between a name, a number or a bracket and an operand, on one line - not a JSX tag or attribute', () => {
  assert.deepEqual(ops('x = a.length > 0 && (b) <= c[1] && d !== "e" && 1 < -f;'), ['comparison', 'comparison', 'comparison', 'comparison', 'number', 'number', 'number']);
  assert.deepEqual(ops('const a = <div\n  className="row"\n>\n  text\n</div>;'), []);
  assert.deepEqual(ops('const a = <div className="a" > hi</div>;'), []);
  assert.deepEqual(ops('const a = b\n  > c;'), []);
});

test('a returned value that goes on over lines in a template is replaced whole', () => {
  const source = 'function f() {\n  return `npm <command>\n\nUsage: ${x}\n` + y;\n}\n';
  const [ret] = jsMutants(source, everyLine(source)).filter((m) => m.op === 'return');
  assert.equal(apply(source, ret), 'function f() {\n  return null;\n}\n');
  // A value past 2000 characters is not replaced: its end cannot be told for sure.
  assert.deepEqual(ops(`function f() {\n  return [${'1, '.repeat(700)}];\n}\n`).filter((op) => op === 'return'), []);
  // Nor is a guard removed whose statement runs past 2000 characters, also when the 2000th ends a line.
  const head = 'function f(x) {\n  if (x) throw [';
  const long = `${head}${'a'.repeat(head.indexOf('throw') + 2005 - head.length)}\n    2,\n  ];\n  go();\n}\n`;
  assert.equal(long[head.indexOf('throw') + 2005], '\n');
  assert.deepEqual(ops(long).filter((op) => op === 'guard'), []);
});

test('JavaScript returns and numbers that are left alone', () => {
  assert.deepEqual(ops('function f() {\n  return;\n}\nfunction g() {\n  return null;\n}\nfunction h() {\n  return undefined;\n}\n'), []);
  for (const number of ['0x1f', '1e3', '10n', '1_000', '007', 'a1', '.5', '1.2.3', 'x.1']) assert.deepEqual(ops(`y = ${number};`), [], number);
  assert.deepEqual(ops('y = 1.5 + 0;'), ['number', 'number']);
});

test('JavaScript order: a sort or a reverse is removed with its call, and the items stay in the order they came in', () => {
  const orders = (source, lines = everyLine(source)) => jsMutants(source, lines).filter((m) => m.op === 'order').map((m) => apply(source, m));
  assert.deepEqual(orders('const out = items.sort((a, b) => a.placed - b.placed);'), ['const out = items;']);
  assert.deepEqual(orders('return [...items].toSorted((a, b) => b - a).map(f);'), ['return [...items].map(f);']);
  assert.deepEqual(orders('const r = xs.slice().reverse();'), ['const r = xs.slice();']);
  assert.deepEqual(orders('const r = xs?.toReversed ();'), ['const r = xs;']);
  // In place, as a statement of its own: nothing is left to do.
  assert.deepEqual(orders('xs.sort();\nxs.reverse();\n'), ['xs;\nxs.reverse();\n', 'xs.sort();\nxs;\n']);
  // A call over lines goes whole, and counts when any of its lines changed.
  const chain = 'const r = items\n  .filter(Boolean)\n  .sort((a, b) => {\n    return a - b;\n  });\n';
  assert.deepEqual(orders(chain, new Set([4])), ['const r = items\n  .filter(Boolean)\n  ;\n']);
  assert.deepEqual(orders(chain, new Set([1, 2])), []);
  assert.deepEqual(breaks('const out = items.sort(byDate);').filter(([op]) => op === 'order'), [['order', 'const out = items.sort(byDate);  ->  const out = items;']]);
  // Not an order: a spread of a function named sort, a method of super, other names, strings and comments.
  for (const source of ['const all = [...sort(xs)];', 'class A extends B { f() { return super.sort(); } }', 'obj.sorted(x); obj.reverseAll(); sortBy(x); sort(x);',
    'const s = "x.sort()"; // y.reverse()', 'xs.sort = byName;']) {
    assert.deepEqual(orders(source), [], source);
  }
  for (const source of ['const out = items.sort((a, b) => a - b);', 'xs.reverse();', 'return [...a].toSorted().map(f);']) {
    for (const broken of orders(source)) assert.equal(stillParses('a.js', source, broken), true, broken);
  }
});

test('every JavaScript break of this repository\'s own code still parses', () => {
  const files = ['gate/hook.js', 'gate/mutate.js', 'gate/runner.js', ...fs.readdirSync(path.join(__dirname, '..', 'lib')).filter((f) => f.endsWith('.js')).map((f) => `gate/lib/${f}`)];
  let count = 0;
  for (const file of files) {
    const source = fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8').replace(/^#!.*/, '');
    for (const mutant of jsMutants(source, everyLine(source))) {
      count += 1;
      assert.equal(stillParses(file, source, apply(source, mutant)), true, `${file}: ${describe(source, mutant).change}`);
    }
  }
  assert.ok(count > 1000, `${count} breaks`);
});

test('a break that does not parse is caught before it runs; files the check cannot read pass through', () => {
  assert.equal(stillParses('a.js', 'x = 1;', 'x = ;'), false);
  assert.equal(stillParses('a.js', 'label:\n  go();\n', 'label:\n'), false);
  // A method named if reads like an if: its turned condition does not parse (in JavaScript), or it has
  // a return type and is left alone (TypeScript).
  const method = 'class A {\n  if(x) {\n    return x;\n  }\n}\n';
  const [condition] = jsMutants(method, everyLine(method)).filter((m) => m.op === 'condition');
  assert.equal(stillParses('a.js', method, apply(method, condition)), false);
  assert.deepEqual(ops('class A {\n  if(x: number): number {\n    return x;\n  }\n}\n').filter((op) => op === 'condition'), []);
  assert.equal(stillParses('a.cjs', 'x = 1;', 'x = 2;'), true);
  // The original does not parse as CommonJS (an ES module, JSX): nothing to compare with.
  assert.equal(stillParses('a.js', 'import x from "y";', 'import x from ;'), true);
  assert.equal(stillParses('a.ts', 'let x: number = 1;', 'let x: = 1;'), true);
  // Parsing runs nothing.
  assert.equal(stillParses('a.js', 'x = 1;', 'process.exit(3); x = 2;'), true);
  assert.equal(typeof vm.Script, 'function');
});

test("Python's edits land on the right characters: CRLF and CR lines, characters outside the BMP", () => {
  const source = 'a = "😀" + b\r\nif x < 1:\r    pass\n';
  const [edit] = fromLines(source, [{ op: 'comparison', start: [2, 5], end: [2, 6], text: '>=' }]);
  assert.equal(apply(source, edit), 'a = "😀" + b\r\nif x >= 1:\r    pass\n');
  const [emoji] = fromLines(source, [{ op: 'number', start: [1, 10], end: [1, 11], text: 'c' }]);
  assert.equal(apply(source, emoji), 'a = "😀" + c\r\nif x < 1:\r    pass\n');
});

test('the breaks tried: at most the limit, every file and every kind in turn, spread over a file, the same whatever the order', () => {
  const all = [];
  for (const file of ['b.js', 'a.js', 'c.py']) for (let i = 0; i < 10; i += 1) all.push({ file, start: i * 10, end: i * 10 + 1, op: 'number', text: '1' });
  const chosen = choose(all, 6);
  assert.equal(chosen.length, 6);
  // Two of each file, in the order they are tried: each file's middle, then the middle of each file's first half.
  assert.deepEqual(chosen.map((m) => `${m.file}:${m.start}`), ['a.js:50', 'b.js:50', 'c.py:50', 'a.js:20', 'b.js:20', 'c.py:20']);
  // The report shows them in the order of file and place.
  assert.deepEqual([...chosen].sort(byPlace).map((m) => `${m.file}:${m.start}`), ['a.js:20', 'a.js:50', 'b.js:20', 'b.js:50', 'c.py:20', 'c.py:50']);
  assert.deepEqual(choose([...all].reverse(), 6), chosen);
  assert.deepEqual(choose(all.slice(0, 3), 20).map((m) => m.start), [10, 0, 20]);
  // Many numbers in one file do not crowd out the breaks of another, nor a guard in the same file.
  const table = Array.from({ length: 200 }, (_, i) => ({ file: 'a.js', start: i * 3, end: i * 3 + 1, op: 'number', text: '1' }));
  const guard = { file: 'a.js', start: 900, end: 950, op: 'guard', text: '' };
  const other = [{ file: 'z.js', start: 0, end: 40, op: 'guard', text: '' }, { file: 'z.js', start: 5, end: 12, op: 'comparison', text: '>=' }];
  const picked = choose([...table, guard, ...other], 5);
  assert.deepEqual(picked.filter((m) => m.op !== 'number').map((m) => `${m.file}:${m.op}`), ['a.js:guard', 'z.js:guard', 'z.js:comparison']);
  assert.equal(picked.length, 5);
  // A kind late in the order still gets a turn before a frequent early one gets a second.
  const comparisons = Array.from({ length: 50 }, (_, i) => ({ file: 'b.js', start: i * 5, end: i * 5 + 1, op: 'comparison', text: '<' }));
  assert.deepEqual(choose([...comparisons, { file: 'b.js', start: 999, end: 1003, op: 'boolean', text: 'false' }], 3).map((m) => m.op).sort(), ['boolean', 'comparison', 'comparison']);
  // At one place, the kinds go in the order of the kinds.
  const one = ['number', 'boolean', 'return', 'order', 'guard', 'comparison', 'condition'].map((op) => ({ file: 'a.js', start: 0, end: 5, op, text: '' }));
  assert.deepEqual(choose(one, 7).map((m) => m.op), ['guard', 'condition', 'comparison', 'order', 'return', 'boolean', 'number']);
  // Every break of the list, each once, when the limit allows.
  assert.equal(new Set(choose(all, 100)).size, 30);
});

test('the estimate: the runs to go at the control run\'s length, the time a run with a break gets, what fits, and what to change for all', () => {
  const base = { run: 2, finished: true, controls: 3, mutants: 4, spent: 5, timeoutSeconds: 600, runTimeoutSeconds: null };
  // No --run-timeout: a run with a break gets the control run's time x 1.5 + 10 s, rounded up.
  assert.deepEqual(estimate(base), {
    perRun: 13, total: 19,
    line: 'Estimate: one test run takes 2.0 s (the control run); 7 runs to go (3 control breaks, 4 mutants), up to 13 s each'
      + ' (the control run x 1.5 + 10 s, as --run-timeout is not set): about 19 s in all, within the 600 s for everything (--timeout): all of them fit',
  });
  assert.equal(estimate({ ...base, run: 2.1 }).perRun, 14);
  // A --run-timeout a human set is kept as it is.
  assert.deepEqual(estimate({ ...base, runTimeoutSeconds: 120 }), {
    perRun: 120, total: 19,
    line: 'Estimate: one test run takes 2.0 s (the control run); 7 runs to go (3 control breaks, 4 mutants), up to 120 s each (--run-timeout):'
      + ' about 19 s in all, within the 600 s for everything (--timeout): all of them fit',
  });
  assert.match(estimate({ ...base, run: 0.25, controls: 1, mutants: 1, spent: 0.5, timeoutSeconds: 1 }).line,
    /^Estimate: one test run takes 0\.3 s \(the control run\); 2 runs to go \(1 control break, 1 mutant\), up to 11 s each .*: about 1\.0 s in all, within the 1 s /);
  // 50 s spent, 23 runs of 45 s to go: a run starts while time is left, 13 of them in the 550 s, the
  // control breaks first, so 10 mutants; all of them with the runs half again as long: 50 + 23 * 45 * 1.5 = 1602.5.
  const short = estimate({ ...base, run: 45, controls: 3, mutants: 20, spent: 50 });
  assert.equal(short.total, 1085);
  assert.equal(short.perRun, 78);
  assert.match(short.line, /: about 1085 s in all, past the 600 s for everything \(--timeout\): the time left starts 13 of them, so about 10 of the 20 mutants will be tried\. For all of them, run it again with --timeout 1603$/);
  // Rounded up: 10 + 21 * 10 * 1.5 = 325, and 10 + 21 * 10.01 * 1.5 = 325.3.
  assert.match(estimate({ ...base, run: 10, controls: 1, mutants: 20, spent: 10, timeoutSeconds: 100 }).line, /: the time left starts 9 of them, so about 8 of the 20 mutants will be tried\. For all of them, run it again with --timeout 325$/);
  assert.match(estimate({ ...base, run: 10.01, controls: 1, mutants: 20, spent: 10, timeoutSeconds: 100 }).line, /--timeout 326$/);
  // Fewer runs start than there are control breaks, or none at all (the time went before the control run ended).
  assert.match(estimate({ ...base, run: 45, controls: 3, mutants: 20, spent: 50, timeoutSeconds: 100 }).line, /: the time left starts 2 of them, so about 0 of the 20 mutants /);
  assert.match(estimate({ ...base, run: 1.8, controls: 1, mutants: 2, spent: 2.5, timeoutSeconds: 2 }).line, /: the time left starts 0 of them, so about 0 of the 2 mutants /);
  // Up to the most --timeout takes, and past it no option: fewer mutants.
  assert.match(estimate({ ...base, run: 4114, controls: 1, mutants: 13, spent: 6 }).line, /For all of them, run it again with --timeout 86400$/);
  assert.match(estimate({ ...base, run: 4114, controls: 1, mutants: 13, spent: 7 }).line, /For all of them it needs about 86401 s, past the 86400 s --timeout takes at most; lower --limit$/);
  // A control run longer than the --run-timeout a human set: no break runs, and the options that let them.
  const slow = estimate({ ...base, run: 150, controls: 1, mutants: 2, spent: 152, timeoutSeconds: 900, runTimeoutSeconds: 120 });
  assert.deepEqual(slow, {
    perRun: null, total: null,
    line: 'Estimate: one test run takes 150 s (the control run), more than the 120 s --run-timeout gives a run with a break, so no break runs.'
      + ' For all of them, run it again with --run-timeout 235',
  });
  assert.match(estimate({ ...base, run: 150, controls: 1, mutants: 20, spent: 152, runTimeoutSeconds: 120 }).line, /, so no break runs\. For all of them, run it again with --run-timeout 235 --timeout 4877$/);
  assert.equal(estimate({ ...base, run: 120, runTimeoutSeconds: 120 }).perRun, 120);
  // A control run the time for everything stopped: its length is not known.
  assert.deepEqual(estimate({ ...base, run: 598.2, finished: false }), {
    perRun: null, total: null,
    line: 'Estimate: one test run takes more than 598 s: the control run did not finish in the 600 s for everything (--timeout), so no break runs.'
      + ' For all of them, run it again with a longer --timeout',
  });
});

test('three outcomes: failed tests kill a break, passing tests let it survive, did not run is never a kill (GW-61)', () => {
  assert.deepEqual(OUTCOMES, { failed: 'killed', passed: 'survived', 'did not run': 'did not run' });
  const r = (outcome, op = 'guard') => ({ file: 'a.js', line: 3, op, change: 'removed: if (x) return;', outcome, why: outcome === 'did not run' ? 'the command did not finish in 5 s and was stopped' : '' });
  const base = { header: ['greenwashing mutants'], control: 'Control: passed', notTried: 0, problems: [] };
  assert.equal(report({ ...base, results: [r('killed'), r('killed')] }).code, 0);
  assert.match(report({ ...base, results: [r('killed')] }).text, /Result: every mutant was killed$/);
  const survived = report({ ...base, results: [r('killed'), r('survived'), r('survived', 'number')] });
  assert.equal(survived.code, 1);
  assert.match(survived.text, /Mutants: 3 tried - 1 killed, 2 survived, 0 did not run\n/);
  assert.match(survived.text, /\nSurvived - the tests passed with the code broken:\n- a\.js:3: removed: if \(x\) return;\n {2}the tests pass without this guard: .*\. See GW-02 in /);
  assert.match(survived.text, /\n {2}the tests pass with this number one higher: .*\. See GW-11 in /);
  const unordered = report({ ...base, results: [{ ...r('survived', 'order'), change: 'return sorted(xs)  ->  return list(xs)' }] });
  assert.match(unordered.text, /\n- a\.js:3: return sorted\(xs\) {2}-> {2}return list\(xs\)\n {2}the tests pass with this sort or reverse removed: in no case does the result depend on the order; add a case with two or more items out of order\. See GW-04 in /);
  assert.match(survived.text, /Result: 2 mutants survived$/);
  const notRun = report({ ...base, results: [r('killed'), r('did not run')] });
  assert.equal(notRun.code, 2);
  assert.match(notRun.text, /- did not run: a\.js:3: removed: if \(x\) return; \(the command did not finish in 5 s and was stopped\)\n/);
  assert.match(notRun.text, /"Did not run" is never counted as caught \(GW-61 in /);
  assert.match(notRun.text, /Result: did not run$/);
  // A survivor decides over a break that did not run; nothing tried, or not tried for lack of time, is did not run.
  assert.equal(report({ ...base, results: [r('survived'), r('did not run')] }).code, 1);
  assert.equal(report({ ...base, results: [] }).code, 2);
  assert.equal(report({ ...base, results: [r('killed')], notTried: 1 }).code, 2);
  assert.equal(report({ ...base, results: [r('killed')], problems: ['x.py: Python could not read it'] }).code, 2);
  // The breaks of a file the tests do not run: one line, counted as did not run, never as survived.
  const unrun = [{ file: 'b.js', count: 3, outcome: 'not exercised', why: NOT_EXERCISED }];
  const unexercised = report({ ...base, controls: 'Control breaks: 2 files', results: [r('killed')], unrun });
  assert.equal(unexercised.code, 2);
  assert.match(unexercised.text, /\nControl: passed\nControl breaks: 2 files\nMutants: 4 tried - 1 killed, 0 survived, 3 did not run \(3 not exercised\)\n/);
  assert.match(unexercised.text, /\n- not exercised: b\.js: 3 mutants not run - the tests passed with this file failing as soon as it runs, so they do not run it: an editable install \(pip install -e\)/);
  assert.match(unexercised.text, /"Did not run" is never counted as caught \(GW-61 in [^]*Result: did not run$/);
  assert.equal(report({ ...base, results: [], unrun }).code, 2);
  assert.equal(report({ ...base, results: [r('survived')], unrun }).code, 1);
  const unknown = report({ ...base, results: [r('killed')], unrun: [{ file: 'c.js', count: 1, outcome: 'did not run', why: 'its control break did not run' }] });
  assert.match(unknown.text, /Mutants: 2 tried - 1 killed, 0 survived, 1 did not run\n[^]*\n- did not run: c\.js: 1 mutant not run - its control break did not run\n/);
  assert.equal(unknown.code, 2);
  // The estimate after the control line, and the time taken before the result.
  const estimated = { total: 19, line: 'Estimate: about 19 s' };
  assert.match(report({ ...base, estimated, controls: 'Control breaks: 1 file', results: [r('killed')], took: 12.34 }).text,
    /\nControl: passed\nEstimate: about 19 s\nControl breaks: 1 file\n[^]*\nTime: 12 s in all \(estimated: about 19 s\)\nResult: every mutant was killed$/);
  assert.match(report({ ...base, results: [r('did not run')], took: 0 }).text, /\n"Did not run" is never counted as caught \(GW-61 in \S+\)\.\nTime: 0\.0 s in all\nResult: did not run$/);
  // Tenths below 10 s, whole seconds from there.
  for (const [took, shown] of [[0.04, '0.0 s'], [9.94, '9.9 s'], [9.96, '10 s'], [10, '10 s'], [12.7, '13 s'], [599.4, '599 s']]) {
    assert.match(report({ ...base, results: [r('killed')], took }).text, new RegExp(`\nTime: ${shown.replace('.', '\\.')} in all\n`), String(took));
  }
  // No time to compare with when no break could run.
  assert.match(report({ ...base, estimated: { total: null, line: 'Estimate: none' }, results: [], took: 3 }).text, /\nTime: 3\.0 s in all\n/);
  assert.doesNotMatch(report({ ...base, results: [r('killed')] }).text, /Time|Estimate/);
  // Every hint names an entry of the catalog.
  const catalog = fs.readFileSync(path.join(__dirname, '..', '..', 'CATALOG.md'), 'utf8');
  for (const [gw] of Object.values(HINTS)) assert.match(catalog, new RegExp(`^### ${gw} `, 'm'));
  assert.deepEqual([...new Set(Object.values(HINTS).map(([gw]) => gw))].sort(), ['GW-02', 'GW-04', 'GW-11']);
  assert.match(CATALOG, /CATALOG\.md$/);
});

// Python breaks, from python_mutants.py as the command runs it.
function python(text, lines = null) {
  const request = { files: [{ file: 'a.py', text, lines: [...(lines || everyLine(text))] }] };
  const run = spawnSync('python3', ['-I', path.join(__dirname, '..', 'lib', 'python_mutants.py')], { input: JSON.stringify(request), encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  if (out.errors.length) return out.errors;
  return out.mutants.map((edit) => [edit.op, apply(text, fromLines(text, [edit])[0])]);
}

test('each kind of break in Python, on changed lines only', () => {
  const source = 'def f(n, items):\n    if n < 0:\n        raise ValueError("negative")\n    ok = n >= 10 and True\n    return n * 2.5\n';
  const found = python(source);
  const changed = (op) => found.filter(([kind]) => kind === op).map(([, text]) => text.split('\n').find((line, i) => line !== source.split('\n')[i]));
  assert.deepEqual(changed('guard'), ['    pass']);
  assert.deepEqual(changed('condition'), ['    if not (n < 0):']);
  assert.deepEqual(changed('comparison'), ['    if n >= 0:', '    ok = n < 10 and True']);
  assert.deepEqual(changed('return'), ['    return None']);
  assert.deepEqual(changed('boolean'), ['    ok = n >= 10 and False']);
  assert.deepEqual(changed('number').sort(), ['    if n < 1:', '    ok = n >= 11 and True', '    return n * 3.5'].sort());
  assert.deepEqual(python(source, [4]).map(([op]) => op).sort(), ['boolean', 'comparison', 'number']);
  // A break over two lines counts when its second line changed.
  assert.deepEqual(python('if (a and\n        b):\n    go()\n', [2]).map(([op]) => op), ['condition']);
  // A file that starts with a byte order mark.
  assert.deepEqual(python('\uFEFFx = 1\n').map(([op]) => op), ['number']);
  for (const [, text] of found) assert.equal(spawnSync('python3', ['-I', '-c', 'import ast, sys; ast.parse(sys.stdin.read())'], { input: text }).status, 0, text);
});

test('Python order: sorted(x, ...) becomes list(x), reversed(x) becomes x, and x.sort(...) or x.reverse() on its own becomes pass', () => {
  const orders = (source, lines) => python(source, lines).filter(([op]) => op === 'order').map(([, text]) => text);
  assert.deepEqual(orders('def f(orders):\n    return sorted(orders, key=lambda o: o["placed"], reverse=True)\n'), ['def f(orders):\n    return list(orders)\n']);
  assert.deepEqual(orders('ids = list(reversed(ids))\n'), ['ids = list(ids)\n']);
  // A reversed argument that is more than a name, a member, a call or an index keeps its brackets.
  assert.deepEqual(orders('both = list(reversed(a + b))\n'), ['both = list((a + b))\n']);
  assert.deepEqual(orders('first = sorted(x for x in xs)[0]\n'), ['first = list((x for x in xs))[0]\n']);
  assert.deepEqual(orders('def f(xs):\n    xs.sort(key=len)\n    xs.reverse()\n    return xs\n'), [
    'def f(xs):\n    pass\n    xs.reverse()\n    return xs\n', 'def f(xs):\n    xs.sort(key=len)\n    pass\n    return xs\n']);
  // A statement over lines goes whole, and counts when any of its lines changed.
  const long = 'def f(xs):\n    xs.sort(\n        key=len,\n    )\n    return xs\n';
  assert.deepEqual(orders(long, [3]), ['def f(xs):\n    pass\n    return xs\n']);
  assert.deepEqual(orders(long, [5]), []);
  // Not an order: a sort whose value is used (it is None), no argument, a starred one reversed, inside an f-string.
  for (const source of ['y = xs.sort()\n', 'y = sorted()\n', 'y = reversed(*a)\n', 'y = f"{sorted(a)}"\n', 'y = xs.sorted()\n']) assert.deepEqual(orders(source), [], source);
});

test('Python: an elif is no guard, a guard alone in its block becomes pass, f-strings and plain returns are left alone', () => {
  const chain = 'def f(n):\n    if n < 0:\n        return 1\n    elif n == 0:\n        return 2\n';
  assert.equal(python(chain).filter(([op]) => op === 'guard').length, 0);
  const alone = 'def f(n):\n    if n is None:\n        raise ValueError\n';
  assert.deepEqual(python(alone).filter(([op]) => op === 'guard').map(([, text]) => text), ['def f(n):\n    pass\n']);
  assert.deepEqual(python('def f(n):\n    return\n\n\ndef g():\n    return None\n'), []);
  assert.deepEqual(python('x = f"{n < 3} {True} {2}"\n'), []);
  assert.deepEqual(python('x = 0x1f + 1e3 + 1_000 + 00\n'), []);
  assert.match(python('def f(:\n')[0].error, /Python could not read it \(SyntaxError/);
  // ast counts bytes: a character outside ASCII before the place of a break.
  assert.deepEqual(python('x = ("é😀", 7)\n'), [['number', 'x = ("é😀", 8)\n']]);
});

// The control break applied: JavaScript from controlBreak(), Python at the line python_mutants.py gives.
function controlled(text, kind) {
  if (kind === 'js') return apply(text, controlBreak(text, 'js'));
  const request = { files: [{ file: 'a.py', text, lines: [1] }] };
  const run = spawnSync('python3', ['-I', path.join(__dirname, '..', 'lib', 'python_mutants.py')], { input: JSON.stringify(request), encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const [control] = JSON.parse(run.stdout).controls;
  assert.equal(control.file, 'a.py');
  return apply(text, controlBreak(text, 'python', control.line));
}

test('the control break: the file raises as soon as it runs, before its own code, and still parses', (t) => {
  const js = [
    ['globalThis.ran = 1;\n', ''], ['\uFEFFglobalThis.ran = 1;\n', '\uFEFF'], ['#!/usr/bin/env node\nglobalThis.ran = 1;\n', '#!/usr/bin/env node\n'],
    ['#!/usr/bin/env node', '#!/usr/bin/env node\n'], ['', ''],
  ];
  for (const [source, before] of js) {
    const broken = controlled(source, 'js');
    assert.ok(broken.startsWith(`${before}(() => { throw new Error('${CONTROL_MESSAGE}'); })();\n`), JSON.stringify(broken));
    const context = {};
    assert.throws(() => vm.runInNewContext(broken.replace(/^\uFEFF/, '').replace(/^#!.*/, ''), { globalThis: context }), new RegExp(CONTROL_MESSAGE));
    assert.equal(context.ran, undefined);
    // No unreachable code for a linter or a compiler to reject, and it parses.
    assert.equal(stillParses('a.js', source, broken), true);
  }
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'gw-control-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const python = [
    ['ran = 1\n', 1], ['"""Doc."""\nran = 1\n', 2], ['"""Doc\n\nmore."""\nfrom __future__ import annotations\n\nran = 1\n', 5],
    ['#!/usr/bin/env python3\n# -*- coding: utf-8 -*-\nran = 1\n', 3], ['\uFEFFran = 1\n', 1], ['# a comment\nran = 1\n', 2],
    ['from __future__ import annotations', 2], ['"""Doc."""\r\nfrom __future__ import division\r\nran = 1\r\n', 3], ['', 1],
    ['"""Doc\n\nmore."""\nran = 1\n', 4],
  ];
  for (const [source, line] of python) {
    const broken = controlled(source, 'python');
    const lines = broken.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
    assert.equal(lines[line - 1], `raise RuntimeError('${CONTROL_MESSAGE}')`, JSON.stringify(broken));
    if (source.startsWith('\uFEFF')) assert.ok(broken.startsWith('\uFEFFraise'), JSON.stringify(broken));
    // It raises, not a SyntaxError: the __future__ imports stay first.
    const file = path.join(dir, 'a.py');
    fs.writeFileSync(file, broken);
    const run = spawnSync('python3', ['-I', '-c', 'import runpy, sys\ntry:\n    runpy.run_path(sys.argv[1])\nexcept RuntimeError as e:\n    print(e)\nelse:\n    print("ran")', file], { encoding: 'utf8' });
    assert.equal(run.stdout.trim(), CONTROL_MESSAGE, `${JSON.stringify(broken)}\n${run.stderr}`);
  }
});
