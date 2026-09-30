Before the site goes live, in Neon's SQL editor:

Run:

`alter table submissions drop constraint if exists submissions_voter_key;` 

The table was created allowing one submission per voter, and deploying the new code doesn't change an existing table. Until you run this, a player's second submission fails with "server error".


Run:

`truncate submissions, votes restart identity;`

to clear the test submissions.