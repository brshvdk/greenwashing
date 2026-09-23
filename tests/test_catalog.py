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
ENTRY_RE = re.compile(r"### GW-(0[1-9]|[1-9][0-9]+) (.*)")
FIELD_RE = re.compile(r"- \*\*([^*]+):\*\*(.*)")
# Outside entries, a line that would hide entries or move them under another heading
# once rendered: indented or quoted lines, HTML, code fences, other headings, setext underlines.
MARKUP_RE = re.compile(r"\s|>|<|```|~~~|#|[-=]+\s*$")
# A title or line with no ASCII letter or digit renders empty.
VISIBLE_RE = re.compile(r"[A-Za-z0-9]")


def read_catalog():
    with open(CATALOG, encoding="utf-8") as f:
        return f.read()


def split_lines(text):
    """Lines as Markdown sees them: only CRLF, CR and LF end a line."""
    return re.split(r"\r\n|\r|\n", text)


def index(lines, prefix, start=0):
    """The first line at or after `start` that starts with `prefix`; the end of the text if none."""
    return next((i for i in range(start, len(lines)) if lines[i].startswith(prefix)), len(lines))


def headings(lines):
    return [i for i, line in enumerate(lines) if line.startswith("### ")]


def problems(text):
    """Every broken rule as (rule, where); an empty list means the structure holds.

    A `## ` heading starts a section (lettered like `## A. Title`, or not) and
    ends the entry above it; a `### ` heading starts an entry; every other
    non-blank line up to the next heading is a line of that entry. An entry
    line with no entry above it starts an entry without a heading, so a broken
    heading cannot make an entry vanish. Outside entries, only the first line
    may be another heading (the `# ` title).
    """
    letters, entries, markup, section, entry = [], [], [], None, None
    for row, line in enumerate(split_lines(text)):
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
        elif line.strip() and MARKUP_RE.match(line) and not (row == 0 and line.startswith("# ")):
            markup.append(("unexpected markup", line))

    found = []
    if letters != list(SECTIONS):
        found.append(("sections not A-H", " ".join(letters)))
    for letter in sorted(set(letters)):
        if not any(section == letter for section, _, _ in entries):
            found.append(("empty section", letter))
    found += markup
    numbers = []
    for section, heading, body in entries:
        match = heading and ENTRY_RE.fullmatch(heading)
        if not match or not VISIBLE_RE.search(match.group(2)):
            found.append(("bad heading", heading or body[0]))
            continue
        if section is None:
            found.append(("outside a section", heading))
        fields = [FIELD_RE.fullmatch(line) for line in body]
        if [field and field.group(1) for field in fields] != FIELDS:
            found.append(("wrong lines", heading))
        elif not all(VISIBLE_RE.search(field.group(2)) for field in fields):
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
        self.text = read_catalog()

    def lines(self):
        return split_lines(self.text)

    def assert_breaks(self, lines, *rules):
        self.assertEqual([found[0] for found in problems("\n".join(lines))], list(rules))

    def test_duplicate_number(self):
        lines = self.lines()
        first, second = headings(lines)[:2]
        lines[second] = lines[second].replace(lines[second].split()[1], lines[first].split()[1], 1)
        self.assert_breaks(lines, "duplicate number")

    def test_number_not_ascending(self):
        for pair in (slice(0, 2), slice(-2, None)):
            with self.subTest(pair=pair):
                lines = self.lines()
                first, second = headings(lines)[pair]
                lines[first], lines[second] = lines[second], lines[first]
                self.assert_breaks(lines, "number not ascending")

    def test_missing_line(self):
        lines = self.lines()
        del lines[index(lines, "- **Why it's green:**")]
        self.assert_breaks(lines, "wrong lines")

    def test_lines_out_of_order(self):
        lines = self.lines()
        looks = index(lines, "- **Looks like:**")
        why = index(lines, "- **Why it's green:**", looks)
        lines[looks], lines[why] = lines[why], lines[looks]
        self.assert_breaks(lines, "wrong lines")

    def test_extra_line(self):
        lines = self.lines()
        lines.insert(index(lines, "- **Catch it:**") + 1, "A paragraph inside an entry.")
        self.assert_breaks(lines, "wrong lines")

    def test_empty_line(self):
        for empty in ("- **Catch it:**", "- **Catch it:**   ", "- **Catch it:** \u200b", "- **Catch it:** <!-- -->"):
            with self.subTest(line=empty):
                lines = self.lines()
                lines[index(lines, "- **Catch it:**")] = empty
                self.assert_breaks(lines, "empty line")

    def test_bad_heading(self):
        for heading in ("### GW-1 Title", "### GW-01", "### GW-01 ", "### GW-01Title", "### gw-01 Title",
                        "### Title", "**GW-01 Title**", "", "### GW-001 Title", "### GW-\uff10\uff11 Title",
                        "### GW-01 \u200b"):
            with self.subTest(heading=heading):
                lines = self.lines()
                lines[headings(lines)[0]] = heading
                self.assert_breaks(lines, "bad heading")

    def test_heading_at_another_level(self):
        # The heading line itself is stray markup, and the entry under it has no heading.
        for heading in ("#### GW-01 Title", "###GW-01 Title"):
            with self.subTest(heading=heading):
                lines = self.lines()
                lines[headings(lines)[0]] = heading
                self.assert_breaks(lines, "unexpected markup", "bad heading")

    def test_missing_section(self):
        lines = self.lines()
        del lines[index(lines, "## B. ")]
        self.assert_breaks(lines, "sections not A-H")

    def test_sections_out_of_order(self):
        lines = self.lines()
        c, d = index(lines, "## C. "), index(lines, "## D. ")
        lines[c], lines[d] = lines[d], lines[c]
        self.assert_breaks(lines, "sections not A-H")

    def test_duplicate_section(self):
        lines = self.lines()
        b = index(lines, "## B. ")
        lines[b] = "## A." + lines[b][len("## B."):]
        self.assert_breaks(lines, "sections not A-H")

    def test_extra_section(self):
        lines = self.lines()
        last = headings(lines)[-1]
        lines[last:last] = ["## I. Extra", ""]
        self.assert_breaks(lines, "sections not A-H")

    def test_empty_catalog(self):
        self.assert_breaks([], "sections not A-H")

    def test_empty_section(self):
        for letter in SECTIONS:
            with self.subTest(section=letter):
                lines = self.lines()
                start = index(lines, f"## {letter}. ")
                del lines[start + 1:index(lines, "## ", start + 1)]
                self.assert_breaks(lines, "empty section")

    def test_entry_before_the_sections(self):
        lines = self.lines()
        first = headings(lines)[0]
        entry = lines[first:index(lines, "#", first + 1)]
        del lines[first:first + len(entry)]
        lines[index(lines, "## A. "):index(lines, "## A. ")] = entry
        self.assert_breaks(lines, "outside a section")

    def test_entry_under_a_heading_that_is_not_a_section(self):
        lines = self.lines()
        last = headings(lines)[-1]
        entry = lines[last:]
        del lines[last:]
        lines += ["## Notes", ""] + entry
        self.assert_breaks(lines, "outside a section")

    def test_markup_that_hides_or_moves_entries(self):
        for markup in (["```text"], ["~~~"], ["<!--"], ["<h2>Notes</h2>"], ["<h3>GW-01 Duplicate</h3>"], ["# Appendix"],
                       ["#### Notes"], ["##\tNotes"], [" ## Notes"], [" ### GW-01 Indented"], ["    indented code"],
                       ["> ### GW-01 Quoted"], ["Notes", "-----"], ["Notes", "====="]):
            with self.subTest(markup=markup):
                lines = self.lines()
                top = index(lines, "## C. ") + 1
                lines[top:top] = ["", *markup, ""]
                self.assert_breaks(lines, "unexpected markup")

    def test_line_separators_markdown_does_not_know(self):
        for separator in ("\u2028", "\u2029", "\x85", "\f", "\v", "\x1c", "\x1d", "\x1e"):
            with self.subTest(separator=ascii(separator)):
                lines = self.lines()
                first = headings(lines)[0]
                lines[first:first + 2] = [lines[first] + separator + lines[first + 1]]
                self.assert_breaks(lines, "wrong lines")

    def test_line_endings_markdown_knows(self):
        for ending in ("\r\n", "\r"):
            with self.subTest(ending=ascii(ending)):
                self.assertEqual(problems(self.text.replace("\n", ending)), [])


if __name__ == "__main__":
    unittest.main()
