// GET /api/list?order=new|top|random&page=0&seed=…: a page of the submissions not hidden, with their votes.
// random is shuffled by seed, so the pages of one seed don't overlap. Cached for 30 s, so it's the same for everyone.

import { db, handle, ensureSchema, json } from '../lib/db.mjs';

const PAGE = 20;
const ORDERS = {
  new: 'id desc',
  top: 'up - down desc, id desc',
  random: 'md5(id::text || $3)',
};

export default handle(async req => {
  const sql = db();
  const q = new URL(req.url).searchParams;
  const order = ORDERS[q.get('order')] ? q.get('order') : 'new';
  const page = Math.max(0, Math.min(1000, parseInt(q.get('page') ?? '0', 10) || 0));
  const seed = (q.get('seed') ?? '').slice(0, 32);
  await ensureSchema();
  const rows = await sql.query(`
    select id, created_at, score, up, down from (
      select s.id, s.created_at, s.score,
        count(*) filter (where v.value = 1)::int as up,
        count(*) filter (where v.value = -1)::int as down
      from submissions s left join votes v on v.submission_id = s.id
      where not s.hidden
      group by s.id
    ) t
    order by ${ORDERS[order]} limit $1 offset $2`, order === 'random' ? [PAGE + 1, page * PAGE, seed] : [PAGE + 1, page * PAGE]);
  return json({ items: rows.slice(0, PAGE).map(r => ({ ...r, id: Number(r.id) })), more: rows.length > PAGE }, 200,
    { 'Netlify-CDN-Cache-Control': 'public, max-age=30, stale-while-revalidate=30', 'Cache-Control': 'public, max-age=0, must-revalidate' });
});

export const config = { path: '/api/list' };
