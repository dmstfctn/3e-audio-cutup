# cutup-proto

A browser game where players drag words cut from a recorded performance into four 2-bar lines over a 144 bpm beat. A Python script splits the recording into words, with timings and part-of-speech tags, and the prototypes in `build/` use that data.

## Layout

```
source/       original recording (.wav) and transcript (.txt, one spoken line per line)
preprocess/   word alignment + tagging script
data/         preprocess output (manifest.json kept; audio + clips regenerable)
build/        static site: prototypes + the audio/data they load (lib/ holds js-yaml)
```

## Run the prototypes

```
cd build
python3 -m http.server
```

Open http://localhost:8000. The pages must be served, because opening the HTML file directly (`file://`) can't load the audio.

## Set up preprocessing

Needs Python 3.10–3.12 and ffmpeg (`brew install ffmpeg`).

```
python3 -m venv preprocess/.venv
preprocess/.venv/bin/pip install -r preprocess/requirements.txt
preprocess/.venv/bin/python -m spacy download en_core_web_sm
```

The first run downloads a ~360 MB alignment model to `~/.cache/torch`.

## Re-run preprocessing

After editing the transcript or replacing the recording:

```
preprocess/.venv/bin/python preprocess/preprocess.py --clips
cp data/audio.wav build/audio/words.wav
cp data/manifest.json build/audio/words.json
```

The script prints the words in each category and a list of words with low alignment confidence. Listen to those in `data/clips/`. A low score usually means the transcript doesn't match what's said at that point.

Options:

- `--clips`: write one .wav per word to `data/clips/` for auditioning
- `--separate`: isolate vocals with Demucs before aligning (for speech over music; `pip install demucs` first)
- `--pad`, `--fade`: clip padding and fade in seconds (defaults 0.03, 0.008). The prototype sets its own padding (`PAD`) and fade (`FADE`).
- `--wav`, `--transcript`: use files other than the ones in `source/`

## Fix word categories

The preprocess script guesses each word's category (`bin`) from its part of speech, and gets some wrong. Corrections go in `build/audio/bins.yaml`. The prototypes load it and apply it over `words.json`, so it survives re-running preprocessing, and anyone can edit it without the Python setup.

```yaml
noun:
  - club
  - nothing
yeah:
  - yeh
  - yehh
  - yeah
```

- Each word listed moves to that bin everywhere it appears. Matching ignores case.
- Words that aren't listed keep the bin the script gave them.
- A new bin name makes a new palette section with its own colour.
- Reload the page to see edits. Problems (a word that isn't in the recording, a word listed under two bins, a YAML syntax error) show next to the play button.

The script's bins are `noun`, `verb`, `describer`, `pronoun`, `glue` and `other`. The `yeah` bin only exists in `bins.yaml`.

## Tag words to images (prototype-02)

In prototype-02's first two stages the palette deals a few random nouns, verbs, adjectives and yeahs to go with an image. `build/images/tags.yaml` sets words that always come up with a given image:

```yaml
1.png:
  noun:
    - hot-dog
    - vegetables
  adjective:
    - long
```

- The tagged words are always dealt, and random words fill the rest of the stage's count. If an image tags more words than the stage deals, they all show.
- Bins an image doesn't list stay fully random.
- Only images listed here come up (an image listed with no words gets random words). If it lists fewer than the two a game needs, every image is used and a warning shows.
- Words match as in `bins.yaml`. A word shows in its real bin; listing it under another bin shows a warning.
- Reload the page to see edits. They apply to games already in progress as well.

## Couplets (prototype-03)

Prototype-03 opens with the first line of a couplet from `build/words/lines.txt`, with one word switched for another from the same bin. The next step brings in the second line, cut short at the `/`, and the player finishes it from the tray. Write each couplet as two lines, with a blank line between couplets:

```
A market with vegetables and fruits for sale.
A rich feast, but / the bread is stale

A woman an umbrella, but there is no rain
a treasure is just a / prison to a coin
```

- The `/` goes in the second line and isn't shown. Without one, the line is cut in the middle.

- Every word has to be in the recording. Words match as in `bins.yaml`. Case and punctuation are ignored, except hyphens and apostrophes inside a word (`hot-dog` and `hot dog` are different).
- A word that isn't in the recording is left out, with a warning next to the play button.
- A line that's said as a whole in the recording uses the words from that take. Any other line gets a random recording of each word, with a warning. Couplets come up in a random order and don't repeat until every one has been used.
- Reload the page to see edits. They apply from the next new game (restart).

## First lines and starting tray (prototype-04)

Prototype-04 opens with one line from `build/words/first-lines.txt`, one line per line of the file, and a blank second line comes next. The tray starts with the words in `build/words/tray.yaml`, grouped by bin:

```yaml
noun:
  - angels
  - book
verb:
  - that’s
```

- Words match as in `bins.yaml`, and apostrophes are ignored (`that’s` finds the recorded "thats"). A word that isn't in the recording is left out, with a warning next to the play button.
- Each game picks a random recording of every word. The first line's recordings show in the tray, so a word said twice in it shows twice.
- A tray word shows in the bin `bins.yaml` gives it. Listing it under another bin shows a warning.
- First lines come up in a random order and don't repeat until every one has been used.
- Reload the page to see edits. `tray.yaml` edits apply to games in progress. `first-lines.txt` edits apply from the next new game (restart).

## Minigames (prototype-05)

Prototype-05 plays like prototype-04, but each stage after the first two opens with a minigame from [3e-coco-games](../3e-coco-games): Find It before the 4-line stage, Caption Match before the 6-line stage, Find Them All before the 8-line stage. The new lines come whatever the result. The words come only for a win: every round right, or every one found.

- Find It and Caption Match each add a round of words (5 nouns, verbs and adjectives, 3 yeahs). Find Them All adds every word.
- The games box at the top right lists the games played so far. A lost game can be played again there to win its words. A won game can be replayed, but it adds nothing.
- The music stops while a game is played. Press play again after it.
- The game code is in `build/minigames/minigames.js`, and the rules text is in `GAMES` in `prototype-05.html`.
- The games' data is in `build/minigames/*.json`, copied from the 3e-coco-games pages. After rebuilding the games there, copy it again:

  ```
  python3 preprocess/import_minigames.py ../3e-coco-games
  ```

- The photos load from COCO's image host, which only serves `http://`. A deploy served over `https://` will block them until they're hosted elsewhere.

## Minigame content (prototype-06)

Prototype-06 plays like prototype-05, but the games use set photos from `build/images/`, and each one wins set words. Only Find It plays automatically, before the 4-line stage. Caption Match and Find Them All are unlocked by the 6-line and 8-line stages: the lines come straight away, and a notice offers **play** or **continue writing**. An unlocked game stays in the games box until it's played. All of it is in `build/minigames/games.yaml`, which explains itself in its comments. For each game it holds:

- the photos, what to find in each one (or, for Caption Match, the caption and the two decoy photos), and an optional prompt
- the words each photo wins, grouped by bin as in `tray.yaml`
- the settings: seconds, zoom and click tolerance, and the rules text shown before the game

How the words are won:

- **Find It:** each play shows one photo and one thing to find, picked from the things not found yet. Finding it wins the thing's own word and half of the photo's other words. Things to find don't count as other words. Finding the photo's last thing wins the rest.
- **Find Them All:** one photo per play. What's found adds up over plays of the same photo. A bar shows the count, with a notch where each word is won: with 10 to find and 5 words, one word per 2 found. The thing's own word comes first, then the others in the order listed.
- **Caption Match:** every round is played each time, in a random order. Each photo matched wins all its words.

The games box shows the words each game has won out of all the words it has. Any game can be replayed to win more.

The shapes to find are drawn in an SVG per photo, `build/images/<photo name>.svg` (`1.svg` for `1.jpg`), at the photo's pixel size:

- A shape's `id` is the thing it marks. For several of one thing, add `_` and anything else: `fruits_1`, `fruits_2`.
- Case is ignored. `<polygon>`, `<path>`, `<rect>`, `<circle>` and `<ellipse>` all work, and a group (`<g>`) with an id counts as one shape.
- The shapes' colours don't matter: the game hides them until it reveals them.
- Shapes that share an id (`rain`, `rain`…) each count as one thing, like `rain_1`, `rain_2`.

A missing SVG, a thing with no shape, or a word that isn't in the recording shows a warning next to the play button, and that photo or thing is left out. Reload the page to see edits.

## Add a prototype

Copy `build/prototype-01.html` to `build/prototype-02.html` and add a link to it in `build/index.html`.

## Deploy

`build/` is a static site: upload it to any static host (Netlify, itch.io, GitHub Pages, Cloudflare Pages).
