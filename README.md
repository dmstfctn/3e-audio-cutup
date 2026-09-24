# cutup-proto

A browser game where players drag words cut from a recorded performance into four 2-bar lines over a 144 bpm beat. A Python script splits the recording into words, with timings and part-of-speech tags, and the prototypes in `build/` use that data.

## Layout

```
source/       original recording (.wav) and transcript (.txt, one spoken line per line)
preprocess/   word alignment + tagging script
data/         preprocess output (manifest.json kept; audio + clips regenerable)
build/        static site: prototypes + the audio/data they load
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

To fix a wrong category, edit the word's `bin` in `build/audio/words.json`. The bins are `noun`, `verb`, `describer`, `pronoun`, `glue` and `other`. Re-running the script overwrites these edits.

## Add a prototype

Copy `build/prototype-01.html` to `build/prototype-02.html` and add a link to it in `build/index.html`.

## Deploy

`build/` is a static site: upload it to any static host (Netlify, itch.io, GitHub Pages, Cloudflare Pages).
