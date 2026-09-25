"""Where to break the changed lines of Python code, for the mutation command (gate/mutate.js).

The same kinds of break as for JavaScript: an if's condition turned around, a guard (an if with one
raise or return and no else) replaced by pass, a comparison turned around, a returned value replaced
by None, True and False swapped, a number one higher. The command runs it as
`<python> -I python_mutants.py` with JSON on stdin:
    {"files": [{"file", "text", "lines": [changed line]}]}
and reads JSON from stdout:
    {"mutants": [{"file", "op", "start": [line, column], "end": [line, column], "text"}],
     "controls": [{"file", "line"}],
     "errors": [{"file", "error"}]}
Lines are split at CRLF, CR and LF, as the JavaScript side splits them; columns count characters.
Each break is kept only when the file still parses with it. A control is the line of a file a raise
goes before, so that the module fails as soon as it runs (the command's control break).
"""

import ast
import io
import json
import re
import sys
import tokenize

FLIP = {ast.Lt: ("<", ">="), ast.GtE: (">=", "<"), ast.Gt: (">", "<="), ast.LtE: ("<=", ">"),
        ast.Eq: ("==", "!="), ast.NotEq: ("!=", "==")}
PLAIN_NUMBER = re.compile(r"(0|[1-9]\d*)(\.\d+)?")
LINE_BREAK = re.compile(r"\r\n|\r|\n")


def mutants(source, changed):
    """The breaks of one file that touch a changed line: [(op, (line, column), (line, column), text)]."""
    tree = ast.parse(source)
    lines = LINE_BREAK.split(source)

    def char(line, byte):
        """ast gives UTF-8 byte offsets; the edits count characters."""
        return len(lines[line - 1].encode("utf-8")[:byte].decode("utf-8", "replace"))

    def start(node):
        return (node.lineno, char(node.lineno, node.col_offset))

    def end(node):
        return (node.end_lineno, char(node.end_lineno, node.end_col_offset))

    def segment(first, last):
        if first[0] == last[0]:
            return lines[first[0] - 1][first[1]:last[1]]
        middle = lines[first[0]:last[0] - 1]
        return "\n".join([lines[first[0] - 1][first[1]:], *middle, lines[last[0] - 1][:last[1]]])

    # Operator tokens by position: ast does not say where a comparison's operator is.
    operators = [(token.start, token.end, token.string) for token in tokenize.generate_tokens(io.StringIO(source, newline=None).readline)
                 if token.type == tokenize.OP and token.string in {"<", ">", "<=", ">=", "==", "!="}]
    # Positions inside an f-string are not reliable before Python 3.12.
    in_fstring = {id(inner) for node in ast.walk(tree) if isinstance(node, ast.JoinedStr) for inner in ast.walk(node)}
    found = []
    for node in ast.walk(tree):
        if id(node) in in_fstring:
            continue
        if isinstance(node, ast.If):
            keyword = lines[node.lineno - 1][char(node.lineno, node.col_offset):]
            found.append(("condition", start(node.test), end(node.test), f"not ({segment(start(node.test), end(node.test))})"))
            if keyword.startswith("if") and not node.orelse and len(node.body) == 1 and isinstance(node.body[0], (ast.Raise, ast.Return)):
                indent = re.match(r"[ \t]*", lines[node.lineno - 1]).group()
                found.append(("guard", (node.lineno, 0), (node.end_lineno, len(lines[node.end_lineno - 1])), f"{indent}pass"))
        elif isinstance(node, ast.Compare):
            operands = [node.left, *node.comparators]
            for i, op in enumerate(node.ops):
                if type(op) not in FLIP:
                    continue
                symbol, opposite = FLIP[type(op)]
                token = next((t for t in operators if t[2] == symbol and end(operands[i]) <= t[0] and t[1] <= start(operands[i + 1])), None)
                if token:
                    found.append(("comparison", token[0], token[1], opposite))
        elif isinstance(node, ast.Return) and node.value is not None and not (isinstance(node.value, ast.Constant) and node.value.value is None):
            found.append(("return", start(node.value), end(node.value), "None"))
        elif isinstance(node, ast.Constant) and isinstance(node.value, bool):
            found.append(("boolean", start(node), end(node), "False" if node.value else "True"))
        elif isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
            number = PLAIN_NUMBER.fullmatch(segment(start(node), end(node)))
            if number:
                found.append(("number", start(node), end(node), f"{int(number.group(1)) + 1}{number.group(2) or ''}"))
    kept = []
    for op, first, last, text in found:
        if not any(line in changed for line in range(first[0], last[0] + 1)):
            continue
        broken = lines[:first[0] - 1] + [lines[first[0] - 1][:first[1]] + text + lines[last[0] - 1][last[1]:]] + lines[last[0]:]
        try:
            ast.parse("\n".join(broken))
        except (SyntaxError, ValueError):
            continue
        kept.append((op, first, last, text))
    return kept


def control_line(source):
    """The first line a statement may take before the rest of the module: after a #! and a coding line
    (the first two lines, when they are comments), the docstring and the __future__ imports."""
    line = 1
    for text in LINE_BREAK.split(source)[:2]:
        if not text.startswith("#"):
            break
        line += 1
    for index, node in enumerate(ast.parse(source).body):
        docstring = index == 0 and isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant) and isinstance(node.value.value, str)
        if not (docstring or (isinstance(node, ast.ImportFrom) and node.module == "__future__")):
            break
        line = max(line, node.end_lineno + 1)
    return line


def main():
    request = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    found, controls, errors = [], [], []
    for item in request["files"]:
        text = item["text"][1:] if item["text"].startswith("﻿") else item["text"]
        try:
            for op, first, last, replacement in mutants(text, set(item["lines"])):
                found.append({"file": item["file"], "op": op, "start": list(first), "end": list(last), "text": replacement})
            controls.append({"file": item["file"], "line": control_line(text)})
        except (SyntaxError, ValueError, tokenize.TokenError) as error:
            errors.append({"file": item["file"], "error": f"Python could not read it ({type(error).__name__}: {error})"})
    sys.stdout.buffer.write(json.dumps({"mutants": found, "controls": controls, "errors": errors}).encode("utf-8"))


if __name__ == "__main__":
    main()
