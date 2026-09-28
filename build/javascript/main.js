const BPM = 143.59;
const BEATS_PER_LINE = 8;                       // 2 bars of 4/4
const LINE_DUR = BEATS_PER_LINE * 60 / BPM;     // 3.343s
const MIN_LINES = 2, MAX_LINES = 4;              // the lines showing: 2, or 4 with the + below them
const TRACK_LINES = 2;                          // lines loop the tracks' first 4 bars
const PAD = 0.03;                               // seconds around each word's aligned bounds
const FADE = 0.008;                             // seconds of fade in/out on each word
const LOOKAHEAD = 0.15;                         // how far ahead lines are scheduled
const ENTER_SPREAD = 1.2;                       // seconds over which the words won drop into the tray
const MORPH_MS = 900, MORPH_SPREAD = 300;       // the strip growing into the tray, and the most its words are staggered by
const JITTER = 30;                              // px: a point, word or track won flies from a random spot this near the click
const FLY_GAP = 120;                            // the gap between words won together flying to the strip
// how long a point and a word take to fly to the counter and the strip, the word 10% slower
const POINT_FLY_MS = 700, WORD_FLY_MS = POINT_FLY_MS * 1.1;
// a word won grows from nothing to this many times its size in the strip (or as big as fits on screen), holds,
// then flies; each in ms
const WORD_FLY_SCALE = 12, WORD_GROW_MS = 200, WORD_HOLD_MS = 500;
const SHRINK_MS = 250, SHRINK_GAP = 60;         // a word a retry clears shrinking out of the strip, and the gap between words
const DROP_MS = 700, DROP_SPREAD = 1.5;         // a point a retry takes back dropping from the counter, and the most time they all take
const LINE_GAP = 350;                           // ms between the rows a page's button reveals together
const BUTTON_GAP = 600;                         // ms from the last of them to the next button
const TRY_MS = 1000;                            // how long a try's win shows before the story goes on
// The game runs through the steps of story.yaml's sequence (see its comments), each one of these kinds:
//   page:  a screen of text, shown a line at a time, each line with its own button
//   try:   a game played with no timer until its first win, winning nothing
//   games: the games in GAME_ORDER, each played through once, with its points after and a retry; words won fly
//          to the strip at the bottom, which shows from here until writing, and points to the counter
//   write: the lines, empty, the first line's words, what the games won, the write words, and the
//          tracks unlocked; the lines play over the tracks, and submit plays them once on their own
// A step can play, unlock or stop tracks, and a track loops from when it's unlocked. The header shows from
// the games on, with the points counter; play / pause and the track toggles only show when writing.
// Minigames (javascript/minigames.js). Their photos, shapes, words and settings come from
// config/games.yaml; these are the settings a game gets when games.yaml leaves one out. points is what
// each thing found, pair or round matched, or shape found is worth.
// What a score unlocks beyond the words is under each game's unlocks, and the tracks under tracks.
const GAME_DEFAULTS = {
  'find': { seconds: 5, tolerance: 10, points: 1 },
  'pair-it': { seconds: 15, prompt: 'pair two', points: 1 },
  'caption-match': { seconds: [6, 4, 3], prompt: 'choose one: "{caption}"', points: 1 },
  'find-all': { seconds: 15, tolerance: 10, points: 1 },
};
// tracks that have the others in them: while one is on, the others are muted
const SOLO_TRACKS = ['all'];
const COARSE = matchMedia('(pointer: coarse)').matches;  // a touch screen
const BIN_ORDER = ['yeah', 'noun', 'verb', 'describer', 'pronoun', 'glue', 'other', 'rest'];
const BIN_LABELS = { rest: 'pause' };
const STORE_KEY = 'cutup';

const ctx = new AudioContext();
let trackBufs = {}, wordsBuf;  // track url -> buffer
const trackGains = {};  // track name -> its gain, so a toggle is heard straight away
let words = {};  // id -> { id, text, bin, a, d }; pauses have no audio (a = null)
let takes = {};  // text -> the ids of its recordings, in recording order
let binOrder = [...BIN_ORDER];  // palette sections: bins.yaml's order, then any bins it leaves out, then pauses
let GAMES = {};       // game key -> its content and settings from games.yaml; a key missing can't be played
// games.yaml: tracks as [name, url], and game key -> its unlocks [{ above, track }]
let TRACKS = [['drone', 'audio/track-drone.mp3'], ['metro', 'audio/track-metronome.mp3'], ['beat', 'audio/track-drums.mp3'], ['all', 'audio/track-full.mp3']];
let REWARDS = {};
// config/story.yaml, filled in by loadStory; words are texts
let STORY = null;
// the story's steps: [{ kind, play, stop, and for a page: dark, lines: [{ rows, button }]; a try: game }]
let SEQUENCE = [];
let GAME_ORDER = [];  // the games step's games
let LAST_BUTTON = 'finish';  // the button after the last game

// state: lines[i] is an array of word ids in play order
let at = 0;        // the step of SEQUENCE showing
let phase = null;  // its kind
let shown = 1;     // how many of a page's lines are showing
let task = 0;      // index in GAME_ORDER of the game being played
let start = [];    // texts of the words given with the first line: its own, then the rest of first.words
// game key -> the result of its run: { points, total, words: [texts], tracks }
let results = {};
let run = null;    // the game being played: its plays, and what it's won so far
let tried = [];    // indexes in GAMES['pair-it'].items of the pairs matched in tries, left out of later tries
let trackOn = {};  // track name -> whether its toggle is on
let paused = false;  // the loop stopped with the play / pause button
let shownPoints = 0;  // the counter at the top right: the points that have landed there
let landed = {};      // game key -> its points that have landed on the counter, so a retry takes back as many
let last = null;   // [line, index] of the word added last, where a clicked word goes after
let nLines = MIN_LINES;  // how many lines are showing and played
const lines = Array.from({ length: MAX_LINES }, () => []);

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
      decode('audio/words.mp3'),
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
  addEventListener('resize', sizeTray);
  new ResizeObserver(() => document.documentElement.style.setProperty('--tray', `${$('#palette').offsetHeight}px`)).observe($('#palette'));
  $('#status').textContent = warnings.join(' · ');
  fillStrip();
  showStep();
  applyGains();
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
  binOrder = [...new Set([...yamlOrder, ...BIN_ORDER, ...all.map(w => w.bin)].filter(b => b !== 'rest')), 'rest'];
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

// config/story.yaml: the sequence, the first line and its words, and the words given for writing (see
// the file's comments). Anything missing or wrong gets a stand-in, with a warning.
function loadStory(doc) {
  const problems = [], unknown = new Set(), misfiled = new Set();
  const list = v => [].concat(v ?? []).map(x => String(x).trim()).filter(Boolean);  // a lone item works as well as a list
  doc ??= {};
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
    first: { line, words: byBin('first', first.words) },
    write: { words: [...byBin('write', write.words), ...yeahs], pauses },
  };
  SEQUENCE = readSequence(doc.sequence, String(doc.next ?? 'next'), problems);
  const games = SEQUENCE.find(s => s.kind === 'games');
  GAME_ORDER = games?.games ?? [];
  LAST_BUTTON = games?.lastButton ?? LAST_BUTTON;
  if (problems.length) warnings.push(`story.yaml: ${problems.join('; ')}`);
  if (unknown.size) warnings.push(`story.yaml: not in the recording: ${[...unknown].join(', ')}`);
  if (misfiled.size) warnings.push(`story.yaml: in another bin, shown there: ${[...misfiled].join(', ')}`);
}

// story.yaml's sequence as steps (see SEQUENCE). A step with a problem is left out, with a warning; the
// sequence always ends in write, and has one games step at most.
function readSequence(list, next, problems) {
  const out = [];
  const tracks = (where, v) => [].concat(v ?? []).map(String).filter(name => {
    if (TRACKS.some(([n]) => n === name)) return true;
    problems.push(`${where}: no track called ${name} in games.yaml`);
    return false;
  });
  if (!Array.isArray(list) || !list.length) problems.push('sequence: expected a list of steps');
  for (const [k, raw] of [].concat(list ?? []).entries()) {
    const where = `sequence step ${k + 1}`;
    const s = typeof raw === 'string' ? { [raw]: null } : raw;
    const kind = ['page', 'try', 'games', 'write'].find(key => s && key in s);
    if (!kind) { problems.push(`${where}: expected page, try, games or write`); continue; }
    const step = { kind, play: tracks(where, s.play), unlock: tracks(where, s.unlock), stop: tracks(where, s.stop) };
    if (kind === 'page') {
      if (!['light', 'dark'].includes(s.page)) problems.push(`${where}: page should be light or dark`);
      step.dark = s.page === 'dark';
      // a line ends with its [button]; lines without one show with the next that has one
      step.lines = [];
      let rows = [];
      for (const row of String(s.text ?? '').trim().split('\n')) {
        const m = /^(.*?)\s*\[([^\]]*)\]\s*$/.exec(row);
        if (!m) { rows.push(row); continue; }
        if (m[1]) rows.push(m[1]);
        step.lines.push({ rows, button: m[2] });
        rows = [];
      }
      if (rows.some(r => r.trim())) step.lines.push({ rows, button: next });
      if (!step.lines.length) { problems.push(`${where}: no text`); step.lines.push({ rows: [], button: next }); }
    } else if (kind === 'try') {
      step.game = String(s.try);
      if (!GAME_DEFAULTS[step.game]) { problems.push(`${where}: no game called ${step.game}`); continue; }
    } else if (kind === 'games') {
      if (out.some(o => o.kind === 'games')) { problems.push(`${where}: only one games step is played`); continue; }
      step.games = [].concat(s.games ?? []).map(String).filter(key => {
        if (GAME_DEFAULTS[key]) return true;
        problems.push(`${where}: no game called ${key}`);
        return false;
      });
      if (!step.games.length) { problems.push(`${where}: no games`); continue; }
      step.lastButton = String(s['last-button'] ?? 'finish');
    } else {
      out.push(step);
      if (k < list.length - 1) problems.push(`${where}: nothing after write is played`);
      return out;
    }
    out.push(step);
  }
  problems.push('sequence: no write step, so one is added at the end');
  out.push({ kind: 'write', play: [], unlock: [], stop: [] });
  return out;
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
  if (doc.unlocked !== undefined) problems.push('unlocked is ignored: tracks come from the start with play in story.yaml\'s sequence');
  for (const key of Object.keys(GAME_DEFAULTS)) {
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
    if (key === 'tracks' || key === 'unlocked') continue;  // read by loadUnlocks
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
            rewards: rewards(where, p.rewards, targets.map(t => t.target)) });
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

// a new game: empty lines, and the first line's words given
function newGame() {
  at = 0;
  phase = SEQUENCE[0].kind;
  shown = 1;
  task = 0;
  results = {};
  tried = [];
  trackOn = {};
  paused = false;
  landed = {};
  shownPoints = 0;
  lines.forEach(l => l.length = 0);
  nLines = MIN_LINES;
  last = null;
  start = [...new Set([...STORY.first.line, ...STORY.first.words])];
  save();
}

// what the palette offers: every recording of each word the player has (the first line's, then when
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

// the tracks unlocked, played by the steps so far or by the games played and the one being played, in TRACKS order
function unlockedTracks() {
  const won = new Set([...SEQUENCE.slice(0, at + 1).flatMap(s => [...s.play, ...s.unlock]), ...[...Object.values(results), run ?? { tracks: [] }].flatMap(r => r.tracks)]);
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

// When writing, play / pause and a toggle per track unlocked; from the games until writing, the points
// counter. The header shows when either does.
function renderTracks() {
  $('#play').hidden = phase !== 'write';
  $('#play').textContent = paused ? 'play' : 'pause';
  $('#toggles').replaceChildren(...(phase === 'write' ? unlockedTracks() : []).map(([name]) => {
    const b = toggle(name);
    b.addEventListener('click', () => { trackOn[name] = !trackOn[name]; save(); renderTracks(); applyGains(); });
    return b;
  }));
  renderPoints();
  // hidden on a dark page, and the header with it
  $('#points').hidden = gamesAt() < 0 || at < gamesAt() || phase === 'write' || (phase === 'page' && SEQUENCE[at].dark);
  $('#ui-header').hidden = !headerOn();
  document.body.classList.toggle('with-header', headerOn());
}
const headerOn = () => !$('#points').hidden || phase === 'write';

// paused stops the loop; playing starts it again from the first line
function togglePlay() {
  paused = !paused;
  if (paused) stopLoop();
  renderTracks();
}
$('#play').addEventListener('click', togglePlay);
// the space bar too, whenever the button shows; the focused button is let go of, so space doesn't also press it
document.addEventListener('keydown', e => {
  if (e.code !== 'Space' || e.repeat || $('#ui-header').hidden || $('#play').hidden || !$('#show').hidden) return;
  e.preventDefault();
  document.activeElement?.blur();
  togglePlay();
});

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

// a track just unlocked joins the lines already scheduled from now, so toggling it on is heard straight away
function joinLoop(name) {
  const buf = trackBufs[TRACKS.find(([n]) => n === name)?.[1]];
  if (!buf || !looping()) return;
  const now = ctx.currentTime + 0.02;
  for (const s of scheduled) {
    const from = Math.max(now, s.t0), into = from - s.t0;
    if (into < LINE_DUR) playSlice(buf, from, (s.line % TRACK_LINES) * LINE_DUR + into, LINE_DUR - into, 0, trackGains[name]);
  }
}

// ---------- the sequence ----------

// A page shows its lines one at a time, each line's button showing the next, and the last one's moving
// on to the next step. The cutup only shows when writing.
function showScreen() {
  const s = SEQUENCE[at], on = s.kind === 'page';
  $('#screen').hidden = !on;
  $('#game').hidden = phase !== 'write';
  if (!on) return;
  $('#screen').classList.toggle('dark', s.dark);
  const rows = s.lines.slice(0, shown).flatMap((l, k) => l.rows.map(r => [r, k === shown - 1]));
  let n = 0;  // the new rows come in one after another
  $('#screen-text').replaceChildren(...rows.map(([r, fresh]) => {
    const d = document.createElement('div');
    d.textContent = r.trim() ? r : ' ';  // a blank row keeps its space
    if (fresh) {
      d.className = 'new';
      d.style.animationDelay = `${n++ * LINE_GAP}ms`;
    }
    return d;
  }));
  // the button comes in BUTTON_GAP after the last new row, and can't be pressed before it shows
  const go = $('#screen-go'), delay = n && (n - 1) * LINE_GAP + BUTTON_GAP, ready = performance.now() + delay;
  go.textContent = s.lines[shown - 1].button;
  go.disabled = false;
  go.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 400, delay, easing: 'ease-out', fill: 'backwards' });
  go.onclick = () => {
    if (performance.now() < ready) return;
    if (shown < s.lines.length) { shown++; return showScreen(); }
    enter(at + 1);
  };
}

// moves the game on to step k: the tracks it plays come on, and those it stops go off
function enter(k) {
  const next = SEQUENCE[k];
  const before = next.kind === 'write' ? new Set(paletteWords().map(w => w.id)) : null;  // so the words won drop in
  const strip = next.kind === 'write' ? stripNow() : null;  // so the tray can grow out of it
  const had = new Set(unlockedTracks().map(([name]) => name));
  const wasDark = document.body.classList.contains('dark');
  at = k;
  phase = next.kind;
  shown = 1;
  if (phase === 'games') { task = 0; results = {}; landed = {}; shownPoints = 0; $('#strip').replaceChildren(); }
  if (phase === 'write') stopLoop();  // the lines start from the first
  for (const name of next.play) {
    trackOn[name] = true;
    if (!had.has(name)) joinLoop(name);
  }
  for (const name of next.stop) trackOn[name] = false;
  save();
  applyGains();
  showStep(before, strip);
  if (wasDark && !document.body.classList.contains('dark')) fadeFromDark();
}

// leaving a dark page, the page fades from black while the bars change back (see style.css)
function fadeFromDark() {
  const cover = document.createElement('div');
  cover.className = 'cover';
  document.body.append(cover);
  cover.animate([{ opacity: 1 }, { opacity: 0 }], { duration: MORPH_MS, easing: 'ease-in-out' }).onfinish = () => cover.remove();
}

// shows the step the game is at, from its start; before and strip as for showPhase
function showStep(before = null, strip = null) {
  showScreen();
  showBars();
  if (phase === 'try') return startTry(SEQUENCE[at].game);
  if (phase === 'games') return openTask();
  $('#minigame').hidden = true;
  if (phase === 'write') showPhase(before, strip);
}

// before = the tray's word ids before the phase changed, so the new ones can be animated in;
// strip = the strip as it was (see stripNow), for the tray to grow out of
function showPhase(before = null, strip = null) {
  showLines();
  sizeToWindow();  // the lines have only just shown, and the tray's words are sized from them
  morphing = new Set(strip?.chips.map(c => takesOf(c.text)[0]).filter(Boolean));
  buildPalette(before, strip ? (MORPH_MS + MORPH_SPREAD) / 1000 : 0);
  if (strip) morphTray(strip);
  $('#submit').hidden = $('#more').hidden = phase !== 'write';
  showBars();
}

const gamesAt = () => SEQUENCE.findIndex(s => s.kind === 'games');

// the strip of words won, from the games until writing, inverted on a dark page; and
// writing, all white on black
function showBars() {
  const strip = gamesAt() >= 0 && at >= gamesAt() && phase !== 'write';
  document.body.classList.toggle('dark', phase === 'page' && SEQUENCE[at].dark);
  document.body.classList.toggle('writing', phase === 'write');
  document.body.classList.toggle('with-strip', strip);
  $('#strip').hidden = !strip;
  renderTracks();
}

// ---------- try: a game with no timer, until its first win ----------

// The game's first play, which wins nothing. Its first win shows for TRY_MS, then the story goes on;
// so does a play that ends without one. A pair-it try leaves out the pairs matched in earlier tries
// (the games step has them all).
function startTry(key) {
  showGame();
  $('#mg-card').hidden = true;
  if (typeof MINIGAMES === 'undefined' || !GAMES[key]) return enter(at + 1);  // nothing to try
  const data = planRun(key)[0].data;
  data.seconds = null;
  data.rounds?.forEach(r => r.seconds = null);
  const items = GAMES[key].items;
  let pairs = items.map((_, k) => k);  // pair-it: the items of data.pairs
  if (key === 'pair-it' && tried.length < items.length) {
    pairs = pairs.filter(k => !tried.includes(k));
    data.pairs = pairs.map(k => data.pairs[k]);
  }
  let won = false;
  const game = mounted = MINIGAMES[key].mount($('#mg-body'), data, () => on(), ev => {
    if (key === 'pair-it' && !tried.includes(pairs[ev.pair])) { tried.push(pairs[ev.pair]); save(); }
    if (won) return;
    won = true;
    setTimeout(on, TRY_MS);
  });
  function on() {
    if (mounted !== game) return;  // already gone on, or restarted
    game.destroy();
    mounted = null;
    enter(at + 1);
  }
}

// ---------- games: each once through, with its points after ----------

let mounted = null;  // the game being played, so it can be torn down

// find-all: the counts at which each of a photo's words is won: the thing's own word at the first
// found, the rest spread evenly up to finding them all
const steps = item => item.rewards.map((_, k) => k ? Math.ceil((k + 1) * item.shapes.length / item.rewards.length) : 1);

function showGame() {
  $('#minigame').hidden = false;
}

// the task's points if it's been played, otherwise straight into the game
function openTask() {
  const key = GAME_ORDER[task];
  if (results[key]) return showSummary(key);
  if (typeof MINIGAMES !== 'undefined' && GAMES[key]) return startRun(key);
  // a game that can't be played counts as played for nothing, so the games carry on
  showGame();
  $('#mg-text').textContent = typeof MINIGAMES === 'undefined' ? 'couldn\'t load this game (no javascript/minigames.js).'
    : 'this game has nothing to play: see the warnings above the lines.';
  $('#mg-retry').hidden = true;
  $('#mg-go').textContent = 'next task';
  $('#mg-go').onclick = () => { results[key] = { points: 0, total: 0, words: [], tracks: [] }; save(); nextTask(); };
  $('#mg-card').hidden = false;
}

// Everything a run plays, with the data each play needs, in a random order except find-all,
// which follows config/games.yaml: find, every thing in every photo; pair-it, one play of every
// pair; find-all, every photo; caption-match, one play of every round.
function planRun(key) {
  const G = GAMES[key];
  const photo = name => `images/${name}`;
  if (key === 'find') {
    const all = shuffle(G.items.flatMap(item => item.targets.map(t => ({ item, t }))));
    return all.map(({ item, t }) => ({ item, t, data: { photo: photo(item.photo), viewBox: item.viewBox,
      shapes: t.shapes.map(s => s.el), target: t.target, prompt: t.prompt ?? `find the ${t.target}`,
      seconds: +G.seconds, tolerance: +G.tolerance } }));
  }
  if (key === 'find-all') {
    return G.items.map(item => ({ item, steps: steps(item), data: { photo: photo(item.photo), viewBox: item.viewBox,
      shapes: item.shapes, target: item.target, prompt: item.prompt ?? `find the ${item.target}`, seconds: +G.seconds,
      tolerance: +G.tolerance, reach: item.reach, found: [] } }));
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

// plays the run's plays back to back, giving words and unlocks as they're won, then shows its points
function startRun(key) {
  clearStrip(key);
  dropPoints(key);
  const plays = planRun(key);
  run = { key, plays, points: 0, total: totalOf(key, plays), words: [], tracks: [], given: new Set(), state: new Map() };
  showGame();
  $('#mg-card').hidden = true;
  const next = k => {
    const upcoming = plays[k + 1]?.data.photo;
    if (upcoming) new Image().src = upcoming;
    mounted = MINIGAMES[key].mount($('#mg-body'), plays[k].data, () => {
      mounted?.destroy();
      mounted = null;
      if (k + 1 < plays.length) return next(k + 1);
      results[key] = { points: run.points, total: run.total, words: run.words, tracks: run.tracks };
      run = null;
      save();
      showSummary(key);
    }, ev => progress(k, ev));
  };
  next(0);
}

// A win in play k of the run: its points, its words (flown to the strip from the click) and any unlock it passes.
// find: a thing found wins its own word. caption-match: a round matched wins its first word. find-all: a
// photo's words come at its steps. pair-it: a pair matched wins its words.
function progress(k, ev) {
  const p = run.plays[k];
  const before = run.points, each = GAMES[run.key].points;
  let won = [];
  if (run.key === 'find') {
    run.points += each;
    won = [findWord(p.t.target.toLowerCase())?.text];
  } else if (run.key === 'find-all') {
    run.points += each * ev.found.length;
    const n = (run.state.get(k) ?? 0) + ev.found.length;
    run.state.set(k, n);
    won = p.item.rewards.slice(0, p.steps.filter(x => x <= n).length);
  } else if (run.key === 'pair-it') {
    run.points += each;
    won = p.pairs[ev.pair].rewards;
  } else {
    run.points += each;
    won = p.rounds[ev.round].rewards.slice(0, 1);
  }
  const fresh = won.filter(t => t && !run.words.includes(t));
  run.words.push(...fresh);
  flyWords(fresh, ev.x, ev.y, run.key);
  flyPoints(run.points - before, ev.x, ev.y, run.key);
  const percent = run.total ? run.points / run.total * 100 : 0;
  for (const u of REWARDS[run.key] ?? []) {
    if (!(percent > u.above) || run.given.has(u)) continue;
    run.given.add(u);
    if (!u.track || run.tracks.includes(u.track)) continue;
    const had = unlockedTracks().some(([name]) => name === u.track);
    run.tracks.push(u.track);
    if (!had) joinLoop(u.track);  // off, but in the loop, for its toggle when writing
  }
}

// the run's points, with a retry (which throws away what it won and plays again) and the way on
function showSummary(key) {
  const r = results[key];
  showGame();
  $('#mg-text').textContent = `${r.points} / ${r.total} points`;
  const retry = $('#mg-retry');
  retry.hidden = !GAMES[key] || typeof MINIGAMES === 'undefined';
  retry.onclick = () => { delete results[key]; save(); renderTracks(); applyGains(); startRun(key); };
  const go = $('#mg-go');
  go.textContent = task < GAME_ORDER.length - 1 ? 'next task' : LAST_BUTTON;
  go.onclick = nextTask;
  $('#mg-card').hidden = false;
}

// on to the next game, or after the last, the next step
function nextTask() {
  if (task < GAME_ORDER.length - 1) {
    task++;
    save();
    return openTask();
  }
  enter(at + 1);
}

// ---------- the strip: words won in the games ----------

const stripGen = {};  // game key -> bumped on a retry or restart, so words and points still flying for it land nowhere

const HUES = [0, 60, 120, 180, 240, 300];  // the hues a word won flashes through (hues in style.css)

function chip(text, key) {
  const el = document.createElement('div');
  el.className = 'chip';
  el.style.setProperty('--hue', `hsl(${HUES[Math.floor(Math.random() * HUES.length)]} 90% 45%)`);
  el.textContent = text;
  el.dataset.bin = words[takesOf(text)[0]]?.bin;
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

// the strip's height and its words, where they are, and whether they're grey, for the tray to grow out of
function stripNow() {
  return { height: $('#strip').offsetHeight, grey: document.body.classList.contains('dark'),
    chips: [...$('#strip').children].filter(c => c.dataset.game).map(c => ({ text: c.textContent, key: c.dataset.game, rect: c.getBoundingClientRect() })) };
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
// flies there from (x, y): bare text, big and cycling through the hues, shrinking to its place, where it
// gets its block.
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
  const bare = chip(text, key);
  bare.classList.add('bare');
  fly(bare, () => place.isConnected ? place : null, x, y, WORD_FLY_MS, () => place.style.visibility = '', { scale: WORD_FLY_SCALE, grow: WORD_GROW_MS, hold: WORD_HOLD_MS });
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
      if (stripGen[key] !== gen) return;  // retried or restarted while it flew
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

// el appears near (x, y) at scale, growing from nothing over grow ms if given, and waits there for hold ms. Then it
// flies to where target() is, taking ms, following it as it moves, and shrinking to its own size, then land() is
// called. If target() comes back empty on the way, el vanishes where it is and land() is still called. Scaled up, it
// stays whole on screen: nudged in from the edges, and smaller if it can't fit. It's scaled by its font size, not a
// transform, which iOS Safari draws at the size it started and blows up, pixellated.
function fly(el, target, x, y, ms, land, { scale = 1.4, grow = 0, hold = 0 } = {}) {
  // from a random spot near (x, y), so things won together don't all start from one point
  const a = Math.random() * 2 * Math.PI, r = JITTER * Math.sqrt(Math.random());
  x += r * Math.cos(a);
  y += r * Math.sin(a);
  el.classList.add('flying');
  document.body.append(el);
  const w = el.offsetWidth, h = el.offsetHeight, m = 8, size = parseFloat(getComputedStyle(el).fontSize);
  const vw = document.documentElement.clientWidth, vh = innerHeight;
  scale = Math.max(1, Math.min(scale, (vw - 2 * m) / w, (vh - 2 * m) / h));
  const inside = (c, size, room) => Math.max(m + size / 2, Math.min(room - m - size / 2, c));
  x = inside(x, w * scale, vw);
  y = inside(y, h * scale, vh);
  const fx = x - w / 2, fy = y - h / 2, start = performance.now(), t0 = start + grow + hold;
  const frame = now => {
    const t = Math.max(0, Math.min(1, (now - t0) / ms)), e = 1 - (1 - t) ** 3;
    const g = grow ? 1 - (1 - Math.min(1, (now - start) / grow)) ** 3 : 1;
    const to = target()?.getBoundingClientRect();
    if (to) {
      el.style.fontSize = `${size * (scale - (scale - 1) * e) * g}px`;
      // centred where a box of its own size would be
      el.style.left = `${fx + (to.left - fx) * e + (w - el.offsetWidth) / 2}px`;
      el.style.top = `${fy + (to.top - fy) * e + (h - el.offsetHeight) / 2}px`;
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
  $('#submit').hidden = true;  // back to writing brings it back
  const cues = [];  // [span, time it's said]
  const box = $('#show-lines');
  box.replaceChildren();
  $('#show').hidden = false;
  await ctx.resume();
  let t = ctx.currentTime + 0.3;
  for (let i = 0; i < nLines; i++) {
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
    if (now < end) requestAnimationFrame(light);
  };
  light();
});

$('#show-back').addEventListener('click', () => {
  showing++;
  stopLoop();
  submitting = false;
  $('#show').hidden = true;
  $('#submit').hidden = false;
});

$('#show-restart').addEventListener('click', () => restart());

// a new game from the top, clearing the lines and everything the games won
function restart() {
  mounted?.destroy();
  mounted = null;
  run = null;
  showing++;
  submitting = false;
  $('#minigame').hidden = true;
  $('#show').hidden = true;
  $('#strip').replaceChildren();
  GAME_ORDER.forEach(key => stripGen[key] = (stripGen[key] ?? 0) + 1);  // words and points still flying land nowhere
  stopLoop();
  newGame();
  showStep();
  applyGains();
}

// ---------- layout ----------

// the words' room in line i, inside its padding: where it starts, and its width
function lineRoom(i) {
  const s = getComputedStyle(lineEls[i]), left = parseFloat(s.paddingLeft);
  return { left, width: lineEls[i].clientWidth - left - parseFloat(s.paddingRight) };
}
// where t seconds into line i is, from the line's left edge
function lineX(i, t) {
  const { left, width } = lineRoom(i);
  return left + t / LINE_DUR * width;
}

function sizeToWindow() {
  // one line (2 bars) spans the words' room in a line, so px-per-second follows from its width
  const pps = lineRoom(0).width / LINE_DUR;
  if (!(pps > 0)) return;  // hidden behind the intro
  document.documentElement.style.setProperty('--pps', pps);
  document.documentElement.style.setProperty('--beat', pps * 60 / BPM);
}

function wordEl(w) {
  const el = document.createElement('div');
  el.className = 'word';
  el.dataset.id = w.id;
  el.dataset.bin = w.bin;  // its shade
  el.textContent = w.text;
  el.title = w.bin === 'rest' ? `pause (${w.d.toFixed(2)}s)` : `${w.text} (${w.bin}, ${w.d.toFixed(2)}s)`;
  el.style.setProperty('--d', w.d);
  el.draggable = !COARSE;  // a finger drags with touchDrag instead
  return el;
}

// The tray: tabs in two rows (the shorter on top), a bin each, and the chosen bin's words, in a panel as
// tall as the tallest bin's that scrolls up and down.
const trayHome = new Map();  // id -> its word in the tray, which the morph flies to
let tab = null;  // the bin whose tab is chosen
let morphing = new Set();  // ids hidden in the tray while a word from the strip flies to them

// before: as for showPhase; delay: seconds before the new words start popping in
function buildPalette(before = null, delay = 0) {
  const palette = $('#palette');
  palette.replaceChildren();
  trayHome.clear();
  const offered = paletteWords();
  // new words pop in in tray order, spread over ENTER_SPREAD however many there are; words flying from
  // the strip land instead
  const fresh = before ? offered.filter(w => !before.has(w.id) && !morphing.has(w.id)) : [];
  const step = fresh.length && Math.min(0.06, ENTER_SPREAD / fresh.length);
  const enterDelays = new Map(fresh.map((w, k) => [w.id, delay + k * step]));
  const bins = binOrder.filter(bin => offered.some(w => w.bin === bin));
  if (!bins.includes(tab)) tab = bins[0];
  const tabs = document.createElement('div');
  tabs.className = 'tabs';
  const rows = [document.createElement('div'), document.createElement('div')];
  tabs.append(...rows);
  palette.append(tabs);
  bins.forEach((bin, k) => {
    const binWords = offered.filter(w => w.bin === bin);
    // pauses go shortest to longest; words go alphabetically, a word's recordings in recording order
    binWords.sort(bin === 'rest' ? (a, b) => a.d - b.d : (a, b) => a.text.localeCompare(b.text));
    const list = document.createElement('div');
    list.className = 'bin-words';
    list.dataset.bin = bin;
    list.classList.toggle('on', bin === tab);
    const tabEl = document.createElement('button');
    tabEl.className = 'tab';
    tabEl.textContent = BIN_LABELS[bin] ?? bin;
    tabEl.dataset.bin = bin;
    tabEl.classList.toggle('on', bin === tab);
    tabEl.addEventListener('click', () => {
      tab = bin;
      palette.querySelectorAll('.tab, .bin-words').forEach(el => el.classList.toggle('on', el.dataset.bin === bin));
      palette.scrollTop = 0;
      sizeTray();
    });
    rows[+(k >= Math.floor(bins.length / 2))].append(tabEl);
    list.append(...binWords.map(w => {
      const el = wordEl(w);
      el.addEventListener('dragstart', e => startDrag(e, { id: w.id, from: null }));
      el.addEventListener('click', () => { playWord(w.id); addWord(w.id); });
      touchDrag(el, { id: w.id, from: null }, true);
      if (morphing.has(w.id)) el.style.visibility = 'hidden';
      if (enterDelays.has(w.id)) {
        el.classList.add('entering');
        el.style.animationDelay = `${enterDelays.get(w.id).toFixed(3)}s`;
      }
      trayHome.set(w.id, el);
      return el;
    }));
    palette.append(list);
  });
  sizeTray();
}

// The tray is as tall as its tallest bin, up to its max-height, but only the chosen bin is laid out, so it
// scrolls only when that bin's words don't fit.
function sizeTray() {
  const palette = $('#palette'), tabs = palette.querySelector('.tabs');
  if (!tabs) return;
  palette.style.height = '';
  const tallest = Math.max(0, ...[...palette.querySelectorAll('.bin-words')].map(b => b.scrollHeight));
  const border = palette.offsetHeight - palette.clientHeight;
  palette.style.height = `${Math.min(border + tabs.offsetHeight + tallest, parseFloat(getComputedStyle(palette).maxHeight))}px`;
}

// Going from the games to writing, the tray grows up out of the strip, and each word in the strip moves to
// its place in the tray, taking its size there. The strip = stripNow(), taken before it was hidden.
function morphTray(strip) {
  const palette = $('#palette');
  const box = palette.getBoundingClientRect();  // as it will be once grown
  palette.animate([{ height: `${strip.height}px` }, { height: `${palette.offsetHeight}px` }],
    { duration: MORPH_MS, easing: 'cubic-bezier(.3, .7, .2, 1)' });
  const gap = Math.min(40, MORPH_SPREAD / strip.chips.length);
  // newest first, from the right
  [...strip.chips].reverse().forEach(({ text, key, rect }, k) => {
    const id = takesOf(text)[0];
    if (!trayHome.has(id)) return;
    const el = chip(text, key);
    el.classList.add('flying');
    Object.assign(el.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, overflow: 'hidden', textAlign: 'center' });
    document.body.append(el);
    // grey from a dark page: its colour comes in on the way
    if (strip.grey) {
      el.classList.add('grey');
      el.getBoundingClientRect();  // so the grey is drawn before it goes
      Object.assign(el.style, { transitionDuration: `${MORPH_MS}ms`, transitionDelay: `${k * gap}ms` });
      el.classList.remove('grey');
    }
    const t0 = performance.now() + k * gap;
    const frame = now => {
      const t = Math.max(0, Math.min(1, (now - t0) / MORPH_MS)), e = 1 - (1 - t) ** 3;
      // a resize on the way lays the tray out again; a word in a tab not showing goes to its tab
      const home = trayHome.get(id);
      const shown = home && getComputedStyle(home.parentElement).visibility !== 'hidden';
      const target = shown ? home : palette.querySelector(`.tab[data-bin="${CSS.escape(words[id].bin)}"]`);
      if (target) {
        const to = target.getBoundingClientRect();
        el.style.left = `${rect.left + (to.left - rect.left) * e}px`;
        el.style.top = `${rect.top + (to.top - rect.top) * e}px`;
        el.style.width = `${rect.width + (to.width - rect.width) * e}px`;
        el.style.padding = `0 ${8 - 7 * e}px`;  // .chip's padding to .word's
        // a place below the tray's fold, or a tab: fade on the way
        el.style.opacity = target === home && to.bottom <= box.bottom + palette.getBoundingClientRect().top - box.top ? 1 : 1 - e;
      }
      if (t < 1 && target) return requestAnimationFrame(frame);
      el.remove();
      morphing.delete(id);
      $('#palette').querySelectorAll(`[data-id="${CSS.escape(id)}"]`).forEach(w => w.style.visibility = '');
    };
    requestAnimationFrame(frame);
  });
}

// dropping a placed word back on the palette removes it
function onPaletteDragOver(e) { if (dragging && dragging.from !== null) e.preventDefault(); }
function onPaletteDrop(e) {
  e.preventDefault();
  if (dragging && dragging.from !== null) removeWord(dragging.from, dragging.index);
}

function buildLines() {
  const container = $('#lines');
  for (let i = 0; i < MAX_LINES; i++) {
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

// the lines showing, and the button that shows or hides the other two
function showLines() {
  lineEls.forEach((el, i) => el.hidden = i >= nLines);
  for (let i = 0; i < MAX_LINES; i++) renderLine(i);
  const more = nLines < MAX_LINES;
  $('#more').textContent = more ? '+' : '−';
  $('#more').title = more ? 'add two lines' : 'remove the last two lines, and their words';
}

// Two more lines, or back to two. Removing lines throws their words away; if the word added last was
// in them, the last word of the last line left takes its place.
$('#more').addEventListener('click', () => {
  nLines = nLines < MAX_LINES ? MAX_LINES : MIN_LINES;
  for (let i = nLines; i < MAX_LINES; i++) lines[i] = [];
  if (last?.[0] >= nLines) last = [nLines - 1, lines[nLines - 1].length - 1];
  showLines();
  save();
});

// a placed word is removed by clicking it or dragging it out
function renderLine(i) {
  const line = lineEls[i];
  line.replaceChildren(markerEls[i], playheadEls[i]);
  lines[i].forEach((id, index) => {
    const el = wordEl(words[id]);
    el.addEventListener('dragstart', e => startDrag(e, { id, from: i, index }));
    el.addEventListener('click', () => removeWord(i, index));
    touchDrag(el, { id, from: i, index }, false);
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
    i = (i + 1) % nLines;
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

// shows where the word being dragged would go in line i at clientX x; false if it doesn't fit
function showMarker(i, x) {
  if (!dragging || !fits(i)) return false;
  const ids = lines[i].slice(0, insertIndex(i, x));
  markerEls[i].style.left = lineX(i, ids.reduce((t, id) => t + words[id].d, 0)) + 'px';
  markerEls[i].style.display = 'block';
  return true;
}

function onLineDragOver(e, i) {
  if (!showMarker(i, e.clientX)) return;  // not preventing default = drop refused
  e.preventDefault();
  e.dataTransfer.dropEffect = dragging.from === null ? 'copy' : 'move';
}

function onLineDrop(e, i) {
  e.preventDefault();
  dropAt(i, e.clientX);
}

// a word dropped from the tray becomes the last added; a moved word that was the last added stays so
function dropAt(i, x) {
  markerEls[i].style.display = 'none';
  if (!dragging || !fits(i)) return;
  let idx = insertIndex(i, x);
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

// Touch screens have no HTML5 drag and drop, so a finger drags a copy of the word. In the tray, when its words
// don't all fit and a swipe scrolls, the word has to be held first; otherwise it moves straight away. A tap
// still clicks.
const HOLD_MS = 300, SLOP = 8;  // how long a hold is, and px a finger can move before it's a swipe
let touch = null;  // { info, el, x, y, hold, ghost, over }

function touchDrag(el, info, hold) {
  el.addEventListener('touchstart', e => {
    if (e.touches.length > 1) return cancelTouch();
    const t = e.touches[0], palette = $('#palette');
    hold &&= palette.scrollHeight > palette.clientHeight;
    touch = { info, el, x: t.clientX, y: t.clientY, hold: hold && setTimeout(() => liftTouch(), HOLD_MS) };
  }, { passive: true });
}

function liftTouch() {
  clearTimeout(touch.hold);
  touch.hold = null;
  dragging = touch.info;
  touch.ghost = wordEl(words[dragging.id]);
  touch.ghost.classList.add('flying', 'dragged');
  touch.ghost.style.width = `${touch.el.offsetWidth}px`;
  document.body.append(touch.ghost);
  touch.el.classList.add('lifted');
  moveTouch(touch.x, touch.y);
}

// the copy sits just above the finger, so it isn't hidden under it
function moveTouch(x, y) {
  const { ghost } = touch;
  ghost.style.left = `${x - ghost.offsetWidth / 2}px`;
  ghost.style.top = `${y - ghost.offsetHeight * 1.5}px`;
  const under = document.elementFromPoint(x, y);
  const i = lineEls.indexOf(under?.closest('.line'));
  markerEls.forEach(m => m.style.display = 'none');
  if (i >= 0) showMarker(i, x);
  touch.over = { i, x, palette: !!under?.closest('#palette'), lines: !!under?.closest('#lines') };
}

function cancelTouch() {
  if (!touch) return;
  clearTimeout(touch.hold);
  touch.ghost?.remove();
  touch.el.classList.remove('lifted');
  if (touch.ghost) dragging = null;
  markerEls.forEach(m => m.style.display = 'none');
  touch = null;
}

document.addEventListener('touchmove', e => {
  if (!touch) return;
  const t = e.touches[0];
  if (!touch.ghost) {
    if (Math.hypot(t.clientX - touch.x, t.clientY - touch.y) < SLOP) return;
    if (touch.hold) return cancelTouch();  // moved before the hold: a swipe, which scrolls
    liftTouch();
  }
  e.preventDefault();
  moveTouch(t.clientX, t.clientY);
}, { passive: false });

// as with a mouse: dropped on a line, it goes there if it fits; a placed word dropped on the tray or
// outside the lines is removed
document.addEventListener('touchend', e => {
  if (!touch?.ghost) return cancelTouch();
  e.preventDefault();  // no click
  const { over } = touch, { from, index } = dragging;
  if (over?.i >= 0) dropAt(over.i, over.x);
  else if (from !== null && (over?.palette || !over?.lines)) removeWord(from, index);
  cancelTouch();
});
document.addEventListener('touchcancel', cancelTouch);
// a long press would open the browser's menu
document.addEventListener('contextmenu', e => { if (e.target.closest?.('.word')) e.preventDefault(); });

// ---------- persistence (per browser, convenience only) ----------

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({ phase, at, task, start, results, tried, lines, nLines, last, trackOn }));
  } catch {}
}
// returns false when there's nothing usable saved, so a new game is dealt
function restore() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    // a sequence changed since may have another step here: start again
    if (!s?.phase || SEQUENCE[s.at]?.kind !== s.phase || !Array.isArray(s.start)) return false;
    // words.json may have changed since: words no longer in it are dropped
    const ids = a => [].concat(a ?? []).map(known).filter(Boolean);
    const texts = a => [].concat(a ?? []).map(String).filter(t => takesOf(t).length);
    at = s.at;
    phase = s.phase;
    shown = 1;
    task = Math.max(0, Math.min(s.task | 0, GAME_ORDER.length - 1));
    start = texts(s.start);
    tried = [].concat(s.tried ?? []).map(Number).filter(k => k >= 0 && k < (GAMES['pair-it']?.items.length ?? 0));
    results = {};
    for (const key of GAME_ORDER) {
      const r = s.results?.[key];
      if (!r) continue;
      results[key] = { points: +r.points || 0, total: +r.total || 0, words: texts(r.words),
        tracks: [].concat(r.tracks ?? []).filter(t => TRACKS.some(([n]) => n === t)) };
    }
    nLines = s.nLines === MAX_LINES ? MAX_LINES : MIN_LINES;
    [].concat(s.lines ?? []).slice(0, nLines).forEach((l, i) => {
      lines[i] = ids(l);
      while (lineDur(i) > LINE_DUR + 1e-6) lines[i].pop();
    });
    const [li, lk] = [].concat(s.last ?? []).map(Number);
    last = li < nLines && lk >= -1 && lk < lines[li].length ? [li, lk] : null;
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

// the browser only lets audio start after a click
document.addEventListener('pointerdown', () => { if (ctx.state !== 'running') ctx.resume(); });

// a word on its own, now or at when; pauses make no sound
function playWord(id, when = ctx.currentTime) {
  const w = words[id];
  if (w.a !== null) playSlice(wordsBuf, when, w.a, w.d, FADE);
}

// The tracks loop, line by line; when writing, the lines play over them.
const looping = () => !submitting && !paused;
let nextTime = null;   // audio-clock time the next line starts
let slot = 0;          // lines since the loop started; slot % nLines is the line
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
    playLine(slot % nLines, t0, phase === 'write');
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
      el.style.left = lineX(i, now - current.t0) + 'px';
      el.style.display = 'block';
    } else {
      el.style.display = 'none';
    }
  });
  requestAnimationFrame(drawPlayhead);
}
requestAnimationFrame(drawPlayhead);

load();
