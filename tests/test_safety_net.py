"""Tests for scripts/safety-net.

The comparison logic is tested directly; the whole script runs as a
subprocess against a local fake of the GitHub API (no network).
"""

import http.server
import importlib.machinery
import importlib.util
import json
import os
import subprocess
import sys
import threading
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(ROOT, "scripts", "safety-net")


def load_script():
    loader = importlib.machinery.SourceFileLoader("safety_net", SCRIPT)
    spec = importlib.util.spec_from_loader("safety_net", loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


safety_net = load_script()


def entry(name, status="modified", previous=None):
    data = {"filename": name, "status": status}
    if previous:
        data["previous_filename"] = previous
    return data


# Written out here, not taken from the script: a name dropped there must turn a test red.
GUARDED = [
    "CLAUDE.md", "scripts/leak-check", "tests/test_leak_check.py", "scripts/safety-net", "tests/test_safety_net.py",
    ".github/public-repos.txt", "ruff.toml", ".gitleaks.toml", ".gitleaksignore",
    ".github/workflows/ci.yml", ".github/workflows/safety-net.yml", ".github/workflows/new.yml",
]


class GuardedChangesTest(unittest.TestCase):
    def test_every_guarded_file_is_caught(self):
        for name in GUARDED:
            for status in ("modified", "added", "removed"):
                with self.subTest(name=name, status=status):
                    self.assertEqual(safety_net.guarded_changes([entry("README.md"), entry(name, status)]), [name])

    def test_rename_counts_old_and_new_name(self):
        self.assertEqual(
            safety_net.guarded_changes([entry("docs/old-ruff.toml", "renamed", previous="ruff.toml")]), ["ruff.toml"])
        self.assertEqual(
            safety_net.guarded_changes([entry(".gitleaks.toml", "renamed", previous="notes.toml")]), [".gitleaks.toml"])
        self.assertEqual(
            safety_net.guarded_changes([entry(".github/workflows/x.yml", "renamed", previous="CLAUDE.md")]),
            [".github/workflows/x.yml", "CLAUDE.md"])

    def test_unguarded_files_pass(self):
        files = [entry("README.md"), entry("scripts/other"), entry(".github/ISSUE_TEMPLATE/bug_report.md"),
                 entry("docs/CLAUDE.md"), entry("my-ruff.toml"), entry(".github/workflows-notes.md")]
        self.assertEqual(safety_net.guarded_changes(files), [])


class FakeGitHub(http.server.BaseHTTPRequestHandler):
    """Serves one pull request (#7 of o/r) from the class attributes."""

    files = []
    changed_files = None
    fail = False

    def do_GET(self):
        path, _, query = self.path.partition("?")
        params = dict(p.split("=", 1) for p in query.split("&") if p)
        if self.fail or not self.headers.get("Authorization", "").startswith("Bearer "):
            self.send_response(500)
            self.end_headers()
            return
        if path == "/repos/o/r/pulls/7":
            count = len(self.files) if self.changed_files is None else self.changed_files
            body = {"changed_files": count}
        elif path == "/repos/o/r/pulls/7/files":
            size, page = int(params["per_page"]), int(params["page"])
            body = self.files[(page - 1) * size:page * size]
        else:
            self.send_response(404)
            self.end_headers()
            return
        data = json.dumps(body).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):
        pass


class SafetyNetScriptTest(unittest.TestCase):
    def setUp(self):
        FakeGitHub.files, FakeGitHub.changed_files, FakeGitHub.fail = [], None, False
        self.server = http.server.HTTPServer(("127.0.0.1", 0), FakeGitHub)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)

    def run_script(self, **overrides):
        env = {
            "PATH": os.environ.get("PATH", ""),
            "PR_NUMBER": "7",
            "GITHUB_REPOSITORY": "o/r",
            "GITHUB_TOKEN": "fake-token",
            "GITHUB_API_URL": f"http://127.0.0.1:{self.server.server_port}",
        }
        env.update(overrides)
        env = {k: v for k, v in env.items() if v is not None}
        proc = subprocess.run([sys.executable, SCRIPT], env=env, capture_output=True, text=True)
        return proc.returncode, proc.stdout + proc.stderr

    def test_guarded_file_on_second_page_fails_and_only_guarded_names_are_printed(self):
        FakeGitHub.files = [entry(f"docs/page-{i}.md") for i in range(100)] + [
            entry("docs/extra.md"), entry("ruff.toml", "renamed", previous="CLAUDE.md")]
        code, out = self.run_script()
        self.assertEqual(code, 1, out)
        self.assertEqual(out.splitlines(), ["[failed] safety net - 2 guarded file(s) touched", "  CLAUDE.md", "  ruff.toml"])

    def test_no_guarded_file_passes(self):
        FakeGitHub.files = [entry("README.md"), entry("docs/a.md", "added")]
        code, out = self.run_script()
        self.assertEqual(code, 0, out)
        self.assertIn("[passed] safety net - 2 changed files, none guarded", out)

    def test_incomplete_file_list_did_not_run(self):
        FakeGitHub.files = [entry("README.md")]
        FakeGitHub.changed_files = 2
        code, out = self.run_script()
        self.assertEqual(code, 2, out)
        self.assertIn("[did not run] safety net - read 1 changed files, the pull request has 2", out)

    def test_api_error_did_not_run(self):
        FakeGitHub.fail = True
        code, out = self.run_script()
        self.assertEqual(code, 2, out)
        self.assertIn("[did not run] safety net - GitHub API request failed", out)

    def test_empty_or_malformed_file_list_did_not_run(self):
        for files in ([], [{"status": "modified"}]):
            with self.subTest(files=files):
                FakeGitHub.files = files
                code, out = self.run_script()
                self.assertEqual(code, 2, out)
                self.assertIn("[did not run] safety net", out)

    def test_missing_or_malformed_input_did_not_run(self):
        FakeGitHub.files = [entry("README.md")]
        for overrides in ({"GITHUB_TOKEN": None}, {"PR_NUMBER": "7; true"}, {"PR_NUMBER": None}):
            with self.subTest(overrides=overrides):
                code, out = self.run_script(**overrides)
                self.assertEqual(code, 2, out)
                self.assertIn("[did not run] safety net - PR_NUMBER, GITHUB_REPOSITORY or GITHUB_TOKEN", out)


if __name__ == "__main__":
    unittest.main()
