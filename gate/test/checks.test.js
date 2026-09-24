'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkJs, testFileKind, mask } = require('../lib/checks');
const { lineChanges } = require('../lib/diff');

const ALL = { skips: true, assertions: true, selfComparisons: true };
const brief = (findings) => findings.map(({ line, gw }) => [line, gw]);
// Findings in a new file: every line is added.
const fresh = (source, checks = ALL) => brief(checkJs(source, lineChanges(null, source), checks));
// Findings when a turn changed `before` into `after`.
const edited = (before, after, checks = ALL) => brief(checkJs(after, lineChanges(before, after), checks));
const OK = "test('adds', () => { expect(add(1, 2)).toBe(3); });";

test('test files are the ones jest, vitest and node --test collect by default, and Python test*.py (unittest) and *_test.py (pytest)', () => {
  const js = ['a.test.js', 'a.spec.js', 'a.test.ts', 'a.spec.tsx', 'a.test.mjs', 'a.test.cjs', 'a.test.mts', 'a.test.cts',
    'a.test.jsx', 'src/c.spec.ts', 'test.js', 'a-test.js', 'a_test.js', 'test-a.js', 'test/a.js', 'test/sub/b.js',
    '__tests__/a.js', '__tests__/b.ts', 'a-test.ts', 'test-b.ts'];
  for (const file of js) assert.equal(testFileKind(file), 'js', file);
  for (const file of ['test_a.py', 'tests/a_test.py', 'shop/tests.py', 'test.py']) assert.equal(testFileKind(file), 'python', file);
  const none = ['a.js', 'tests/a.js', 'spec/a.js', 'a.tests.js', 'atest.js', 'a.test.json', 'a.test.md', 'test/a.py', 'a.test.js.snap',
    'contest.js', 'latest.js', 'src/testing.ts'];
  for (const file of none) assert.equal(testFileKind(file), null, file);
});

test('the scanner blanks comments, string and template text and regular expressions, and keeps ${} code', () => {
  const source = "a('it.skip(x)'); // it.skip('c')\nb(\"it.only(\" + `t ${it.skip(1)} it.only(`) /* test.skip( */ /it.skip\\(/.test(s);";
  const { code, comments } = mask(source);
  assert.equal(code.length, source.length);
  assert.equal(code.split('\n').length, 2);
  assert.deepEqual([...code.matchAll(/it\.(skip|only)\(/g)].map((m) => m.index), [source.indexOf('it.skip(1)')]);
  assert.deepEqual(comments.map((c) => c.text.trim()), ["it.skip('c')", 'test.skip(']);
  // A division is not a regular expression; a broken string ends at its line.
  assert.match(mask('x = a / b; y = c / d; it.skip(1)').code, /it\.skip\(1\)/);
  assert.match(mask("f('it\nit.skip(2)").code, /it\.skip\(2\)/);
  // Nested templates and braces inside ${}.
  assert.match(mask('`a ${ {b: `c ${ d } e`}.b } f`; it.only(3)').code, /it\.only\(3\)/);
});

test('GW-17: every skip, focus and expected-failure marker on an added line is red', () => {
  const markers = [
    "it.skip('a', () => {});", "test.skip('a', () => {});", "describe.skip('s', () => {});", "it.only('a', () => {});",
    "describe.only('s', () => {});", "xit('a', () => {});", "xdescribe('s', () => {});", "xtest('a', () => {});",
    "fit('a', () => {});", "fdescribe('s', () => {});", "test.todo('a', () => { run(); });", "test.failing('a', () => {});",
    "test.fails('a', () => {});", "test.skipIf(ci)('a', () => {});", "test.runIf(!ci)('a', () => {});",
    "test.concurrent.skip('a', () => {});", "test.skip.each([[1]])('a %i', (n) => {});", 'it.only.each`x\n${1}`(\'a\', () => {});',
    "test('a', (t) => { t.skip('later'); });", "it('a', function () { this.skip(); });", "test('a', (ctx) => { ctx.skip(); });",
    "test('a', (t) => { t.todo(); });", "test('a', { skip: true }, () => {});", "test('a', { only: true }, () => {});",
    "describe('s', { todo: 'later' }, () => {});", "// it('a', () => {", "// test('a', () => {", "/*\n * test.skip('a', () => {\n */",
    "suite.skip('s', () => {});", "context.only('s', () => {});", "specify.skip('a', () => {});", "bench.skip('b', () => {});",
    // A quote inside a regular expression does not hide the rest of the line.
    "expect(s).toMatch(/'/); it.skip('a', () => {});",
  ];
  for (const source of markers) {
    const found = fresh(source, { ...ALL, assertions: false }).filter(([, gw]) => gw === 'GW-17');
    assert.equal(found.length, 1, source);
  }
});

test('GW-17 honest cases: a marker the turn did not add, or code that only looks like one, is not red', () => {
  const old = `it.skip('old', () => {});\n${OK}\n`;
  assert.deepEqual(edited(old, `${old}${OK}\n`), []);
  const comment = `// it('old', () => {\n/*\n * test('older', () => {\n */\n${OK}\n`;
  assert.deepEqual(edited(comment, `${comment}${OK}\n`), []);
  const lookalikes = [
    "test('a', { skip: false }, () => { expect(1 + 1).toBe(2); });", 'const r = fit(model, data);', "db.find().skip(10);",
    "cursor.skip(10).limit(5);", "expect(/it.skip\\(/.test(src)).toBe(true);", "const s = 'xit(\"a\")';", "// test (the helper) is slow",
    "test.todo('parses dates');", "it.todo('later');", "test('parses dates', { todo: true });",
    "// see test('a') in a.test.js is fine", "query({ skip: 10, take: 5 });", "items.only = true;", "const test = require('node:test');",
    "expect(src).not.toMatch(/it.skip('a')/);",
  ];
  for (const source of lookalikes) {
    assert.deepEqual(fresh(source, { ...ALL, assertions: false }), [], source);
  }
});

test('GW-18: a new or changed test with no assertion is red', () => {
  assert.deepEqual(fresh("test('saves the user', async () => { await save(user); });"), [[1, 'GW-18']]);
  assert.deepEqual(fresh("it('works', function () {\n  run();\n});"), [[1, 'GW-18']]);
  assert.deepEqual(fresh("test.each([[1], [2]])('adds %i', (n) => { add(n); });"), [[1, 'GW-18']]);
  // An existing test the turn changed.
  assert.deepEqual(edited("test('a', () => {\n  run(1);\n});\n", "test('a', () => {\n  run(2);\n});\n"), [[1, 'GW-18']]);
  // The turn removed the only assertion: the test lost a line inside it.
  assert.deepEqual(edited("test('a', () => {\n  run();\n  expect(x).toBe(1);\n});\n", "test('a', () => {\n  run();\n});\n"), [[1, 'GW-18']]);
});

test('GW-18 honest cases: a test with an assertion, an unchanged test, or a test function defined elsewhere is not red', () => {
  const asserting = [
    OK, "it('a', () => { assert.equal(f(), 2); });", "it('a', () => { assert(f()); });", "it('a', () => { f().should.equal(2); });",
    "test('a', (t) => { t.assert.equal(f(), 2); });", "test('a', async (t) => { await t.test('b', () => { assert.ok(f()); }); });",
    "test('a', (ctx) => { ctx.expect(f()).toBe(2); });", "test('a', async ({ page }) => { await expect(page).toHaveTitle('x'); });",
    "it('a', () => { expectValidUser(u); });", "it('a', () => { assertUser(u); });", "it('a', () => { sinon.assert.calledOnce(spy); });",
    "it('a', () => request(app).get('/').expect(200));", "test('a', function (t) { t.equal(f(), 2); });",
    "test('a', done => { done.fail(); });", "test('a', savesTheUser);", "test.todo('later');", "describe('s', () => { setup(); });",
  ];
  for (const source of asserting) {
    assert.deepEqual(fresh(source, { ...ALL, skips: false }), [], source);
  }
  const unchanged = "test('a', () => { run(); });\n";
  assert.deepEqual(edited(unchanged, `${unchanged}${OK}\n`), []);
  // A line removed between two tests belongs to neither.
  assert.deepEqual(edited(`${unchanged}\n${OK}\n`, `${unchanged}${OK}\n`), []);
});

test('GW-01: a check whose two sides are the same is red', () => {
  const same = [
    'expect(a.b).toBe(a.b);', 'expect(result.limit).toEqual(result . limit);', 'expect(x).toStrictEqual(x);',
    'expect(a /* same */).toBe(a);', "expect('a').toBe('a');", 'expect(obj).to.deep.equal(obj);', 'expect(v).to.eql(v);',
    'assert.equal(x, x);', 'assert.deepStrictEqual(obj , obj);', 'assert.strict.equal(a.b, a.b);', 't.is(a, a);',
    't.assert.deepEqual(r, r);', 'expect(f(1)).toBe(f(1));',
  ];
  for (const source of same) assert.deepEqual(fresh(`test('a', () => { ${source} });`), [[1, 'GW-01']], source);
  // Only the second line of a check that spans lines changed.
  assert.deepEqual(edited('expect(\n  a.b,\n).toBe(a.c);\n', 'expect(\n  a.b,\n).toBe(a.b);\n'), [[1, 'GW-01']]);
});

test('GW-01 honest cases: different sides, a negated check or an unchanged line are not red', () => {
  const different = [
    'expect(x).toBe(y);', "expect('a').toBe('b');", "expect('a b').toBe('ab');", 'expect(a).not.toBe(a);', 'expect(a).toBeDefined();',
    'assert.equal(x, y);', 'assert.notEqual(x, x);', 'assert.equal(x);', 'expect(a.b).toBe(a.c);', 'expect(`${a}`).toBe(`${b}`);',
  ];
  for (const source of different) assert.deepEqual(fresh(`test('a', () => { ${source} });`), [], source);
  const old = "test('a', () => { expect(x).toBe(x); });\n";
  assert.deepEqual(edited(old, `${old}${OK}\n`), []);
});

test('GW-18: only a test counts - Playwright hooks, steps, options and suites on test are not tests', () => {
  const playwright = [
    "test.beforeEach(async ({ page }) => { await page.goto('/'); });", "test.afterAll(async () => { await db.close(); });",
    "test.use({ locale: 'en' });", "test.describe('login', () => { setup(); });",
    "test('a', async ({ page }) => {\n  await test.step('open', async () => { await page.click('#x'); });\n  await expect(page).toHaveTitle('x');\n});",
  ];
  for (const source of playwright) assert.deepEqual(fresh(source), [], source);
  assert.deepEqual(fresh("test.fixme('later', async () => {});"), [[1, 'GW-17']]);
  assert.deepEqual(fresh("test('a', async ({ page }) => { test.fail(); await expect(page).toHaveURL('/x'); });"), [[1, 'GW-17']]);
});

test('GW-18: a name that only starts like expect or assert, or an assertion that cannot fail, is no assertion', () => {
  for (const source of [
    "test('saves', () => { const expected = build(); save(expected.user); });", "test('logs', () => { const assertions = []; assertions.push(run()); });",
    "test('a', () => { save(u); assert(true); });", "test('a', () => { save(u); assert.ok(1); });", "test('a', () => { save(u); expect(true).toBeTruthy(); });",
    "test('a', () => { save(u); expect('saved').toBeDefined(); });",
  ]) {
    assert.deepEqual(fresh(source), [[1, 'GW-18']], source);
  }
  // A real value checked, or two same sides (reported as GW-01, not twice).
  for (const source of ["test('a', () => { assert(save(u)); });", "test('a', () => { expect(save(u)).toBeTruthy(); });", "test('a', () => { assert.ok(u.id); });"]) {
    assert.deepEqual(fresh(source), [], source);
  }
  assert.deepEqual(fresh("test('a', () => { save(u); expect(true).toBe(true); });"), [[1, 'GW-01']]);
});

test('a test skipped when it runs is a skip, not a test without assertions; t. counts as an assertion', () => {
  assert.deepEqual(fresh("it('a', function () { this.skip(); });"), [[1, 'GW-17']]);
  // mocha: this.skip() in a hook skips the tests it runs for.
  assert.deepEqual(fresh("describe('s', function () {\n  before(function () { this.skip(); });\n  it('a', () => { expect(f()).toBe(1); });\n});"), [[2, 'GW-17']]);
  assert.deepEqual(fresh("test('a', (ctx) => { ctx.skip(); run(); });"), [[1, 'GW-17']]);
  assert.deepEqual(fresh("test('a', () => { t.ok(run()); });"), []);
});

test('a check turned off in the settings does not report', () => {
  const source = "it.skip('a', () => { expect(x).toBe(x); });\ntest('b', () => { run(); });";
  assert.deepEqual(fresh(source).map(([, gw]) => gw).sort(), ['GW-01', 'GW-17', 'GW-18']);
  assert.deepEqual(fresh(source, { ...ALL, skips: false }).map(([, gw]) => gw).sort(), ['GW-01', 'GW-18']);
  assert.deepEqual(fresh(source, { ...ALL, assertions: false }).map(([, gw]) => gw).sort(), ['GW-01', 'GW-17']);
  assert.deepEqual(fresh(source, { ...ALL, selfComparisons: false }).map(([, gw]) => gw).sort(), ['GW-17', 'GW-18']);
});

test('findings name the line and what was found', () => {
  const source = `${OK}\nit.skip('later', () => {});\ntest('saves', () => { save(); });\ntest('c', () => { expect(a.b).toBe(a.b); });\n`;
  assert.deepEqual(checkJs(source, lineChanges(null, source), ALL), [
    { line: 2, gw: 'GW-17', what: 'it.skip - the test does not run' },
    { line: 3, gw: 'GW-18', what: "the test 'saves' has no assertion" },
    { line: 4, gw: 'GW-01', what: 'expect(a.b).toBe(a.b) - both sides are the same' },
  ]);
});

test('GW-18: functions imported from assertion modules count, with type arguments too; the same names from elsewhere do not', () => {
  const asserting = [
    "import { strictEqual } from 'node:assert/strict';\ntest('a', () => { strictEqual(total([1]), 6); });",
    "import assert, { deepEqual as same } from 'node:assert';\ntest('a', () => { same(f(), [1]); });",
    "import * as check from 'node:assert';\ntest('a', () => { check.equal(f(), 1); });",
    "const { ok: isOk } = require('assert');\ntest('a', () => { isOk(f()); });",
    "import { expect as want } from 'chai';\nit('a', () => { want(f()).to.equal(1); });",
    "test('a', () => { expect<number>(f()).toBe(1); });", "test('a', () => { assertType<string>(f()); });",
  ];
  for (const source of asserting) assert.deepEqual(fresh(source), [], source);
  assert.deepEqual(fresh("import { strictEqual } from './helpers';\ntest('a', () => { strictEqual(f(), 1); });"), [[2, 'GW-18']]);
  assert.deepEqual(fresh("import { strictEqual } from 'node:assert/strict';\ntest('a', () => { strictEqual(x.y, x.y); });"), [[2, 'GW-01']]);
  assert.deepEqual(fresh("import * as check from 'node:assert';\ntest('a', () => { check.equal(x.y, x.y); });"), [[2, 'GW-01']]);
});

test('GW-18: expect with no matcher, a context member that checks nothing, a test with no function, a .for table', () => {
  assert.deepEqual(fresh("test('a', () => { expect(total(x)); });"), [[1, 'GW-18']]);
  assert.deepEqual(fresh("test('a', (t) => { t.diagnostic(String(total(x))); });"), [[1, 'GW-18']]);
  assert.deepEqual(fresh("test('a', (t) => { t.plan(1); t.assert.ok(f()); });"), []);
  assert.deepEqual(fresh("test('multiplies by quantity');"), [[1, 'GW-18']]);
  assert.deepEqual(fresh("test('a', { timeout: 5 });"), [[1, 'GW-18']]);
  assert.deepEqual(fresh("test.for([[1]])('adds %i', ([n]) => { add(n); });"), [[1, 'GW-18']]);
  assert.deepEqual(fresh("specify('a', () => { run(); });"), [[1, 'GW-18']]);
});

test('GW-17: a test stops itself only through its own context; t.skip() on some other t is not a skip', () => {
  for (const source of ["test('a', (tc) => { tc.skip('flaky'); run(); });", "test('a', ({ skip }) => { skip(!!ci, 'flaky'); run(); });",
    "test('a', (testContext) => { testContext.skip(); run(); });", "it('a', async function () { this.skip(); });"]) {
    assert.deepEqual(fresh(source), [[1, 'GW-17']], source);
  }
  assert.deepEqual(fresh("const t = tokens('a b');\nt.skip();\ntest('a', () => { expect(t.next()).toBe('b'); });"), []);
});

test('GW-17 and GW-18 read node:test subtests', () => {
  assert.deepEqual(fresh("test('a', async (t) => {\n  await t.test('b', { skip: 'flaky' }, () => { assert.ok(f()); });\n});"), [[2, 'GW-17']]);
  assert.deepEqual(fresh("test('a', async (t) => {\n  await t.test('b', () => { run(); });\n});"), [[2, 'GW-18']]);
});

test('GW-17: a marker that is named instead of called, and every use of that name the turn adds', () => {
  assert.deepEqual(fresh("(process.env.CI ? it.skip : it)('a', () => { expect(f()).toBe(1); });"), [[1, 'GW-17']]);
  assert.deepEqual(fresh("const pending = it.skip;\npending('a', () => { expect(f()).toBe(1); });"), [[1, 'GW-17'], [2, 'GW-17']]);
  const old = `const itWithSandbox = process.env.SANDBOX ? it : it.skip;\n${OK}\n`;
  assert.deepEqual(edited(old, `${old}itWithSandbox('pays', () => { expect(pay()).toBe(true); });\n`), [[3, 'GW-17']]);
  assert.deepEqual(edited(old, `${old}${OK}\n`), []);
  // Old uses of the name stay old.
  const used = `${old}itWithSandbox('pays', () => { expect(pay()).toBe(true); });\n`;
  assert.deepEqual(edited(used, `${used}${OK}\n`), []);
  // A declaration over several lines, and a use through a member (.each).
  const lines = `const itWithDatabase = process.env.DATABASE_URL\n  ? it\n  : it.skip;\n${OK}\n`;
  assert.deepEqual(edited(lines, `${lines}itWithDatabase('loads', () => { expect(load()).toBe(1); });\n`), [[5, 'GW-17']]);
  assert.deepEqual(edited(old, `${old}itWithSandbox.each([1])('pays %i', (n) => { expect(pay(n)).toBe(true); });\n`), [[3, 'GW-17']]);
  // A name that holds no marker is no marker, whatever comes after its declaration.
  const plain = `const setup = makeDb();\nit.skip('old', () => {});\n${OK}\n`;
  assert.deepEqual(edited(plain, `${plain}test('b', () => { setup(); expect(f()).toBe(1); });\n`), []);
});

test('GW-17: a hook that skips through its context skips the tests it runs for', () => {
  assert.deepEqual(fresh(`beforeEach((ctx) => {\n  if (process.env.CI) ctx.skip();\n});\n${OK}`), [[2, 'GW-17']]);
  assert.deepEqual(fresh(`beforeEach((t) => t.skip());\n${OK}`), [[1, 'GW-17']]);
  assert.deepEqual(fresh(`beforeEach((ctx) => {\n  ctx.db = connect();\n});\n${OK}`), []);
  const old = `beforeEach((ctx) => {\n  if (process.env.CI) ctx.skip();\n});\n${OK}\n`;
  assert.deepEqual(edited(old, `${old}${OK}\n`), []);
});

test('GW-17: vitest fails and node:test shorthand options; nested keys and false values are not options', () => {
  assert.deepEqual(fresh("it('a', { fails: true }, () => { expect(f()).toBe(1); });"), [[1, 'GW-17']]);
  assert.deepEqual(fresh("const skip = !!process.env.CI;\ntest('a', { skip }, () => { assert.ok(f()); });"), [[2, 'GW-17']]);
  assert.deepEqual(fresh("test('a', { skip: true }, () => {});"), [[1, 'GW-17']]);
  assert.deepEqual(fresh("test('a', { meta: { skip: true } }, () => { expect(f()).toBe(1); });"), []);
});

test('GW-17: a changed condition of skipIf, or a new test in a suite that never runs, is a new skip; an edit inside an old skip is not', () => {
  const skipIf = (condition) => `it.skipIf(\n  ${condition},\n)('a', () => {\n  expect(f()).toBe(1);\n});\n`;
  assert.deepEqual(edited(skipIf("process.platform === 'win32'"), skipIf("process.platform === 'win32' || !!process.env.CI")), [[1, 'GW-17']]);
  const suite = (body) => `describe.skip('old', () => {\n${body}});\n`;
  const one = "  test('a', () => { expect(f()).toBe(1); });\n";
  assert.deepEqual(edited(suite(one), suite(`${one}  test('b', () => { expect(g()).toBe(2); });\n`)), [[3, 'GW-17']]);
  assert.deepEqual(edited(`xdescribe('old', () => {\n${one}});\n`, `xdescribe('old', () => {\n${one}  test('b', () => { expect(g()).toBe(2); });\n});\n`), [[3, 'GW-17']]);
  // A new skipped suite is one finding, not one more for each test in it.
  assert.deepEqual(fresh(suite(`${one}  test('b', () => { run(); });\n`)), [[1, 'GW-17']]);
  assert.deepEqual(fresh(`xdescribe('new', () => {\n${one}});\n`), [[1, 'GW-17']]);
  // Only a test new in the suite counts: an edit or a rename of a test that was already there does
  // not, nor a new test above the suite, nor one in a suite a condition may let run.
  assert.deepEqual(edited(suite(one), suite(one.replace("'a'", "'renamed'").replace('f()', 'f(1)'))), []);
  assert.deepEqual(edited(suite(one), `test('above', () => { expect(h()).toBe(3); });\n${suite(one)}`), []);
  const skipIfSuite = (body) => `describe.skipIf(process.platform === 'win32')('old', () => {\n${body}});\n`;
  assert.deepEqual(edited(skipIfSuite(one), skipIfSuite(`${one}  test('b', () => { expect(g()).toBe(2); });\n`)), []);
  assert.deepEqual(edited("it.skip('old', () => {\n  run(1);\n});\n", "it.skip('old', () => {\n  run(2);\n});\n"), []);
});

test('GW-17: a test commented out by a new /* and */ around its old lines', () => {
  const failing = "test('multiplies', () => {\n  expect(total(2, 3)).toBe(6);\n});\n";
  assert.deepEqual(edited(`${OK}\n${failing}`, `${OK}\n/*\n${failing}*/\n`), [[3, 'GW-17']]);
  assert.deepEqual(edited(`${OK}\n${failing}`, `${OK}\n/* ${failing}*/\n`), [[2, 'GW-17']]);
  // An old block comment that stays as it was is not new.
  const old = `${OK}\n/*\n${failing}*/\n`;
  assert.deepEqual(edited(old, `${old}${OK}\n`), []);
});

test('each marker says what it does to the test', () => {
  const what = (source) => checkJs(source, lineChanges(null, source), ALL).map((f) => f.what);
  assert.deepEqual(what("it.only('a', () => { expect(f()).toBe(1); });"), ['it.only - only this test runs']);
  assert.deepEqual(what("test.failing('a', () => { expect(f()).toBe(1); });"), ['test.failing - the test passes when it fails']);
  assert.deepEqual(what("xit('a', () => {});"), ['xit - the test does not run']);
  assert.deepEqual(what("test('a', () => { t2(); });"), ["the test 'a' has no assertion"]);
});

test('the scanner: JSX text with a stray /* or backtick hides nothing; slashes after } and return start regular expressions', () => {
  assert.deepEqual(fresh("const a = <b>Matches src/* only</b>;\nit.skipIf(ci)('a', () => { expect(f()).toBe(1); });"), [[2, 'GW-17']]);
  assert.deepEqual(fresh("const h = <Hint>Press ` to open</Hint>;\nit.skip('a', () => {});"), [[2, 'GW-17']]);
  // A later template: a backtick misread as one would close there and hide the lines between.
  assert.deepEqual(fresh("function f() {}\n/`/.test(s);\nit.only('a', () => { expect(g()).toBe(1); });\nconst t = `x`;"), [[3, 'GW-17']]);
  assert.deepEqual(fresh("function f() { return /`/.test(s); }\nit.only('a', () => { expect(g()).toBe(1); });\nconst t = `x`;"), [[2, 'GW-17']]);
  // A comment's lines keep their places; a lone CR ends a line.
  assert.deepEqual(edited('/*\n * notes\n */\n', "/*\n * it('old', () => {\n */\n"), [[2, 'GW-17']]);
  assert.deepEqual(fresh("test('a', () => { expect(f()).toBe(1); });\rxit('b', () => {});\r"), [[2, 'GW-17']]);
});

test('GW-18 and GW-01 edges: a line removed above a test is not in it; other same-sides matchers; an old self-comparison stays', () => {
  assert.deepEqual(edited("run();\ntest('a', () => { go(); });\n", "test('a', () => { go(); });\n"), []);
  for (const source of ['expect(a).toMatchObject(a);', 'expect(a).toBeCloseTo(a);', 't.same(a, a);', 't.strictSame(a, a);', 't.like(a, a);']) {
    assert.deepEqual(fresh(`test('a', (t) => { ${source} });`), [[1, 'GW-01']], source);
  }
  const old = "test('a', () => { assert.equal(x, x); });\n";
  assert.deepEqual(edited(old, `${old}${OK}\n`), []);
  assert.deepEqual(fresh("xcontext('s', () => {});\nxspecify('a', () => {});"), [[1, 'GW-17'], [2, 'GW-17']]);
});

// Python test files go through python_checks.py, run the way the hook runs it.
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { CHECKS } = require('../lib/command');

function python(before, after, checks = ALL) {
  const { added, gaps } = lineChanges(before, after);
  const request = { files: [{ file: 'test_x.py', text: after, added: [...added], gaps: [...gaps], checks }], entries: CHECKS };
  const run = spawnSync('python3', ['-I', path.join(__dirname, '..', 'lib', 'python_checks.py')], { input: JSON.stringify(request), encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  return out.errors.length ? out.errors : out.findings.map(({ line, gw }) => [line, gw]);
}
const PY_OK = 'def test_adds():\n    assert add(1, 2) == 3\n';

test('Python GW-17: every skip and expected-failure marker on an added line is red, under any import name', () => {
  const markers = [
    'import pytest\n\n\n@pytest.mark.skip(reason="later")\ndef test_a():\n    assert f()\n',
    'import pytest\n\n\n@pytest.mark.skipif(True, reason="x")\ndef test_a():\n    assert f()\n',
    'import pytest\n\n\n@pytest.mark.xfail\ndef test_a():\n    assert f()\n',
    'import unittest\n\n\nclass T(unittest.TestCase):\n    @unittest.skip("x")\n    def test_a(self):\n        self.assertTrue(f())\n',
    'import unittest\n\n\nclass T(unittest.TestCase):\n    @unittest.skipIf(True, "x")\n    def test_a(self):\n        self.assertTrue(f())\n',
    'import unittest\n\n\nclass T(unittest.TestCase):\n    @unittest.skipUnless(False, "x")\n    def test_a(self):\n        self.assertTrue(f())\n',
    'import unittest\n\n\nclass T(unittest.TestCase):\n    @unittest.expectedFailure\n    def test_a(self):\n        self.assertTrue(f())\n',
    'import unittest\n\n\nclass T(unittest.TestCase):\n    def test_a(self):\n        self.skipTest("x")\n        self.assertTrue(f())\n',
    'import pytest\n\n\ndef test_a():\n    pytest.skip("x")\n    assert f()\n',
    'import pytest\n\n\ndef test_a():\n    pytest.xfail("x")\n    assert f()\n',
    'import pytest\n\nnp = pytest.importorskip("numpy")\n',
    'import unittest\n\n\ndef test_a():\n    raise unittest.SkipTest("x")\n',
    'import pytest\n\npytestmark = pytest.mark.skip\n',
    'import pytest as pt\n\n\n@pt.mark.skip\ndef test_a():\n    assert f()\n',
    'from pytest import mark\n\n\n@mark.xfail\ndef test_a():\n    assert f()\n',
    'from unittest import skip\n\n\n@skip("x")\ndef test_a():\n    assert f()\n',
    'from unittest.case import skip as later\n\n\n@later("x")\ndef test_a():\n    assert f()\n',
    `${PY_OK}\n\n# def test_old():\n#     assert f()\n`,
    `${PY_OK}\n\n#async def test_old():\n`,
  ];
  for (const source of markers) {
    assert.deepEqual(python(null, source, { ...ALL, assertions: false }).filter(([, gw]) => gw === 'GW-17').length, 1, source);
  }
});

test('Python GW-17 honest cases: an old marker, a name that only looks like one, a comment or a string are not red', () => {
  const old = 'import pytest\n\n\n@pytest.mark.skip\ndef test_old():\n    assert f()\n\n\n';
  assert.deepEqual(python(old, `${old}${PY_OK}`), []);
  for (const source of ['skip = 10\n\n\ndef test_a():\n    assert f(skip)\n', '# define test data below\nDATA = 1\n',
    'NOTE = "use @pytest.mark.skip only with a reason"\n', 'def test_a(runner):\n    runner.skip(3)\n    assert runner.done\n']) {
    assert.deepEqual(python(null, source), [], source);
  }
});

test('Python GW-18: a new or changed test with no assertion is red; one whose assertion the turn removed too', () => {
  assert.deepEqual(python(null, 'def test_saves():\n    save(user)\n'), [[1, 'GW-18']]);
  assert.deepEqual(python(null, 'async def test_saves():\n    await save(user)\n'), [[1, 'GW-18']]);
  assert.deepEqual(python(null, 'import unittest\n\n\nclass T(unittest.TestCase):\n    def testSaves(self):\n        save(user)\n'), [[5, 'GW-18']]);
  assert.deepEqual(python('def test_a():\n    run()\n    assert x == 1\n\n\nDONE = 1\n', 'def test_a():\n    run()\n\n\nDONE = 1\n'), [[1, 'GW-18']]);
});

test('Python GW-18 honest cases: any assertion counts; a helper, a skipped test or an unchanged test is not red', () => {
  const asserting = [
    PY_OK, 'import pytest\n\n\ndef test_a():\n    with pytest.raises(ValueError):\n        f()\n',
    'import pytest\n\n\ndef test_a():\n    with pytest.warns(UserWarning):\n        f()\n', 'def test_a(m):\n    f()\n    m.assert_called_once_with(1)\n',
    'from pandas.testing import assert_frame_equal\n\n\ndef test_a():\n    assert_frame_equal(f(), g())\n',
    'import unittest\n\n\nclass T(unittest.TestCase):\n    def test_a(self):\n        if f():\n            self.fail("no")\n',
    'def test_a():\n    def check(x):\n        assert x\n    check(f())\n', 'def testdata():\n    return [1, 2]\n', 'def helper():\n    run()\n',
  ];
  for (const source of asserting) assert.deepEqual(python(null, source), [], source);
  const unchanged = 'def test_old():\n    run()\n\n\n';
  assert.deepEqual(python(unchanged, `${unchanged}${PY_OK}`), []);
});

test('Python GW-01: a check whose two sides are the same is red; different sides or a negated check are not', () => {
  for (const source of ['def test_a():\n    assert x == x\n', 'def test_a():\n    assert a.b is a.b\n', 'def test_a():\n    assert f(1) >= f( 1 )\n',
    'import unittest\n\n\nclass T(unittest.TestCase):\n    def test_a(self):\n        self.assertEqual(x, x)\n',
    'import numpy as np\n\n\ndef test_a():\n    np.testing.assert_array_equal(a, a)\n']) {
    assert.deepEqual(python(null, source).map(([, gw]) => gw), ['GW-01'], source);
  }
  for (const source of ['def test_a():\n    assert x == y\n', 'def test_a():\n    assert x != x\n',
    'import unittest\n\n\nclass T(unittest.TestCase):\n    def test_a(self):\n        self.assertNotEqual(x, x)\n        self.assertEqual(x, y)\n']) {
    assert.deepEqual(python(null, source), [], source);
  }
});

test('Python GW-18: an assertion on a constant that is always true is no assertion; assert False is one', () => {
  assert.deepEqual(python(null, 'def test_a():\n    save(u)\n    assert True\n'), [[1, 'GW-18']]);
  assert.deepEqual(python(null, 'import unittest\n\n\nclass T(unittest.TestCase):\n    def test_a(self):\n        save(u)\n        self.assertTrue(1)\n'), [[5, 'GW-18']]);
  assert.deepEqual(python(null, 'def test_a():\n    try:\n        save(u)\n    except ValueError:\n        assert False, "raised"\n'), []);
  assert.deepEqual(python(null, 'import unittest\n\n\nclass T(unittest.TestCase):\n    def test_a(self):\n        self.assertTrue(save(u))\n'), []);
});

test('Python: a skipped test is a skip, not a test without assertions', () => {
  assert.deepEqual(python(null, 'import pytest\n\n\n@pytest.mark.skip\ndef test_a():\n    pass\n'), [[4, 'GW-17']]);
  assert.deepEqual(python(null, 'import unittest\n\n\nclass T(unittest.TestCase):\n    def test_a(self):\n        self.skipTest("x")\n'), [[6, 'GW-17']]);
  assert.deepEqual(python(null, 'import pytest\n\n\ndef test_a():\n    pytest.skip("x")\n'), [[5, 'GW-17']]);
});

test('Python: a check turned off does not report; a file Python cannot read is an error, not a pass', () => {
  const source = 'import pytest\n\n\n@pytest.mark.skip\ndef test_a():\n    assert x == x\n\n\ndef test_b():\n    run()\n';
  assert.deepEqual(python(null, source).map(([, gw]) => gw).sort(), ['GW-01', 'GW-17', 'GW-18']);
  assert.deepEqual(python(null, source, { ...ALL, skips: false }).map(([, gw]) => gw).sort(), ['GW-01', 'GW-18']);
  assert.deepEqual(python(null, source, { ...ALL, assertions: false }).map(([, gw]) => gw).sort(), ['GW-01', 'GW-17']);
  assert.deepEqual(python(null, source, { ...ALL, selfComparisons: false }).map(([, gw]) => gw).sort(), ['GW-17', 'GW-18']);
  const [error] = python(null, 'def test_a(:\n');
  assert.equal(error.file, 'test_x.py');
  assert.match(error.error, /^Python could not read it \(SyntaxError/);
});

test('Python: a BOM, a CR-only file and a NUL byte', () => {
  assert.deepEqual(python(null, '﻿def test_a():\n    run()\n'), [[1, 'GW-18']]);
  const cr = 'def test_a():\r    assert f()\r';
  assert.deepEqual(python(cr, `${cr}# def test_b():\r`), [[3, 'GW-17']]);
  const [error] = python(null, 'x = 1\x00\n');
  assert.match(error.error, /^Python could not read it \((SyntaxError|ValueError)/);
});

test('Python GW-18: a pytest fixture named test_* is not a test; a helper named _assert... is an assertion', () => {
  assert.deepEqual(python(null, 'import pytest\n\n\n@pytest.fixture\ndef test_cart():\n    return Cart()\n'), []);
  assert.deepEqual(python(null, 'from pytest import fixture\n\n\n@fixture(scope="module")\ndef test_user():\n    return make()\n'), []);
  assert.deepEqual(python(null, 'import unittest\n\n\nclass T(unittest.TestCase):\n    def test_a(self):\n        self._assert_file("x")\n'), []);
});

test('Python GW-17: __test__ = False, a new test in a class or module that never runs, a changed skipif condition, a named marker', () => {
  assert.deepEqual(python(null, 'class TestA:\n    __test__ = False\n\n    def test_a(self):\n        assert f()\n'), [[2, 'GW-17']]);
  const skipped = 'import pytest\n\n\n@pytest.mark.skip\nclass TestOld:\n    def test_a(self):\n        assert f()\n';
  assert.deepEqual(python(skipped, `${skipped}\n    def test_b(self):\n        assert g()\n`), [[9, 'GW-17']]);
  // An edit or a rename of a test that was already in the skipped class is no new skip.
  assert.deepEqual(python(skipped, skipped.replace('assert f()', 'assert f(1)').replace('test_a', 'test_renamed')), []);
  const marked = 'import pytest\n\npytestmark = pytest.mark.skip\n';
  assert.deepEqual(python(marked, `${marked}\n\ndef test_a():\n    assert f()\n`), [[6, 'GW-17']]);
  // __test__ = False counts where it is added: a base class keeps it while its subclasses run its tests.
  const base = 'class BaseTests:\n    __test__ = False\n\n    def test_a(self):\n        assert f()\n\n\nclass TestReal(BaseTests):\n    __test__ = True\n';
  assert.deepEqual(python(base, base.replace('        assert f()\n', '        assert f()\n\n    def test_b(self):\n        assert g()\n')), []);
  // A class marked by its own pytestmark, and a module whose pytestmark list holds a skip.
  const classMark = 'import pytest\n\n\nclass TestOld:\n    pytestmark = pytest.mark.skip\n\n    def test_a(self):\n        assert f()\n';
  assert.deepEqual(python(classMark, `${classMark}\n    def test_b(self):\n        assert g()\n`), [[10, 'GW-17']]);
  const listMark = 'import pytest\n\npytestmark = [pytest.mark.slow, pytest.mark.skip]\n';
  assert.deepEqual(python(listMark, `${listMark}\n\ndef test_a():\n    assert f()\n`), [[6, 'GW-17']]);
  // A condition may let the module run: a new test there is not reported, nor more marks added.
  const platform = 'import sys\n\nimport pytest\n\npytestmark = pytest.mark.skipif(sys.platform == "win32", reason="x")\n';
  assert.deepEqual(python(platform, `${platform}\n\ndef test_a():\n    assert f()\n`), []);
  assert.deepEqual(python(platform, `${platform}pytestmark = pytestmark + [pytest.mark.slow]\n`), []);
  // One case of a parametrize marked skip does not make the class a suite that never runs.
  const oneCase = 'import pytest\n\n\n@pytest.mark.parametrize("x", [1, pytest.param(2, marks=pytest.mark.skip)])\nclass TestP:\n    def test_a(self, x):\n        assert f(x)\n';
  assert.deepEqual(python(oneCase, `${oneCase}\n    def test_b(self, x):\n        assert g(x)\n`), []);
  const skipIf = (condition) => `import sys\n\nimport pytest\n\n\n@pytest.mark.skipif(\n    ${condition},\n    reason="x",\n)\ndef test_a():\n    assert f()\n`;
  assert.deepEqual(python(skipIf('sys.platform == "win32"'), skipIf('sys.platform == "win32" or True')), [[6, 'GW-17']]);
  const named = 'import os\n\nimport pytest\n\nneeds_sandbox = pytest.mark.skipif(not os.environ.get("SANDBOX"), reason="x")\n\n\n';
  assert.deepEqual(python(named, `${named}@needs_sandbox\ndef test_pays():\n    assert pay()\n`), [[8, 'GW-17']]);
  assert.deepEqual(python(named, `${named}def test_pays():\n    assert pay()\n`), []);
  // A module importorskip returns is no marker: a new test that uses it is not a skip.
  const imported = 'import pytest\n\nsqlite3 = pytest.importorskip("sqlite3")\n\n\ndef test_a():\n    assert sqlite3.connect(":memory:")\n';
  assert.deepEqual(python(imported, `${imported}\n\ndef test_b():\n    assert sqlite3.sqlite_version\n`), []);
  // A test under a named skip does not run: a skip, not also a test without assertions.
  assert.deepEqual(python(named, `${named}@needs_sandbox\ndef test_pays():\n    pay()\n`), [[8, 'GW-17']]);
  // A new skipped class or module is one finding, not one more for each test in it.
  assert.deepEqual(python(null, `${skipped}\n    def test_b(self):\n        run()\n`), [[4, 'GW-17']]);
  assert.deepEqual(python(null, `${marked}\n\ndef test_a():\n    assert f()\n`), [[3, 'GW-17']]);
  // A changed condition of a module's skipif, on a line of its own.
  const module = (condition) => `import sys\n\nimport pytest\n\npytestmark = [\n    pytest.mark.slow,\n    pytest.mark.skipif(\n        ${condition},\n        reason="x",\n    ),\n]\n\n\ndef test_a():\n    assert f()\n`;
  assert.deepEqual(python(module('sys.platform == "win32"'), module('True')), [[7, 'GW-17']]);
  // A class marked xfail still runs its tests: a new test in it without assertions is also GW-18.
  const xfail = 'import pytest\n\n\n@pytest.mark.xfail\nclass TestOld:\n    def test_a(self):\n        assert f()\n';
  assert.deepEqual(python(xfail, `${xfail}\n    def test_b(self):\n        run()\n`), [[9, 'GW-17'], [9, 'GW-18']]);
});

test('Python edges: markers and messages, an old comment, removed lines above a test, other same sides', () => {
  const found = (source) => python(null, source).map(([, gw]) => gw).sort();
  assert.deepEqual(found('import pytest\n\n\n@pytest.mark.xfail\ndef test_a():\n    run()\n'), ['GW-17', 'GW-18']);
  assert.deepEqual(found('def test():\n    run()\n'), ['GW-18']);
  assert.deepEqual(found('def test_a():\n    assert a <= a\n'), ['GW-01']);
  assert.deepEqual(found('import numpy as np\n\n\ndef test_a():\n    np.testing.assert_allclose(a, a)\n'), ['GW-01']);
  assert.deepEqual(found('import unittest\n\n\nclass T(unittest.TestCase):\n    def test_a(self):\n        self.assertIs(a, a)\n'), ['GW-01']);
  assert.deepEqual(found('def test_a():\n    assert a == a == b\n'), []);
  assert.deepEqual(found('import pytest\n\n\ndef test_a():\n    with pytest.deprecated_call():\n        old()\n'), []);
  // The second line of an assert that spans lines changed.
  assert.deepEqual(python('def test_a():\n    assert (\n        a.b\n        == a.c\n    )\n', 'def test_a():\n    assert (\n        a.b\n        == a.b\n    )\n'), [[2, 'GW-01']]);
  // A new decorator on an old test without assertions makes it a changed test.
  const bare = 'def test_old():\n    run()\n';
  assert.deepEqual(python(`import pytest\n\n\n${bare}`, `import pytest\n\n\n@pytest.mark.slow\n${bare}`), [[4, 'GW-18']]);
  assert.deepEqual(python(`import os\n${bare}`, bare), []);
  const comment = 'def test_a():\n    assert f()\n\n# def test_old():\n';
  assert.deepEqual(python(comment, `${comment}\n\ndef test_b():\n    assert g()\n`), []);
  const words = (source) => JSON.parse(spawnSync('python3', ['-I', path.join(__dirname, '..', 'lib', 'python_checks.py')], {
    input: JSON.stringify({ files: [{ file: 't.py', text: source, added: [...lineChanges(null, source).added], gaps: [], checks: ALL }], entries: CHECKS }),
    encoding: 'utf8',
  }).stdout).findings.map((f) => f.what);
  assert.deepEqual(words('import pytest\n\n\n@pytest.mark.xfail\ndef test_a():\n    assert f()\n'), ['pytest.mark.xfail - the test passes when it fails']);
  assert.deepEqual(words('import pytest\n\n\n@pytest.mark.skip\ndef test_a():\n    assert f()\n'), ['pytest.mark.skip - the test does not run']);
  const inside = (before, after) => JSON.parse(spawnSync('python3', ['-I', path.join(__dirname, '..', 'lib', 'python_checks.py')], {
    input: JSON.stringify({ files: [{ file: 't.py', text: after, added: [...lineChanges(before, after).added], gaps: [], checks: ALL }], entries: CHECKS }),
    encoding: 'utf8',
  }).stdout).findings.map((f) => f.what);
  const old = 'import pytest\n\n\n@pytest.mark.skip\nclass TestOld:\n    def test_a(self):\n        assert f()\n';
  assert.deepEqual(inside(old, `${old}\n    def test_b(self):\n        assert g()\n`), ['a test inside a class marked pytest.mark.skip - the test does not run']);
  const xfailed = 'import pytest\n\npytestmark = pytest.mark.xfail\n';
  assert.deepEqual(inside(xfailed, `${xfailed}\n\ndef test_b():\n    assert g()\n`), ['a test inside a module marked pytest.mark.xfail - the test passes when it fails']);
});
