"""Parse inline HTML JavaScript without executing it or loading external scripts."""

import argparse
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path
import subprocess
import sys


ASCII_SPACE = " \t\n\r\f"
JS_TYPES = {
    "application/ecmascript", "application/javascript", "application/x-ecmascript",
    "application/x-javascript", "text/ecmascript", "text/javascript",
    "text/javascript1.0", "text/javascript1.1", "text/javascript1.2",
    "text/javascript1.3", "text/javascript1.4", "text/javascript1.5",
    "text/jscript", "text/livescript", "text/x-ecmascript", "text/x-javascript",
}


@dataclass
class InlineScript:
    number: int
    line: int
    kind: str
    chunks: list[str] = field(default_factory=list)


class Scripts(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.scripts = []
        self.errors = []
        self.current = None
        self.in_script = False
        self.number = 0

    def handle_starttag(self, tag, attrs):
        if tag != "script":
            return
        self.in_script = True
        self.number += 1
        attributes = {}
        # HTML uses the first occurrence of a duplicated attribute.
        for name, value in attrs:
            attributes.setdefault(name, value or "")
        if "src" in attributes:
            return
        script_type = attributes.get("type", "").strip(ASCII_SPACE).lower()
        if "type" not in attributes and attributes.get("language", ""):
            script_type = "text/" + attributes["language"].strip(ASCII_SPACE).lower()
        if script_type == "module":
            kind = "module"
        elif not script_type or script_type in JS_TYPES:
            kind = "classic"
        else:
            # JSON, JSON-LD, import maps, speculation rules and other data blocks
            # are not JavaScript. MIME parameters do not make a script executable.
            return
        self.current = InlineScript(self.number, self.getpos()[0], kind)

    def handle_data(self, data):
        if self.current is not None:
            self.current.chunks.append(data)

    def handle_endtag(self, tag):
        if tag != "script":
            return
        if self.current is not None:
            self.scripts.append(self.current)
        self.current = None
        self.in_script = False

    def handle_startendtag(self, tag, attrs):
        if tag == "script":
            # Script is not a void element in HTML; treating it as self-closing
            # would silently miss code that the browser may consume after it.
            self.errors.append(f"line {self.getpos()[0]}: script elements need an explicit closing tag")
        else:
            super().handle_startendtag(tag, attrs)

    def finish(self):
        self.close()
        if self.in_script:
            self.errors.append("an inline or external script element has no closing tag")


CLASSIC_PARSER = """
const fs = require('node:fs');
const vm = require('node:vm');
try {
  new vm.Script(fs.readFileSync(0, 'utf8'), {
    filename: process.argv[1], lineOffset: Number(process.argv[2])
  });
} catch (error) {
  console.error(error.stack);
  process.exitCode = 1;
}
"""


def check_files(paths, node="node"):
    count = 0
    failed = False
    for path in paths:
        parser = Scripts()
        try:
            parser.feed(path.read_text(encoding="utf-8"))
            parser.finish()
        except (OSError, UnicodeError) as error:
            print(f"{path}: {error}", file=sys.stderr)
            failed = True
            continue
        for error in parser.errors:
            print(f"{path}: {error}", file=sys.stderr)
            failed = True
        for script in parser.scripts:
            count += 1
            label = f"{path}:inline-script-{script.number}"
            command = ([node, "--input-type=module", "--check"] if script.kind == "module"
                       else [node, "-e", CLASSIC_PARSER, label, str(script.line - 1)])
            try:
                result = subprocess.run(command, input="".join(script.chunks), text=True,
                                        encoding="utf-8", capture_output=True)
            except OSError as error:
                print(f"{label}: Node.js could not run: {error}", file=sys.stderr)
                return 2
            if result.returncode:
                failed = True
                print(f"{label} ({script.kind}, HTML line {script.line}): syntax check failed", file=sys.stderr)
                print(result.stderr.rstrip(), file=sys.stderr)
    if not failed:
        print(f"Checked {count} inline JavaScript script(s) across {len(paths)} HTML file(s).")
    return 1 if failed else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("html", nargs="+", type=Path, help="HTML files to check")
    parser.add_argument("--node", default="node", help="Node.js executable (default: node)")
    arguments = parser.parse_args()
    return check_files(arguments.html, arguments.node)


if __name__ == "__main__":
    raise SystemExit(main())
