// /api/admin, for tools/submissions.html, with ADMIN_PASSWORD as a bearer token.
// GET: every submission, hidden ones too, with their votes. POST { id, hidden }: hide or show one.

import { db, handle, ensureSchema, isAdmin, json } from '../lib/db.mjs';

export default handle(async req => {
  const sql = db();
  if (!process.env.ADMIN_PASSWORD) return json({ error: 'ADMIN_PASSWORD isn\'t set in Netlify' }, 503);
  if (!isAdmin(req)) return json({ error: 'wrong password' }, 401);
  await ensureSchema();
  if (req.method === 'POST') {
    const { id, hidden } = await req.json().catch(() => ({}));
    if (!Number.isInteger(id) || typeof hidden !== 'boolean') return json({ error: 'expected { id, hidden }' }, 400);
    await sql`update submissions set hidden = ${hidden} where id = ${id}`;
    return json({ id, hidden });
  }
  const rows = await sql`
    select s.id, s.created_at, s.score, s.text, s.hidden,
      count(v.*) filter (where v.value = 1)::int as up,
      count(v.*) filter (where v.value = -1)::int as down
    from submissions s left join votes v on v.submission_id = s.id
    group by s.id order by s.id desc`;
  return json({ items: rows.map(r => ({ ...r, id: Number(r.id) })) }, 200, { 'Cache-Control': 'no-store' });
});

export const config = { path: '/api/admin' };
