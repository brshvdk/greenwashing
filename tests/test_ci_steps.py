"""Tests for CI steps, run exactly as written in .github/workflows/.

Each test takes a step's run: block from the workflow file and runs it the way
GitHub Actions runs a step without a shell: key - `bash -e` (the CI logs show
"shell: /usr/bin/bash -e {0}"), so no pipefail - in a throwaway directory. A
step may only have the keys name, env and run, and the workflows may not use
keys that change how or whether a step runs (shell, if, continue-on-error,
working-directory, defaults). Needs python3, ruff, git and node on PATH, as in the
CI job that runs it.
"""

import os
import re
import shutil
import subprocess
import sys
import tempfile
import textwrap
import threading
import unittest
import http.server

from test_safety_net import FakeGitHub, entry

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WORKFLOWS = os.path.join(ROOT, ".github", "workflows")
GITHUB_BASH = ["bash", "--noprofile", "--norc", "-e"]
ALLOWED_STEP_KEYS = {"name", "env", "run"}
STEP_MODIFIERS = re.compile(r"^\s*(-\s+)?(shell|if|continue-on-error|working-directory|defaults):")

BAD_LINT = "import os\n"  # F401: unused import
PASSING_TEST = "import unittest\n\n\nclass T(unittest.TestCase):\n    def test_ok(self):\n        pass\n"
FAILING_TEST = "import unittest\n\n\nclass T(unittest.TestCase):\n    def test_fails(self):\n        self.fail('planted')\n"
# A package named like the standard library at the root: without -I, `python3 -m unittest`
# runs this instead of the real unittest and prints a fake success.
FAKE_UNITTEST = {
    "unittest/__init__.py": "",
    "unittest/__main__.py": "import sys\nprint('Ran 60 tests in 0.1s\\n\\nOK', file=sys.stderr)\n",
}


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def step_script(workflow, name):
    """The run: block of the named step; fails when the step has keys beyond name, env and run."""
    lines = read(os.path.join(WORKFLOWS, workflow)).splitlines()
    starts = [i for i, line in enumerate(lines) if line.strip() == f"- name: {name}"]
    if len(starts) != 1:
        raise AssertionError(f"{workflow} has {len(starts)} steps named {name!r}")
    dash = len(lines[starts[0]]) - len(lines[starts[0]].lstrip())
    keys, run, i = ["name"], None, starts[0] + 1
    while i < len(lines):
        line = lines[i]
        indent = len(line) - len(line.lstrip())
        if line.strip() and indent <= dash:
            break
        if indent == dash + 2 and line.strip() and not line.lstrip().startswith("#"):
            key, _, value = line.strip().partition(":")
            keys.append(key)
            if key == "run":
                if value.strip() != "|":
                    run = value.strip() + "\n"
                else:
                    body = []
                    while i + 1 < len(lines) and (not lines[i + 1].strip()
                                                  or len(lines[i + 1]) - len(lines[i + 1].lstrip()) > indent):
                        i += 1
                        body.append(lines[i])
                    run = textwrap.dedent("\n".join(body)) + "\n"
        i += 1
    extra = set(keys) - ALLOWED_STEP_KEYS
    if extra:
        raise AssertionError(f"step {name!r} in {workflow} has keys {sorted(extra)}")
    if run is None:
        raise AssertionError(f"step {name!r} in {workflow} has no run: block")
    return run


class WorkflowShapeTest(unittest.TestCase):
    def test_no_keys_that_change_how_or_whether_steps_run(self):
        for workflow in ("ci.yml", "safety-net.yml"):
            for number, line in enumerate(read(os.path.join(WORKFLOWS, workflow)).splitlines(), 1):
                with self.subTest(workflow=workflow, line=number):
                    self.assertIsNone(STEP_MODIFIERS.match(line), line)


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

    def run_step(self, workflow, name, cwd, **extra_env):
        runner_temp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, runner_temp)
        script = os.path.join(runner_temp, "step.sh")
        with open(script, "w", encoding="utf-8") as f:
            f.write(step_script(workflow, name))
        env = {k: v for k, v in os.environ.items() if not k.lower().endswith("_proxy")}
        env.update(RUNNER_TEMP=runner_temp, GITHUB_PATH=os.path.join(runner_temp, "github_path"), **extra_env)
        proc = subprocess.run([*GITHUB_BASH, script], cwd=cwd, env=env, capture_output=True, text=True)
        self.runner_temp = runner_temp
        return proc.returncode, proc.stdout + proc.stderr


class UnitTestsStepTest(StepCase):
    def run_tests_step(self, files):
        return self.run_step("ci.yml", "Unit tests", self.make_dir(files))

    def test_passing_suite_passes(self):
        code, out = self.run_tests_step({"tests/test_ok.py": PASSING_TEST})
        self.assertEqual(code, 0, out)

    def test_failing_test_fails(self):
        code, out = self.run_tests_step({"tests/test_fails.py": FAILING_TEST})
        self.assertNotEqual(code, 0, out)
        self.assertIn("FAILED (failures=1)", out)

    def test_root_package_named_unittest_cannot_fake_a_pass(self):
        path = self.make_dir({**FAKE_UNITTEST, "tests/test_fails.py": FAILING_TEST})
        # Control: the plain command is fooled in this directory.
        plain = subprocess.run(["python3", "-m", "unittest", "discover", "-s", "tests", "-v"], cwd=path,
                               capture_output=True, text=True)
        self.assertEqual(plain.returncode, 0, plain.stderr)
        self.assertIn("Ran 60 tests", plain.stderr)
        code, out = self.run_step("ci.yml", "Unit tests", path)
        self.assertNotEqual(code, 0, out)
        self.assertIn("test_fails", out)

    def test_zero_tests_fail(self):
        code, out = self.run_tests_step({"tests/helpers.py": "VALUE = 1\n"})
        self.assertNotEqual(code, 0, out)
        self.assertIn("unit tests did not run: 0 tests ran", out)

    def test_run_without_a_summary_line_fails(self):
        # A module that ends the process during discovery: exit 0 and no "Ran N tests" line.
        code, out = self.run_tests_step({"tests/test_exit.py": "import os\nos._exit(0)\n"})
        self.assertNotEqual(code, 0, out)
        self.assertIn("unit tests did not run: no tests ran", out)


NODE_PASSING = "const test = require('node:test');\ntest('ok', () => {});\n"
NODE_FAILING = "const test = require('node:test');\nconst assert = require('node:assert');\ntest('fails', () => assert.fail('planted'));\n"


class GateTestsStepTest(StepCase):
    def run_gate_step(self, files):
        return self.run_step("ci.yml", "Gate tests", self.make_dir(files))

    def test_passing_suite_passes_and_prints_the_node_version(self):
        code, out = self.run_gate_step({"gate/test/ok.test.js": NODE_PASSING})
        self.assertEqual(code, 0, out)
        self.assertRegex(out.splitlines()[0], r"^v\d+\.\d+\.\d+$")
        self.assertIn("# pass 1", out)

    def test_failing_test_fails(self):
        code, out = self.run_gate_step({"gate/test/ok.test.js": NODE_PASSING, "gate/test/bad.test.js": NODE_FAILING})
        self.assertNotEqual(code, 0, out)
        self.assertIn("# fail 1", out)

    def test_no_test_files_fail(self):
        # Node 22 reads the unmatched glob itself: "# tests 0" and exit 0; Node 20: "Could not find".
        code, out = self.run_gate_step({"gate/lib/x.js": "module.exports = 1;\n"})
        self.assertNotEqual(code, 0, out)
        self.assertRegex(out, r"gate tests did not run: (0|no) tests ran")

    def test_run_without_a_summary_line_fails(self):
        # A test file that kills the runner: no "# tests N" line.
        code, out = self.run_gate_step({"gate/test/kill.test.js": "process.kill(process.ppid, 'SIGKILL');\n"})
        self.assertNotEqual(code, 0, out)
        self.assertIn("gate tests did not run: no tests ran", out)


class ToolsVenvStepTest(StepCase):
    def test_planted_venv_module_does_not_build_the_tools_environment(self):
        marker = os.path.join(tempfile.mkdtemp(), "planted-ran")
        self.addCleanup(shutil.rmtree, os.path.dirname(marker))
        planted = f"open({marker!r}, 'w').close()\n"
        path = self.make_dir({"venv.py": planted, "venv/__init__.py": planted, "venv/__main__.py": planted})
        code, out = self.run_step("ci.yml", "Create a virtual environment for tools", path)
        self.assertEqual(code, 0, out)
        self.assertFalse(os.path.exists(marker), "the planted venv module ran")
        self.assertTrue(os.path.exists(os.path.join(self.runner_temp, "venv", "pyvenv.cfg")), out)
        self.assertEqual(read(os.path.join(self.runner_temp, "github_path")).strip(),
                         os.path.join(self.runner_temp, "venv", "bin"))


class LintStepTest(StepCase):
    def make_repo(self, files):
        path = self.make_dir({"ruff.toml": read(os.path.join(ROOT, "ruff.toml")), **files})
        subprocess.run(["git", "init", "-q"], cwd=path, check=True)
        return path

    def test_reports_every_violation_in_scripts_and_tests(self):
        path = self.make_repo({"scripts/leak-check": BAD_LINT,
                               "tests/test_x.py": "import os\nx = None\nif x == None:\n    pass\n"})
        code, out = self.run_step("ci.yml", "Lint", path)
        self.assertNotEqual(code, 0, out)
        for expected in ("scripts/leak-check:1:8", "tests/test_x.py:1:8", "tests/test_x.py:3:9", "E711", "Found 3 errors."):
            self.assertIn(expected, out)

    def assert_hidden_file_is_linted(self, files):
        path = self.make_repo(files)
        # Control: plain ruff respects the ignore file and passes.
        plain = subprocess.run(["ruff", "check", "--no-cache", "."], cwd=path, capture_output=True, text=True)
        self.assertEqual(plain.returncode, 0, plain.stdout + plain.stderr)
        code, out = self.run_step("ci.yml", "Lint", path)
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
        code, out = self.run_step("ci.yml", "Lint", path)
        self.assertEqual(code, 0, out)
        self.assertIn("All checks passed!", out)


class SafetyNetStepTest(StepCase):
    def test_module_next_to_the_script_cannot_fake_a_pass(self):
        FakeGitHub.files, FakeGitHub.changed_files, FakeGitHub.fail = [entry("CLAUDE.md")], None, False
        server = http.server.HTTPServer(("127.0.0.1", 0), FakeGitHub)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        path = self.make_dir({"scripts/json.py": "import sys\nprint('[passed] safety net - fake')\nsys.exit(0)\n"})
        shutil.copy(os.path.join(ROOT, "scripts", "safety-net"), os.path.join(path, "scripts"))  # keeps the exec bit
        env = dict(PR_NUMBER="7", GITHUB_REPOSITORY="o/r", GITHUB_TOKEN="fake-token",
                   GITHUB_API_URL=f"http://127.0.0.1:{server.server_port}")
        # Control: without -I the planted json module takes over.
        plain = subprocess.run([sys.executable, "scripts/safety-net"], cwd=path, capture_output=True, text=True,
                               env=dict(PATH=os.environ.get("PATH", ""), **env))
        self.assertIn("fake", plain.stdout)
        code, out = self.run_step("safety-net.yml", "Fail when a guarded file is touched", path, **env)
        self.assertEqual(code, 1, out)
        self.assertIn("[failed] safety net - 1 guarded file(s) touched", out)
        self.assertNotIn("fake", out)


if __name__ == "__main__":
    unittest.main()
