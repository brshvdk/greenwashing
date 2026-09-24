'use strict';
// Which files changed during a turn, and whether any of them is more than documentation.
// Pure functions: the hook gathers file contents from git and the working tree.

const path = require('path');

// Not .txt: requirements.txt, CMakeLists.txt and test data are code (owner decision, PR 4 review).
const DOC_EXTENSIONS = ['.md', '.markdown', '.rst', '.adoc'];

function isDocumentation(file) {
  return DOC_EXTENSIONS.includes(path.extname(file).toLowerCase());
}

// A file can differ from the start of the turn only if it was dirty at the start, is dirty
// now, or changed between the commit at the start and the commit now.
function candidatePaths(dirtyAtStart, dirtyNow, committed) {
  return [...new Set([...dirtyAtStart, ...dirtyNow, ...committed])].sort();
}

// before, after: {path: content hash, or null when the file does not exist}.
function changedPaths(before, after) {
  const all = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...all].filter((file) => (before[file] ?? null) !== (after[file] ?? null)).sort();
}

function classify(changed) {
  const docs = changed.filter(isDocumentation);
  return { code: changed.filter((file) => !isDocumentation(file)), docs };
}

module.exports = { isDocumentation, candidatePaths, changedPaths, classify, DOC_EXTENSIONS };
