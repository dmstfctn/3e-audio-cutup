# Hosting plan: submissions and "scroll for inspiration"

Players submit their lines at the end. Built (on the `submit` branch): the submit path, the API (`/api/submit`, `/api/list`, `/api/vote`, `/api/admin`), the database tables and a private page for hearing the submissions. Not built: "scroll for inspiration" and the freeze script.

"Scroll for inspiration", a page or overlay for browsing the submissions and voting them up or down, may not be built. The submit path, the API and the database still support it: listing and voting are part of the API and the table from the start, so the page can be added later without changing them.

## Requirements

- Online only. Up for a week before an event, with about 1k visitors, not all of whom play to the end.
- Live for about a month, then frozen into a static archive.
- Anonymous: no names, no login.
- One submission per player. No share links.
- Up and down votes, with a choice of order (newest, top, random), supported by the API even if no page uses them yet.
- A submission keeps the track mix it was made with. It may end up as the full track (`all`) instead, which the format allows without changing.
- One person looks after it, so upkeep should be close to none.
- Loading outside scripts is acceptable if needed. The rule against it was mostly to keep the prototypes self-contained.

## The submission format

A submission is a small JSON "score", about 1–3 KB. It can't be edited and always sounds the same.

```json
{
  "v": 1,
  "audio": { "words": "words.8da2ffd2.mp3", "manifest": "words.387cb059.json",
             "tracks": { "beat": "track-drums.786c6c78.mp3", "strings": "track-string2.0b62008a.mp3" } },
  "bpm": 143.59, "beats": 8, "fade": 0.008,
  "lines": [
    { "bar": 0, "words": [ { "id": 812, "text": "yeah", "bin": "yeah", "s": 101.234, "d": 0.412 },
                           { "rest": 0.836 } ] },
    { "bar": 4, "words": [ … ] }
  ]
}
```

- **Times, not just ids.** Each word stores its start time `s` and length `d` in `words.mp3`, with any `clips.json` trims already applied, as well as its text and bin for display. Re-running preprocessing can renumber the ids, and the clip picker can change the trims, so an id alone could come to point at a different sound. Pauses store only their length.
- **The files a submission uses are never changed.** `preprocess/hash_audio.py` copies `words.mp3`, `words.json` and the tracks to `build/audio/v/` with a content hash in their names (`words.8da2ffd2.mp3`), and `build/audio/v/index.json` maps each plain name to its latest copy. The game loads the copies, and old copies stay for good. `manifest` is the `words.json` the ids come from. Replacing `track-drums.mp3` in place, as happened on 2026-09-29, would change every submission made before it.
- **What actually played.** `tracks` lists the tracks that could be heard at submit time, after the `all` solo rule (`SOLO_TRACKS`) is applied. If it's decided that submissions use the full track, submit writes `all` there, and the format stays the same.
- **Each line's bars.** A line plays over the bars set by its position (`playLine(i, …)`: line i over bars 2i+1–2i+2), whether or not the lines before it are on. `bar` stores that start, so switching lines off doesn't shift anything. Lines that are off aren't included.
- **Checked on the server** (`netlify/lib/score.mjs`). Each word's id has to be in the manifest the score names, its text has to be that word's, and its clip has to lie within 0.5 s of the word's aligned bounds (room for the clip picker's trims, which can change, so they aren't matched exactly). The files it names have to be on the site, which it checks by fetching them from itself, so every audio version ever deployed works with no list to keep. It rejects a line longer than 2 bars, more than 8 lines, or no words at all, and stores a clean copy, dropping anything else in the JSON. Otherwise anyone could post any stretch of the recording with any text over it.

Rendering each submission to an audio file (`OfflineAudioContext`, then an encoder) is the only way to freeze it completely. But it takes about 100× the storage and bandwidth, and `MediaRecorder` records in real time and produces a different format in each browser. The score is the master copy; audio could be rendered from it later if downloads or share previews are wanted.

## Hosting: Netlify and Neon

- **The site:** `build/` as it is now, on Netlify's CDN.
- **The API:** Netlify Functions in `netlify/functions/`, on the same domain (so no CORS setup), sharing `netlify/lib/`:
  - `/api/submit` (POST a score) checks and stores it: 201, or 409 if this voter has submitted already, 400 with the problem, 429 past 20 an hour from one IP.
  - `/api/list?order=new|top|random&page=0&seed=…` returns 20 submissions not hidden, with their `up` and `down`, and `more`. Cached on the CDN for 30 s. `random` is shuffled by `seed`, so one seed's pages don't overlap.
  - `/api/vote` (POST `{ id, value }`, value 1, −1 or 0 to take it back) returns the counts. 300 an hour from one IP.
  - `/api/admin`, for `build/tools/submissions.html`, with `ADMIN_PASSWORD` as the password: every submission, hidden ones too, and hiding or showing one.
- **The database:** Postgres on a free Neon account, reached from the functions through a connection string kept in the site's environment variables in Netlify. Netlify's own database (Netlify DB, which also runs on Neon) needs a credit-based plan, and the account is on a legacy plan, so Neon is used directly.
- **Config:** `netlify.toml` with `publish = "build"` and `functions = "netlify/functions"`. There's no build step; Netlify installs `package.json`'s one dependency (`@neondatabase/serverless`) for the functions.
- **Environment variables** in Netlify: `DATABASE_URL` (Neon's; `DATABASE_URL_POOLED` is there too but unused, as the driver goes over HTTP), `ADMIN_PASSWORD` for the submissions page, and optionally `IP_SALT` (the IP hashes' salt; without it the database URL is used).
- **The tables** (`submissions`, `votes`, in `netlify/lib/db.mjs`) are made by the first request after a deploy, if they aren't there.

### The Netlify account

The account predates 4 September 2025, so it's on the **legacy Starter** plan and can stay on it: 100 GB bandwidth, 300 build minutes and 125k function requests a month. (The 1M Edge Function invocations are a different kind of function, which this doesn't use.)

| | Estimate for the month | Limit |
|---|---|---|
| Bandwidth | about 6 MB per full play (4.7 MB before [start], plus photos) × 1k, plus return visits: under 10 GB | 100 GB |
| Function requests | pages of the list, votes and submissions, 20–40 per visitor: under 40k | 125k |
| Build minutes | about none: no build step | 300 |

Over the limits, the Starter plan charges overage (about $19 per extra 500k requests) rather than taking the site down. Check whether a card is on the account, and turn on usage alerts.

Neon's free tier is far more than needed (about 2 KB per submission). It sleeps when idle, so the first request after a quiet spell takes about half a second longer.

### Why not a small server

A $5–6/month server would work, but it needs security updates, TLS, backups and restarting when it goes down, and one machine can struggle with a launch spike. Netlify and Neon cost nothing at this scale and need no upkeep beyond the tasks under "Looking after it".

### Speed

- The pages come from the CDN. Only submitting and voting reach a function, and the first call after a quiet spell can take 0.2–1 s.
- "Scroll for inspiration" plays every submission from `words.mp3` and the tracks. The game has those in memory already, so the overlay loads only the scores. On its own the page loads them once (about 4.5 MB), and each submission after that is about 2 KB.
- Submissions load a page at a time as the viewer scrolls.

## Votes without logins

No login means a determined cheater can't be stopped, but several light measures together make it more trouble than it's worth:

1. **A voter id:** a random id the server sets in a cookie scripts can't read on the first visit. The database allows one vote per id per submission (a unique key), and a new vote replaces the last. This stops accidental and casual repeat votes; clearing cookies gets past it.
2. **Rate limit by IP:** a salted hash of the IP, never the IP itself, with a loose cap on votes per hour. Shared Wi-Fi at a venue isn't a concern, as it's online only.
3. **Cloudflare Turnstile** (an invisible CAPTCHA) on votes and submissions, only if bots show up. It can be added later. It's the one outside script the site would load.

The same voter id enforces one submission per player: a unique key on it in the submissions table, and the game hides [submit your lines] once it has submitted. Clearing cookies gets past it, which is fine.

Order: newest, top (up minus down) and random all come from one query with a different `ORDER BY`.

## Freezing into a static archive

After about a month:

1. A script exports every submission that isn't hidden, with its vote counts, to `build/data/submissions.json`.
2. One setting in the page makes it read that file instead of `/api/list`, and hides voting.
3. The functions are removed, and the Neon project can be deleted.

The archive is then plain static files and can stay up indefinitely on Netlify or any static host.

## Looking after it

- **Moderation:** the words can only come from the recording, but some combinations can still be offensive. The table has a `hidden` column, set by hand in Neon's web console. The list and the archive leave hidden submissions out.
- **Backups:** Neon keeps a short restore history. A manual export now and then (the same script as the freeze) covers the rest.
- **Privacy:** IPs are only stored hashed, and the voter cookie counts as strictly necessary. A line saying so goes on the page.

## Decided

- Netlify deploys from the GitHub repo (`dmstfctn/3e-audio-cutup`), so the functions deploy with the site.
- One submission per player, no share links.
- A submission keeps its track mix.
- Whether "scroll for inspiration" is built, and if so as an overlay or a page, is left for later.

## Hearing the submissions

`/tools/submissions.html` (not linked from the game, and marked noindex) asks for `ADMIN_PASSWORD`, then lists every submission with its time, votes and tracks. ▶ plays it as it sounded, from its own audio files. **hidden** takes it out of `/api/list` (and so out of "scroll for inspiration" and the archive). **download .txt** saves the list as text, for picking lines for the performance on 18 October.

## Still to do

1. Test on the branch's deploy preview, then merge to `main`. Test submissions go into the same database: clear them before launch in Neon's SQL editor with `truncate submissions, votes restart identity;`.
2. The freeze script. "Scroll for inspiration" only if it's wanted.

## Sources

- [Netlify legacy pricing plans](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-legacy-plans/legacy-pricing-plans/)
- [Netlify functions usage and billing](https://docs.netlify.com/build/functions/usage-and-billing/)
- [Netlify legacy plans billing FAQ](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-legacy-plans/billing-faq-for-legacy-plans/)
- [Netlify Database now generally available](https://www.netlify.com/changelog/2026-04-28-netlify-database/)
- [Netlify DB docs](https://docs.netlify.com/build/data-and-storage/netlify-database/)
- [Netlify support forum: Starter 125k function requests](https://answers.netlify.com/t/125k-functions-limit-got-over-starter-vs-pro-limits-are-not-clear-urgent/151709)
