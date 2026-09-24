"""
Split a performance recording into tagged words.

Takes a .wav and its transcript (.txt, one line per spoken line), and:
  1. force-aligns the transcript to the audio (WhisperX / wav2vec2) to get
     word start/end times
  2. part-of-speech tags each line with spaCy and groups tags into game bins
  3. writes data/manifest.json + a 16-bit copy of the audio for the browser
  4. optionally writes one padded, faded .wav per word for auditioning

Setup (once):
  python3 -m venv preprocess/.venv
  preprocess/.venv/bin/pip install -r preprocess/requirements.txt
  preprocess/.venv/bin/python -m spacy download en_core_web_sm

Usage (with the venv's python):
  python preprocess/preprocess.py                    # uses the files in source/
  python preprocess/preprocess.py --clips              # also export per-word clips
  python preprocess/preprocess.py --separate --clips   # align on a Demucs vocal stem
"""

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

ROOT = Path(__file__).resolve().parent.parent

# spaCy UPOS tag -> bin shown to the player. Corrections, and bins spaCy can't
# know about (e.g. "yeah"), go in build/audio/bins.yaml, which the prototypes apply.
BINS = {
    "NOUN": "noun", "PROPN": "noun",
    "VERB": "verb", "AUX": "verb",
    "ADJ": "describer", "ADV": "describer",
    "PRON": "pronoun",
    "DET": "glue", "ADP": "glue", "CCONJ": "glue", "SCONJ": "glue", "PART": "glue",
    "NUM": "describer", "INTJ": "other", "X": "other", "SYM": "other", "PUNCT": "other",
}

LOW_SCORE = 0.4  # alignment confidence below which a word is flagged for checking


def find_one(folder: Path, pattern: str) -> Path:
    matches = sorted(folder.glob(pattern))
    if len(matches) != 1:
        sys.exit(f"expected exactly one {pattern} in {folder}, found {len(matches)}")
    return matches[0]


def read_transcript(path: Path) -> list[list[str]]:
    """Returns lines as lists of raw words. Drops [stage directions] and blank lines."""
    lines = []
    for raw in path.read_text(encoding="utf-8").splitlines():
        text = re.sub(r"\[[^\]]*\]", " ", raw).replace("’", "'").replace("‘", "'")
        words = text.split()
        if words:
            lines.append(words)
    return lines


def clean_word(w: str) -> str:
    """Strips surrounding punctuation, keeps internal apostrophes and hyphens."""
    return re.sub(r"^[^\w']+|[^\w']+$", "", w)


def separate_vocals(wav: Path, out_dir: Path) -> Path:
    subprocess.run(
        [sys.executable, "-m", "demucs", "--two-stems=vocals", "-o", str(out_dir / "demucs"), str(wav)],
        check=True,
    )
    return next((out_dir / "demucs").glob(f"*/{wav.stem}/vocals.wav"))


def align(wav: Path, words: list[str], device: str) -> list[dict]:
    import whisperx

    audio = whisperx.load_audio(str(wav))  # 16 kHz mono float32
    duration = len(audio) / whisperx.audio.SAMPLE_RATE
    model, meta = whisperx.load_align_model(language_code="en", device=device)
    # One segment spanning the whole file: CTC alignment handles the silences
    # between lines, and the transcript is short enough to fit in memory.
    segments = [{"text": " ".join(words), "start": 0.0, "end": duration}]
    result = whisperx.align(segments, model, meta, audio, device, return_char_alignments=False)
    aligned = result["word_segments"]
    if len(aligned) != len(words):
        sys.exit(f"aligner returned {len(aligned)} words for {len(words)} transcript words")
    return aligned


def tagging_text(words: list[str]) -> str:
    """spaCy mis-tags SHOUTED words, so lowercase all-caps words (except 'I') before tagging."""
    return " ".join(w.lower() if w.isupper() and len(clean_word(w)) > 1 else w for w in words)


def tag_line(nlp, words: list[str]) -> list[dict]:
    """Tags a whole line so context decides the tag, then maps spaCy tokens back to our words."""
    text = tagging_text(words)
    doc = nlp(text)
    tags, pos = [], 0
    for w in text.split(" "):
        start, end = pos, pos + len(w)
        pos = end + 1
        # A word can be several spaCy tokens ("banana-fish", "what's"). Use the
        # syntactic head of the span, ignoring surrounding punctuation.
        span = doc.char_span(start, end, alignment_mode="expand")
        toks = [t for t in span if not t.is_punct] or list(span)
        heads = [t for t in toks if t.head not in toks or t.head == t]
        tok = heads[0] if heads else toks[0]
        tags.append({"pos": tok.pos_, "tag": tok.tag_, "lemma": tok.lemma_.lower()})
    return tags


def write_clips(audio: np.ndarray, sr: int, words: list[dict], out_dir: Path, pad: float, fade: float):
    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.glob("*.wav"):
        old.unlink()
    n_fade = int(fade * sr)
    ramp = np.linspace(0.0, 1.0, n_fade)[:, None] if n_fade else None
    for w in words:
        a = max(0, int((w["start"] - pad) * sr))
        b = min(len(audio), int((w["end"] + pad) * sr))
        clip = audio[a:b].copy()
        if ramp is not None and len(clip) > 2 * n_fade:
            clip[:n_fade] *= ramp
            clip[-n_fade:] *= ramp[::-1]
        slug = re.sub(r"[^a-z0-9]+", "-", w["word"].lower()).strip("-")
        sf.write(out_dir / f"{w['id']:04d}_{w['bin']}_{slug}.wav", clip, sr, subtype="PCM_16")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--wav", type=Path, help="default: the .wav in source/")
    p.add_argument("--transcript", type=Path, help="default: the .txt in source/")
    p.add_argument("--out", type=Path, default=ROOT / "data")
    p.add_argument("--separate", action="store_true", help="align on a Demucs vocal stem (for audio with music)")
    p.add_argument("--clips", action="store_true", help="export one .wav per word to <out>/clips")
    p.add_argument("--pad", type=float, default=0.03, help="seconds of padding around clips (default 0.03)")
    p.add_argument("--fade", type=float, default=0.008, help="clip fade in/out seconds (default 0.008)")
    p.add_argument("--device", default="cpu")
    args = p.parse_args()

    wav = args.wav or find_one(ROOT / "source", "*.wav")
    transcript = args.transcript or find_one(ROOT / "source", "*.txt")
    out = args.out
    out.mkdir(parents=True, exist_ok=True)

    lines = read_transcript(transcript)
    flat = [(li, wi, raw) for li, line in enumerate(lines) for wi, raw in enumerate(line)]
    print(f"{len(lines)} lines, {len(flat)} words from {transcript.name}")

    align_wav = wav
    if args.separate:
        print("separating vocals with demucs...")
        align_wav = separate_vocals(wav, out)

    print("aligning...")
    aligned = align(align_wav, [clean_word(raw) or raw for _, _, raw in flat], args.device)

    print("tagging...")
    import spacy
    nlp = spacy.load("en_core_web_sm")
    line_tags = [tag_line(nlp, line) for line in lines]

    words = []
    for i, ((li, wi, raw), a) in enumerate(zip(flat, aligned)):
        t = line_tags[li][wi]
        words.append({
            "id": i,
            "word": clean_word(raw) or raw,
            "raw": raw,
            "line": li,
            "index": wi,
            "start": round(a["start"], 3) if "start" in a else None,
            "end": round(a["end"], 3) if "end" in a else None,
            "score": round(a.get("score", 0.0), 3),
            "bin": BINS.get(t["pos"], "other"),
            **t,
        })

    # Browser copy of the audio: 16-bit PCM decodes everywhere and keeps sample-accurate timing
    audio, sr = sf.read(wav, always_2d=True)
    sf.write(out / "audio.wav", audio, sr, subtype="PCM_16")

    manifest = {
        "source": wav.name,
        "audio": "audio.wav",
        "sampleRate": sr,
        "duration": round(len(audio) / sr, 3),
        "alignedOn": "vocals" if args.separate else "original",
        "lines": [
            {"id": li, "text": " ".join(line), "wordIds": [w["id"] for w in words if w["line"] == li]}
            for li, line in enumerate(lines)
        ],
        "words": words,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False))

    if args.clips:
        write_clips(audio, sr, words, out / "clips", args.pad, args.fade)

    by_bin = {}
    for w in words:
        by_bin.setdefault(w["bin"], []).append(w["word"])
    print(f"\nwrote {out / 'manifest.json'}")
    for b, ws in sorted(by_bin.items()):
        print(f"  {b:10s} {len(ws):3d}  {', '.join(ws[:12])}{' ...' if len(ws) > 12 else ''}")
    flagged = [w for w in words if w["start"] is None or w["score"] < LOW_SCORE]
    if flagged:
        print(f"\n{len(flagged)} words with low alignment confidence (check these):")
        for w in flagged:
            print(f"  #{w['id']:<4d} line {w['line']:<3d} {w['raw']:<16s} {w['start']}-{w['end']}  score {w['score']}")


if __name__ == "__main__":
    main()
