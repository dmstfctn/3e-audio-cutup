# cutup-proto

A browser game where players cut words from a recorded performance into 2-bar lines over a 144 bpm beat. A Python script splits the recording into words, with timings and part-of-speech tags, and the game in `build/` uses that data. The prototypes it grew from are in `prototype/`.

## Layout

```
source/       original recording (.wav) and transcript (.txt, one spoken line per line)
preprocess/   word alignment + tagging script
data/         preprocess output (manifest.json kept; audio + clips regenerable)
build/        the game: a static site with everything it loads
prototype/    the prototypes (01–09) and tools, with the audio and data they load
```

## Run the game

```
cd build
python3 -m http.server
```

Open http://localhost:8000. The page must be served, because opening the HTML file directly (`file://`) can't load the audio.

The game started as a copy of prototype-09 (see [Two lines, live rewards](#two-lines-live-rewards-prototype-09)), and is changed in place from here on. `build/` holds everything it needs, some of it copied from `prototype/`, so the two can change separately.

- `build/index.html`: the page
- `build/config/`: what to edit to change the content. Each file's comments explain it.
  - `games.yaml`: the games' photos, shapes, words, settings and unlocks, and the tracks
  - `story.yaml`: the order the game runs in (pages of text, tries, games, the end), the first line and its words, and the words given for writing
  - `bins.yaml`: word category fixes (see [Fix word categories](#fix-word-categories))
  - `clips.json`: trims and recordings switched off, from the clip picker (see [Trim and pick recordings](#trim-and-pick-recordings)). Optional.
- `build/javascript/`: `main.js` runs the page, `minigames.js` the games, and `lib/` holds js-yaml
- `build/style/`: the page's styles (`style.css`) and the games' (`minigames.css`)
- `build/audio/`: the cut-up recording (`words.mp3`, `words.json`; `words.wav` is kept) and the tracks
- `build/images/`: the photos and their shapes
- `build/tools/clippicker.html`: the clip picker

## Run the prototypes

```
cd prototype
python3 -m http.server
```

Open http://localhost:8000 for the list of prototypes and tools.

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
lame --quiet -V 2 build/audio/words.wav build/audio/words.mp3
cp data/manifest.json build/audio/words.json
```

Copy them to `prototype/audio/` as well to update the prototypes (the prototypes play the `.wav`). The game plays the `.mp3`. Make it with `lame`, whose header tells browsers how much silence the encoder added at the start, so they trim it and the words' times still line up.

The script prints the words in each category and a list of words with low alignment confidence. Listen to those in `data/clips/`. A low score usually means the transcript doesn't match what's said at that point.

Options:

- `--clips`: write one .wav per word to `data/clips/` for auditioning
- `--separate`: isolate vocals with Demucs before aligning (for speech over music; `pip install demucs` first)
- `--pad`, `--fade`: clip padding and fade in seconds (defaults 0.03, 0.008). The game sets its own padding (`PAD`) and fade (`FADE`).
- `--wav`, `--transcript`: use files other than the ones in `source/`

## Trim and pick recordings

With the game served, open http://localhost:8000/tools/clippicker.html. It lists every recording of every word, A–Z, each over its stretch of the recording.

- Click the block or ▶ to hear the clip as the game plays it. Shift-click ▶ to hear the context around it.
- Drag the block's left or right edge to trim it. It plays when you let go. The dashed lines are the default bounds, and **reset** goes back to them.
- Untick a recording to leave it out of the game's tray. A word with every recording unticked isn't offered at all.
- **export clips.json** downloads the file. Move it to `build/config/clips.json` and reload the game. The file lists only the recordings changed from the defaults, by id, with their times in seconds (padding included).
- Edits are kept in the browser until they're exported. **revert** drops them and goes back to `config/clips.json`.

Without `clips.json`, every recording plays from `PAD` before its aligned start to `PAD` after its end. The tray picks its `TAKES` recordings of a word from those left on. Re-running preprocessing can renumber the recordings. The game then leaves out the entries whose word no longer matches, with a warning above the lines.

## Fix word categories

The preprocess script guesses each word's category (`bin`) from its part of speech, and gets some wrong. Corrections go in `build/config/bins.yaml` (and `prototype/audio/bins.yaml` for the prototypes). The game loads it and applies it over `words.json`, so it survives re-running preprocessing, and anyone can edit it without the Python setup.

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
- Reload the page to see edits. Problems (a word that isn't in the recording, a word listed under two bins, a YAML syntax error) show above the lines (next to the play button in the prototypes).

The script's bins are `noun`, `verb`, `describer`, `pronoun`, `glue` and `other`. The `yeah` bin only exists in `bins.yaml`.

## Tag words to images (prototype-02)

In prototype-02's first two stages the palette deals a few random nouns, verbs, adjectives and yeahs to go with an image. `prototype/images/tags.yaml` sets words that always come up with a given image:

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

Prototype-03 opens with the first line of a couplet from `prototype/words/lines.txt`, with one word switched for another from the same bin. The next step brings in the second line, cut short at the `/`, and the player finishes it from the tray. Write each couplet as two lines, with a blank line between couplets:

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

Prototype-04 opens with one line from `prototype/words/first-lines.txt`, one line per line of the file, and a blank second line comes next. The tray starts with the words in `prototype/words/tray.yaml`, grouped by bin:

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
- The game code is in `prototype/minigames/minigames.js`, and the rules text is in `GAMES` in `prototype-05.html`.
- The games' data is in `prototype/minigames/*.json`, copied from the 3e-coco-games pages. After rebuilding the games there, copy it again:

  ```
  python3 preprocess/import_minigames.py ../3e-coco-games
  ```

- The photos load from COCO's image host, which only serves `http://`. A deploy served over `https://` will block them until they're hosted elsewhere.

## Minigame content (prototype-06)

Prototype-06 plays like prototype-05, but the games use set photos from `prototype/images/`, and each one wins set words. Only Find It plays automatically, before the 4-line stage. Caption Match and Find Them All are unlocked by the 6-line and 8-line stages: the lines come straight away, and a notice offers **play** or **continue writing**. An unlocked game stays in the games box until it's played. All of it is in `prototype/minigames/games.yaml`, which explains itself in its comments. For each game it holds:

- the photos, what to find in each one (or, for Caption Match, the caption and the two decoy photos), and an optional prompt
- the words each photo wins, grouped by bin as in `tray.yaml`
- the settings: seconds, zoom and click tolerance, and the rules text shown before the game

How the words are won:

- **Find It:** each play shows one photo and one thing to find, picked from the things not found yet. Finding it wins the thing's own word and half of the photo's other words. Things to find don't count as other words. Finding the photo's last thing wins the rest.
- **Find Them All:** one photo per play. What's found adds up over plays of the same photo. A bar shows the count, with a notch where each word is won: with 10 to find and 5 words, one word per 2 found. The thing's own word comes first, then the others in the order listed.
- **Caption Match:** every round is played each time, in a random order. Each photo matched wins all its words.

The games box shows the words each game has won out of all the words it has. Any game can be replayed to win more.

The shapes to find are drawn in an SVG per photo, `prototype/images/<photo name>.svg` (`1.svg` for `1.jpg`), at the photo's pixel size:

- A shape's `id` is the thing it marks. For several of one thing, add `_` and anything else: `fruits_1`, `fruits_2`.
- Case is ignored. `<polygon>`, `<path>`, `<rect>`, `<circle>` and `<ellipse>` all work, and a group (`<g>`) with an id counts as one shape.
- The shapes' colours don't matter: the game hides them until it reveals them.
- Shapes that share an id (`rain`, `rain`…) each count as one thing, like `rain_1`, `rain_2`.

A missing SVG, a thing with no shape, or a word that isn't in the recording shows a warning next to the play button, and that photo or thing is left out. Reload the page to see edits.

## Story, work and unlocks (prototype-07)

Prototype-07 uses prototype-06's games and content. It's a one-shot game in six parts:

1. **Intro:** screens of text.
2. **First line:** 4 lines over the metronome, with the first line filled in and a few words in the tray, for 15 seconds. Then a notice sends the player on.
3. **Brief:** screens of text before work.
4. **Work:** Find It, Find Them All, then Caption Match. Each is played once through: every thing in every photo, every photo, every round. After each one, a summary lists the words won, the points and any track unlocked, with **retry** (plays that game again and replaces its result) and **next task**. Once work is done it can't be played again.
5. **Debrief:** screens of text after work.
6. **Writing:** the 4 lines as the player left them, the first stage's words, everything won, and a set list of words, every yeah and pauses of several lengths. The metronome plays. Buttons at the top switch to any track unlocked. **submit** shows the lines on their own, centred, and plays them once.

All the text, the first line, the first stage's words and time limit, and the words given for writing are in `prototype/words/story-07.yaml`. The file's comments explain it. Words match as in `tray.yaml`, and a word that isn't in the recording or is listed under the wrong bin shows a warning next to the play button. Reload the page to see edits. The first line and first words apply from the next new game (restart).

Points and words:

- **Find It:** one point per thing found. A thing found wins its own word and a share of its photo's other words (the photo's things share them out). The share is all of it for finding the thing in up to half the time, falling to none a second before the end.
- **Find Them All:** one point per shape found. Each photo's bar wins its words as in prototype-06. A photo with `reach: 15` in `games.yaml` finds every shape within 15 of the photo's pixels on each click. This is for photos with many small shapes, like the rain in `12.jpg`.
- **Caption Match:** one point per round matched, which wins that round's words.

The tracks a score unlocks are set in `prototype/minigames/games.yaml`, under each game's `unlocks`, with the tracks under `tracks` at the top. Each unlock is given when the score is more than its `above`:

```yaml
find-all:
  unlocks:
    - above: 50%
      track: drums     # from tracks
```

The Find Them All rules card comes from `rules-07` in `games.yaml`, because 06's wording talks about finds adding up across plays.

## Pair It (prototype-08)

Prototype-08 is prototype-07 with a fourth game, Pair It, from [3e-coco-games](../3e-coco-games)' game 11 (Same Energy). Work plays Find It, Pair It, Find Them All, then Caption Match.

- **Pair It:** every pair's photos are shuffled into one grid, with one timer for all of them. Click a photo, then the one with the same energy. A match shrinks away and wins the pair's words, and a wrong pair flashes red. One point per pair matched.
- The first stage shows all 4 lines, but only the first can be used. The others open for writing.
- The pairs, the words they win, the prompt, the timer and the rules card are under `pair-it` in `prototype/minigames/games.yaml`. It can have `unlocks` like the other games. Prototypes 06 and 07 ignore it.
- The photos are in `prototype/images/pair-it/`, copied from `3e-coco-games/game-prototypes/same-energy/`.
- The story is in `prototype/words/story-08.yaml`, a copy of `story-07.yaml` to start with.
- The game code is in `prototype/minigames/minigames-08.js`, which is `minigames-07.js` with Pair It added.

## Two lines, live rewards (prototype-09)

Prototype-09 plays in the same six parts as prototype-08, with these changes:

- **Screens:** the text shows a line at a time. The button says **next** until the last line, then shows the screen's own button. The **next** label is `next` in `prototype/words/story-09.yaml`.
- **Lines:** there are 2 lines, with no on/off, clear or move buttons. Clicking a tray word adds it after the word added last. If it doesn't fit there, it goes at the end of the other line. Clicking a word in a line removes it, and dragging still rearranges words. Pointing at a word plays it.
- **Every recording:** the tray shows every recording of each word, so "a" shows 20 times. A word won wins all its recordings. The first line always uses the first recording of each word.
- **First stage:** both lines are open, and it's silent. The time limit still applies, but no timer shows.
- **Tracks:** nothing plays until a track is unlocked. From work on, the tracks unlocked show as toggles at the top of the page, and any mix of them can be on. The full track has the others in it, so while it's on, the others are muted. The lines loop the first 4 bars of the tracks. When writing, the lines play over whatever's on, or on their own if nothing is.
- **Games:** each game starts without a rules card. Words won fly from the click to a strip at the bottom of the page, and a track unlocked appears at the top and comes on. The summary after each game still lists what was won. A retry clears that game's words from the strip.
  - **Find It:** a miss shows a red ring, and the player keeps looking until time runs out. Finding one thing unlocks the metronome.
  - **Pair It:** matching one pair unlocks the drums.
  - **Find Them All:** the whole photo shows, with no zoom. The first thing found wins the thing's own word and unlocks the full track. The other words come at the notches on the bar, as before.
  - **Caption Match:** the caption shows at the top as `select the image that shows: "…"`, set by `prompt` under `caption-match`. It unlocks nothing.

`games.yaml` is shared, so 09's changes go in keys that only 09 reads, and 06–08 play as before:

- `unlocks-09` sets a game's unlocks for 09. Where a game has none, 09 uses `unlocks`.
- `reach-09` sets a photo's reach for 09. `12.jpg` has `reach-09: 30`, because the rain is smaller on the whole photo.

The story is in `prototype/words/story-09.yaml`, and the games are in `prototype/minigames/minigames-09.js`.

## Tools

- `prototype/tools-test-find-all-svg.html`: drop a photo and its shapes (.svg) on the page to check them before they go in `games.yaml`. It outlines every shape over the photo, lists the things the ids mark with their counts, and warns when the SVG's proportions don't match the photo's or its name isn't the one the game looks for. Choose a thing and press **play** to try it in Find Them All, as the game plays it (the whole photo, not zoomed in), with the seconds, tolerance, reach and number of words set on the page. When the page is served, these start from `games.yaml`, including the photo's own entry if it has one. Drop a new .svg at any time to try an edit with the same photo.

## Deploy

`build/` is a static site: upload it to any static host (Netlify, itch.io, GitHub Pages, Cloudflare Pages).
