"""Tests for the Lint and Unit tests steps of .github/workflows/ci.yml.

Each test takes a step's run: block exactly as written in ci.yml and runs it
the way GitHub Actions does (bash -eo pipefail) in a throwaway directory, so
a change to the step itself turns a test red. Needs python3, ruff and git on
PATH, as in the CI job that runs it.
"""

import os
import shutil
import subprocess
import tempfile
import textwrap
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CI = os.path.join(ROOT, ".github", "workflows", "ci.yml")

BAD_LINT = "import os\n"  # F401: unused import
PASSING_TEST = "import unittest\n\n\nclass T(unittest.TestCase):\n    def test_ok(self):\n        pass\n"
FAILING_TEST = "import unittest\n\n\nclass T(unittest.TestCase):\n    def test_fails(self):\n        self.fail('planted')\n"
# A package named like the standard library at the root: without -I, `python3 -m unittest`
# runs this instead of the real unittest and prints a fake success.
FAKE_UNITTEST = {
    "unittest/__init__.py": "",
    "unittest/__main__.py": "import sys\nprint('Ran 60 tests in 0.1s\\n\\nOK', file=sys.stderr)\n",
}


def step_script(name):
    """The run: block of the step with this name in ci.yml."""
    lines = open(CI, encoding="utf-8").read().splitlines()
    starts = [i for i, line in enumerate(lines) if line.strip() == f"- name: {name}"]
    if len(starts) != 1:
        raise AssertionError(f"ci.yml has {len(starts)} steps named {name!r}")
    for i in range(starts[0] + 1, len(lines)):
        stripped = lines[i].strip()
        if stripped.startswith("- name:"):
            break
        if stripped.startswith("run:"):
            value = stripped[len("run:"):].strip()
            if value != "|":
                return value + "\n"
            indent = len(lines[i]) - len(lines[i].lstrip())
            body = []
            for line in lines[i + 1:]:
                if line.strip() and len(line) - len(line.lstrip()) <= indent:
                    break
                body.append(line)
            return textwrap.dedent("\n".join(body)) + "\n"
    raise AssertionError(f"step {name!r} has no run: block")


class StepCase(unittest.TestCase):
    def make_dir(self, files):
        path = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, path)
        for name, text in files.items():
            full = os.path.join(path, name)
            os.makedirs(os.path.dirname(full), exist_ok=True)
            with open(full, "w", encoding="utf-8") as f:
                f.write(text)
        return path

    def run_step(self, name, cwd):
        runner_temp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, runner_temp)
        script = os.path.join(runner_temp, "step.sh")
        with open(script, "w", encoding="utf-8") as f:
            f.write(step_script(name))
        env = dict(os.environ, RUNNER_TEMP=runner_temp)
        proc = subprocess.run(["bash", "--noprofile", "--norc", "-eo", "pipefail", script], cwd=cwd, env=env,
                              capture_output=True, text=True)
        return proc.returncode, proc.stdout + proc.stderr


class UnitTestsStepTest(StepCase):
    def test_passing_suite_passes(self):
        code, out = self.run_step("Unit tests", self.make_dir({"tests/test_ok.py": PASSING_TEST}))
        self.assertEqual(code, 0, out)

    def test_failing_test_fails(self):
        code, out = self.run_step("Unit tests", self.make_dir({"tests/test_fails.py": FAILING_TEST}))
        self.assertNotEqual(code, 0, out)

    def test_root_package_named_unittest_cannot_fake_a_pass(self):
        path = self.make_dir({**FAKE_UNITTEST, "tests/test_fails.py": FAILING_TEST})
        # Control: the plain command is fooled in this directory.
        plain = subprocess.run(["python3", "-m", "unittest", "discover", "-s", "tests", "-v"], cwd=path,
                               capture_output=True, text=True)
        self.assertEqual(plain.returncode, 0, plain.stderr)
        self.assertIn("Ran 60 tests", plain.stderr)
        code, out = self.run_step("Unit tests", path)
        self.assertNotEqual(code, 0, out)
        self.assertIn("test_fails", out)

    def test_zero_tests_fail(self):
        code, out = self.run_step("Unit tests", self.make_dir({"tests/helpers.py": "VALUE = 1\n"}))
        self.assertNotEqual(code, 0, out)
        self.assertIn("unit tests did not run: 0 tests ran", out)

    def test_run_without_a_summary_line_fails(self):
        # A module that ends the process during discovery: exit 0 and no "Ran N tests" line.
        code, out = self.run_step("Unit tests", self.make_dir({"tests/test_exit.py": "import os\nos._exit(0)\n"}))
        self.assertNotEqual(code, 0, out)
        self.assertIn("unit tests did not run: no tests ran", out)


class LintStepTest(StepCase):
    def make_repo(self, files):
        path = self.make_dir({"ruff.toml": open(os.path.join(ROOT, "ruff.toml"), encoding="utf-8").read(), **files})
        subprocess.run(["git", "init", "-q"], cwd=path, check=True)
        return path

    def assert_hidden_file_is_linted(self, files):
        path = self.make_repo(files)
        # Control: plain ruff respects the ignore file and passes.
        plain = subprocess.run(["ruff", "check", "--no-cache", "."], cwd=path, capture_output=True, text=True)
        self.assertEqual(plain.returncode, 0, plain.stdout + plain.stderr)
        code, out = self.run_step("Lint", path)
        self.assertNotEqual(code, 0, out)
        self.assertIn("F401", out)

    def test_file_hidden_by_nested_gitignore_is_linted(self):
        self.assert_hidden_file_is_linted({"a/bad.py": BAD_LINT, "a/.gitignore": "bad.py\n"})

    def test_file_hidden_by_nested_ignore_file_is_linted(self):
        self.assert_hidden_file_is_linted({"b/bad.py": BAD_LINT, "b/.ignore": "bad.py\n"})

    def test_default_excludes_still_apply(self):
        path = self.make_repo({"ok.py": "VALUE = 1\n", ".venv/bad.py": BAD_LINT, "venv/bad.py": BAD_LINT})
        with open(os.path.join(path, ".git", "bad.py"), "w", encoding="utf-8") as f:
            f.write(BAD_LINT)
        code, out = self.run_step("Lint", path)
        self.assertEqual(code, 0, out)
        self.assertIn("All checks passed!", out)


if __name__ == "__main__":
    unittest.main()
