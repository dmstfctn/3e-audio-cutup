"""Copies the minigame data out of the 3e-coco-games pages into build/minigames/.

3e-coco-games/analysis/build_games.py bakes each game's data into its page between
/*@data*/ and /*@end*/. Rerun this after rebuilding the games there.

    python preprocess/import_minigames.py [path to 3e-coco-games]

The path defaults to ../3e-coco-games, next to this repo. Standard library only.
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# build/minigames/<key>.json <- game-prototypes/<page>
GAMES = {
    'find': 'game3-find.html',
    'caption-match': 'game1-caption-match.html',
    'find-all': 'game4-find-all.html',
}


def main():
    coco = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT.parent / '3e-coco-games'
    out = ROOT / 'build' / 'minigames'
    out.mkdir(exist_ok=True)
    for key, page in GAMES.items():
        html = (coco / 'game-prototypes' / page).read_text(encoding='utf-8')
        m = re.search(r'/\*@data\*/(.*?)/\*@end\*/', html, re.S)
        if not m:
            sys.exit(f'{page}: no /*@data*/ … /*@end*/ block')
        data = json.loads(m.group(1))  # fails loudly if the block isn't plain JSON
        (out / f'{key}.json').write_text(json.dumps(data, separators=(',', ':')), encoding='utf-8')
        print(f'{key}.json: {len(data) if isinstance(data, list) else {k: len(v) for k, v in data.items()}} from {page}')


if __name__ == '__main__':
    main()
