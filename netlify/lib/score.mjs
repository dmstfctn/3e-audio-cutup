// Checks a submission's score (see hosting-plan.md) and returns a clean copy of it, or throws with the problem.
// Every word has to be a real recording from the manifest it names, played from near its own bounds, so nobody can
// post any stretch of the recording with any text over it. load(file) fetches a file from the site's audio/v/.

const WORDS_MP3 = /^words\.[0-9a-f]{8}\.mp3$/;
const MANIFEST = /^words\.[0-9a-f]{8}\.json$/;
const TRACK = /^[\w-]+\.[0-9a-f]{8}\.mp3$/;
const NAME = /^[a-z0-9-]{1,20}$/;
const SLACK = 0.5;       // seconds a clip may reach past its word's aligned bounds (the clip picker's trims)
const MAX_LINES = 8, MAX_WORDS = 64;

const manifests = new Map();  // file -> promise of id -> word; the files never change, so they're kept
const files = new Map();      // file -> promise of whether it's on the site

class Problem extends Error {}
const fail = msg => { throw new Problem(msg); };
const num = (x, lo, hi) => typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi;

export async function checkScore(score, load) {
  if (!score || typeof score !== 'object' || score.v !== 1) fail('expected a score, v 1');
  const { audio, bpm, beats, fade, lines } = score;
  if (!num(bpm, 40, 300) || !Number.isInteger(beats) || !num(beats, 1, 32) || !num(fade, 0, 0.1)) fail('bpm, beats or fade');
  const lineDur = beats * 60 / bpm;

  if (!audio || !WORDS_MP3.test(audio.words) || !MANIFEST.test(audio.manifest)) fail('audio: words or manifest');
  const tracks = Object.entries(audio.tracks ?? {});
  if (tracks.length > 8 || tracks.some(([name, file]) => !NAME.test(name) || !TRACK.test(file))) fail('audio: tracks');
  const missing = [];
  await Promise.all([audio.words, ...tracks.map(([, f]) => f)].map(async f => {
    if (!files.has(f)) files.set(f, load(f, 'HEAD').then(r => r.ok, () => { files.delete(f); return false; }));
    if (!await files.get(f)) missing.push(f);
  }));
  if (missing.length) fail(`not on the site: ${missing.join(', ')}`);
  if (!manifests.has(audio.manifest)) {
    manifests.set(audio.manifest, load(audio.manifest).then(async r => {
      if (!r.ok) throw new Problem(`not on the site: ${audio.manifest}`);
      return new Map((await r.json()).words.map(w => [w.id, w]));
    }));
    manifests.get(audio.manifest).catch(() => manifests.delete(audio.manifest));
  }
  const known = await manifests.get(audio.manifest);

  if (!Array.isArray(lines) || !lines.length || lines.length > MAX_LINES) fail(`1 to ${MAX_LINES} lines`);
  let said = 0;
  const clean = lines.map((line, i) => {
    if (!line || !Number.isInteger(line.bar) || !num(line.bar, 0, 63)) fail(`line ${i + 1}: bar`);
    if (!Array.isArray(line.words) || line.words.length > MAX_WORDS) fail(`line ${i + 1}: words`);
    let dur = 0;
    const words = line.words.map((w, k) => {
      const where = `line ${i + 1} word ${k + 1}`;
      if (w && 'rest' in w) {
        if (!num(w.rest, 0.001, lineDur)) fail(`${where}: rest`);
        dur += w.rest;
        return { rest: w.rest };
      }
      const m = known.get(w?.id);
      if (!m || !Number.isInteger(w.id)) fail(`${where}: no recording ${w?.id}`);
      if (w.text !== m.word.toLowerCase() && w.text !== m.raw.toLowerCase()) fail(`${where}: text`);
      if (typeof w.bin !== 'string' || !NAME.test(w.bin)) fail(`${where}: bin`);
      if (!num(w.s, m.start - SLACK, m.end) || !num(w.d, 0.001, m.end + SLACK - w.s)) fail(`${where}: times`);
      dur += w.d;
      said++;
      return { id: w.id, text: w.text, bin: w.bin, s: w.s, d: w.d };
    });
    if (dur > lineDur + 0.01) fail(`line ${i + 1}: longer than a line`);
    return { bar: line.bar, words };
  });
  if (!said) fail('no words');
  return {
    v: 1,
    audio: { words: audio.words, manifest: audio.manifest, tracks: Object.fromEntries(tracks) },
    bpm, beats, fade, lines: clean,
  };
}

export const isProblem = e => e instanceof Problem;

// the lines as text, a line per line, pauses left out
export const scoreText = score => score.lines.map(l => l.words.filter(w => !('rest' in w)).map(w => w.text).join(' ')).join('\n');
