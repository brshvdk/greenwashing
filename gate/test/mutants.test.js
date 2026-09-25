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
  codeKind, addedLines, jsMutants, fromLines, apply, stillParses, describe, choose, report, OUTCOMES, HINTS,
} = require('../lib/mutants');
const { CATALOG } = require('../lib/verdict');

const everyLine = (source) => new Set(source.split(/\r\n|\r|\n/).map((_, i) => i + 1));
// The breaks of a JavaScript text on every line: [op, the first changed line after].
const breaks = (source, lines = everyLine(source)) => jsMutants(source, lines).map((m) => [m.op, describe(source, m).change]);
const ops = (source) => jsMutants(source, everyLine(source)).map((m) => m.op);

test('code under test: JavaScript, TypeScript and Python files that are not tests, test helpers, runner config or dependencies', () => {
  for (const file of ['src/cart.js', 'cart.ts', 'lib/a.mjs', 'b.cjs', 'ui/C.tsx', 'd.jsx', 'shop/models.py', 'app/__init__.py']) assert.notEqual(codeKind(file), null, file);
  assert.equal(codeKind('src/cart.js'), 'js');
  assert.equal(codeKind('shop/models.py'), 'python');
  const none = ['cart.test.js', 'cart.spec.ts', '__tests__/a.js', 'test/helpers.js', 'tests/helpers.js', 'tests/helpers.py', 'spec/a.js',
    '__mocks__/fs.js', 'test_cart.py', 'cart_test.py', 'conftest.py', 'sub/conftest.py', 'jest.config.js', 'vitest.config.mts',
    'node_modules/x/index.js', '.venv/lib/site.py', 'venv/a.py', 'README.md', 'data.json', 'cart.go'];
  for (const file of none) assert.equal(codeKind(file), null, file);
});

test('the changed lines are the new side of each hunk of git diff -U0', () => {
  const diff = 'diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1,0 +2,3 @@\n+a\n+b\n+c\n@@ -10 +13 @@\n-x\n+y\n@@ -20,2 +22,0 @@\n-p\n-q\n@@ -30 +29,2 @@\n';
  assert.deepEqual([...addedLines(diff)].sort((a, b) => a - b), [2, 3, 4, 13, 29, 30]);
  assert.deepEqual([...addedLines('')], []);
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
  // another statement, code before it on its line or after it.
  const none = [
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
  const code = 'a = 1;\nb = 2 < c;\nif (d) e();\n';
  assert.deepEqual(jsMutants(code, new Set([2])).map((m) => m.op), ['comparison', 'number']);
  assert.deepEqual(jsMutants(code, new Set()).map((m) => m.op), []);
  // A break that spans lines counts when any of its lines changed.
  assert.deepEqual(jsMutants('if (a &&\n  b) go();\n', new Set([2])).map((m) => m.op), ['condition']);
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

test('the breaks tried: at most the limit, spread over the list, the same ones whatever order they come in', () => {
  const all = [];
  for (const file of ['b.js', 'a.js', 'c.py']) for (let i = 0; i < 10; i += 1) all.push({ file, start: i * 10, end: i * 10 + 1, op: 'number', text: '1' });
  const chosen = choose(all, 6);
  assert.equal(chosen.length, 6);
  assert.deepEqual(chosen.map((m) => `${m.file}:${m.start}`), ['a.js:0', 'a.js:50', 'b.js:0', 'b.js:50', 'c.py:0', 'c.py:50']);
  assert.deepEqual(choose([...all].reverse(), 6), chosen);
  assert.deepEqual(choose(all.slice(0, 3), 20).map((m) => m.start), [0, 10, 20]);
  // At one place, the kinds go in their order.
  const one = ['number', 'guard', 'comparison', 'condition'].map((op) => ({ file: 'a.js', start: 0, end: 5, op, text: '' }));
  assert.deepEqual(choose(one, 4).map((m) => m.op), ['guard', 'condition', 'comparison', 'number']);
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
