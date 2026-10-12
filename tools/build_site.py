"""Build the static site using only reviewed runtime files, never test/user data."""
import argparse
import hashlib
import json
import re
import shutil
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--output', required=True)
parser.add_argument('--revision', required=True)
args = parser.parse_args()
if not re.fullmatch(r'[a-f0-9]{40}|unpublished', args.revision):
    raise SystemExit('Revision must be a Git commit SHA or unpublished for a local check.')

repo = Path(__file__).resolve().parents[1]
source = repo / 'web'
output = Path(args.output).resolve()
if output == source or source in output.parents or output == repo or output in source.parents:
    raise SystemExit('Build output must be separate from the source tree.')
output.mkdir(parents=True, exist_ok=True)
if any(output.iterdir()):
    raise SystemExit('Build output must be an empty directory.')
names = ['index.html', 'styles.css', 'app.js', 'core.js', 'assistant.js', 'meals.html']
hashes = {}
for name in names:
    original = source / name
    if not original.is_file() or original.is_symlink():
        raise SystemExit('Missing or unsafe runtime file: ' + name)
    shutil.copy2(original, output / name)
    hashes[name] = hashlib.sha256(original.read_bytes()).hexdigest()
(output / '.nojekyll').write_text('')
(output / 'build-info.json').write_text(json.dumps({'app': 'Tidy', 'revision': args.revision, 'files': hashes}, indent=2) + '\n')
print(json.dumps({'files': len(names), 'revision': args.revision, 'output': str(output)}))
