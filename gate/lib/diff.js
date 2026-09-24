'use strict';
// Which lines of a file a turn added or changed, and where it removed lines. Pure functions:
// texts in, line numbers out.

// Past this many inserted and removed lines the diff stops, and every line between the first and
// the last difference counts as changed.
const MAX_EDITS = 2000;

const splitLines = (text) => text.split(/\r\n|\r|\n/);

// Myers' shortest edit script between a and b (arrays of line ids), or null past MAX_EDITS.
// Returns [{insert: j}] for b[j] added and [{remove: j}] for a line removed before b[j].
function shortestEdit(a, b) {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const v = new Int32Array(2 * max + 3);
  const at = (k) => k + max + 1;
  // trace[d]: v for k from -d - 1 to d + 1 before round d, all that backtracking reads.
  const trace = [];
  for (let d = 0; d <= Math.min(max, MAX_EDITS); d += 1) {
    trace.push(v.slice(at(-d - 1), at(d + 1) + 1));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[at(k - 1)] < v[at(k + 1)]) ? v[at(k + 1)] : v[at(k - 1)] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[at(k)] = x;
      if (x >= n && y >= m) return backtrack(trace, n, m);
    }
  }
  return null;
}

function backtrack(trace, n, m) {
  const edits = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d -= 1) {
    const get = (k) => trace[d][k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && get(k - 1) < get(k + 1)) ? k + 1 : k - 1;
    const prevX = get(prevK);
    const prevY = prevX - prevK;
    edits.push(prevK === k + 1 ? { insert: prevY } : { remove: prevY });
    x = prevX;
    y = prevY;
  }
  return edits;
}

// before: the text at the start of the turn, or null for a new file; after: the text now.
// Returns {added, gaps}: added holds the 1-based numbers of the lines of after that are new or
// changed; gaps holds the line numbers of after before which lines were removed (the line count
// plus 1 for the end of the file).
function lineChanges(before, after) {
  const now = splitLines(after);
  const added = new Set();
  const gaps = new Set();
  if (before === null) {
    now.forEach((_, i) => added.add(i + 1));
    return { added, gaps };
  }
  const old = splitLines(before);
  let start = 0;
  while (start < old.length && start < now.length && old[start] === now[start]) start += 1;
  let endOld = old.length;
  let endNow = now.length;
  while (endOld > start && endNow > start && old[endOld - 1] === now[endNow - 1]) {
    endOld -= 1;
    endNow -= 1;
  }
  const ids = new Map();
  const id = (line) => {
    if (!ids.has(line)) ids.set(line, ids.size);
    return ids.get(line);
  };
  const edits = shortestEdit(old.slice(start, endOld).map(id), now.slice(start, endNow).map(id));
  if (edits === null) {
    for (let i = start; i < endNow; i += 1) added.add(i + 1);
    gaps.add(start + 1);
    return { added, gaps };
  }
  for (const edit of edits) {
    if ('insert' in edit) added.add(start + edit.insert + 1);
    else gaps.add(start + edit.remove + 1);
  }
  return { added, gaps };
}

module.exports = { lineChanges, splitLines, MAX_EDITS };
