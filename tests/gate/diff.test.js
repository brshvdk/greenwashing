'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { lineChanges, MAX_EDITS } = require('../../plugin/gate/lib/diff');

const changes = (before, after) => {
  const { added, gaps } = lineChanges(before, after);
  return { added: [...added].sort((x, y) => x - y), gaps: [...gaps].sort((x, y) => x - y) };
};

test('a new file: every line is added', () => {
  assert.deepEqual(changes(null, 'a\nb'), { added: [1, 2], gaps: [] });
});

test('the same text: nothing changed', () => {
  assert.deepEqual(changes('a\nb\n', 'a\nb\n'), { added: [], gaps: [] });
});

test('an added, a changed and a removed line', () => {
  assert.deepEqual(changes('a\nb\nc\n', 'a\nx\nb\nc\n'), { added: [2], gaps: [] });
  assert.deepEqual(changes('a\nb\nc\n', 'a\nB\nc\n'), { added: [2], gaps: [2] });
  // Line b removed: the gap is before the line that follows it now, c (line 2).
  assert.deepEqual(changes('a\nb\nc\n', 'a\nc\n'), { added: [], gaps: [2] });
  // The last line removed: the gap is past the end.
  assert.deepEqual(changes('a\nb', 'a'), { added: [], gaps: [2] });
  assert.deepEqual(changes('a\nb', 'b'), { added: [], gaps: [1] });
});

test('lines are compared whole, CRLF and CR read like LF', () => {
  assert.deepEqual(changes('a\r\nb\r\n', 'a\nb\n'), { added: [], gaps: [] });
  assert.deepEqual(changes('a\rb', 'a\nb'), { added: [], gaps: [] });
  assert.deepEqual(changes('  a\n', 'a\n'), { added: [1], gaps: [1] });
});

// The longest common subsequence of two arrays, by dynamic programming.
function lcs(a, b) {
  const row = new Array(b.length + 1).fill(0);
  for (const x of a) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const up = row[j];
      row[j] = x === b[j - 1] ? diagonal + 1 : Math.max(row[j], row[j - 1]);
      diagonal = up;
    }
  }
  return row[b.length];
}

test('on random texts, the unchanged lines are a longest common subsequence of both texts', () => {
  let seed = 7;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const text = () => Array.from({ length: Math.floor(random() * 12) }, () => 'abc'[Math.floor(random() * 3)]);
  for (let round = 0; round < 2000; round += 1) {
    // An empty text is one empty line.
    const a = text().join('\n').split('\n');
    const b = text().join('\n').split('\n');
    const { added } = lineChanges(a.join('\n'), b.join('\n'));
    const kept = b.filter((_, i) => !added.has(i + 1));
    assert.equal(kept.length, lcs(a, b), `${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
    // The kept lines appear in the old text in the same order.
    let at = 0;
    for (const line of kept) {
      while (at < a.length && a[at] !== line) at += 1;
      assert.ok(at < a.length, `${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
      at += 1;
    }
  }
});

test('the edit limit leaves room for a big honest edit: 1800 new lines around an old one keep it old', () => {
  const lines = (n, tag) => Array.from({ length: n }, (_, i) => `${tag} ${i}`);
  const old = "it.skip('old', () => {});";
  const { added } = changes(old, [...lines(900, 'top'), old, ...lines(900, 'end')].join('\n'));
  assert.equal(added.length, 1800);
  assert.ok(!added.includes(901));
});

test('past the edit limit, every line between the first and the last difference counts as changed', () => {
  const before = Array.from({ length: MAX_EDITS }, (_, i) => `old ${i}`);
  const after = Array.from({ length: MAX_EDITS }, (_, i) => `new ${i}`);
  const result = changes(['same', ...before, 'end'].join('\n'), ['same', ...after, 'end'].join('\n'));
  assert.equal(result.added.length, MAX_EDITS);
  assert.deepEqual([result.added[0], result.added.at(-1)], [2, MAX_EDITS + 1]);
  assert.deepEqual(result.gaps, [2]);
  // Within the limit the diff is exact, however long the file.
  const long = Array.from({ length: 50000 }, (_, i) => `line ${i}`);
  const edited = [...long.slice(0, 10), 'x', ...long.slice(10, 40000), ...long.slice(40001)];
  assert.deepEqual(changes(long.join('\n'), edited.join('\n')), { added: [11], gaps: [40002] });
});
