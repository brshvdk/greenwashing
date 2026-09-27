"""The gate's quick checks for Python test files, with Python's own ast module.

A new skip or expected-failure marker (GW-17), a new or changed test with no
assertion (GW-18), a check whose two sides are the same (GW-01), each only on
the lines a turn added or changed. The hook runs it as
`python3 -I python_checks.py` with JSON on stdin:
    {"files": [{"file", "text", "before", "added": [line], "gaps": [line],
                "checks": {"skips", "assertions", "selfComparisons"}}],
     "entries": {"skips": "GW-17", ...}}
and reads JSON from stdout:
    {"findings": [{"file", "line", "gw", "what"}], "errors": [{"file", "error"}]}
The request can also ask for the tests of texts, for the tests a turn removed:
    "list": [{"key", "file", "text", "start"}]  ->  "tests": {key: [{"name", "key", "body"}]}
A text from the start of the turn that Python cannot read ran no tests: its list is empty.
"""

import ast
import copy
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
# Calls that skip or fail where they run: what they return (importorskip's module) is no marker.
AT_ONCE = {"pytest.skip", "pytest.xfail", "pytest.importorskip", "unittest.SkipTest", "unittest.case.SkipTest"}
# Markers whose condition may let the tests run: on a class or module they do not make it a suite
# that never runs.
CONDITIONAL = {"pytest.mark.skipif", "unittest.skipIf", "unittest.skipUnless", "unittest.case.skipIf", "unittest.case.skipUnless"}
# Calls that check something, besides the assert statement and names starting with "assert".
CHECKING_CALLS = {"pytest.raises", "pytest.warns", "pytest.deprecated_call", "pytest.fail"}
# Comparisons that hold whenever both sides are the same.
SAME_OPS = (ast.Eq, ast.Is, ast.GtE, ast.LtE)
TEST_NAME = re.compile(r"test(?:$|_|[A-Z0-9])")
# A name the CI variable goes by: os.environ["CI"], os.getenv("CI"), "CI" in os.environ, a pytest
# string condition "os.environ.get('CI')".
CI_WORD = re.compile(r"(?<![\w$])CI(?![\w$])")
COMMENTED_TEST = re.compile(r"#\s*(?:async\s+)?def\s+test")


CI_EFFECT = "whether it runs depends on CI (the gate runs the tests with CI=true)"


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
            marker = next((name for name in found if name in SKIPS - AT_ONCE), None)
            if marker and node.targets[0].id != "pytestmark":
                given[node.targets[0].id] = marker
    return given


def reads_ci(node, tree):
    """The condition of a conditional marker (the first argument of skipif, skipIf, skipUnless, or
    condition=) reads the CI variable, itself or through a module-level name bound to such a read
    (IS_CI = bool(os.getenv("CI"))). The gate runs the tests with CI=true, so such a condition decides
    by where the tests run, not by the code: a skip, unlike a platform or version condition. node: a
    marker call, or a name given one."""
    values = {t.id: s.value for s in tree.body if isinstance(s, ast.Assign) for t in s.targets if isinstance(t, ast.Name)}
    if isinstance(node, ast.Name) and isinstance(values.get(node.id), ast.Call):
        node = values[node.id]
    if not isinstance(node, ast.Call):
        return False
    condition = node.args[:1] + [k.value for k in node.keywords if k.arg == "condition"]

    def mentions(expr):
        for inner in ast.walk(expr):
            if isinstance(inner, ast.Constant) and isinstance(inner.value, str) and CI_WORD.search(inner.value):
                return True
            if (isinstance(inner, ast.Name) and inner.id == "CI") or (isinstance(inner, ast.Attribute) and inner.attr == "CI"):
                return True
        return False
    return any(mentions(c) or any(isinstance(n, ast.Name) and n.id in values and mentions(values[n.id]) for n in ast.walk(c))
               for c in condition)


def read(source, file):
    """(tree, names, given, marker) of a file's text (given: marker_names()). A byte order mark starts the file on disk; Python reads
    past it there, not in a string. marker: the marker a decorator or an expression stands for,
    through a name given to it too."""
    tree = ast.parse(source[1:] if source.startswith("\ufeff") else source, filename=file)
    names = imported_names(tree)
    given = marker_names(tree, names)

    def marker(node):
        name = dotted(node.func if isinstance(node, ast.Call) else node, names)
        return name if name in SKIPS else given.get(name)
    return tree, names, given, marker


def check(file, source, added, gaps, checks, entries, before=None):
    """The findings in one file: [{"file", "line", "gw", "what"}]; entries: the catalog entry of each
    check; before: the file's text at the start of the turn, or None."""
    tree, names, given, marker = read(source, file)
    source = source[1:] if source.startswith("\ufeff") else source
    findings = []

    def report(gw, line, text):
        findings.append({"file": file, "line": line, "gw": gw, "what": text})

    def added_in(node):
        return any(line in added for line in range(node.lineno, (node.end_lineno or node.lineno) + 1))

    at_start = []

    def was_outside(function):
        """The test was outside every suite that never runs at the start of the turn, under its name."""
        if before is None:
            return False
        if not at_start:
            at_start.append(start_names(before, file))
        outside, inside = at_start[0]
        return function.name in outside and function.name not in inside

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
        # A test new in a suite that never runs, or brought into one: moved there, or the suite moved
        # around it. A new marker of the suite is reported above, not again for each test in it.
        for function, start, suite in tests:
            if suite and not added_in(suite[1]) and (is_new(start, added, gaps) or was_outside(function)):
                effect = CI_EFFECT if suite[2] in CONDITIONAL else what(suite[2])
                report(entries["skips"], start, f"a test inside {suite[0]} - {effect}")

    if checks.get("assertions") is not False:
        for function, start, suite in tests:
            # A test in a suite skipped on CI still runs elsewhere: it is read for assertions.
            stopped = suite and suite[2] not in PASSES_WHEN_FAILING | CONDITIONAL
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


def start_names(before, file):
    """The names of the tests at the start of the turn outside every suite that never runs, and inside
    one: (outside, inside); both empty when Python cannot read that text."""
    try:
        tree, names, _, marker = read(before, file)
    except (SyntaxError, ValueError):
        return set(), set()
    outside, inside = set(), set()
    for function, _, suite in test_functions(tree, names, marker):
        (inside if suite else outside).add(function.name)
    return outside, inside


def is_new(start, added, gaps):
    """A test that is new here, or moved here: its first line added, and no line removed in its place
    (an edited or renamed test is a changed line, one removed and one added). The rest of it may match
    other lines."""
    return start in added and start not in gaps


def touched(function, start, added, gaps):
    """A line of the test added or changed, or a line removed inside it. A function ends at its last
    statement, so a line removed right after it may have been that statement: the gap before line
    end + 1 counts too."""
    end = function.end_lineno or function.lineno
    return any(line in added for line in range(start, end + 1)) or any(start < gap <= end + 1 for gap in gaps)


def test_functions(tree, names, marker):
    """(function, first line with its decorators, suite) for each test function in the module or its
    classes. suite is (what, node, marker) when a marker on its class, in the class's or the module's
    pytestmark, keeps every test in it from running as written whatever the environment (not a
    condition, CONDITIONAL, unless it reads CI); node is where that marker is written. pytest fixtures named test_* are
    not tests, nor methods of a class no runner collects."""
    def suite_mark(nodes):
        # Decorators, or pytestmark values and the items of their lists; not marks deeper inside, such
        # as pytest.param(..., marks=pytest.mark.skip) for one case of a parametrize. A condition counts
        # only when it reads CI (reads_ci).
        items = [item for node in nodes for item in (node.elts if isinstance(node, (ast.List, ast.Tuple)) else [node])]
        return next((n for n in items if marker(n) and (marker(n) not in CONDITIONAL or reads_ci(n, tree))), None)

    def described(kind, mark):
        return f"a {kind} marked {marker(mark)}{' on CI' if marker(mark) in CONDITIONAL else ''}", mark, marker(mark)

    def pytestmark(body):
        return [s.value for s in body if isinstance(s, ast.Assign)
                and any(isinstance(t, ast.Name) and t.id == "pytestmark" for t in s.targets)]

    module = suite_mark(pytestmark(tree.body))
    # A class no runner collects: not Test*, no base (unittest.TestCase), and no Test class of the
    # module inherits it (pytest collects test_* methods a Test class inherits).
    inherited = {base.id for node in ast.walk(tree) if isinstance(node, ast.ClassDef)
                 for base in node.bases if isinstance(base, ast.Name)}
    found = []
    bodies = [(tree.body, module and described("module", module))]
    while bodies:
        body, suite = bodies.pop()
        for node in body:
            if isinstance(node, ast.ClassDef):
                if not node.name.startswith("Test") and not node.bases and node.name not in inherited:
                    continue
                mark = suite_mark(node.decorator_list + pytestmark(node.body))
                bodies.append((node.body, suite or (mark and described("class", mark))))
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and TEST_NAME.match(node.name):
                if any(dotted(d.func if isinstance(d, ast.Call) else d, names) == "pytest.fixture" for d in node.decorator_list):
                    continue
                found.append((node, min([node.lineno] + [d.lineno for d in node.decorator_list]), suite))
    return found


def list_tests(file, source):
    """The tests of a file, as the checks see them: [{"name", "key", "body"}]. name and key: its classes
    and its own name (TestCart.test_total); body: its parameters, without the self or cls of a method, and
    its statements (ast.dump, without line numbers), the same wherever the test is indented and whether or
    not it is in a class. A definition that a later one of the same name in its module or class replaces
    is not a test: Python keeps only the later one."""
    tree, names, _, marker = read(source, file)
    qualified, methods = {}, set()
    bodies = [(tree.body, "", False)]
    while bodies:
        body, prefix, in_class = bodies.pop()
        last = {node.name: node for node in body if isinstance(node, (ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef))}
        for node in body:
            if last.get(getattr(node, "name", None)) is not node:
                continue
            if isinstance(node, ast.ClassDef):
                bodies.append((node.body, f"{prefix}{node.name}.", True))
            else:
                qualified[id(node)] = prefix + node.name
                if in_class:
                    methods.add(id(node))

    def body(function):
        args = function.args
        if id(function) in methods and (args.posonlyargs or args.args):
            args = copy.copy(args)
            args.posonlyargs, args.args = (args.posonlyargs[1:], args.args) if args.posonlyargs else ([], args.args[1:])
        return ast.dump(args) + "".join(ast.dump(s) for s in function.body)

    listed = [function for function, _, _ in test_functions(tree, names, marker) if id(function) in qualified]
    tests = [{"name": qualified[id(f)], "key": qualified[id(f)], "body": body(f)} for f in listed]
    # A class of the module also runs the tests it inherits from classes of the module (a set of tests run
    # once per backend by TestCase subclasses): listed under its name too, with the body they have there.
    inherited = {id(f) for f in listed}
    # The classes of the module, each name as Python keeps it (the last definition).
    classes = {node.name: node for node in tree.body if isinstance(node, ast.ClassDef)}

    def own(node):
        return {n.name: n for n in node.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))}

    def from_bases(node, seen):
        found = {}
        for base in node.bases:
            parent = classes.get(base.id) if isinstance(base, ast.Name) else None
            if parent is None or parent.name in seen:
                continue
            for name, method in {**from_bases(parent, seen | {parent.name}), **own(parent)}.items():
                found.setdefault(name, method)
        return found

    for node in classes.values():
        mine = own(node)
        for name, method in from_bases(node, {node.name}).items():
            if name not in mine and id(method) in inherited:
                tests.append({"name": f"{node.name}.{name}", "key": f"{node.name}.{name}", "body": body(method)})
    return tests


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
    """A value that is always true, written out: a constant, or a non-empty tuple, list, set or dict
    (assert (x == 6, "message") checks nothing)."""
    if isinstance(node, (ast.Tuple, ast.List, ast.Set)):
        return bool(node.elts)
    if isinstance(node, ast.Dict):
        return bool(node.keys)
    return isinstance(node, ast.Constant) and bool(node.value)


def main():
    request = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    findings, errors, tests = [], [], {}

    def unreadable(file, error):
        if all(e["file"] != file for e in errors):
            errors.append({"file": file, "error": f"Python could not read it ({type(error).__name__}: {error})"})
    for item in request["files"]:
        try:
            findings += check(item["file"], item["text"], set(item["added"]), set(item["gaps"]), item["checks"], request["entries"],
                              item.get("before"))
        except (SyntaxError, ValueError, tokenize.TokenError) as error:
            unreadable(item["file"], error)
    for item in request.get("list", []):
        try:
            tests[item["key"]] = list_tests(item["file"], item["text"])
        except (SyntaxError, ValueError) as error:
            if item["start"]:
                tests[item["key"]] = []
            else:
                unreadable(item["file"], error)
    sys.stdout.buffer.write(json.dumps({"findings": findings, "errors": errors, "tests": tests}).encode("utf-8"))


if __name__ == "__main__":
    main()
