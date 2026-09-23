"""Tests for skills/greenwashing/SKILL.md: the frontmatter and the links to CATALOG.md.

The checker runs on the real skill, which must pass, and on mutants of it,
each of which must report exactly the rules it breaks.
"""

import os
import re
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SKILL_DIR = os.path.join(ROOT, "skills", "greenwashing")
SKILL = os.path.join(SKILL_DIR, "SKILL.md")
CATALOG = os.path.join(ROOT, "CATALOG.md")
# Limits of the Agent Skills format for the name and description fields.
NAME_MAX = 64
DESCRIPTION_MAX = 1024
NAME_RE = re.compile(r"[a-z0-9-]+")
FIELD_RE = re.compile(r"([A-Za-z_-]+):(.*)")
ID_RE = re.compile(r"\bGW-(\d+)\b")
CATALOG_ID_RE = re.compile(r"^### GW-(\d+) ", re.M)
# A YAML block scalar (`>`, `|-` ...): its text is on later lines, which this checker does not read.
BLOCK_RE = re.compile(r"[>|][-+]?")


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def frontmatter(text):
    """Fields of the `---` block that opens the file, or None when there is none."""
    lines = re.split(r"\r\n|\r|\n", text.removeprefix("\ufeff"))
    end = next((i for i, line in enumerate(lines) if i and line == "---"), None)
    if lines[0] != "---" or end is None:
        return None
    fields = {}
    for line in lines[1:end]:
        match = FIELD_RE.fullmatch(line)
        if match:
            fields[match.group(1)] = value(match.group(2))
    return fields


def value(raw):
    """A plain one-line YAML value: surrounding quotes removed, `~` and `null` read as empty."""
    raw = raw.strip()
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in "'\"":
        return raw[1:-1]
    return "" if raw in ("~", "null") else raw


def problems(skill, catalog, folder):
    """Every broken rule as (rule, where); an empty list means the skill holds."""
    found = []
    fields = frontmatter(skill)
    if fields is None:
        found.append(("no frontmatter", ""))
        fields = {}
    for key in ("name", "description"):
        if BLOCK_RE.fullmatch(fields.get(key, "")):
            found.append(("unreadable value", key))
            fields.pop(key)
    name, description = fields.get("name"), fields.get("description")
    if name is None:
        found.append(("no name", ""))
    elif name != folder or not NAME_RE.fullmatch(name) or len(name) > NAME_MAX:
        found.append(("bad name", name))
    if not description:
        found.append(("no description", ""))
    elif len(description) > DESCRIPTION_MAX:
        found.append(("description too long", str(len(description))))
    known = {int(number) for number in CATALOG_ID_RE.findall(catalog)}
    used = [int(number) for number in ID_RE.findall(skill)]
    if not used:
        found.append(("no catalog ids", ""))
    for number in used:
        if number not in known:
            found.append(("id not in catalog", f"GW-{number:02d}"))
    if re.search(rf"(?<![\w-]){len(known)}(?!\w)", skill):
        found.append(("catalog count", str(len(known))))
    return found


class SkillTest(unittest.TestCase):
    def test_skill_follows_the_rules(self):
        self.assertEqual(problems(read(SKILL), read(CATALOG), os.path.basename(SKILL_DIR)), [])


class CheckerTest(unittest.TestCase):
    """Each mutant of the real skill must report exactly the rules it breaks."""

    def setUp(self):
        self.skill, self.catalog = read(SKILL), read(CATALOG)
        self.folder = os.path.basename(SKILL_DIR)

    def assert_breaks(self, skill, *rules, catalog=None, folder=None):
        found = problems(skill, catalog or self.catalog, folder or self.folder)
        self.assertEqual([rule for rule, _ in found], list(rules))

    def replace(self, old, new):
        self.assertEqual(self.skill.count(old), 1, old)
        return self.skill.replace(old, new)

    def test_no_frontmatter(self):
        body = self.skill.split("\n---\n", 1)[1]
        self.assert_breaks(body, "no frontmatter", "no name", "no description")

    def test_unclosed_frontmatter(self):
        self.assert_breaks(self.skill.replace("\n---\n", "\n\n", 1), "no frontmatter", "no name", "no description")

    def test_no_name(self):
        self.assert_breaks(self.replace("name: greenwashing\n", ""), "no name")

    def test_bad_name(self):
        # The folder carries the same name, so only the name's own rules can fail.
        for name in ("Greenwashing", "green_washing", "green washing", "green.washing", "gr\u00eben", "green/washing",
                     "g" * 65):
            with self.subTest(name=name):
                self.assert_breaks(self.replace("name: greenwashing\n", f"name: {name}\n"), "bad name", folder=name or "-")

    def test_good_names(self):
        # Limits are literals here, not the checker's constants.
        for name in ("greenwashing2", "green-washing", "g" * 64):
            with self.subTest(name=name):
                self.assert_breaks(self.replace("name: greenwashing\n", f"name: {name}\n"), folder=name)

    def test_name_differs_from_folder(self):
        self.assert_breaks(self.skill, "bad name", folder="green-washing")

    def test_no_description(self):
        line = next(line for line in self.skill.split("\n") if line.startswith("description:"))
        for replacement in ("", "description:", "description:   ", "description: ''", 'description: ""',
                            "description: ~", "description: null"):
            with self.subTest(line=replacement):
                self.assert_breaks(self.replace(line + "\n", replacement + "\n" if replacement else ""),
                                   "no description")

    def test_block_scalar(self):
        line = next(line for line in self.skill.split("\n") if line.startswith("description:"))
        for marker in (">", "|", ">-", "|+"):
            with self.subTest(marker=marker):
                long = f"description: {marker}\n  " + "x" * 2000
                self.assert_breaks(self.replace(line, long), "unreadable value", "no description")

    def test_valid_variants(self):
        line = next(line for line in self.skill.split("\n") if line.startswith("description:"))
        variants = {"CRLF": self.skill.replace("\n", "\r\n"), "BOM": "\ufeff" + self.skill,
                    "quoted name": self.replace("name: greenwashing", 'name: "greenwashing"'),
                    "quoted description": self.replace(line, 'description: "' + line[len("description: "):] + '"'),
                    "quoted 1024 characters": self.replace(line, "description: '" + "x" * 1024 + "'")}
        for name, text in variants.items():
            with self.subTest(variant=name):
                self.assert_breaks(text)

    def test_description_length(self):
        line = next(line for line in self.skill.split("\n") if line.startswith("description:"))
        for length, rules in ((1024, []), (1025, ["description too long"])):
            with self.subTest(length=length):
                self.assert_breaks(self.replace(line, "description: " + "x" * length), *rules)

    def test_id_not_in_catalog(self):
        for missing in ("GW-17", "GW-116", "GW-99"):
            with self.subTest(id=missing):
                self.assert_breaks(self.replace("(GW-55)", f"({missing})"), "id not in catalog")

    def test_id_removed_from_catalog(self):
        # The number stays in the catalog's prose but is no longer an entry heading.
        catalog = self.catalog.replace("### GW-55 ", "Formerly GW-55: ", 1)
        self.assertNotEqual(catalog, self.catalog)
        self.assert_breaks(self.skill, "id not in catalog", catalog=catalog)

    def test_no_catalog_ids(self):
        self.assert_breaks(ID_RE.sub("the catalog", self.skill), "no catalog ids")

    def test_catalog_count(self):
        count = len(CATALOG_ID_RE.findall(self.catalog))
        for text in (f"all {count} entries", f"{count} ways", f"({count})"):
            with self.subTest(text=text):
                self.assert_breaks(self.replace("## Full catalog\n", f"## Full catalog\n\n{text}\n"), "catalog count")

    def test_other_numbers_pass(self):
        count = len(CATALOG_ID_RE.findall(self.catalog))
        for text in (f"{count + 1} ways", f"{count}0 ways", f"step-{count}"):
            with self.subTest(text=text):
                self.assert_breaks(self.replace("## Full catalog\n", f"## Full catalog\n\n{text}\n"))


if __name__ == "__main__":
    unittest.main()
