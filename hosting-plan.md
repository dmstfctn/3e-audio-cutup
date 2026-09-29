# Hosting plan: submissions and "scroll for inspiration"

Players submit their lines at the end. Anyone can browse the submissions and vote on them up or down on a separate page or overlay, "scroll for inspiration", which can also be opened while writing (how exactly is to be decided). Nothing is built yet.

## Requirements

- Online only. Up for a week before an event, with about 1k visitors, not all of whom play to the end.
- Live for about a month, then frozen into a static archive.
- Anonymous: no names, no login.
- Up and down votes, with a choice of order (newest, top, random).
- A submission keeps the track mix it was made with. It may end up as the full track (`all`) instead.
- One person looks after it, so upkeep should be close to none.
- Loading outside scripts is acceptable if needed. The rule against it was mostly to keep the prototypes self-contained.

## The submission format

A submission is a small JSON "score", about 1–3 KB. It can't be edited and always sounds the same.

```json
{
  "v": 1,
  "audio": { "words": "words.3f9a2c.mp3",
             "tracks": { "beat": "track-drums.81be07.mp3", "strings": "track-string2.c41d9e.mp3" } },
  "bpm": 143.59,
  "lines": [
    { "bar": 0, "words": [ { "id": 812, "text": "yeah", "bin": "yeah", "s": 101.234, "d": 0.412 },
                           { "rest": 0.836 } ] },
    { "bar": 4, "words": [ … ] }
  ]
}
```

- **Times, not just ids.** Each word stores its start time `s` and length `d` in `words.mp3`, with any `clips.json` trims already applied, as well as its text and bin for display. Re-running preprocessing can renumber the ids, and the clip picker can change the trims, so an id alone could come to point at a different sound. Pauses store only their length.
- **The files a submission uses are never changed.** Audio files get a content hash in their names (`words.3f9a2c.mp3`, `track-drums.81be07.mp3`), and old versions stay in `build/audio/` for good. Replacing `track-drums.mp3` in place, as happened on 2026-09-29, would change every submission made before it.
- **What actually played.** `tracks` lists the tracks that could be heard at submit time, after the `all` solo rule (`SOLO_TRACKS`) is applied. If it's decided that submissions use the full track, submit writes `all` there, and the format stays the same.
- **Each line's bars.** A line plays over the bars set by its position (`playLine(i, …)`: line i over bars 2i+1–2i+2), whether or not the lines before it are on. `bar` stores that start, so switching lines off doesn't shift anything. Lines that are off aren't included.
- **Checked on the server.** The server keeps a copy of the allowed clips (text, `s` and `d` for each) for each audio version, and rejects a submission with a clip that doesn't match one of them, a line longer than 2 bars, more than 8 lines, or no words at all. Otherwise anyone could post any stretch of the recording with any text over it.

Rendering each submission to an audio file (`OfflineAudioContext`, then an encoder) is the only way to freeze it completely. But it takes about 100× the storage and bandwidth, and `MediaRecorder` records in real time and produces a different format in each browser. The score is the master copy; audio could be rendered from it later if downloads or share previews are wanted.

## Hosting: Netlify and Neon

- **The site:** `build/` as it is now, on Netlify's CDN.
- **The API:** three Netlify Functions on the same domain (so no CORS setup):
  - `/api/submit` checks and stores a score.
  - `/api/list` returns a page of submissions in the order asked for, cached for about 30 s.
  - `/api/vote` records +1, −1 or 0 (a vote taken back).
- **The database:** Postgres on a free Neon account, reached from the functions through a connection string kept in the site's environment variables in Netlify. Netlify's own database (Netlify DB, which also runs on Neon) needs a credit-based plan, and the account is on a legacy plan, so Neon is used directly.
- **Config:** `netlify.toml` with `publish = "build"` and `functions = "netlify/functions"`. There's no build step.

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
3. **Cloudflare Turnstile** (an invisible CAPTCHA) on votes and submissions, only if bots show up. It can be added later.

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

## Also to decide

- One submission per player, or as many as they like? The game already rejects submissions with no words (see "The submission format").
- A link to each submission (`/s/abc123`) so players can share their own?
- How "scroll for inspiration" opens during writing: an overlay over the lines, or a separate page? Does each submission play as it scrolls into view, or when tapped?
- The mix: as it was when submitted, or always the full track?

## Before building

1. Does Netlify deploy from the GitHub repo (`dmstfctn/3e-audio-cutup`), or is `build/` uploaded by hand? Functions need a Git-connected deploy or the Netlify CLI.
2. Create a Neon account. The table setup comes with the build, along with the environment variable to set in Netlify.
3. Suggested order: the submit path (format, function, database) first, then "scroll for inspiration", then votes, then the freeze script.

## Sources

- [Netlify legacy pricing plans](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-legacy-plans/legacy-pricing-plans/)
- [Netlify functions usage and billing](https://docs.netlify.com/build/functions/usage-and-billing/)
- [Netlify legacy plans billing FAQ](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-legacy-plans/billing-faq-for-legacy-plans/)
- [Netlify Database now generally available](https://www.netlify.com/changelog/2026-04-28-netlify-database/)
- [Netlify DB docs](https://docs.netlify.com/build/data-and-storage/netlify-database/)
- [Netlify support forum: Starter 125k function requests](https://answers.netlify.com/t/125k-functions-limit-got-over-starter-vs-pro-limits-are-not-clear-urgent/151709)
