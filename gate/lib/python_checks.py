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
# Markers after which the test does not run: it is a skip, not a test without assertions.
NOT_RUN = {name for name in SKIPS if "xfail" not in name and "expectedFailure" not in name}
# Calls that check something, besides the assert statement and names starting with "assert".
CHECKING_CALLS = {"pytest.raises", "pytest.warns", "pytest.deprecated_call", "pytest.fail"}
# Comparisons that hold whenever both sides are the same.
SAME_OPS = (ast.Eq, ast.Is, ast.GtE, ast.LtE)
TEST_NAME = re.compile(r"test(?:$|_|[A-Z0-9])")
COMMENTED_TEST = re.compile(r"#\s*(?:async\s+)?def\s+test")


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


def check(file, source, added, gaps, checks, entries):
    """The findings in one file: [{"file", "line", "gw", "what"}]; entries: the catalog entry of each check."""
    tree = ast.parse(source, filename=file)
    names = imported_names(tree)
    findings = []

    def report(gw, line, what):
        findings.append({"file": file, "line": line, "gw": gw, "what": what})

    def added_in(node):
        return any(line in added for line in range(node.lineno, (node.end_lineno or node.lineno) + 1))

    if checks.get("skips") is not False:
        for node in ast.walk(tree):
            if isinstance(node, (ast.Name, ast.Attribute)) and node.lineno in added:
                name = dotted(node, names)
                if name in SKIPS:
                    report(entries["skips"], node.lineno, f"{name} - the test does not run as written")
                elif isinstance(node, ast.Attribute) and node.attr == "skipTest":
                    report(entries["skips"], node.lineno, f"{name or 'skipTest'}() - the test stops as skipped")
        for token in tokenize.generate_tokens(io.StringIO(source).readline):
            if token.type == tokenize.COMMENT and token.start[0] in added and COMMENTED_TEST.match(token.string):
                report(entries["skips"], token.start[0], f"a test in a comment: {token.string[:60]}")

    if checks.get("assertions") is not False:
        for function, start in test_functions(tree):
            end = function.end_lineno or function.lineno
            # A function ends at its last statement, so a line removed right after it may have been that
            # statement: the gap before line end + 1 counts too.
            touched = any(line in added for line in range(start, end + 1)) or any(start < gap <= end + 1 for gap in gaps)
            if touched and runs(function, names) and not asserts(function, names):
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
    return findings


def test_functions(tree):
    """(function, first line with its decorators) for each test function in the module or its classes."""
    found = []
    bodies = [tree.body]
    while bodies:
        for node in bodies.pop():
            if isinstance(node, ast.ClassDef):
                bodies.append(node.body)
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and TEST_NAME.match(node.name):
                found.append((node, min([node.lineno] + [d.lineno for d in node.decorator_list])))
    return found


def runs(function, names):
    """The test runs as written: no skip decorator, and no skipTest() or pytest.skip() in its body."""
    if any(dotted(d.func if isinstance(d, ast.Call) else d, names) in NOT_RUN for d in function.decorator_list):
        return False
    for statement in function.body:
        for node in ast.walk(statement):
            if isinstance(node, ast.Call) and (last_name(node.func) == "skipTest" or dotted(node.func, names) in NOT_RUN):
                return False
    return True


def asserts(function, names):
    """The function's body checks something: an assert statement, a call named assert*, or pytest.raises and the like."""
    for statement in function.body:
        for node in ast.walk(statement):
            if isinstance(node, ast.Assert):
                return True
            if isinstance(node, ast.Call):
                name = last_name(node.func)
                if name.lower().startswith("assert") or name == "fail" or dotted(node.func, names) in CHECKING_CALLS:
                    return True
    return False


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
