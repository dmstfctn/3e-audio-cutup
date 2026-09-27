const BPM = 143.59;
const BEATS_PER_LINE = 8;                       // 2 bars of 4/4
const LINE_DUR = BEATS_PER_LINE * 60 / BPM;     // 3.343s
const N_LINES = 2;
const TRACK_LINES = 2;                          // lines loop the tracks' first 4 bars
const PAD = 0.03;                               // seconds around each word's aligned bounds
const FADE = 0.008;                             // seconds of fade in/out on each word
const LOOKAHEAD = 0.15;                         // how far ahead lines are scheduled
const ENTER_SPREAD = 1.2;                       // seconds over which the words won drop into the tray
const FLY_GAP = 120;                            // the gap between words won together flying to the strip
// how long a point, a word and a track take to fly to the counter, the strip and the bar: each 10% slower than the last
const POINT_FLY_MS = 700, WORD_FLY_MS = POINT_FLY_MS * 1.1, TRACK_FLY_MS = WORD_FLY_MS * 1.1;
const SHRINK_MS = 250, SHRINK_GAP = 60;         // a word a retry clears shrinking out of the strip, and the gap between words
const DROP_MS = 700, DROP_SPREAD = 1.5;         // a point a retry takes back dropping from the counter, and the most time they all take
// The game runs through these phases. Their texts, the first stage's line and words, and the words
// given for writing come from config/story.yaml (see its comments).
//   intro:   screens of text, shown a line at a time; the last one's button starts the first stage
//   first:   the lines, the first filled in, with a few words, silent, for first.seconds (not shown);
//            then the time-up notice sends the player on
//   brief:   screens of text before work
//   work:    the games in GAME_ORDER, each played through once, with a summary after that offers a retry;
//            words won fly to the strip at the bottom, tracks unlocked show in the bar at the top
//   debrief: screens of text after work
//   write:   the lines as the first stage left them, its words, what the games won, the write words, and
//            the tracks unlocked; the lines loop, and submit plays them once on their own
const PHASES = ['intro', 'first', 'brief', 'work', 'debrief', 'write'];
const SCREENS = ['intro', 'brief', 'debrief'];  // the phases that are screens of text
const MUSIC = ['work', 'debrief', 'write'];     // the phases with the tracks bar; the lines only play in write
const GAME_ORDER = ['find', 'pair-it', 'find-all', 'caption-match'];
// Minigames (javascript/minigames.js). Their photos, shapes, words and settings come from
// config/games.yaml; these are the settings a game gets when games.yaml leaves one out. points is what
// each thing found, pair or round matched, or shape found is worth.
// What a score unlocks beyond the words is under each game's unlocks, and the tracks under tracks.
const GAME_DEFAULTS = {
  'find': { title: 'find it', seconds: 5, tolerance: 10, points: 1 },
  'pair-it': { title: 'pair it', seconds: 15, prompt: 'click two photos with the same energy', points: 1 },
  'caption-match': { title: 'caption match', seconds: [6, 4, 3], prompt: 'select the image that shows: "{caption}"', points: 1 },
  'find-all': { title: 'find them all', seconds: 15, tolerance: 10, points: 1 },
};
// tracks that have the others in them: while one is on, the others are muted
const SOLO_TRACKS = ['full'];
const BIN_ORDER = ['rest', 'yeah', 'noun', 'verb', 'describer', 'pronoun', 'glue', 'other'];
const BIN_COLORS = {
  rest: 'white', yeah: 'gold', noun: 'lightskyblue', verb: 'lightsalmon', describer: 'palegreen',
  pronoun: 'plum', glue: 'lightgray', other: 'khaki',
};
// handed out in order to bins that only exist in bins.yaml
const EXTRA_COLORS = ['lightpink', 'aquamarine', 'peachpuff', 'lightsteelblue', 'wheat', 'thistle', 'palegoldenrod', 'paleturquoise'];
const BIN_LABELS = { rest: 'pause' };
const STORE_KEY = 'cutup';

const ctx = new AudioContext();
let trackBufs = {}, wordsBuf;  // track url -> buffer
const trackGains = {};  // track name -> its gain, so a toggle is heard straight away
let words = {};  // id -> { id, text, bin, a, d }; pauses have no audio (a = null)
let takes = {};  // text -> the ids of its recordings, in recording order
let binOrder = [...BIN_ORDER];  // palette sections: pauses, bins.yaml's order, then any bins it leaves out
let GAMES = {};       // game key -> its content and settings from games.yaml; a key missing can't be played
// games.yaml: tracks as [name, url], and game key -> its unlocks [{ above, track, text }]
let TRACKS = [['metronome', 'audio/track-metronome.wav'], ['drums', 'audio/track-drums.wav'], ['full', 'audio/track-full.wav']];
let REWARDS = {};
// config/story.yaml, filled in by loadStory; screens are [{ text, button }], words are texts
let STORY = null;

// state: lines[i] is an array of word ids in play order
let phase = 'intro';
let step = 0;      // the screen showing, in a phase of screens
let shown = 1;     // how many of the screen's lines are showing
let task = 0;      // index in GAME_ORDER of the game being played at work
let start = [];    // texts of the words the first stage gives: the first line's, then the rest of first.words
// game key -> the result of its last run: { points, total, words: [texts], tracks, notes: [text] }
let results = {};
let run = null;    // the game being played: its plays, and what it's won so far
let trackOn = {};  // track name -> whether its toggle is on
let shownPoints = 0;  // the counter at the top right: the points that have landed there
let landed = {};      // game key -> its points that have landed on the counter, so a retry takes back as many
const flyingTracks = new Set();  // tracks unlocked whose toggle is still flying to the bar, kept hidden till it lands
let last = null;   // [line, index] of the word added last, where a clicked word goes after
const lines = Array.from({ length: N_LINES }, () => []);

const $ = s => document.querySelector(s);
const lineEls = [], markerEls = [], playheadEls = [];

// ---------- loading ----------

async function load() {
  const decode = url => fetch(url).then(r => r.arrayBuffer()).then(b => ctx.decodeAudioData(b));
  try {
    const [doc, story] = await Promise.all([readGames(), readYaml('config/story.yaml')]);
    loadUnlocks(doc);  // first: it says which tracks to load
    const [manifest, voice, ...tracks] = await Promise.all([
      fetch('audio/words.json').then(r => r.json()),
      decode('audio/words.wav'),
      // all up front, so an unlocked track never waits; one that won't load is left silent
      ...TRACKS.map(([name, url]) => decode(url).catch(() => { warnings.push(`track ${name} (${url}) didn't load`); return null; })),
    ]);
    TRACKS.forEach(([name, url], k) => {
      if (tracks[k]) trackBufs[url] = tracks[k];
      trackGains[name] = ctx.createGain();
      trackGains[name].gain.value = 0;
      trackGains[name].connect(ctx.destination);
    });
    wordsBuf = voice;
    for (const w of manifest.words) {
      const a = Math.max(0, w.start - PAD);
      const b = Math.min(voice.duration, w.end + PAD);
      words[w.id] = { id: w.id, text: w.word.toLowerCase(), raw: w.raw.toLowerCase(), bin: w.bin, line: w.line, a, d: b - a };
    }
    await applyBinOverrides();
    for (const w of Object.values(words)) (takes[w.text] ??= []).push(w.id);
    loadStory(story);
    await loadGames(doc);
  } catch (e) {
    $('#screen-text').textContent = 'could not load — serve this folder, e.g. `python3 -m http.server` in build/, then open http://localhost:8000';
    $('#screen-go').textContent = 'couldn\'t load';
    throw e;
  }
  if (!restore()) newGame();
  buildLines();
  $('#palette').addEventListener('dragover', onPaletteDragOver);
  $('#palette').addEventListener('drop', onPaletteDrop);
  new ResizeObserver(sizeToWindow).observe(lineEls[0]);
  $('#status').textContent = warnings.join(' · ');
  showScreen();
  showPhase();
  applyGains();
  if (phase === 'first') startTimer();  // a reload gives the whole time again
  if (phase === 'work') { fillStrip(); openTask(); }
}

// bins.yaml maps bin -> [words] and moves every occurrence of each word (ignoring case)
// into that bin; words it doesn't list keep the bin from words.json.
// An entry written with the transcript's punctuation ("yeh!") only matches that spelling,
// shows it, and beats the plain entry ("yeh"), which covers the rest.
const warnings = [];
async function applyBinOverrides() {
  let doc = {};
  try {
    const r = await fetch('config/bins.yaml', { cache: 'no-cache' });  // pick up edits on reload
    if (r.ok) doc = jsyaml.load(await r.text()) || {};  // no file: use the tagger's bins
    if (typeof doc !== 'object' || Array.isArray(doc)) throw new Error('expected bin names with lists of words');
  } catch (e) {
    warnings.push(`bins.yaml ignored, could not read it: ${e.message}`);
    doc = {};
  }
  const all = Object.values(words);
  const texts = new Set(all.map(w => w.text));
  const punctuated = new Set(all.filter(w => w.raw !== w.text).map(w => w.raw));
  const textBins = {}, rawBins = {}, unknown = [], twice = [];
  const yamlOrder = [];
  for (const [bin, list] of Object.entries(doc)) {
    if (bin === 'rest') { warnings.push('bins.yaml: "rest" is reserved for pauses'); continue; }
    yamlOrder.push(bin);
    for (const item of [].concat(list ?? [])) {  // a lone word works as well as a list
      const entry = String(item).toLowerCase().trim();
      const bins = punctuated.has(entry) ? rawBins : texts.has(entry) ? textBins : null;
      if (!bins) { unknown.push(entry); continue; }
      if (bins[entry]) twice.push(`${entry} (${bins[entry]}, ${bin})`);
      bins[entry] = bin;
    }
  }
  for (const w of all) {
    if (rawBins[w.raw]) { w.bin = rawBins[w.raw]; w.text = w.raw; }
    else if (textBins[w.text]) w.bin = textBins[w.text];
  }
  if (unknown.length) warnings.push(`bins.yaml: not in the recording: ${unknown.join(', ')}`);
  if (twice.length) warnings.push(`bins.yaml: listed twice, last one used: ${twice.join(', ')}`);
  // bins from words.json that bins.yaml doesn't mention still get a section, after its bins
  binOrder = [...new Set(['rest', ...yamlOrder, ...BIN_ORDER, ...all.map(w => w.bin)])];
  binOrder.filter(b => !BIN_COLORS[b]).forEach((b, i) => BIN_COLORS[b] = EXTRA_COLORS[i % EXTRA_COLORS.length]);
}

// Matches a word as bins.yaml does: the shown spelling first, so "yeh!" finds the split-off
// word rather than any "yeh", then the transcript's. Apostrophes are ignored, so that’s = thats.
function findWord(token) {
  const bare = s => s.replace(/['’]/g, '');
  const all = Object.values(words).filter(w => w.bin !== 'rest');
  return all.find(w => bare(w.text) === bare(token)) ?? all.find(w => bare(w.raw) === bare(token));
}

// a YAML file of names and their settings, or null if it can't be read (with a warning)
async function readYaml(file, missing = `no ${file}`) {
  try {
    const r = await fetch(file, { cache: 'no-cache' });  // pick up edits on reload
    if (!r.ok) { warnings.push(missing); return null; }
    const doc = jsyaml.load(await r.text()) || {};
    if (typeof doc !== 'object' || Array.isArray(doc)) throw new Error('expected names with their settings');
    return doc;
  } catch (e) {
    warnings.push(`${file} ignored, could not read it: ${e.message}`);
    return null;
  }
}
const readGames = () => readYaml('config/games.yaml', 'no config/games.yaml: the games can\'t be played');

// config/story.yaml: the screens of text, the first stage's line and words, and the words given for
// writing (see the file's comments). Anything missing or wrong gets a stand-in, with a warning.
function loadStory(doc) {
  const problems = [], unknown = new Set(), misfiled = new Set();
  const list = v => [].concat(v ?? []).map(x => String(x).trim()).filter(Boolean);  // a lone item works as well as a list
  doc ??= {};
  const screen = (where, s) => {
    if (!s || typeof s !== 'object') { problems.push(`${where}: expected a text and a button`); s = {}; }
    return { text: String(s.text ?? '').trim(), button: String(s.button ?? 'continue') };
  };
  const screens = key => {
    const out = [].concat(doc[key] ?? []).map((s, k) => screen(`${key} ${k + 1}`, s));
    if (!out.length) { problems.push(`${key}: no screens`); out.push(screen(key, {})); }
    return out;
  };
  // texts of the words listed by bin; a word counts as in its bin if any recording of it is
  const byBin = (where, bins) => {
    if (bins != null && (typeof bins !== 'object' || Array.isArray(bins))) { problems.push(`${where}: expected bin names with lists of words`); return []; }
    const texts = [];
    for (const [bin, items] of Object.entries(bins ?? {})) for (const item of list(items)) {
      const w = findWord(item.toLowerCase());
      if (!w) { unknown.add(item); continue; }
      if (!Object.values(words).some(v => v.text === w.text && v.bin === bin)) misfiled.add(`${w.text} is ${w.bin}, not ${bin}`);
      if (!texts.includes(w.text)) texts.push(w.text);
    }
    return texts;
  };
  const first = doc.first ?? {};
  const seconds = Number(first.seconds ?? 15);
  if (!(seconds > 0)) problems.push('first: seconds should be a number');
  // the line's words, in order, repeats kept; punctuation around a word is ignored
  const line = String(first.line ?? '').split(/\s+/).map(t => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')).filter(Boolean)
    .flatMap(t => { const w = findWord(t.toLowerCase()); if (!w) unknown.add(t); return w ? [w.text] : []; });
  const write = doc.write ?? {};
  const pauses = [].concat(write.pauses ?? []).map(Number).filter(b => {
    if (b > 0 && b <= BEATS_PER_LINE) return true;
    problems.push(`write: pause ${b} should be a number of beats up to ${BEATS_PER_LINE}`);
    return false;
  });
  let yeahs = [];
  if (String(write.yeahs).toLowerCase() === 'all') yeahs = yeahTexts();
  else yeahs = byBin('write yeahs', { yeah: write.yeahs });
  STORY = {
    next: String(doc.next ?? 'next'),
    intro: screens('intro'),
    first: { seconds: seconds > 0 ? seconds : 15, line, words: byBin('first', first.words),
      timeUp: screen('first time-up', first['time-up']) },
    brief: screens('brief'),
    lastButton: String(doc.work?.['last-button'] ?? 'finish work'),
    debrief: screens('debrief'),
    write: { words: [...byBin('write', write.words), ...yeahs], pauses },
  };
  if (problems.length) warnings.push(`story.yaml: ${problems.join('; ')}`);
  if (unknown.size) warnings.push(`story.yaml: not in the recording: ${[...unknown].join(', ')}`);
  if (misfiled.size) warnings.push(`story.yaml: in another bin, shown there: ${[...misfiled].join(', ')}`);
}

// games.yaml's tracks, and each game's unlocks: what its score wins beyond words (see the file's comments). An unlock with a problem is left out, with a warning.
function loadUnlocks(doc) {
  if (!doc) return;
  const problems = [];
  const percent = v => { const n = parseFloat(String(v)); return Number.isFinite(n) ? n : null; };  // 25% or 25
  if (doc.tracks != null) {
    if (typeof doc.tracks === 'object' && !Array.isArray(doc.tracks) && Object.keys(doc.tracks).length) {
      TRACKS = Object.entries(doc.tracks).map(([name, url]) => [name, String(url)]);
    } else problems.push('tracks: expected names with their files');
  }
  for (const key of GAME_ORDER) {
    REWARDS[key] = [];
    for (const [k, r] of [].concat(doc[key]?.unlocks ?? []).entries()) {
      const where = `${key} unlock ${k + 1}`;
      if (!r || typeof r !== 'object') { problems.push(`${where}: expected above: and what it gives`); continue; }
      const out = { above: percent(r.above) };
      if (out.above == null) { problems.push(`${where}: above should be a percentage, e.g. 50%`); continue; }
      if (r.track != null) {
        if (TRACKS.some(([name]) => name === String(r.track))) out.track = String(r.track);
        else problems.push(`${where}: no track called ${r.track} in tracks`);
      }
      // writing gives every yeah and pause (story.yaml), so they're not unlocks
      if (r.yeahs != null || r.rest != null) problems.push(`${where}: yeahs and rest aren't unlocks, see story.yaml's write`);
      if (r.text != null) out.text = String(r.text);
      REWARDS[key].push(out);
    }
  }
  if (problems.length) warnings.push(`games.yaml: ${problems.join('; ')}`);
}

// config/games.yaml: each game's photos, what's found or matched in them, the words they win and
// the game's settings (see the file's comments). A photo or thing with a problem is left out, with
// a warning; a game with nothing left can't be played.
async function loadGames(doc) {
  if (!doc) return;
  const problems = [], unknown = new Set(), misfiled = new Set();
  const list = v => [].concat(v ?? []).map(x => String(x).trim()).filter(Boolean);  // a lone item works as well as a list
  // a photo's words, from bin -> [words], in the order listed; first puts the thing found first
  function rewards(where, bins, first = []) {
    const texts = [];
    const add = (item, bin) => {
      const w = findWord(item.toLowerCase());
      if (!w) return unknown.add(item);
      if (bin && w.bin !== bin) misfiled.add(`${w.text} is ${w.bin}, not ${bin}`);
      if (!texts.includes(w.text)) texts.push(w.text);
    };
    first.forEach(t => add(t));
    if (bins != null && (typeof bins !== 'object' || Array.isArray(bins))) problems.push(`${where}: rewards needs bin names with lists of words`);
    else for (const [bin, words] of Object.entries(bins ?? {})) list(words).forEach(t => add(t, bin));
    return texts;
  }
  const settings = (key, g) => {
    const s = { ...GAME_DEFAULTS[key] };
    for (const k of Object.keys(s)) if (g[k] != null) s[k] = g[k];
    return s;
  };

  const shapeFiles = {};  // photo -> promise of its shapes, so each .svg loads once
  const shapesOf = photo => shapeFiles[photo] ??= loadShapes(photo).catch(e => { problems.push(e.message); return null; });

  for (const [key, g] of Object.entries(doc)) {
    if (key === 'tracks') continue;  // read by loadUnlocks
    if (!GAME_DEFAULTS[key]) { problems.push(`unknown game "${key}"`); continue; }
    if (typeof g !== 'object' || !g) { problems.push(`${key}: expected its settings and photos`); continue; }
    const game = { ...settings(key, g), items: [] };
    game.points = Number(game.points);
    if (!(Number.isInteger(game.points) && game.points > 0)) {
      problems.push(`${key}: points should be a whole number, e.g. 50`);
      game.points = GAME_DEFAULTS[key].points;
    }
    if (key === 'caption-match') {
      for (const [k, r] of [].concat(g.rounds ?? []).entries()) {
        const where = `caption-match round ${k + 1}`;
        if (!r?.photo || !r.caption) { problems.push(`${where}: needs a photo and a caption`); continue; }
        game.items.push({ photo: String(r.photo), caption: String(r.caption), decoys: list(r.decoys), rewards: rewards(where, r.rewards) });
      }
      game.seconds = list(game.seconds).map(Number);
      if (!game.seconds.length || game.seconds.some(s => !(s > 0))) {
        problems.push('caption-match: seconds should be numbers, e.g. [6, 4, 3]');
        game.seconds = GAME_DEFAULTS['caption-match'].seconds;
      }
    } else if (key === 'pair-it') {
      // pair-it: pairs of photos with the same energy, each with the words it wins
      for (const [k, r] of [].concat(g.pairs ?? []).entries()) {
        const where = `pair-it pair ${k + 1}`;
        const photos = list(r?.photos);
        if (photos.length !== 2) { problems.push(`${where}: needs photos: [two photos]`); continue; }
        game.items.push({ photos, rewards: rewards(where, r.rewards) });
      }
    } else {
      for (const [photo, p] of Object.entries(g.photos ?? {})) {
        const where = `${key} ${photo}`;
        const shapes = await shapesOf(photo);
        if (!shapes) continue;
        const thing = t => {  // the shapes marking thing t, or null
          const found = shapes.byTag[t.toLowerCase()];
          if (!found) problems.push(`${where}: no shape with the id ${t} in ${svgName(photo)}`);
          return found ?? null;
        };
        if (key === 'find') {
          // find: a thing per line, with an optional prompt after it; or a list of things
          const f = p?.find;
          const pairs = f && typeof f === 'object' && !Array.isArray(f) ? Object.entries(f) : list(f).map(t => [t, null]);
          const targets = pairs.map(([t, prompt]) => ({ target: String(t), prompt: prompt == null ? null : String(prompt), shapes: thing(String(t)) }))
            .filter(t => t.shapes);
          if (!pairs.length) problems.push(`${where}: nothing to find`);
          if (!targets.length) continue;
          game.items.push({ photo, viewBox: shapes.viewBox, targets,
            rewards: rewards(where, p.rewards, targets.map(t => t.target)),
            findWords: targets.map(t => findWord(t.target.toLowerCase())?.text).filter(Boolean) });
        } else {
          const target = p?.find == null ? '' : String(p.find);
          if (!target) { problems.push(`${where}: nothing to find`); continue; }
          const found = thing(target);
          if (!found) continue;
          // reach: a click finds every shape within this many of the photo's pixels
          let reach = null;
          if (p.reach != null) {
            if (Number(p.reach) > 0) reach = Number(p.reach);
            else problems.push(`${where}: reach should be a number of pixels, e.g. 5`);
          }
          game.items.push({ photo, viewBox: shapes.viewBox, target, prompt: p.prompt == null ? null : String(p.prompt),
            shapes: found, reach, rewards: rewards(where, p.rewards, [target]) });
        }
      }
    }
    if (!game.items.length) { problems.push(`${key}: nothing playable, so it can't be played`); continue; }
    GAMES[key] = game;
  }
  for (const key of Object.keys(GAME_DEFAULTS)) if (!(key in doc)) problems.push(`no ${key} in it, so that game can't be played`);
  if (problems.length) warnings.push(`games.yaml: ${problems.join('; ')}`);
  if (unknown.size) warnings.push(`games.yaml: not in the recording: ${[...unknown].join(', ')}`);
  if (misfiled.size) warnings.push(`games.yaml: in another bin, shown there: ${[...misfiled].join(', ')}`);
}

const svgName = photo => `${photo.replace(/\.[^.]+$/, '')}.svg`;

// images/<photo>.svg: shapes drawn over the photo at its pixel size. A shape's id is the thing it
// marks, and anything after a _ is ignored, so fruits_1 and fruits_2 are two fruits. A <g> with an
// id is one shape. The shapes lose their ids and styles, so the game controls how they look.
async function loadShapes(photo) {
  const file = `images/${svgName(photo)}`;
  const r = await fetch(file, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`no ${file}, so ${photo} is left out`);
  const doc = new DOMParser().parseFromString(await r.text(), 'image/svg+xml');
  const svg = doc.documentElement;
  if (svg.nodeName !== 'svg' || doc.querySelector('parsererror')) throw new Error(`${file} isn't a readable SVG`);
  const viewBox = svg.getAttribute('viewBox') ?? `0 0 ${parseFloat(svg.getAttribute('width'))} ${parseFloat(svg.getAttribute('height'))}`;
  const tagOf = el => el.id.toLowerCase().split('_')[0];
  const byTag = {}, seen = {};  // seen: id -> times used, so shapes sharing an id still get their own key
  for (const el of svg.querySelectorAll('[id]')) {
    if (el.closest('defs, clipPath, mask, style')) continue;
    // a shape inside a group of the same thing belongs to the group
    let up = el.parentElement, inGroup = false;
    for (; up && up !== svg; up = up.parentElement) if (up.id && tagOf(up) === tagOf(el)) inGroup = true;
    if (inGroup) continue;
    const copy = el.cloneNode(true);
    for (const n of [copy, ...copy.querySelectorAll('*')]) for (const a of ['id', 'class', 'style', 'fill', 'stroke']) n.removeAttribute(a);
    const n = seen[el.id] = (seen[el.id] ?? 0) + 1;
    (byTag[tagOf(el)] ??= []).push({ key: n > 1 ? `${el.id}#${n}` : el.id, el: copy });
  }
  return { viewBox, byTag };
}

// ---------- words ----------

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// every recording of a word, pauses left out
const takesOf = text => (takes[text] ?? []).filter(id => words[id].bin !== 'rest');

// a pause block this many beats long, made the first time it's needed; one ~ per 1/32 note
function restId(beats) {
  const id = `rest-${beats}`;
  words[id] ??= { id, text: '~'.repeat(Math.max(1, Math.round(beats * 8))), bin: 'rest', a: null, d: beats * 60 / BPM };
  return id;
}
// a saved id, remaking pauses, or null if the word's gone
function known(id) {
  const m = /^rest-(.+)$/.exec(id);
  if (m && Number(m[1]) > 0) return restId(Number(m[1]));
  return words[id] ? id : null;
}
const yeahTexts = () => [...new Set(Object.values(words).filter(w => w.bin === 'yeah').map(w => w.text))];

// a new game: the first line filled in, always with each word's first recording (cut to fit, with a
// warning), and the first stage's words
function newGame() {
  phase = 'intro';
  step = 0;
  shown = 1;
  task = 0;
  results = {};
  trackOn = {};
  landed = {};
  shownPoints = 0;
  lines.forEach(l => l.length = 0);
  lines[0] = STORY.first.line.map(t => takesOf(t)[0]).filter(id => id != null);
  let cut = 0;
  while (lineDur(0) > LINE_DUR + 1e-6) { lines[0].pop(); cut++; }
  if (cut) {
    warnings.push(`story.yaml: the first line is too long for 2 bars, ${cut} word${cut === 1 ? '' : 's'} cut`);
    $('#status').textContent = warnings.join(' · ');
  }
  last = lines[0].length ? [0, lines[0].length - 1] : null;
  start = [...new Set([...STORY.first.line, ...STORY.first.words])];
  save();
}

// what the palette offers: every recording of each word the player has (the first stage's, then when
// writing, what the games won and story.yaml's write words), and when writing, the pauses
function paletteWords() {
  const texts = new Set(start);
  if (phase === 'write') {
    for (const key of GAME_ORDER) results[key]?.words.forEach(t => texts.add(t));
    STORY.write.words.forEach(t => texts.add(t));
  }
  const ids = [...texts].flatMap(takesOf);
  if (phase === 'write') ids.push(...STORY.write.pauses.map(restId));
  return ids.map(id => words[id]);
}

// ---------- tracks ----------

// the tracks unlocked, by the games played and the one being played, in TRACKS order
function unlockedTracks() {
  const won = new Set([...Object.values(results), run ?? { tracks: [] }].flatMap(r => r.tracks));
  return TRACKS.filter(([name]) => won.has(name));
}

function toggle(name) {
  const b = document.createElement('button');
  b.className = 'toggle';
  b.textContent = name;
  b.dataset.track = name;
  b.setAttribute('aria-pressed', !!trackOn[name]);
  return b;
}

// a toggle per track unlocked, hidden while it's still flying there; and the points counter
function renderTracks() {
  $('#toggles').replaceChildren(...unlockedTracks().map(([name]) => {
    const b = toggle(name);
    if (flyingTracks.has(name)) b.style.visibility = 'hidden';
    b.addEventListener('click', () => { trackOn[name] = !trackOn[name]; save(); renderTracks(); applyGains(); });
    return b;
  }));
  renderPoints();
  $('#tracks').hidden = !MUSIC.includes(phase);
}

function renderPoints() {
  $('#points').textContent = `${shownPoints}`;
}

// the tracks on are heard, but a solo track (one with the others in it) on mutes the rest
function applyGains() {
  const open = new Set(unlockedTracks().map(([name]) => name));
  const on = name => open.has(name) && !!trackOn[name];
  const solo = SOLO_TRACKS.some(on);
  for (const [name] of TRACKS) {
    trackGains[name]?.gain.setTargetAtTime(on(name) && (!solo || SOLO_TRACKS.includes(name)) ? 1 : 0, ctx.currentTime, 0.015);
  }
}

// A track just unlocked comes on, and joins the lines already scheduled from now. Its toggle flies to
// the bar from (x, y), where the click that unlocked it was.
function newTrack(name, x, y) {
  trackOn[name] = true;
  save();
  flyingTracks.add(name);
  renderTracks();
  fly(toggle(name), () => $(`#toggles [data-track="${name}"]`), x, y, TRACK_FLY_MS, () => { flyingTracks.delete(name); renderTracks(); });
  applyGains();
  const buf = trackBufs[TRACKS.find(([n]) => n === name)?.[1]];
  if (!buf || !looping()) return;
  const now = ctx.currentTime + 0.02;
  for (const s of scheduled) {
    const from = Math.max(now, s.t0), into = from - s.t0;
    if (into < LINE_DUR) playSlice(buf, from, (s.line % TRACK_LINES) * LINE_DUR + into, LINE_DUR - into, 0, trackGains[name]);
  }
}

// ---------- phases ----------

// In a phase of screens, shows the screen at step, a line at a time: its button shows the next line,
// then after the last, the next screen, or after the last screen, moves on to the next phase.
// Otherwise shows the cutup.
function showScreen() {
  const on = SCREENS.includes(phase);
  $('#screen').hidden = !on;
  $('#game').hidden = on;
  if (!on) return;
  $('#screen').classList.toggle('dark', phase === 'intro');
  const list = STORY[phase], s = list[Math.min(step, list.length - 1)];
  const rows = s.text.split('\n');
  const said = rows.flatMap((r, k) => r.trim() ? [k] : []);  // the rows with words, which show one at a time
  const upTo = said.length ? said[Math.min(shown, said.length) - 1] : -1;
  $('#screen-text').replaceChildren(...rows.slice(0, upTo + 1).map((r, k) => {
    const d = document.createElement('div');
    d.textContent = r || ' ';  // a blank row keeps its space
    if (k === upTo) d.className = 'new';
    return d;
  }));
  const go = $('#screen-go');
  const done = shown >= said.length;
  go.textContent = done ? s.button : STORY.next;
  go.disabled = false;
  go.onclick = () => {
    if (!done) { shown++; return showScreen(); }
    shown = 1;
    if (step < list.length - 1) { step++; save(); return showScreen(); }
    enter(PHASES[PHASES.indexOf(phase) + 1]);
  };
}

// moves the game on to phase next
function enter(next) {
  const before = next === 'write' ? new Set(paletteWords().map(w => w.id)) : null;  // so the words won drop in
  phase = next;
  step = 0;
  shown = 1;
  if (next === 'work') { task = 0; results = {}; landed = {}; shownPoints = 0; $('#strip').replaceChildren(); }
  if (next === 'debrief') { trackOn = {}; applyGains(); }  // after work it's silent until a track's switched on
  if (next === 'write') stopLoop();  // the lines start from the first
  save();
  showScreen();
  showBars();
  if (next === 'work') return openTask();
  if (SCREENS.includes(next)) return;
  showPhase(before);
  if (next === 'first') startTimer();
}

// before = the tray's word ids before the phase changed, so the new ones can be animated in
function showPhase(before = null) {
  for (let i = 0; i < N_LINES; i++) renderLine(i);
  buildPalette(before);
  $('#submit').hidden = phase !== 'write';
  showBars();
}

// the tracks bar from work on, and the strip of words won during work
function showBars() {
  document.body.classList.toggle('with-tracks', MUSIC.includes(phase));
  document.body.classList.toggle('with-strip', phase === 'work');
  $('#strip').hidden = phase !== 'work';
  renderTracks();
}

// the first stage's countdown, not shown; when it's up, a notice sends the player on
let timer = null;
function startTimer() {
  clearTimeout(timer);
  timer = setTimeout(timeUp, STORY.first.seconds * 1000);
}

function timeUp() {
  timer = null;
  $('#notice-text').textContent = STORY.first.timeUp.text;
  $('#notice-go').textContent = STORY.first.timeUp.button;
  $('#notice-go').onclick = () => {
    $('#notice').hidden = true;
    enter('brief');
  };
  $('#notice').hidden = false;
}

// ---------- work: the games, each once through with a summary ----------

let mounted = null;  // the game being played, so it can be torn down

// find-all: the counts at which each of a photo's words is won: the thing's own word at the first
// found, the rest one step per word along the bar
const steps = item => item.rewards.map((_, k) => k ? Math.ceil((k + 1) * item.shapes.length / item.rewards.length) : 1);
const gameTitle = key => GAMES[key]?.title ?? GAME_DEFAULTS[key].title;

function showGame(key) {
  $('#mg-title').textContent = gameTitle(key);
  $('#mg-task').textContent = `task ${task + 1} / ${GAME_ORDER.length}`;
  $('#minigame').hidden = false;
}

// the task's summary if it's been played, otherwise straight into the game
function openTask() {
  const key = GAME_ORDER[task];
  if (results[key]) return showSummary(key);
  if (typeof MINIGAMES !== 'undefined' && GAMES[key]) return startRun(key);
  // a game that can't be played counts as played for nothing, so work carries on
  showGame(key);
  $('#mg-text').textContent = typeof MINIGAMES === 'undefined' ? 'couldn\'t load this game (no javascript/minigames.js).'
    : 'this game has nothing to play: see the warnings above the lines.';
  $('#mg-retry').hidden = true;
  $('#mg-go').textContent = 'next task';
  $('#mg-go').onclick = () => { results[key] = { points: 0, total: 0, words: [], tracks: [], notes: [] }; save(); nextTask(); };
  $('#mg-card').hidden = false;
}

// Everything a run plays, in a random order, with the data each play needs:
// find, every thing in every photo; pair-it, one play of every pair; find-all, every photo;
// caption-match, one play of every round.
function planRun(key) {
  const G = GAMES[key];
  const photo = name => `images/${name}`;
  if (key === 'find') {
    const all = shuffle(G.items.flatMap(item => item.targets.map(t => ({ item, t }))));
    return all.map(({ item, t }, k) => ({ item, t, data: { photo: photo(item.photo), viewBox: item.viewBox,
      shapes: t.shapes.map(s => s.el), target: t.target, prompt: t.prompt ?? `find: ${t.target}`,
      seconds: +G.seconds, tolerance: +G.tolerance, round: [k, all.length] } }));
  }
  if (key === 'find-all') {
    const items = shuffle([...G.items]);
    return items.map((item, k) => ({ item, data: { photo: photo(item.photo), viewBox: item.viewBox, shapes: item.shapes,
      target: item.target, prompt: item.prompt ?? `find all: ${item.target}`, seconds: +G.seconds,
      tolerance: +G.tolerance, reach: item.reach, found: [], steps: steps(item), round: [k, items.length] } }));
  }
  if (key === 'pair-it') {
    return [{ pairs: G.items, data: { pairs: G.items.map(p => p.photos.map(photo)), prompt: String(G.prompt), seconds: +G.seconds } }];
  }
  const rounds = shuffle([...G.items]);
  return [{ rounds, data: { rounds: rounds.map((r, k) => ({
    prompt: String(G.prompt).replaceAll('{caption}', r.caption), caption: r.caption,
    answer: photo(r.photo), options: shuffle([r.photo, ...r.decoys].map(photo)),
    seconds: G.seconds[Math.min(k, G.seconds.length - 1)] })) } }];
}

// a run's points: the game's points for each thing (find), pair (pair-it), shape (find-all) or round (caption-match)
function totalOf(key, plays) {
  const each = GAMES[key].points;
  if (key === 'find') return each * plays.length;
  if (key === 'find-all') return each * plays.reduce((t, p) => t + p.item.shapes.length, 0);
  return each * (plays[0]?.[key === 'pair-it' ? 'pairs' : 'rounds'].length ?? 0);
}

// plays the run's plays back to back, giving words and unlocks as they're won, then shows what it won
function startRun(key) {
  clearStrip(key);
  dropPoints(key);
  const plays = planRun(key);
  run = { key, plays, points: 0, total: totalOf(key, plays), words: [], tracks: [], notes: [], given: new Set(), state: new Map() };
  showGame(key);
  $('#mg-card').hidden = true;
  const next = k => {
    const upcoming = plays[k + 1]?.data.photo;
    if (upcoming) new Image().src = upcoming;
    mounted = MINIGAMES[key].mount($('#mg-body'), plays[k].data, () => {
      mounted?.destroy();
      mounted = null;
      if (k + 1 < plays.length) return next(k + 1);
      results[key] = { points: run.points, total: run.total, words: run.words, tracks: run.tracks, notes: run.notes };
      run = null;
      save();
      showSummary(key);
    }, ev => progress(k, ev));
  };
  next(0);
}

// 1 for taking up to half the time, down to 0 at a second before the end (or at the end, for a game under 2 seconds)
function quickness(taken, seconds) {
  const half = seconds / 2, none = Math.max(half, seconds - 1);
  if (!(taken >= 0)) return 1;  // no time reported
  return none > half ? Math.min(1, Math.max(0, (none - taken) / (none - half))) : +(taken <= half);
}

// A win in play k of the run: its points, its words (flown to the strip from the click) and any unlock it passes.
// find: a thing found wins its own word, and a share of its photo's other words (the photo's things share
// them out) scaled by how quick it was found (see quickness). find-all: each photo's bar wins its words.
// pair-it and caption-match: a pair or round matched wins its words.
function progress(k, ev) {
  const p = run.plays[k];
  const before = run.points, each = GAMES[run.key].points;
  let won = [];
  if (run.key === 'find') {
    run.points += each;
    const item = p.item;
    if (!run.state.has(item)) run.state.set(item, { others: shuffle(item.rewards.filter(w => !item.findWords.includes(w))),
      plays: run.plays.filter(q => q.item === item).length, shares: 0, given: 0 });
    const s = run.state.get(item);
    s.shares += quickness(ev.seconds, p.data.seconds);
    const due = Math.round(s.others.length * s.shares / s.plays);
    won = [findWord(p.t.target.toLowerCase())?.text, ...s.others.slice(s.given, due)];
    s.given = Math.max(s.given, due);
  } else if (run.key === 'find-all') {
    run.points += each * ev.found.length;
    const n = (run.state.get(k) ?? 0) + ev.found.length;
    run.state.set(k, n);
    won = p.item.rewards.slice(0, p.data.steps.filter(x => x <= n).length);
  } else if (run.key === 'pair-it') {
    run.points += each;
    won = p.pairs[ev.pair].rewards;
  } else {
    run.points += each;
    won = p.rounds[ev.round].rewards;
  }
  const fresh = won.filter(t => t && !run.words.includes(t));
  run.words.push(...fresh);
  flyWords(fresh, ev.x, ev.y, run.key);
  flyPoints(run.points - before, ev.x, ev.y, run.key);
  const percent = run.total ? run.points / run.total * 100 : 0;
  for (const u of REWARDS[run.key] ?? []) {
    if (!(percent > u.above) || run.given.has(u)) continue;
    run.given.add(u);
    const note = u.text ?? (u.track ? `you unlocked the ${u.track} track.` : '');
    if (note) run.notes.push(note);
    if (!u.track || run.tracks.includes(u.track)) continue;
    const had = unlockedTracks().some(([name]) => name === u.track);
    run.tracks.push(u.track);
    if (!had) newTrack(u.track, ev.x, ev.y);
  }
}

// what the run won, with a retry (which throws it away and plays again) and the way on
function showSummary(key) {
  const r = results[key];
  showGame(key);
  $('#mg-text').textContent = [
    r.words.length ? `you unlocked ${r.words.length} word${r.words.length === 1 ? '' : 's'}: ${r.words.join(', ')}` : 'you unlocked no words.',
    `you gained ${r.points} / ${r.total} points`,
    ...r.notes,
  ].join('\n');
  const retry = $('#mg-retry');
  retry.hidden = !GAMES[key] || typeof MINIGAMES === 'undefined';
  retry.onclick = () => { delete results[key]; save(); renderTracks(); applyGains(); startRun(key); };
  const go = $('#mg-go');
  go.textContent = task < GAME_ORDER.length - 1 ? 'next task' : STORY.lastButton;
  go.onclick = nextTask;
  $('#mg-card').hidden = false;
}

// on to the next game, or after the last, the screens after work
function nextTask() {
  if (task < GAME_ORDER.length - 1) {
    task++;
    save();
    return openTask();
  }
  $('#minigame').hidden = true;
  enter('debrief');
}

// ---------- the strip: words won at work ----------

const stripGen = {};  // game key -> bumped when its words are cleared, so words still flying for it land nowhere

function chip(text, key) {
  const el = document.createElement('div');
  el.className = 'chip';
  el.textContent = text;
  el.style.background = BIN_COLORS[words[takesOf(text)[0]]?.bin] ?? 'white';
  el.dataset.game = key;
  return el;
}

// the game's words shrink away one after another, newest first, the others closing up behind them
function clearStrip(key) {
  stripGen[key] = (stripGen[key] ?? 0) + 1;
  [...$('#strip').querySelectorAll(`[data-game="${key}"]`)].reverse().forEach((el, k) => {
    delete el.dataset.game;  // already going, so a second clear leaves it be
    el.animate([
      { transform: 'scale(1)', opacity: 1, width: `${el.offsetWidth}px`, marginLeft: '0px' },
      { transform: 'scale(0)', opacity: 0, width: '0px', paddingLeft: '0px', paddingRight: '0px', borderWidth: '0px', marginLeft: '-4px' },  // -4px: the strip's gap
    ], { duration: SHRINK_MS, delay: k * SHRINK_GAP, easing: 'ease-in', fill: 'forwards' }).onfinish = () => el.remove();
  });
}

// after a reload, the words already won, without flying
function fillStrip() {
  $('#strip').replaceChildren(...GAME_ORDER.flatMap(key => (results[key]?.words ?? []).map(t => chip(t, key))));
}

function flyWords(texts, x, y, key) {
  const gen = stripGen[key];
  texts.forEach((t, k) => setTimeout(() => { if (stripGen[key] === gen) flyWord(t, x, y, key); }, k * FLY_GAP));
}

// The word takes its place at the right of the strip, the others sliding left to make room, and a copy
// flies there from (x, y).
function flyWord(text, x, y, key) {
  const strip = $('#strip');
  const olds = [...strip.children], lefts = olds.map(c => c.getBoundingClientRect().left);
  const place = chip(text, key);
  place.style.visibility = 'hidden';
  strip.append(place);
  olds.forEach((c, i) => {
    const dx = lefts[i] - c.getBoundingClientRect().left;
    if (dx) c.animate([{ transform: `translateX(${dx}px)` }, { transform: 'none' }], { duration: 300, easing: 'ease-out' });
  });
  fly(chip(text, key), () => place.isConnected ? place : null, x, y, WORD_FLY_MS, () => place.style.visibility = '');
}

// Each point flies from (x, y) to the counter as a +1, and counts when it lands. Many at once
// (find-all's reach) are spread over at most FLY_GAP each.
function flyPoints(n, x, y, key) {
  const gen = stripGen[key], gap = Math.min(FLY_GAP, 600 / n);
  for (let k = 0; k < n; k++) setTimeout(() => {
    if (stripGen[key] !== gen) return;
    const plus = document.createElement('div');
    plus.className = 'point';
    plus.textContent = '+1';
    fly(plus, () => $('#points'), x, y, POINT_FLY_MS, () => {
      if (stripGen[key] !== gen) return;  // retried while it flew
      landed[key] = (landed[key] ?? 0) + 1;
      shownPoints++;
      renderPoints();
      $('#points').animate([{ transform: 'scale(1.2)' }, { transform: 'none' }], { duration: 200, easing: 'ease-out' });
    });
  }, k * gap);
}

// A retry takes back the game's points: each drops from the counter as a +1 and fades, the counter
// going down with it, spread over at most DROP_SPREAD.
function dropPoints(key) {
  const n = landed[key] ?? 0;
  landed[key] = 0;
  if (!n) return;
  const from = $('#points').getBoundingClientRect(), gap = Math.min(SHRINK_GAP, DROP_SPREAD * 1000 / n);
  for (let k = 0; k < n; k++) setTimeout(() => {
    shownPoints--;
    renderPoints();
    const minus = document.createElement('div');
    minus.className = 'point flying';
    minus.textContent = '+1';
    minus.style.left = `${from.left}px`;
    minus.style.top = `${from.top}px`;
    document.body.append(minus);
    minus.animate([{ transform: 'none', opacity: 1 }, { transform: 'translateY(80px)', opacity: 0 }],
      { duration: DROP_MS, easing: 'ease-in', fill: 'forwards' }).onfinish = () => minus.remove();
  }, k * gap);
}

// el flies from (x, y) to where target() is, taking ms, following it as it moves, then land() is called. If
// target() comes back empty on the way, el vanishes where it is and land() is still called.
function fly(el, target, x, y, ms, land) {
  el.classList.add('flying');
  document.body.append(el);
  const fx = x - el.offsetWidth / 2, fy = y - el.offsetHeight / 2, t0 = performance.now();
  const frame = now => {
    const t = Math.min(1, (now - t0) / ms), e = 1 - (1 - t) ** 3;
    const to = target()?.getBoundingClientRect();
    if (to) {
      el.style.left = `${fx + (to.left - fx) * e}px`;
      el.style.top = `${fy + (to.top - fy) * e}px`;
      el.style.transform = `scale(${1.4 - 0.4 * e})`;
    }
    if (t < 1 && to) return requestAnimationFrame(frame);
    el.remove();
    land();
  };
  requestAnimationFrame(frame);
}

// ---------- submit: the lines once through, on their own ----------

let showing = 0;  // bumped to stop the lighting-up loop
let submitting = false;

$('#submit').addEventListener('click', async () => {
  submitting = true;
  stopLoop();
  const cues = [];  // [span, time it's said]
  const box = $('#show-lines');
  box.replaceChildren();
  $('#show-back').hidden = true;
  $('#show').hidden = false;
  await ctx.resume();
  let t = ctx.currentTime + 0.3;
  for (let i = 0; i < N_LINES; i++) {
    const line = document.createElement('div');
    for (const [id, at] of playLine(i, t, true)) {
      if (words[id].bin === 'rest') continue;
      const span = document.createElement('span');
      span.textContent = words[id].text;
      line.append(span, ' ');
      cues.push([span, at]);
    }
    line.append(' ');  // an empty line still takes its place
    box.append(line);
    t += LINE_DUR;
  }
  const end = t, me = ++showing;
  const light = () => {
    if (me !== showing) return;
    const now = ctx.currentTime;
    for (const [span, at] of cues) span.classList.toggle('said', now >= at);
    if (now >= end) $('#show-back').hidden = false;
    else requestAnimationFrame(light);
  };
  light();
});

$('#show-back').addEventListener('click', () => {
  showing++;
  stopLoop();
  submitting = false;
  $('#show').hidden = true;
});

$('#restart').addEventListener('click', () => {
  if (!confirm('Start again from the top? This clears your lines and everything the games won.')) return;
  stopLoop();
  clearTimeout(timer);
  timer = null;
  $('#notice').hidden = true;
  newGame();
  showPhase();
  showScreen();
  applyGains();
});

// ---------- layout ----------

function sizeToWindow() {
  // one line (2 bars) spans the line box, so px-per-second follows from its width
  const pps = lineEls[0].clientWidth / LINE_DUR;
  if (!pps) return;  // hidden behind the intro
  document.documentElement.style.setProperty('--pps', pps);
  document.documentElement.style.setProperty('--beat', pps * 60 / BPM);
}

// a word plays when the pointer comes over it
function wordEl(w) {
  const el = document.createElement('div');
  el.className = 'word';
  el.style.background = BIN_COLORS[w.bin];
  el.textContent = w.text;
  el.title = w.bin === 'rest' ? `pause (${w.d.toFixed(2)}s)` : `${w.text} (${w.bin}, ${w.d.toFixed(2)}s)`;
  el.style.setProperty('--d', w.d);
  el.draggable = true;
  if (w.a !== null) el.addEventListener('mouseenter', () => preview(w));
  return el;
}

function buildPalette(before = null) {
  const palette = $('#palette');
  palette.replaceChildren();
  const offered = paletteWords();
  // new words drop in in tray order, spread over ENTER_SPREAD however many there are
  const entering = before ? offered.filter(w => !before.has(w.id)).length : 0;
  const step = entering && Math.min(0.06, ENTER_SPREAD / entering);
  let k = 0;
  for (const bin of binOrder) {
    const binWords = offered.filter(w => w.bin === bin);
    // pauses go shortest to longest; words go alphabetically, a word's recordings in recording order
    binWords.sort(bin === 'rest' ? (a, b) => a.d - b.d : (a, b) => a.text.localeCompare(b.text));
    if (!binWords.length) continue;
    const section = document.createElement('div');
    section.className = 'bin';
    section.textContent = bin === 'rest' ? BIN_LABELS.rest : `${bin} (${new Set(binWords.map(w => w.text)).size})`;
    const list = document.createElement('div');
    list.className = 'bin-words';
    for (const w of binWords) {
      const el = wordEl(w);
      el.addEventListener('dragstart', e => startDrag(e, { id: w.id, from: null }));
      el.addEventListener('click', () => addWord(w.id));
      if (before && !before.has(w.id)) {
        el.classList.add('entering');
        el.style.animationDelay = `${(k++ * step).toFixed(3)}s`;
      }
      list.append(el);
    }
    section.append(list);
    palette.append(section);
  }
}

// dropping a placed word back on the palette removes it
function onPaletteDragOver(e) { if (dragging && dragging.from !== null) e.preventDefault(); }
function onPaletteDrop(e) {
  e.preventDefault();
  if (dragging && dragging.from !== null) removeWord(dragging.from, dragging.index);
}

function buildLines() {
  const container = $('#lines');
  for (let i = 0; i < N_LINES; i++) {
    const line = document.createElement('div');
    line.className = 'line';
    const marker = document.createElement('div');
    marker.className = 'marker';
    const playhead = document.createElement('div');
    playhead.className = 'playhead';
    line.addEventListener('dragover', e => onLineDragOver(e, i));
    line.addEventListener('dragleave', e => { if (!line.contains(e.relatedTarget)) marker.style.display = 'none'; });
    line.addEventListener('drop', e => onLineDrop(e, i));
    container.append(line);
    lineEls.push(line); markerEls.push(marker); playheadEls.push(playhead);
  }
}

// a placed word is removed by clicking it or dragging it out
function renderLine(i) {
  const line = lineEls[i];
  line.replaceChildren(markerEls[i], playheadEls[i]);
  lines[i].forEach((id, index) => {
    const el = wordEl(words[id]);
    el.addEventListener('dragstart', e => startDrag(e, { id, from: i, index }));
    el.addEventListener('click', () => removeWord(i, index));
    // dragged out of the lines and dropped nowhere: remove it
    // (a refused drop onto a full line leaves it where it was)
    el.addEventListener('dragend', e => {
      if (e.dataTransfer.dropEffect === 'none' && !overLines && lines[i][index] === id) removeWord(i, index);
    });
    line.append(el);
  });
}

// ---------- adding, moving and removing words ----------

// these keep last pointing at the same word as the lines change
function insertAt(i, idx, id) {
  lines[i].splice(idx, 0, id);
  if (last?.[0] === i && last[1] >= idx) last[1]++;
}
// the word before the one removed becomes the last added, so the next word takes its place
function removeAt(i, idx) {
  lines[i].splice(idx, 1);
  if (last?.[0] === i && last[1] >= idx) last[1]--;
}
function removeWord(i, idx) {
  removeAt(i, idx);
  renderLine(i);
  save();
}

// a word clicked in the tray goes after the word added last; if it doesn't fit there, at the end of
// the other line; if it fits neither, nowhere
function addWord(id) {
  const room = i => lineDur(i) + words[id].d <= LINE_DUR + 1e-6;
  let i = last ? last[0] : 0, idx = last ? last[1] + 1 : lines[0].length;
  if (!room(i)) {
    i = (i + 1) % N_LINES;
    idx = lines[i].length;
    if (!room(i)) return;
  }
  insertAt(i, idx, id);
  last = [i, idx];
  renderLine(i);
  save();
}

let dragging = null;  // { id, from: lineIndex|null, index }
let overLines = false;  // whether the pointer was last over the lines region
document.addEventListener('dragover', e => { overLines = !!e.target.closest?.('#lines'); });

function startDrag(e, info) {
  dragging = info;
  e.dataTransfer.setData('text/plain', words[info.id].text);
  e.dataTransfer.effectAllowed = info.from === null ? 'copy' : 'move';
}
document.addEventListener('dragend', () => {
  dragging = null;
  markerEls.forEach(m => m.style.display = 'none');
});

const lineDur = i => lines[i].reduce((t, id) => t + words[id].d, 0);

function fits(i) {
  const own = dragging.from === i ? words[dragging.id].d : 0;
  return lineDur(i) - own + words[dragging.id].d <= LINE_DUR + 1e-6;
}

// insertion index = number of placed words whose midpoint is left of the pointer
function insertIndex(i, clientX) {
  const els = [...lineEls[i].querySelectorAll('.word')];
  const idx = els.findIndex(el => { const r = el.getBoundingClientRect(); return clientX < r.left + r.width / 2; });
  return idx === -1 ? els.length : idx;
}

function onLineDragOver(e, i) {
  if (!dragging || !fits(i)) return;  // not preventing default = drop refused
  e.preventDefault();
  e.dataTransfer.dropEffect = dragging.from === null ? 'copy' : 'move';
  const idx = insertIndex(i, e.clientX);
  const ids = lines[i].slice(0, idx);
  markerEls[i].style.left = ids.reduce((t, id) => t + words[id].d, 0) / LINE_DUR * lineEls[i].clientWidth + 'px';
  markerEls[i].style.display = 'block';
}

// a word dropped from the tray becomes the last added; a moved word that was the last added stays so
function onLineDrop(e, i) {
  e.preventDefault();
  markerEls[i].style.display = 'none';
  if (!dragging || !fits(i)) return;
  let idx = insertIndex(i, e.clientX);
  const { id, from, index } = dragging;
  if (from !== null) {
    const wasLast = last?.[0] === from && last[1] === index;
    removeAt(from, index);
    if (from === i && index < idx) idx--;
    insertAt(i, idx, id);
    if (wasLast) last = [i, idx];
    if (from !== i) renderLine(from);
  } else {
    insertAt(i, idx, id);
    last = [i, idx];
  }
  renderLine(i);
  save();
}

// ---------- persistence (per browser, convenience only) ----------

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ phase, step, task, start, results, lines, last, trackOn }));
  } catch {}
}
// returns false when there's nothing usable saved, so a new game is dealt
function restore() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (!PHASES.includes(s?.phase) || !Array.isArray(s.start)) return false;
    // words.json may have changed since: words no longer in it are dropped
    const ids = a => [].concat(a ?? []).map(known).filter(Boolean);
    const texts = a => [].concat(a ?? []).map(String).filter(t => takesOf(t).length);
    phase = s.phase;
    step = SCREENS.includes(phase) ? Math.min(Math.max(0, s.step | 0), STORY[phase].length - 1) : 0;
    task = Math.min(Math.max(0, s.task | 0), GAME_ORDER.length - 1);
    start = texts(s.start);
    results = {};
    for (const key of GAME_ORDER) {
      const r = s.results?.[key];
      if (!r) continue;
      results[key] = { points: +r.points || 0, total: +r.total || 0, words: texts(r.words),
        tracks: [].concat(r.tracks ?? []).filter(t => TRACKS.some(([n]) => n === t)), notes: [].concat(r.notes ?? []).map(String) };
    }
    [].concat(s.lines ?? []).slice(0, N_LINES).forEach((l, i) => {
      lines[i] = ids(l);
      while (lineDur(i) > LINE_DUR + 1e-6) lines[i].pop();
    });
    const [li, lk] = [].concat(s.last ?? []).map(Number);
    last = lines[li] && lk >= -1 && lk < lines[li].length ? [li, lk] : null;
    trackOn = {};
    for (const [name] of TRACKS) trackOn[name] = !!s.trackOn?.[name];
    landed = Object.fromEntries(Object.entries(results).map(([key, r]) => [key, r.points]));
    shownPoints = Object.values(landed).reduce((t, n) => t + n, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------- audio ----------

const live = new Set();  // scheduled sources, so they can be stopped

function playSlice(buffer, when, offset, duration, fade, out = ctx.destination) {
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  let node = src;
  if (fade) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(1, when + fade);
    g.gain.setValueAtTime(1, when + duration - fade);
    g.gain.linearRampToValueAtTime(0, when + duration);
    src.connect(g);
    node = g;
  }
  node.connect(out);
  src.start(when, offset, duration);
  live.add(src);
  src.onended = () => live.delete(src);
  return src;
}

// one word at a time: a new one cuts off the last
let previewing = null;
function preview(w) {
  if (ctx.state !== 'running') ctx.resume();
  try { previewing?.stop(); } catch {}
  previewing = playSlice(wordsBuf, ctx.currentTime + 0.01, w.a, w.d, FADE);
}
// the browser only lets audio start after a click
document.addEventListener('pointerdown', () => { if (ctx.state !== 'running') ctx.resume(); });

// From work on, the tracks loop, line by line; when writing, the lines play over them.
const looping = () => MUSIC.includes(phase) && !submitting;
let nextTime = null;   // audio-clock time the next line starts
let slot = 0;          // lines since the loop started; slot % N_LINES is the line
let scheduled = [];    // [{ line, t0, voice }] for the playhead and tracks unlocked mid-line

// Line i from t0: the tracks unlocked, over bars 2i+1..2i+2 of their first 4, and with voice, the line's
// words. Returns [id, time] for each word, for submit to light them up.
function playLine(i, t0, voice) {
  for (const [name, url] of unlockedTracks()) {
    if (trackBufs[url]) playSlice(trackBufs[url], t0, (i % TRACK_LINES) * LINE_DUR, LINE_DUR, 0, trackGains[name]);
  }
  scheduled.push({ line: i, t0, voice });
  if (!voice) return [];
  let t = t0;
  const times = [];
  for (const id of lines[i]) {
    const w = words[id];
    if (w.a !== null) playSlice(wordsBuf, t, w.a, w.d, FADE);
    times.push([id, t]);
    t += w.d;
  }
  return times;
}

// Schedules whole lines slightly ahead of time; edits apply from the next line.
function tick() {
  if (!looping() || ctx.state !== 'running') return;
  if (nextTime === null) nextTime = ctx.currentTime + 0.05;
  while (nextTime < ctx.currentTime + LOOKAHEAD) {
    const t0 = Math.max(nextTime, ctx.currentTime + 0.01);
    playLine(slot % N_LINES, t0, phase === 'write');
    slot++;
    nextTime = t0 + LINE_DUR;
  }
}
setInterval(tick, 25);

function stopAll() {
  for (const src of live) { try { src.stop(); } catch {} }
  live.clear();
}

// stops the loop; it starts again from the first line
function stopLoop() {
  stopAll();
  nextTime = null;
  slot = 0;
  scheduled = [];
}

function drawPlayhead() {
  const now = ctx.currentTime;
  scheduled = scheduled.filter(s => s.t0 + LINE_DUR > now);
  const current = scheduled.find(s => s.voice && s.t0 <= now);
  playheadEls.forEach((el, i) => {
    if (current && current.line === i && !submitting) {
      el.style.left = (now - current.t0) / LINE_DUR * lineEls[i].clientWidth + 'px';
      el.style.display = 'block';
    } else {
      el.style.display = 'none';
    }
  });
  requestAnimationFrame(drawPlayhead);
}
requestAnimationFrame(drawPlayhead);

load();
