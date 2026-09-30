// POST /api/vote { id, value: 1, -1 or 0 (taken back) }: one vote per voter per submission, a new one replacing it.
// Returns the submission's counts.

import { db, handle, ensureSchema, voterOf, ipHash, json } from '../lib/db.mjs';

const PER_IP_HOUR = 300;

export default handle(async (req, context) => {
  const sql = db();
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  let id, value;
  try {
    ({ id, value } = await req.json());
  } catch {
    return json({ error: 'expected { id, value }' }, 400);
  }
  if (!Number.isInteger(id) || ![1, -1, 0].includes(value)) return json({ error: 'expected { id, value: 1, -1 or 0 }' }, 400);
  await ensureSchema();
  const voter = voterOf(context), ip = ipHash(context);
  const [{ n }] = await sql`select count(*)::int as n from votes where ip_hash = ${ip} and created_at > now() - interval '1 hour'`;
  if (n >= PER_IP_HOUR) return json({ error: 'too many votes from here, try later' }, 429);
  if (value) {
    await sql`insert into votes (submission_id, voter, value, ip_hash)
      select ${id}, ${voter}, ${value}, ${ip} where exists (select 1 from submissions where id = ${id} and not hidden)
      on conflict (submission_id, voter) do update set value = excluded.value, ip_hash = excluded.ip_hash, created_at = now()`;
  } else {
    await sql`delete from votes where submission_id = ${id} and voter = ${voter}`;
  }
  const [c] = await sql`select count(*) filter (where value = 1)::int as up, count(*) filter (where value = -1)::int as down
    from votes where submission_id = ${id}`;
  return json({ id, ...c });
});

export const config = { path: '/api/vote' };
