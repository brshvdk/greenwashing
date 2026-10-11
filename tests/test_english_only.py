"""Every tracked file is in English: no Cyrillic in a file's path or text.

The repository is written for readers of English (owner decision). Cyrillic (U+0400 to U+04FF)
in the path or a line of any file git tracks fails the test, with the file and the line; a file
that is not UTF-8 cannot be read for it and fails too. Tests that need Cyrillic data write it as
escapes (tests/test_leak_check.py), and so does this file.
"""

import os
import re
import subprocess
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CYRILLIC = re.compile("[\u0400-\u04ff]")
GIT_ISOLATION = {"GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}


def git(repo, *args):
    return subprocess.run(["git", *args], cwd=repo, capture_output=True, check=True,
                          env={**os.environ, **GIT_ISOLATION}).stdout


def cyrillic_in(repo):
    """The files git tracks in repo, and where Cyrillic is in them: "<file>: path" for a name,
    "<file>:<line>" for a line (lines end at LF), "<file>: not UTF-8" for a file it cannot read."""
    names = [name for name in git(repo, "ls-files", "-z").split(b"\0") if name]
    found = []
    for raw in names:
        name = raw.decode("utf-8")
        if CYRILLIC.search(name):
            found.append(f"{name}: path")
        with open(os.path.join(os.fsencode(repo), raw), "rb") as f:
            data = f.read()
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            found.append(f"{name}: not UTF-8")
            continue
        found += [f"{name}:{number}" for number, line in enumerate(text.split("\n"), 1) if CYRILLIC.search(line)]
    return [raw.decode("utf-8") for raw in names], found


class EnglishOnlyTest(unittest.TestCase):
    def test_tracked_files_have_no_cyrillic(self):
        files, found = cyrillic_in(ROOT)
        # The list is git's: this file is in it, so an empty or wrong list cannot pass.
        self.assertTrue("tests/test_english_only.py" in files, f"git lists {len(files)} files, and not this one")
        self.assertEqual(found, [], "Cyrillic in tracked files (write test data as escapes):\n" + "\n".join(found))

    def test_reports_the_file_and_line_of_cyrillic(self):
        with tempfile.TemporaryDirectory() as repo:
            git(repo, "init", "-q")
            files = {
                # Line 2 has a Cyrillic letter, lines 3 and 4 the first and last of the range,
                # line 5 the characters just outside it.
                "notes.txt": "first line\nthe \u0436 is here\n\u0400\n\u04ff\n\u03ff \u0500\n".encode("utf-8"),
                "\u0437.txt": b"plain\n",
                "cp1251.txt": "\u0436\n".encode("cp1251"),
                "draft.txt": "\u0436\n".encode("utf-8"),
            }
            for name, data in files.items():
                with open(os.path.join(repo, name), "wb") as f:
                    f.write(data)
            # draft.txt stays untracked: only the files git tracks are read.
            git(repo, "add", "notes.txt", "\u0437.txt", "cp1251.txt")
            listed, found = cyrillic_in(repo)
        self.assertEqual(listed, ["cp1251.txt", "notes.txt", "\u0437.txt"])
        self.assertEqual(found, ["cp1251.txt: not UTF-8", "notes.txt:2", "notes.txt:3", "notes.txt:4", "\u0437.txt: path"])


if __name__ == "__main__":
    unittest.main()
