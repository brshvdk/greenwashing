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
  codeKind, addedLines, ownLines, jsMutants, fromLines, apply, stillParses, describe, choose, report, OUTCOMES, HINTS,
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
});

test('JavaScript returns and numbers that are left alone', () => {
  assert.deepEqual(ops('function f() {\n  return;\n}\nfunction g() {\n  return null;\n}\nfunction h() {\n  return undefined;\n}\n'), []);
  for (const number of ['0x1f', '1e3', '10n', '1_000', '007', 'a1', '.5', '1.2.3', 'x.1']) assert.deepEqual(ops(`y = ${number};`), [], number);
  assert.deepEqual(ops('y = 1.5 + 0;'), ['number', 'number']);
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
  // Two of each file, the middle first, then the middle of the first half; shown in the order of file and place.
  assert.deepEqual(chosen.map((m) => `${m.file}:${m.start}`), ['a.js:20', 'a.js:50', 'b.js:20', 'b.js:50', 'c.py:20', 'c.py:50']);
  assert.deepEqual(choose([...all].reverse(), 6), chosen);
  assert.deepEqual(choose(all.slice(0, 3), 20).map((m) => m.start), [0, 10, 20]);
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
  // At one place, the kinds go in their order.
  const one = ['number', 'guard', 'comparison', 'condition'].map((op) => ({ file: 'a.js', start: 0, end: 5, op, text: '' }));
  assert.deepEqual(choose(one, 4).map((m) => m.op), ['guard', 'condition', 'comparison', 'number']);
  // Every break of the list, each once, when the limit allows.
  assert.equal(new Set(choose(all, 100)).size, 30);
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
