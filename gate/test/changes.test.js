'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isDocumentation, candidatePaths, changedPaths, classify } = require('../lib/changes');

test('documentation is told by the file extension, in any case', () => {
  for (const file of ['README.md', 'docs/guide.MD', 'notes.txt', 'index.rst', 'manual.adoc', 'a/b.markdown']) {
    assert.equal(isDocumentation(file), true, file);
  }
  for (const file of ['app.js', 'config.json', 'LICENSE', 'page.mdx', 'md.js', 'x.md.js', 'Makefile', '.greenwashing.json']) {
    assert.equal(isDocumentation(file), false, file);
  }
});

test('candidates join files dirty at the start, dirty now and committed during the turn', () => {
  assert.deepEqual(candidatePaths(['b.js', 'a.md'], ['c.py', 'a.md'], ['d.txt']), ['a.md', 'b.js', 'c.py', 'd.txt']);
});

test('a file counts as changed only when its content differs from the start of the turn', () => {
  const before = { 'same.js': 'h1', 'edited.js': 'h2', 'deleted.js': 'h3', 'created.js': null };
  const after = { 'same.js': 'h1', 'edited.js': 'h9', 'deleted.js': null, 'created.js': 'h4' };
  assert.deepEqual(changedPaths(before, after), ['created.js', 'deleted.js', 'edited.js']);
});

test('a file missing from one side counts as absent there', () => {
  assert.deepEqual(changedPaths({ 'old.js': 'h1' }, {}), ['old.js']);
  assert.deepEqual(changedPaths({}, { 'new.js': 'h1' }), ['new.js']);
  assert.deepEqual(changedPaths({ 'gone.js': null }, {}), []);
});

test('changes split into code and documentation', () => {
  assert.deepEqual(classify(['a.md', 'b.js', 'c.txt']), { code: ['b.js'], docs: ['a.md', 'c.txt'] });
  assert.deepEqual(classify(['a.md']), { code: [], docs: ['a.md'] });
});
