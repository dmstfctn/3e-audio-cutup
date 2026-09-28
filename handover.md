# Handover

For how the game works, read `README.md`, the comments at the top of `build/javascript/main.js`, which describe the step kinds, and the comments in `build/config/story.yaml`, whose `sequence` sets the order. `main.js` is split into sections marked `// ---------- name ----------`. The README's prototype sections describe `prototype/`, and `build/` has moved on from them.

## Working with this user

- The user works in small steps: they make a request, you make the change, and they check it. Several small requests often come in one message, as a list. Do them all, then report in one short list.
- Keep replies short: what changed, where, and what was checked. Don't recap the whole session.
- When a request is ambiguous, pick the plainest reading, do it, and say in one line what you chose. If the user's wording would make a feature do almost nothing, say so and offer the alternatives (e.g. "play a clicked word unless the loop is playing": the loop always plays at the end, so they chose "always").
- Point out problems your change causes or makes worse (e.g. the header overflowing on phones), and offer a fix rather than quietly widening the change.
- They sometimes send a new request mid-turn. Fold it into the current work.
- Commit only when asked. Commit on `main`, stage only the files involved, and end the message with the co-author line. The message is a short title and a few `-` lines.
- This file is tracked. When a change makes something here wrong, update it in the same commit.
- Files the user adds (e.g. audio in `build/audio/`) may be untracked. Leave them out of commits unless the game now depends on them, and say which files you included.
- `build/config/games.yaml` sometimes has uncommitted edits of the user's own. Check `git diff` before committing, and leave theirs out.
- The user's words for things: **the end** is the `write` step, **narrative moments** are the `page` steps, **the tray** is `#palette`. The **intro example** (the old silent first stage) is gone. Its line's words (`first` in `story.yaml`) are still in the tray at the end, but the lines start empty.
- The user writes story changes as text with `[button]`s and `->` instructions. `page` text in `story.yaml` uses the same `[button]` notation.
- Keep code comments short and plain, explaining why rather than what. Match the density of the code around them. When a change makes a comment in the code or a config file's comments wrong, update it.

## Checking changes

- **Syntax:** `node --check build/javascript/main.js` (and `minigames.js`).
- **Headless:** install `puppeteer-core` into your scratchpad (`npm i puppeteer-core`) and use `executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'`. Serve `build/` on a spare port (`python3 -m http.server 8765`) and kill it afterwards. Check layout changes at 1280×800 and at phone size (390×844, `isMobile: true, hasTouch: true`), and read the screenshots. For audio, add `--autoplay-policy=no-user-gesture-required` and inspect state (`live.size`, `nextTime`, `paused`, `trackOn`) instead of listening.
- **Wait for load** with `lineEls.length && ($('#palette').children.length || $('#screen-go').textContent !== 'loading…')`. On a page, `#screen-go` gets its text; at the end the tray is built instead (and `#screen-go` stays at "loading…").
- **Jump to a step** by setting `localStorage.cutup` before a reload, e.g. `{ phase: 'write', at: 10, task: 3, start: ['pages'], results: {}, lines: [[], []], last: null, trackOn: {} }`. `phase` must match the kind of step `at` in the sequence, or a new game starts. Top-level `let`s (`GAMES`, `SEQUENCE`, `at`…) can be read and set from `page.evaluate`, e.g. `GAMES.find.seconds = 0.3` to rush the games. To give every word won, after load: `for (const key of GAME_ORDER) results[key] = { points: 0, total: 0, words: [...new Set(GAMES[key].items.flatMap(i => i.rewards))], tracks: [] }; save();`, then reload. Put track names such as `'metro'` in a result's `tracks` to unlock them.
- **The morph** (the strip growing into the tray) only runs going from the last page into `write`. To test it, start on that page (`{ phase: 'page', at: 9, … }`) with results filled in, click through `#screen-go` (waiting for each button: a click before it shows is ignored), and take screenshots a few hundred ms apart.
- **Pair-it by script:** dispatch `pointerdown` (with `clientX`, `clientY`, `button: 0`) on both `.mg-cell[data-pair="k"]` once `.mg-pairs` is visible and its images have their `src`.
- Headless can't show touch or momentum-scroll problems. Ask the user to try touch changes on their phone.
- There's no build step and no test suite. `build/` loads nothing from outside itself, so no CDN libraries.

## House style

Times, black 1px borders and square corners. Green `#1a9e4b` means right and red `#d23c3c` means wrong. Tray tabs are small uppercase Arial. Header controls (play/pause, submit) are plain bold Arial text. The header has play/pause at the left, the track toggles centred, and the points counter at the right. From the games until the end it shows only the counter. At the end, play/pause and the toggles show, and submit takes the counter's place. Word blocks (tray, lines, strip) are Arial, white with black text and border, whatever their bin. A word won grows from nothing at the click over 0.2 s to 12× size as outlined Arial text (6px on screen) cycling through the hues (smaller if it won't fit, and nudged in from the screen's edges), holds there for 0.5 s, then shrinks into its place in the strip, where it gets its block. On a dark page the header and strip invert (black, white borders) and the strip's words go grey; see `body.dark` in `style.css`. Writing (the end, and submit's screen) is all white on black (`body.writing`); the lines' ticks, bottom border and drop marker take their colour from `--ink`. Buttons on the narrative screens are underlined story text. Rows a button reveals together come in 350 ms apart (`LINE_GAP`), and the next button 600 ms after the last of them (`BUTTON_GAP`). The tray is full width with a border on top only, and tabs in two rows (the shorter row on top) on every screen size. It's as tall as its biggest tab (at most 66% of the screen, half on phones), and its words are centred.

## State of the game

- The order is `sequence` in `story.yaml`: `page` (light or dark, text in `[button]` notation), `try` (a game with no timer until its first win, winning nothing; `seconds: null` in minigames.js), `games` (one step at most; after each game an `X / Y points` card with retry and next task, the last button being the step's `last-button`), and `write`. Any step can `play` (unlock and switch on), `unlock` (off) or `stop` (switch off) tracks. The metro plays from the games until the dark page. The drone never plays by itself: `write` unlocks it, off, as a toggle.
- `restore()` rejects a save whose `phase` doesn't match the kind of step at `at`, so editing the sequence can reset saves. That's fine.
- Pair-it tries leave out pairs matched in earlier tries (`tried`, saved); the timed game has them all.
- The header shows from the games on: the points counter until the end, then play/pause and the toggles. The strip shows from the games until the end.
- Leaving a dark page, a black `.cover` fades out over `MORPH_MS` while the bars' CSS transitions run, and the words flying from the strip into the tray fade from grey to their colours (`morphTray`).
- Tracks are `.mp3` files in `build/audio/` (the `.wav` files are kept; `track-metronome-old.mp3` is the user's untracked backup), named `drone`, `metro`, `beat` and `all` in `games.yaml`. Tracks won in games arrive switched off. `all` mutes the others while it's on (`SOLO_TRACKS`), including the drone. Pair it unlocks `beat`, find them all `all`; find it and caption match unlock nothing. A track unlocked in the games joins the loop off, with no toggle until the end.
- Rewards: find it gives only the thing found's own word (no speed share), and caption match only a round's first listed word. Pair it and find them all give several words as before.
- The recording loads from `words.mp3`, made from `words.wav` with `lame -V 2` (see the README). In Chrome it lines up with the WAV to the sample, because LAME's header lets the browser trim the encoder delay.
- Play/pause (and the space bar) stops the loop. It's not saved.
- Words won are not said. A clicked tray word is always said (`playWord`).
- About 4.7 MB loads before [start] is enabled: `words.mp3` 3.2 MB, all four tracks 1.2 MB, the find/find-all shape `.svg`s 190 KB (mostly `12.svg`), the rest small. Photos load when their game starts.

## Open

- Not yet checked on an iPhone: whether Safari trims the MP3's encoder delay. If it doesn't, words shift by about 23 ms (PAD is 30 ms, so maybe inaudible). Ask the user if words sound clipped or late there.
- Offered, not asked for: loading only the drone before [start] (the other tracks in the background) and the shape files when the games begin, to get [start] up sooner on phones.
