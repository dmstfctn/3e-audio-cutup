// The database (Postgres on Neon, DATABASE_URL in Netlify's environment variables), and what the functions share.

import { neon } from '@neondatabase/serverless';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

// made on first use, inside handle(), so a bad DATABASE_URL is a plain 500, not an error page showing it
let client = null;
export const db = () => client ??= neon(process.env.DATABASE_URL);

// Wraps a function's handler: an error is logged (connection strings blanked out) and answered with a plain
// "server error", never with its details, which Netlify would otherwise show to anyone.
export const handle = fn => async (req, context) => {
  try {
    return await fn(req, context);
  } catch (e) {
    console.error(String(e?.stack ?? e).replace(/postgres(ql)?:\/\/[^\s"']*/g, '[database url]'));
    return json({ error: 'server error' }, 500);
  }
};

// The tables, made on the first request after a deploy if they aren't there. hidden is set by hand in Neon's console
// (or the submissions page) to take a submission out of the list.
let ready = null;
export function ensureSchema() {
  const sql = db();
  ready ??= sql.transaction([
    sql`create table if not exists submissions (
      id bigint generated always as identity primary key,
      created_at timestamptz not null default now(),
      voter uuid not null,
      ip_hash text not null,
      score jsonb not null,
      text text not null,
      hidden boolean not null default false
    )`,
    sql`create table if not exists votes (
      submission_id bigint not null references submissions on delete cascade,
      voter uuid not null,
      value smallint not null check (value in (-1, 1)),
      ip_hash text not null,
      created_at timestamptz not null default now(),
      primary key (submission_id, voter)
    )`,
    sql`create index if not exists submissions_ip on submissions (ip_hash, created_at)`,
    sql`create index if not exists votes_ip on votes (ip_hash, created_at)`,
  ]).catch(e => { ready = null; throw e; });
  return ready;
}

// A random id for this browser, in a cookie scripts can't read: one vote per id per submission.
export function voterOf(context) {
  let id = context.cookies.get('voter');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id ?? '')) {
    id = randomUUID();
    context.cookies.set({ name: 'voter', value: id, path: '/', httpOnly: true, secure: true, sameSite: 'Lax',
      expires: new Date(Date.now() + 365 * 864e5) });
  }
  return id;
}

// The IP is only kept hashed, with a secret salt, for rate limits.
export const ipHash = context => createHash('sha256')
  .update(`${process.env.IP_SALT ?? process.env.DATABASE_URL}|${context.ip ?? ''}`).digest('hex').slice(0, 32);

export const json = (body, status = 200, headers = {}) => Response.json(body, { status, headers });

// the submissions page's password: ADMIN_PASSWORD in Netlify's environment variables
export function isAdmin(req) {
  const want = process.env.ADMIN_PASSWORD;
  const got = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '');
  if (!want || !got) return false;
  const a = createHash('sha256').update(want).digest(), b = createHash('sha256').update(got).digest();
  return timingSafeEqual(a, b);
}
