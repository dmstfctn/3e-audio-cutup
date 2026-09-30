"""Copy the game's audio to names with their content's hash, for submissions.

A submission names the audio files it was made with, so those files must never
change. Run this after replacing words.mp3, words.json or a track in build/audio/:

    python3 preprocess/hash_audio.py

words.mp3, words.json and each track under tracks: in build/config/games.yaml
are copied to build/audio/v/ as name.<hash>.ext (a copy that's there already is
left alone), and build/audio/v/index.json maps each plain name to its latest
copy. The game loads
the copies through index.json. Old copies stay, as old submissions use them:
commit them and never delete them.
"""

import hashlib
import json
import re
import shutil
from pathlib import Path

BUILD = Path(__file__).resolve().parent.parent / 'build'
AUDIO = BUILD / 'audio'
OUT = AUDIO / 'v'


def tracks():
    """The files under tracks: in games.yaml (read by hand, so this needs nothing installed)."""
    text = (BUILD / 'config' / 'games.yaml').read_text()
    block = re.search(r'^tracks:\n((?:[ \t]+.*\n|[ \t]*#.*\n|\s*\n)*)', text, re.M)
    if not block:
        raise SystemExit('no tracks: in games.yaml')
    return [BUILD / m for m in re.findall(r'^[ \t]+[\w-]+:\s*(audio/[^\s#]+)', block.group(1), re.M)]


def main():
    OUT.mkdir(exist_ok=True)
    files = [AUDIO / 'words.mp3', AUDIO / 'words.json', *tracks()]
    index = {}
    for f in files:
        data = f.read_bytes()
        digest = hashlib.sha256(data).hexdigest()[:8]
        name = f'{f.stem}.{digest}{f.suffix}'
        target = OUT / name
        if not target.exists():
            shutil.copyfile(f, target)
            print(f'new: {name}')
        # size, so the game can tell (when served locally) that a plain file changed since this ran
        index[f.name] = {'file': name, 'size': len(data)}
    (OUT / 'index.json').write_text(json.dumps(index, indent=2) + '\n')
    print(f'{len(index)} files in {OUT.relative_to(AUDIO.parent.parent)}/index.json')


if __name__ == '__main__':
    main()
