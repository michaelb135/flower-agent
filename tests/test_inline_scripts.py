"""Regression checks for HTML inline JavaScript; requires only Python and Node."""

from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


CHECKER = Path(__file__).resolve().parents[1] / "tools" / "check_inline_scripts.py"


@unittest.skipUnless(shutil.which("node"), "Node.js is required for syntax checking")
class InlineScriptsTests(unittest.TestCase):
    def check(self, content, expected=0):
        with tempfile.TemporaryDirectory(prefix="tidy-inline-js-") as temporary:
            path = Path(temporary) / "fixture.html"
            path.write_text(content, encoding="utf-8")
            result = subprocess.run([sys.executable, str(CHECKER), str(path)],
                                    text=True, capture_output=True)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        return result

    def test_multiple_classic_and_module_scripts(self):
        result = self.check('''<script>const first = 1;</script>
          <SCRIPT type="TEXT/JAVASCRIPT">const second = 2;</SCRIPT>
          <script type="module">import value from './not-loaded.js'; export default value;</script>''')
        self.assertIn("Checked 3", result.stdout)

    def test_malformed_later_script_fails(self):
        result = self.check("<script>const valid=1;</script><script>const =;</script>", 1)
        self.assertIn("inline-script-2", result.stderr)

    def test_classic_checks_browser_grammar_not_commonjs_wrapper(self):
        self.check("<script>return 1;</script>", 1)
        self.check("<script>export const value=1;</script>", 1)

    def test_module_syntax_and_top_level_await(self):
        self.check('<script type="module">await Promise.resolve(); export const value=1;</script>')
        self.check('<script type="module">export const =;</script>', 1)

    def test_external_and_non_javascript_blocks_are_excluded(self):
        result = self.check('''<script src="https://example.invalid/not-loaded.js">const =;</script>
          <script src="">const =;</script>
          <script type="application/json">{"this": "is data"}</script>
          <script type="application/ld+json">{"@type":"Thing"}</script>
          <script type="importmap">{"imports":{}}</script>
          <script type="text/javascript; charset=utf-8">const =;</script>
          <script type="text/javascript1.8">const =;</script>
          <script type="text/plain">const =;</script>''')
        self.assertIn("Checked 0", result.stdout)

    def test_empty_type_legacy_language_and_attribute_precedence(self):
        result = self.check('''<script type="">const a=1;</script>
          <script language="javascript">const b=1;</script>
          <script language="python">not javascript!</script>
          <script type="text/plain" type="text/javascript">not javascript!</script>
          <script type="text/javascript" type="text/plain">const c=1;</script>''')
        self.assertIn("Checked 3", result.stdout)

    def test_script_contents_are_never_executed(self):
        with tempfile.TemporaryDirectory(prefix="tidy-inline-no-exec-") as temporary:
            marker = Path(temporary) / "must-not-exist"
            html = Path(temporary) / "fixture.html"
            html.write_text("<script>require('node:fs').writeFileSync(" + repr(str(marker)) + ", 'bad'); throw Error('not executed');</script>")
            result = subprocess.run([sys.executable, str(CHECKER), str(html)], text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(marker.exists())

    def test_raw_script_text_and_html_comment_markers(self):
        self.check('<script>const markup = "<div>&amp;</div>"; // a comment\n</script>')
        self.check('<script><!--\nconst legacy = 1;\n// -->\n</script>')

    def test_unclosed_and_self_closing_scripts_fail_clearly(self):
        result = self.check('<script>const value=1;', 1)
        self.assertIn("closing tag", result.stderr)
        self.check('<script/>const value=1;</script>', 1)

    def test_multiple_input_files(self):
        with tempfile.TemporaryDirectory(prefix="tidy-inline-many-") as temporary:
            first, second = Path(temporary) / "first.html", Path(temporary) / "second.html"
            first.write_text('<script>const first=1;</script>')
            second.write_text('<script>let =;</script>')
            result = subprocess.run([sys.executable, str(CHECKER), str(first), str(second)], text=True, capture_output=True)
            self.assertEqual(result.returncode, 1)
            self.assertIn("second.html", result.stderr)


if __name__ == "__main__":
    unittest.main()
