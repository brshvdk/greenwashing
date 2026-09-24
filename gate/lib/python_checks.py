"""The gate's quick checks for Python test files, with Python's own ast module.

A new skip or expected-failure marker (GW-17), a new or changed test with no
assertion (GW-18), a check whose two sides are the same (GW-01), each only on
the lines a turn added or changed. The hook runs it as
`python3 -I python_checks.py` with JSON on stdin:
    {"files": [{"file", "text", "added": [line], "gaps": [line],
                "checks": {"skips", "assertions", "selfComparisons"}}],
     "entries": {"skips": "GW-17", ...}}
and reads JSON from stdout:
    {"findings": [{"file", "line", "gw", "what"}], "errors": [{"file", "error"}]}
"""

import ast
import io
import json
import re
import sys
import tokenize

# Skip and expected-failure markers, by the name they are imported under.
SKIPS = {
    "pytest.mark.skip", "pytest.mark.skipif", "pytest.mark.xfail", "pytest.skip", "pytest.xfail", "pytest.importorskip",
    "unittest.skip", "unittest.skipIf", "unittest.skipUnless", "unittest.expectedFailure", "unittest.SkipTest",
    "unittest.case.skip", "unittest.case.skipIf", "unittest.case.skipUnless", "unittest.case.expectedFailure",
    "unittest.case.SkipTest",
}
PASSES_WHEN_FAILING = {"pytest.mark.xfail", "pytest.xfail", "unittest.expectedFailure", "unittest.case.expectedFailure"}
# Markers after which the test does not run: it is a skip, not a test without assertions.
NOT_RUN = SKIPS - PASSES_WHEN_FAILING
# Calls that check something, besides the assert statement and names starting with "assert".
CHECKING_CALLS = {"pytest.raises", "pytest.warns", "pytest.deprecated_call", "pytest.fail"}
# Comparisons that hold whenever both sides are the same.
SAME_OPS = (ast.Eq, ast.Is, ast.GtE, ast.LtE)
TEST_NAME = re.compile(r"test(?:$|_|[A-Z0-9])")
COMMENTED_TEST = re.compile(r"#\s*(?:async\s+)?def\s+test")


def what(marker):
    return "the test passes when it fails" if marker in PASSES_WHEN_FAILING else "the test does not run"


def imported_names(tree):
    """Local name -> the dotted name it was imported as (import pytest as pt: pt -> pytest)."""
    names = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if alias.asname:
                    names[alias.asname] = alias.name
                else:
                    top = alias.name.split(".")[0]
                    names[top] = top
        elif isinstance(node, ast.ImportFrom) and node.module and not node.level:
            for alias in node.names:
                names[alias.asname or alias.name] = f"{node.module}.{alias.name}"
    return names


def dotted(node, names):
    """The dotted name of a name or attribute chain, imports resolved; None for anything else."""
    if isinstance(node, ast.Name):
        return names.get(node.id, node.id)
    if isinstance(node, ast.Attribute):
        base = dotted(node.value, names)
        return f"{base}.{node.attr}" if base else None
    return None


def last_name(node):
    """self.assertEqual -> assertEqual, assert_frame_equal -> assert_frame_equal."""
    if isinstance(node, ast.Attribute):
        return node.attr
    if isinstance(node, ast.Name):
        return node.id
    return ""


def same_sides_call(name):
    """assertEqual, assertIs, assert_array_equal, assert_allclose: pass when both arguments are the same."""
    flat = name.lower().replace("_", "")
    return flat.startswith("assert") and "not" not in flat and (
        flat.endswith(("equal", "equals", "allclose")) or flat == "assertis")


def brief(source, node):
    text = " ".join((ast.get_source_segment(source, node) or "").split())
    return text if len(text) <= 80 else text[:77] + "..."


def marker_names(tree, names):
    """Names given a marker: needs_sandbox = pytest.mark.skipif(...) -> {"needs_sandbox": "pytest.mark.skipif"}."""
    given = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            found = [dotted(n, names) for n in ast.walk(node.value) if isinstance(n, (ast.Name, ast.Attribute))]
            marker = next((name for name in found if name in SKIPS), None)
            if marker and node.targets[0].id != "pytestmark":
                given[node.targets[0].id] = marker
    return given


def check(file, source, added, gaps, checks, entries):
    """The findings in one file: [{"file", "line", "gw", "what"}]; entries: the catalog entry of each check."""
    # A byte order mark starts the file on disk; Python reads past it there, not in a string.
    source = source[1:] if source.startswith("﻿") else source
    tree = ast.parse(source, filename=file)
    names = imported_names(tree)
    given = marker_names(tree, names)
    findings = []

    def report(gw, line, text):
        findings.append({"file": file, "line": line, "gw": gw, "what": text})

    def added_in(node):
        return any(line in added for line in range(node.lineno, (node.end_lineno or node.lineno) + 1))

    def marker(node):
        """The marker a decorator or an expression stands for, through a name given to it too."""
        name = dotted(node.func if isinstance(node, ast.Call) else node, names)
        return name if name in SKIPS else given.get(name)

    def label(node, mark):
        name = dotted(node.func if isinstance(node, ast.Call) else node, names)
        return name if name == mark else f"{name} ({mark})"

    tests = test_functions(tree, names, marker)
    if checks.get("skips") is not False:
        # A marker on a function or class counts with its arguments: a changed condition of skipif is a new skip.
        seen = set()
        for node in ast.walk(tree):
            for decorator in getattr(node, "decorator_list", []):
                mark = marker(decorator)
                if mark:
                    seen.update(id(inner) for inner in ast.walk(decorator))
                    if added_in(decorator):
                        report(entries["skips"], decorator.lineno, f"{label(decorator, mark)} - {what(mark)}")
        for node in ast.walk(tree):
            if id(node) in seen:
                continue
            mark = marker(node) if isinstance(node, ast.Call) else None
            if mark:
                # A call of a marker counts with its arguments too: pytestmark = pytest.mark.skipif(...).
                seen.update(id(inner) for inner in ast.walk(node))
                if added_in(node):
                    report(entries["skips"], node.lineno, f"{label(node, mark)} - {what(mark)}")
                continue
            if getattr(node, "lineno", None) not in added:
                continue
            if isinstance(node, (ast.Name, ast.Attribute)) and dotted(node, names) in SKIPS:
                report(entries["skips"], node.lineno, f"{dotted(node, names)} - {what(dotted(node, names))}")
            elif isinstance(node, ast.Name) and isinstance(node.ctx, ast.Load) and node.id in given:
                report(entries["skips"], node.lineno, f"{node.id} ({given[node.id]}) - {what(given[node.id])}")
            elif isinstance(node, ast.Attribute) and node.attr == "skipTest":
                report(entries["skips"], node.lineno, f"{dotted(node, names) or 'skipTest'}() - the test stops as skipped")
            elif isinstance(node, ast.Assign) and not_collected(node):
                report(entries["skips"], node.lineno, "__test__ = False - the runner does not collect these tests")
        for token in tokenize.generate_tokens(io.StringIO(source, newline=None).readline):
            if token.type == tokenize.COMMENT and token.start[0] in added and COMMENTED_TEST.match(token.string):
                report(entries["skips"], token.start[0], f"a test in a comment: {token.string[:60]}")
        # A test in a suite that does not run as written; a new marker of the suite is reported above.
        for function, start, suite in tests:
            if suite and not added_in(suite[1]) and touched(function, start, added, gaps):
                effect = what(suite[2]) if suite[2] else "the runner does not collect it"
                report(entries["skips"], start, f"a test inside {suite[0]} - {effect}")

    if checks.get("assertions") is not False:
        for function, start, suite in tests:
            stopped = suite and suite[2] not in PASSES_WHEN_FAILING
            if not stopped and touched(function, start, added, gaps) and runs(function, names, marker) and not asserts(function, names):
                report(entries["assertions"], start, f"{function.name} has no assertion")

    if checks.get("selfComparisons") is not False:
        for node in ast.walk(tree):
            if isinstance(node, ast.Assert) and isinstance(node.test, ast.Compare) and len(node.test.ops) == 1:
                same = isinstance(node.test.ops[0], SAME_OPS) and ast.dump(node.test.left) == ast.dump(node.test.comparators[0])
            elif isinstance(node, ast.Call) and same_sides_call(last_name(node.func)) and len(node.args) >= 2:
                same = ast.dump(node.args[0]) == ast.dump(node.args[1])
            else:
                continue
            if same and added_in(node):
                report(entries["selfComparisons"], node.lineno, f"{brief(source, node)} - both sides are the same")
    # One finding per line and entry, the first one, in the order of the file.
    unique = {}
    for finding in findings:
        unique.setdefault((finding["line"], finding["gw"]), finding)
    return sorted(unique.values(), key=lambda f: f["line"])


def not_collected(node):
    """__test__ = False: pytest does not collect the class or module it is in."""
    return (any(isinstance(target, ast.Name) and target.id == "__test__" for target in node.targets)
            and isinstance(node.value, ast.Constant) and node.value.value is False)


def touched(function, start, added, gaps):
    """A line of the test added or changed, or a line removed inside it. A function ends at its last
    statement, so a line removed right after it may have been that statement: the gap before line
    end + 1 counts too."""
    end = function.end_lineno or function.lineno
    return any(line in added for line in range(start, end + 1)) or any(start < gap <= end + 1 for gap in gaps)


def test_functions(tree, names, marker):
    """(function, first line with its decorators, suite) for each test function in the module or its
    classes. suite is (what, node, marker) for what keeps the test from running as written: a marker
    on its class or in the module's pytestmark, or __test__ = False there (marker None); node is where
    that is written. pytest fixtures named test_* are not tests."""
    module = next(((f"a module marked {marker(n)}", n, marker(n)) for s in tree.body if isinstance(s, ast.Assign)
                   and any(isinstance(t, ast.Name) and t.id == "pytestmark" for t in s.targets)
                   for n in ast.walk(s.value) if marker(n)), None)
    found = []
    bodies = [(tree.body, module)]
    while bodies:
        body, suite = bodies.pop()
        hidden = next((node for node in body if isinstance(node, ast.Assign) and not_collected(node)), None)
        if hidden and not suite:
            suite = (f"{'the module' if body is tree.body else 'a class'} with __test__ = False", hidden, None)
        for node in body:
            if isinstance(node, ast.ClassDef):
                mark = next((d for d in node.decorator_list if marker(d)), None)
                bodies.append((node.body, suite or (mark and (f"a class marked {marker(mark)}", mark, marker(mark)))))
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and TEST_NAME.match(node.name):
                if any(dotted(d.func if isinstance(d, ast.Call) else d, names) == "pytest.fixture" for d in node.decorator_list):
                    continue
                found.append((node, min([node.lineno] + [d.lineno for d in node.decorator_list]), suite))
    return found


def runs(function, names, marker):
    """The test runs as written: no skip decorator, and no skipTest() or pytest.skip() in its body."""
    if any(marker(d) in NOT_RUN for d in function.decorator_list):
        return False
    for statement in function.body:
        for node in ast.walk(statement):
            if isinstance(node, ast.Call) and (last_name(node.func) == "skipTest" or dotted(node.func, names) in NOT_RUN):
                return False
    return True


def asserts(function, names):
    """The function's body checks something: an assert statement, a call named assert* (or _assert*), or
    pytest.raises and the like. An assertion on a constant that is always true (assert True,
    self.assertTrue(1)) checks nothing."""
    for statement in function.body:
        for node in ast.walk(statement):
            if isinstance(node, ast.Assert) and not truthy_constant(node.test):
                return True
            if isinstance(node, ast.Call):
                name = last_name(node.func)
                if name == "assertTrue" and node.args and truthy_constant(node.args[0]):
                    continue
                if name.lstrip("_").lower().startswith("assert") or name == "fail" or dotted(node.func, names) in CHECKING_CALLS:
                    return True
    return False


def truthy_constant(node):
    return isinstance(node, ast.Constant) and bool(node.value)


def main():
    request = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    findings, errors = [], []
    for item in request["files"]:
        try:
            findings += check(item["file"], item["text"], set(item["added"]), set(item["gaps"]), item["checks"], request["entries"])
        except (SyntaxError, ValueError, tokenize.TokenError) as error:
            errors.append({"file": item["file"], "error": f"Python could not read it ({type(error).__name__}: {error})"})
    sys.stdout.buffer.write(json.dumps({"findings": findings, "errors": errors}).encode("utf-8"))


if __name__ == "__main__":
    main()
