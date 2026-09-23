"""Tests for scripts/leak-check.

Every test builds a throwaway git repository and runs the script as a
subprocess under a hostile locale (C locale, Python UTF-8 mode off), with
made-up patterns only. gitleaks is replaced by a stub that reports every
non-merge commit of --log-opts as scanned (every test commit adds content,
which is what gitleaks 8.28.0 counts) and writes a chosen report; the real
gitleaks runs in CI on this repository.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SCRIPT = os.path.join(ROOT, "scripts", "leak-check")
OWNER = "brshvdk"
# Built at runtime, so this file holds no literal reference for the
# repository's own leak check to flag.
REF = OWNER + "/"

LATIN_PATTERN = "(?i)quokka-lantern-417"
LATIN_WORD = "Quokka-LANTERN-417"
CYRILLIC_PATTERN = "(?i)ФИОЛЕТОВЫЙЁЖИК"
CYRILLIC_WORD = "фиолетовыйёжик"
# Same UTF-8 byte length as CYRILLIC_WORD: a decoder that is not UTF-8 turns
# both words into the same replacement characters, so this must stay clean.
CYRILLIC_OTHER = "оранжевыйкотик"
FILLER_PATTERN = "(?i)unused-marmot-58"
SECRETS = (LATIN_WORD, LATIN_PATTERN, CYRILLIC_WORD, CYRILLIC_PATTERN, "zz-unlisted-repo")

HOSTILE_LOCALE = {"LC_ALL": "C", "LANG": "C", "PYTHONUTF8": "0", "PYTHONCOERCECLOCALE": "0"}
GIT_ISOLATION = {"GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}
IDENTITY = {
    "GIT_AUTHOR_NAME": "Test Author",
    "GIT_AUTHOR_EMAIL": "author@example.test",
    "GIT_COMMITTER_NAME": "Test Committer",
    "GIT_COMMITTER_EMAIL": "committer@example.test",
}

GITLEAKS_STUB = """#!{python}
import json, os, subprocess, sys
args = sys.argv[1:]
with open(os.environ["STUB_ARGS_FILE"], "w") as f:
    json.dump(args, f)
revs = [a.split("=", 1)[1] for a in args if a.startswith("--log-opts=")][0].split()
counted = subprocess.run(["git", "rev-list", "--count", "--no-merges", *revs, "--"], capture_output=True, text=True)
print(os.environ.get("STUB_EXTRA_LOG", ""), file=sys.stderr)
scanned = os.environ.get("STUB_SCANNED", counted.stdout.strip())
if scanned != "no count line":
    print("1:00AM INF " + scanned + " commits scanned.", file=sys.stderr)
leaks = json.loads(os.environ["STUB_LEAKS"])
with open(args[args.index("--report-path") + 1], "w") as f:
    json.dump(leaks, f)
sys.exit(int(args[args.index("--exit-code") + 1]) if leaks else 0)
"""


def report(out):
    """Map part name -> (status, finding lines) parsed from the script output."""
    parts, current = {}, None
    for line in out.splitlines():
        match = re.match(r"\[(passed|failed|did not run)\] (.+?) - ", line)
        if match:
            current = match.group(2)
            parts[current] = (match.group(1), [])
        elif current and line.startswith("  ") and not line.startswith("  ("):
            parts[current][1].append(line)
    return parts


class Repo:
    """A throwaway git repository with one base commit on main."""

    def __init__(self, test):
        self.tmp = tempfile.mkdtemp()
        test.addCleanup(shutil.rmtree, self.tmp)
        self.path = os.path.join(self.tmp, "repo")
        self.bin = os.path.join(self.tmp, "bin")
        os.mkdir(self.path)
        os.mkdir(self.bin)
        os.symlink(shutil.which("git"), os.path.join(self.bin, "git"))
        self.git("init", "-q")
        self.git("symbolic-ref", "HEAD", "refs/heads/main")
        self.base = self.commit({"README.md": "clean readme\n"}, "chore: base")

    def git(self, *args, **identity):
        env = dict(os.environ, **GIT_ISOLATION, **IDENTITY)
        env.update(identity)
        proc = subprocess.run(["git", *args], cwd=self.path, env=env, check=True, capture_output=True)
        return proc.stdout.decode("utf-8").strip()

    def commit(self, files, message="feat: change", **identity):
        for name, text in files.items():
            full = os.path.join(self.path, name)
            os.makedirs(os.path.dirname(full), exist_ok=True)
            with open(full, "w", encoding="utf-8") as f:
                f.write(text)
            self.git("add", "--", name)
        self.git("commit", "-q", "--allow-empty", "-m", message, **identity)
        return self.git("rev-parse", "HEAD")

    def run(self, *args, patterns=None, pr=True, gitleaks=True, leaks=(), scanned=None, gitleaks_log=None, extra=None,
            cwd=None):
        """Run the script; return (exit code, output). extra values of None remove a variable."""
        stub = os.path.join(self.bin, "gitleaks")
        if gitleaks:
            with open(stub, "w", encoding="utf-8") as f:
                f.write(GITLEAKS_STUB.format(python=sys.executable))
            os.chmod(stub, 0o755)
        elif os.path.exists(stub):
            os.remove(stub)
        env = dict(PATH=self.bin, HOME=self.tmp, **HOSTILE_LOCALE, **GIT_ISOLATION)
        env["STUB_ARGS_FILE"] = os.path.join(self.tmp, "stub-args.json")
        env["STUB_LEAKS"] = json.dumps(list(leaks))
        if scanned is not None:
            env["STUB_SCANNED"] = scanned
        if gitleaks_log is not None:
            env["STUB_EXTRA_LOG"] = gitleaks_log
        if pr:
            env.update(
                GITHUB_EVENT_NAME="pull_request",
                BASE_SHA=self.base,
                HEAD_SHA=self.git("rev-parse", "HEAD"),
                PR_TITLE="feat: change",
                PR_BODY="Adds a change.",
            )
        if patterns is not None:
            env["LEAK_PATTERNS"] = patterns
        for key, value in (extra or {}).items():
            if value is None:
                env.pop(key, None)
            else:
                env[key] = value
        proc = subprocess.run(
            [sys.executable, SCRIPT, *args],
            cwd=cwd or self.path,
            env={k.encode("utf-8"): v.encode("utf-8") for k, v in env.items()},
            capture_output=True,
        )
        return proc.returncode, (proc.stdout + proc.stderr).decode("utf-8", errors="replace")

    def stub_args(self):
        with open(os.path.join(self.tmp, "stub-args.json"), encoding="utf-8") as f:
            return json.load(f)


class LeakCheckCase(unittest.TestCase):
    """Shared helpers: a fresh repository per test and result assertions."""

    def setUp(self):
        self.repo = Repo(self)

    def assert_result(self, result, code, **statuses):
        exit_code, out = result
        self.assertEqual(exit_code, code, out)
        parts = report(out)
        for part, status in statuses.items():
            self.assertEqual(parts.get(part.replace("_", " "), (None,))[0], status, out)
        return parts

    def assert_no_echo(self, out):
        # Any 5-character piece counts: a partly masked match still leaks it.
        for text in SECRETS:
            for i in range(len(text) - 4):
                self.assertNotIn(text[i:i + 5].lower(), out.lower(), out)


class LeakCheckTest(LeakCheckCase):

    # --- harness control ---

    def test_harness_locale_is_not_utf8(self):
        env = dict(PATH=self.repo.bin, **HOSTILE_LOCALE)
        probe = subprocess.run(
            [sys.executable, "-c", "import locale, sys; print(locale.getpreferredencoding(False), sys.flags.utf8_mode)"],
            env=env, capture_output=True, text=True, check=True,
        )
        encoding, utf8_mode = probe.stdout.split()
        self.assertNotIn("utf", encoding.lower())
        self.assertEqual(utf8_mode, "0")

    # --- patterns ---

    def test_latin_pattern_in_file_fails(self):
        self.repo.commit({"notes.txt": f"first line\nthe {LATIN_WORD} is here\n"})
        result = self.repo.run(patterns=f"{FILLER_PATTERN}\n{LATIN_PATTERN}")
        parts = self.assert_result(result, 1, patterns="failed")
        self.assertIn("  file notes.txt line 2 pattern #2", parts["patterns"][1])
        self.assert_no_echo(result[1])

    def test_cyrillic_pattern_in_file_fails(self):
        self.repo.commit({"заметки.txt": f"первая строка\nтут {CYRILLIC_WORD} живёт\n"})
        result = self.repo.run(patterns=CYRILLIC_PATTERN)
        parts = self.assert_result(result, 1, patterns="failed")
        self.assertIn("  file заметки.txt line 2 pattern #1", parts["patterns"][1])
        self.assert_no_echo(result[1])

    def test_cyrillic_pattern_ignores_other_cyrillic_text(self):
        self.repo.commit({"заметки.txt": f"тут {CYRILLIC_OTHER} живёт\n"})
        self.assert_result(self.repo.run(patterns=CYRILLIC_PATTERN), 0, patterns="passed")

    def test_match_only_in_commit_message_fails(self):
        sha = self.repo.commit({"clean.txt": "nothing here\n"}, f"feat: add a file\n\nMentions {LATIN_WORD}.")
        result = self.repo.run(patterns=LATIN_PATTERN)
        parts = self.assert_result(result, 1, patterns="failed")
        self.assertEqual(parts["patterns"][1], [f"  commit {sha[:12]} message line 3 pattern #1"])
        self.assert_no_echo(result[1])

    def test_match_only_in_author_email_fails(self):
        sha = self.repo.commit({"clean.txt": "nothing here\n"}, GIT_AUTHOR_EMAIL=f"{LATIN_WORD.lower()}@example.test")
        result = self.repo.run(patterns=LATIN_PATTERN)
        parts = self.assert_result(result, 1, patterns="failed")
        self.assertEqual(parts["patterns"][1], [f"  commit {sha[:12]} author email pattern #1"])
        self.assert_no_echo(result[1])

    def test_match_only_in_other_identity_fields_fails(self):
        cases = [
            ("author name", "GIT_AUTHOR_NAME", f"Dr {LATIN_WORD}"),
            ("committer name", "GIT_COMMITTER_NAME", f"{LATIN_WORD} Bot"),
            ("committer email", "GIT_COMMITTER_EMAIL", f"{LATIN_WORD.lower()}@example.test"),
        ]
        for field, variable, value in cases:
            with self.subTest(field=field):
                repo = Repo(self)
                sha = repo.commit({"clean.txt": "nothing here\n"}, **{variable: value})
                result = repo.run(patterns=LATIN_PATTERN)
                parts = self.assert_result(result, 1, patterns="failed")
                self.assertEqual(parts["patterns"][1], [f"  commit {sha[:12]} {field} pattern #1"])
                self.assert_no_echo(result[1])

    def test_match_only_in_pr_body_fails(self):
        self.repo.commit({"clean.txt": "nothing here\n"})
        result = self.repo.run(patterns=LATIN_PATTERN, extra={"PR_BODY": f"Summary\n\nSee {LATIN_WORD}."})
        parts = self.assert_result(result, 1, patterns="failed")
        self.assertEqual(parts["patterns"][1], ["  PR body line 3 pattern #1"])
        self.assert_no_echo(result[1])

    def test_match_only_in_pr_title_fails(self):
        self.repo.commit({"clean.txt": "nothing here\n"})
        result = self.repo.run(patterns=LATIN_PATTERN, extra={"PR_TITLE": f"feat: {LATIN_WORD}"})
        parts = self.assert_result(result, 1, patterns="failed")
        self.assertEqual(parts["patterns"][1], ["  PR title pattern #1"])

    def test_match_only_in_an_earlier_pr_commit_patch_fails(self):
        added = self.repo.commit({"notes.txt": f"{LATIN_WORD}\n"})
        removed = self.repo.commit({"notes.txt": "cleaned up\n"})
        result = self.repo.run(patterns=LATIN_PATTERN)
        parts = self.assert_result(result, 1, patterns="failed")
        where = sorted(line.split(" line ")[0] for line in parts["patterns"][1])
        self.assertEqual(where, sorted([f"  commit {added[:12]} patch", f"  commit {removed[:12]} patch"]))
        self.assert_no_echo(result[1])

    def test_clean_run_passes(self):
        self.repo.commit({"notes.txt": "nothing to see\n"})
        result = self.repo.run(patterns=f"{FILLER_PATTERN}\n{LATIN_PATTERN}\n{CYRILLIC_PATTERN}")
        self.assert_result(result, 0, gitleaks="passed", repo_references="passed", patterns="passed")

    def test_patterns_not_set_did_not_run(self):
        self.repo.commit({"notes.txt": "nothing to see\n"})
        for patterns in (None, "", " \n\n"):
            with self.subTest(patterns=patterns):
                result = self.repo.run(patterns=patterns)
                self.assert_result(result, 2, gitleaks="passed", repo_references="passed", patterns="did not run")
                self.assertIn("[did not run] patterns - patterns not set", result[1].splitlines())

    def test_invalid_pattern_did_not_run(self):
        self.repo.commit({"notes.txt": "nothing to see\n"})
        result = self.repo.run(patterns=f"{LATIN_PATTERN}\n(?i)broken(")
        self.assert_result(result, 2, patterns="did not run")
        self.assertIn("pattern #2", result[1])

    def test_pr_range_skips_older_commits_all_history_finds_them(self):
        self.repo.commit({"old.txt": "old\n"}, f"chore: {LATIN_WORD} before base")
        self.repo.base = self.repo.commit({"base.txt": "new base\n"}, "chore: new base")
        self.repo.git("checkout", "-q", "-b", "side")
        side = self.repo.commit({"side.txt": "side\n"}, f"chore: {LATIN_WORD} on a side branch")
        self.repo.git("checkout", "-q", "main")
        self.repo.commit({"pr.txt": "pr change\n"})
        self.assert_result(self.repo.run(patterns=LATIN_PATTERN), 0, patterns="passed")
        result = self.repo.run("--all-history", patterns=LATIN_PATTERN, pr=False)
        parts = self.assert_result(result, 1, patterns="failed")
        self.assertIn(f"  commit {side[:12]} message line 1 pattern #1", parts["patterns"][1])
        self.assertEqual(len(parts["patterns"][1]), 2, result[1])
        self.assertIn("--log-opts=--all", self.repo.stub_args())

    # --- references to other repositories ---

    def test_reference_to_unlisted_repository_fails(self):
        self.repo.commit({"links.md": (
            f"intro\nsee https://github.com/{REF}zz-unlisted-repo/issues\n"
            f"and {OWNER.upper()}/ZZ-Unlisted-Repo\n"
        )})
        result = self.repo.run(patterns=LATIN_PATTERN)
        parts = self.assert_result(result, 1, repo_references="failed", patterns="passed")
        self.assertIn("  file links.md line 2", parts["repo references"][1])
        self.assertIn("  file links.md line 3", parts["repo references"][1])
        self.assert_no_echo(result[1])

    def test_references_to_listed_and_current_repository_pass(self):
        self.repo.commit({
            ".github/public-repos.txt": "# one name per line\nzz-listed-repo\n",
            "links.md": (
                f"https://github.com/{REF}ZZ-Listed-Repo.git\n"
                f"{REF}greenwashing\n"
                f"{OWNER.upper()}/GreenWashing/blob/main/README.md\n"
            ),
        })
        self.assert_result(self.repo.run(patterns=LATIN_PATTERN), 0, repo_references="passed")

    # --- output hygiene ---

    def test_red_run_never_prints_matched_text_or_pattern(self):
        name = f"{LATIN_WORD}.txt"
        head = self.repo.commit(
            {name: f"{CYRILLIC_WORD}\n", "links.md": f"{REF}zz-unlisted-repo\n"},
            f"feat: {LATIN_WORD}",
            GIT_AUTHOR_NAME=CYRILLIC_WORD,
            GIT_AUTHOR_EMAIL=f"{LATIN_WORD.lower()}@example.test",
        )
        leak = {"Commit": head, "File": name, "StartLine": 1, "RuleID": LATIN_WORD}
        result = self.repo.run(
            patterns=f"{LATIN_PATTERN}\n{CYRILLIC_PATTERN}",
            extra={"PR_TITLE": LATIN_WORD, "PR_BODY": CYRILLIC_WORD},
            leaks=[leak],
        )
        parts = self.assert_result(result, 1, gitleaks="failed", repo_references="failed", patterns="failed")
        self.assert_no_echo(result[1])
        self.assertIn("  path of tracked file #1 (name hidden: it matches a check) pattern #1", parts["patterns"][1])
        self.assertIn("  tracked file #1 (name hidden: it matches a check) line 1 pattern #2", parts["patterns"][1])
        self.assertIn(
            f"  commit {head[:12]} a file (name hidden: it matches a check) line 1 rule (hidden)", parts["gitleaks"][1]
        )

    # --- gitleaks ---

    def test_gitleaks_missing_did_not_run(self):
        self.repo.commit({"notes.txt": "nothing to see\n"})
        result = self.repo.run(patterns=LATIN_PATTERN, gitleaks=False)
        self.assert_result(result, 2, gitleaks="did not run", repo_references="passed", patterns="passed")
        self.assertIn("[did not run] gitleaks - gitleaks not installed", result[1].splitlines())

    def test_gitleaks_finding_fails_and_scans_pr_range(self):
        head = self.repo.commit({"config.ini": "nothing to see\n"})
        leak = {"Commit": head, "File": "config.ini", "StartLine": 3, "RuleID": "generic-api-key"}
        result = self.repo.run(patterns=LATIN_PATTERN, leaks=[leak])
        parts = self.assert_result(result, 1, gitleaks="failed")
        self.assertEqual(parts["gitleaks"][1], [f"  commit {head[:12]} file config.ini line 3 rule generic-api-key"])
        args = self.repo.stub_args()
        self.assertIn(f"--log-opts={self.repo.base}..{head}", args)
        self.assertIn("--redact", args)

    def test_gitleaks_scanning_zero_too_many_or_unknown_commits_did_not_run(self):
        # gitleaks 8.28.0 on a bad revision logs "0 commits scanned", "no leaks found" and exits 0.
        self.repo.commit({"notes.txt": "nothing to see\n"})
        for scanned in ("0", "2", "no count line"):
            with self.subTest(scanned=scanned):
                result = self.repo.run(patterns=LATIN_PATTERN, scanned=scanned)
                self.assert_result(result, 2, gitleaks="did not run", patterns="passed")

    def test_gitleaks_logging_an_error_did_not_run(self):
        # Seen live with gitleaks 8.28.0: "ERR [git] fatal: ..." and exit 0.
        self.repo.commit({"notes.txt": "nothing to see\n"})
        result = self.repo.run(patterns=LATIN_PATTERN, gitleaks_log="1:00AM ERR [git] fatal: bad revision")
        self.assert_result(result, 2, gitleaks="did not run", patterns="passed")

    # --- incomplete input ---

    def test_pull_request_without_pr_body_did_not_run(self):
        self.repo.commit({"notes.txt": "nothing to see\n"})
        result = self.repo.run(patterns=LATIN_PATTERN, extra={"PR_BODY": None})
        self.assert_result(result, 2, repo_references="did not run", patterns="did not run")

    def test_outside_a_git_repository_did_not_run(self):
        elsewhere = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, elsewhere)
        exit_code, out = self.repo.run(patterns=LATIN_PATTERN, pr=False, cwd=elsewhere)
        self.assertEqual(exit_code, 2, out)
        self.assertIn("did not run", out)


class ReviewFindingsTest(LeakCheckCase):
    """Cases found by the fresh-context review of this branch."""

    def test_binary_content_removed_later_in_the_pr_fails(self):
        self.repo.commit({"blob.dat": f"\x00\x01{LATIN_WORD}\x00\n"})
        self.repo.commit({"blob.dat": "\x00\x01clean\x00\n"})
        result = self.repo.run(patterns=LATIN_PATTERN)
        parts = self.assert_result(result, 1, patterns="failed")
        self.assertTrue(any(" patch line " in line for line in parts["patterns"][1]), result[1])
        self.assert_no_echo(result[1])

    def test_merge_commit_message_fails(self):
        self.repo.git("checkout", "-q", "-b", "side")
        self.repo.commit({"side.txt": "side\n"})
        self.repo.git("checkout", "-q", "main")
        self.repo.commit({"main.txt": "main\n"})
        self.repo.git("merge", "-q", "--no-ff", "-m", f"Merge side: {LATIN_WORD}", "side")
        merge = self.repo.git("rev-parse", "HEAD")
        result = self.repo.run(patterns=LATIN_PATTERN)
        parts = self.assert_result(result, 1, patterns="failed")
        self.assertEqual(parts["patterns"][1], [f"  commit {merge[:12]} message line 1 pattern #1"])

    def test_shallow_clone_did_not_run(self):
        self.repo.commit({"notes.txt": "nothing to see\n"})
        clone = os.path.join(self.repo.tmp, "clone")
        subprocess.run(["git", "clone", "-q", "--depth", "1", "file://" + self.repo.path, clone],
                       check=True, capture_output=True, env=dict(os.environ, **GIT_ISOLATION))
        for args in ([], ["--all-history"]):
            with self.subTest(args=args):
                result = self.repo.run(*args, patterns=LATIN_PATTERN, pr=False, cwd=clone)
                self.assert_result(result, 2, gitleaks="did not run", repo_references="did not run",
                                   patterns="did not run")

    def test_malformed_gitleaks_report_did_not_run(self):
        head = self.repo.commit({"notes.txt": "nothing to see\n"})
        exit_code, out = self.repo.run(patterns=LATIN_PATTERN, leaks=[{"Commit": head}])
        self.assertEqual(exit_code, 2, out)
        self.assertIn("internal error", out)

    def test_failed_wins_over_did_not_run(self):
        self.repo.commit({"notes.txt": f"{LATIN_WORD}\n"})
        self.assert_result(self.repo.run(patterns=LATIN_PATTERN, gitleaks=False), 1,
                           gitleaks="did not run", patterns="failed")

    def test_file_name_with_newline_is_hidden(self):
        self.repo.commit({f"notes\n{LATIN_WORD}": "clean\n"})
        result = self.repo.run(patterns=f"(?i)^{LATIN_WORD}$")
        parts = self.assert_result(result, 1, patterns="failed")
        self.assertIn("  path of tracked file #2 (name hidden: it matches a check) pattern #1",
                      parts["patterns"][1])
        self.assert_no_echo(result[1])

    def test_crlf_line_matches_anchored_pattern(self):
        self.repo.commit({"notes.txt": f"first\r\n{LATIN_WORD}\r\n"})
        result = self.repo.run(patterns=f"(?i)^{LATIN_WORD}$")
        parts = self.assert_result(result, 1, patterns="failed")
        self.assertIn("  file notes.txt line 2 pattern #1", parts["patterns"][1])

    def test_pcre_only_class_did_not_run(self):
        self.repo.commit({"notes.txt": "nothing 123\n"})
        result = self.repo.run(patterns="(?i)[[:digit:]]{3}")
        self.assert_result(result, 2, patterns="did not run")
        self.assertIn("pattern #1", result[1])

    def test_tracked_file_missing_from_working_tree_did_not_run(self):
        self.repo.commit({"notes.txt": "nothing to see\n"})
        os.remove(os.path.join(self.repo.path, "notes.txt"))
        result = self.repo.run(patterns=LATIN_PATTERN)
        self.assert_result(result, 2, repo_references="did not run", patterns="did not run")


if __name__ == "__main__":
    unittest.main()
