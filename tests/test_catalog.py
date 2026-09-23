"""Tests for CATALOG.md: the structure of its sections and entries.

The catalog is the only source of its entries: nothing here counts them or
names their numbers. The checker runs on the real catalog, which must pass,
and on mutants of it, each breaking exactly one rule, which must report
exactly that rule.
"""

import os
import re
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CATALOG = os.path.join(ROOT, "CATALOG.md")
SECTIONS = "ABCDEFGH"
FIELDS = ["Looks like", "Why it's green", "Catch it"]
SECTION_RE = re.compile(r"## ([A-Z])\. \S.*")
ENTRY_RE = re.compile(r"### GW-(\d{2,}) \S.*")
FIELD_RE = re.compile(r"- \*\*([^*]+):\*\*(.*)")


def read_catalog():
    with open(CATALOG, encoding="utf-8") as f:
        return f.read()


def problems(text):
    """Every broken rule as (rule, where); an empty list means the structure holds.

    A `## ` heading starts a section (lettered like `## A. Title`, or not) and
    ends the entry above it; a `### ` heading starts an entry; every other
    non-blank line up to the next heading is a line of that entry. An entry
    line with no entry above it starts an entry without a heading, so a broken
    heading cannot make an entry vanish.
    """
    letters, entries, section, entry = [], [], None, None
    for line in text.splitlines():
        if line.startswith("## "):
            match = SECTION_RE.fullmatch(line)
            section = match.group(1) if match else None
            if section:
                letters.append(section)
            entry = None
        elif line.startswith("### "):
            entry = (section, line, [])
            entries.append(entry)
        elif entry is not None and line.strip():
            entry[2].append(line)
        elif any(line.startswith(f"- **{field}:**") for field in FIELDS):
            entry = (section, None, [line])
            entries.append(entry)

    found = []
    if letters != list(SECTIONS):
        found.append(("sections not A-H", " ".join(letters)))
    for letter in sorted(set(letters)):
        if not any(section == letter for section, _, _ in entries):
            found.append(("empty section", letter))
    numbers = []
    for section, heading, body in entries:
        match = heading and ENTRY_RE.fullmatch(heading)
        if not match:
            found.append(("bad heading", heading or body[0]))
            continue
        if section is None:
            found.append(("outside a section", heading))
        fields = [FIELD_RE.fullmatch(line) for line in body]
        if [field and field.group(1) for field in fields] != FIELDS:
            found.append(("wrong lines", heading))
        elif not all(field.group(2).strip() for field in fields):
            found.append(("empty line", heading))
        number = int(match.group(1))
        if number in numbers:
            found.append(("duplicate number", heading))
        elif numbers and number < numbers[-1]:
            found.append(("number not ascending", heading))
        numbers.append(number)
    return found


class CatalogTest(unittest.TestCase):
    def test_catalog_follows_the_structure(self):
        self.assertEqual(problems(read_catalog()), [])


class CheckerTest(unittest.TestCase):
    """Each mutant of the real catalog breaks exactly one rule."""

    def setUp(self):
        self.lines = read_catalog().splitlines()

    def index(self, prefix, start=0):
        return next(i for i in range(start, len(self.lines)) if self.lines[i].startswith(prefix))

    def assert_breaks(self, rule):
        self.assertEqual([found[0] for found in problems("\n".join(self.lines))], [rule])

    def test_duplicate_number(self):
        first = self.index("### ")
        second = self.index("### ", first + 1)
        number = self.lines[first].split()[1]
        self.lines[second] = self.lines[second].replace(self.lines[second].split()[1], number, 1)
        self.assert_breaks("duplicate number")

    def test_number_not_ascending(self):
        first = self.index("### ")
        second = self.index("### ", first + 1)
        self.lines[first], self.lines[second] = self.lines[second], self.lines[first]
        self.assert_breaks("number not ascending")

    def test_missing_line(self):
        del self.lines[self.index("- **Why it's green:**")]
        self.assert_breaks("wrong lines")

    def test_lines_out_of_order(self):
        looks = self.index("- **Looks like:**")
        self.lines[looks], self.lines[looks + 1] = self.lines[looks + 1], self.lines[looks]
        self.assert_breaks("wrong lines")

    def test_extra_line(self):
        self.lines.insert(self.index("- **Catch it:**") + 1, "A paragraph inside an entry.")
        self.assert_breaks("wrong lines")

    def test_empty_line(self):
        catch = self.index("- **Catch it:**")
        for empty in ("- **Catch it:**", "- **Catch it:**   "):
            with self.subTest(line=empty):
                self.lines[catch] = empty
                self.assert_breaks("empty line")

    def test_bad_heading(self):
        first = self.index("### ")
        for heading in ("### GW-1 Title", "### GW-01", "### GW-01 ", "### GW-01Title", "### gw-01 Title",
                        "### Title", "#### GW-01 Title", "###GW-01 Title", "**GW-01 Title**", ""):
            with self.subTest(heading=heading):
                self.lines[first] = heading
                self.assert_breaks("bad heading")

    def test_missing_section(self):
        del self.lines[self.index("## B. ")]
        self.assert_breaks("sections not A-H")

    def test_empty_catalog(self):
        self.lines = []
        self.assert_breaks("sections not A-H")

    def test_empty_section(self):
        start = self.index("## E. ")
        del self.lines[start + 1:self.index("## ", start + 1)]
        self.assert_breaks("empty section")

    def test_entry_before_the_sections(self):
        first = self.index("### ")
        entry = self.lines[first:first + 4]
        del self.lines[first:first + 4]
        self.lines[self.index("## A. "):self.index("## A. ")] = entry + [""]
        self.assert_breaks("outside a section")

    def test_entry_under_a_heading_that_is_not_a_section(self):
        last = max(i for i, line in enumerate(self.lines) if line.startswith("### "))
        entry = self.lines[last:last + 4]
        del self.lines[last:last + 4]
        self.lines += ["", "## Notes", ""] + entry
        self.assert_breaks("outside a section")


if __name__ == "__main__":
    unittest.main()
