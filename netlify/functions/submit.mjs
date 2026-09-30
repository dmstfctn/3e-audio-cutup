// POST /api/submit: a score (see hosting-plan.md), checked and stored. One per voter: a second gets 409.

import { db, handle, ensureSchema, voterOf, ipHash, json } from '../lib/db.mjs';
import { checkScore, isProblem, scoreText } from '../lib/score.mjs';

const PER_IP_HOUR = 20;  // loose: only one per browser anyway

export default handle(async (req, context) => {
  const sql = db();
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const body = await req.text();
  if (body.length > 20000) return json({ error: 'too big' }, 413);
  let score;
  try {
    score = await checkScore(JSON.parse(body), (file, method = 'GET') => fetch(new URL(`/audio/v/${file}`, req.url), { method }));
  } catch (e) {
    if (e instanceof SyntaxError || isProblem(e)) return json({ error: e.message }, 400);
    throw e;
  }
  await ensureSchema();
  const voter = voterOf(context), ip = ipHash(context);
  const [{ n }] = await sql`select count(*)::int as n from submissions where ip_hash = ${ip} and created_at > now() - interval '1 hour'`;
  if (n >= PER_IP_HOUR) return json({ error: 'too many from here, try later' }, 429);
  const rows = await sql`insert into submissions (voter, ip_hash, score, text)
    values (${voter}, ${ip}, ${JSON.stringify(score)}, ${scoreText(score)})
    on conflict (voter) do nothing returning id`;
  if (!rows.length) return json({ error: 'submitted already' }, 409);
  return json({ id: Number(rows[0].id) }, 201);
});

export const config = { path: '/api/submit' };
