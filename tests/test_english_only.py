"""Every tracked file is in English: no Cyrillic in a file's path or text.

The repository is written for readers of English (owner decision). Cyrillic (U+0400 to U+04FF)
in the path or a line of any file git tracks fails the test, with the file and the line; a file
that is not UTF-8 cannot be read for it and fails too. An image, by the rule of scripts/leak-check
(an image name and an image's bytes), is no text: its path is read, its bytes are skipped, and the
test says how many images it skipped. Tests that need Cyrillic data write it as escapes
(tests/test_leak_check.py), and so does this file.
"""

import contextlib
import importlib.machinery
import importlib.util
import io
import os
import re
import subprocess
import sys
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CYRILLIC = re.compile("[\u0400-\u04ff]")
GIT_ISOLATION = {"GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_NOSYSTEM": "1"}


def load_leak_check():
    loader = importlib.machinery.SourceFileLoader("leak_check", os.path.join(ROOT, "scripts", "leak-check"))
    spec = importlib.util.spec_from_loader("leak_check", loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


# The image rule is the leak check's (is_image(), is_real_image()): one rule for both checks.
leak_check = load_leak_check()


def git(repo, *args):
    return subprocess.run(["git", *args], cwd=repo, capture_output=True, check=True,
                          env={**os.environ, **GIT_ISOLATION}).stdout


def cyrillic_in(repo):
    """The files git tracks in repo, and where Cyrillic is in them: "<file>: path" for a name,
    "<file>:<line>" for a line (lines end at LF), "<file>: not UTF-8" for a file it cannot read.
    Images are not read as text; how many were skipped goes to stderr."""
    names = [name for name in git(repo, "ls-files", "-z").split(b"\0") if name]
    found, images = [], 0
    for raw in names:
        name = raw.decode("utf-8")
        if CYRILLIC.search(name):
            found.append(f"{name}: path")
        path = os.path.join(os.fsencode(repo), raw)
        # Git stores a link as the path it points to: that is its text.
        if os.path.islink(path):
            data = os.readlink(path)
        else:
            with open(path, "rb") as f:
                data = f.read()
            if leak_check.is_image(name) and leak_check.is_real_image(data):
                images += 1
                continue
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            found.append(f"{name}: not UTF-8")
            continue
        found += [f"{name}:{number}" for number, line in enumerate(text.split("\n"), 1) if CYRILLIC.search(line)]
    if images:
        print(f"test_english_only: skipped {images} image files", file=sys.stderr)
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
                # Line 1 has a form feed (lines end only at LF), line 2 a Cyrillic letter,
                # lines 3 and 4 the first and last of the range, line 5 the characters just outside it.
                "notes.txt": "first\x0cline\nthe \u0436 is here\n\u0400\n\u04ff\n\u03ff \u0500\n".encode("utf-8"),
                "\u0437.txt": "\u0436\n".encode("utf-8"),
                "cp1251.txt": "\u0436\n".encode("cp1251"),
                "draft.txt": "\u0436\n".encode("utf-8"),
                # Images, by the leak check's rule (an image name and an image's bytes), none of them UTF-8:
                # skipped, while the path of one is still read. An image name on other bytes, and an
                # image's bytes under another name, are files that are not UTF-8.
                "logo.png": b"\x89PNG\x0d\x0a\x1a\x0a\xff" + "\u0436".encode("cp1251"),
                "photo.jpg": b"\xff\xd8\xff\xe0" + "\u0436".encode("cp1251"),
                "\u0436.gif": b"GIF89a\xff",
                "pic.webp": b"RIFF\x10\x00\x00\x00WEBPVP8 \xff",
                "fake.png": "\u0436\n".encode("cp1251"),
                "photo.txt": b"\xff\xd8\xff\xe0" + "\u0436".encode("cp1251"),
            }
            for name, data in files.items():
                with open(os.path.join(repo, name), "wb") as f:
                    f.write(data)
            # A link whose target, the text git stores for it, is Cyrillic (it points nowhere).
            os.symlink("\u0436", os.path.join(repo, "link"))
            # draft.txt stays untracked: only the files git tracks are read.
            git(repo, "add", "notes.txt", "\u0437.txt", "cp1251.txt", "link", "logo.png", "photo.jpg", "\u0436.gif", "pic.webp",
                "fake.png", "photo.txt")
            with contextlib.redirect_stderr(io.StringIO()) as said:
                listed, found = cyrillic_in(repo)
        self.assertEqual(listed, ["cp1251.txt", "fake.png", "link", "logo.png", "notes.txt", "photo.jpg", "photo.txt", "pic.webp",
                                  "\u0436.gif", "\u0437.txt"])
        self.assertEqual(found, ["cp1251.txt: not UTF-8", "fake.png: not UTF-8", "link:1", "notes.txt:2", "notes.txt:3", "notes.txt:4",
                                 "photo.txt: not UTF-8", "\u0436.gif: path", "\u0437.txt: path", "\u0437.txt:1"])
        self.assertEqual(said.getvalue(), "test_english_only: skipped 4 image files\n")


if __name__ == "__main__":
    unittest.main()
