/* Still — sync and accounts (Cloudflare Worker + D1)
   ---------------------------------------------------
   One file, no build step, no dependencies. Paste it into the Worker editor.

   Bindings it expects:
     DB              D1 database, bound as DB
     ALLOWED_ORIGINS comma-separated origins allowed to call this, or *
     ADMIN_TOKEN     secret, only needed for the /admin routes

   The phone remains the source of truth. This stores a copy so it is safe and
   shared, and hands back what a device is missing. Every sit carries an id made
   on the phone, so re-sending one is a no-op rather than a duplicate.
*/

const SESSION_DAYS  = 400;                  // signed in until you sign out
const SLIDE_MS      = 24 * 60 * 60 * 1000;  // refresh the expiry at most once a day
/* The browser does the slow part. Cloudflare's free plan allows 10ms of CPU per request,
   and stretching a password properly costs far more than that — the isolate is killed
   mid-hash, which surfaces as a 500 with no CORS headers and no way to explain itself.
   So the client derives a key from the password with 250,000 rounds and sends that; the
   server stretches it a little more and stores the result. The password itself never
   leaves the device, and an attacker with the database still faces the client's rounds. */
const PBKDF2_ITER   = 1000;
const KEY_RE        = /^[A-Za-z0-9+/]{43}=$/;   // base64 of 32 bytes, what the client sends
const MAX_FAILS     = 8;
const LOCK_MS       = 15 * 60 * 1000;
const MAX_SITS_SYNC = 500;
const MAX_SETTINGS  = 16 * 1024;

/* ---------- small helpers ---------- */
const enc = new TextEncoder();

function b64(bytes){ let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); }
function unb64(s){ const bin = atob(s); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; }
function b64url(bytes){ return b64(bytes).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }

async function sha256hex(text){
  const d = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2,'0')).join('');
}
function sameBytes(a, b){                    // constant time for equal lengths
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
async function pbkdf2(password, salt, iterations){
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name:'PBKDF2', salt, iterations, hash:'SHA-256' }, key, 256);
  return new Uint8Array(bits);
}
async function hashPassword(password){
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await pbkdf2(password, salt, PBKDF2_ITER);
  return `pbkdf2$${PBKDF2_ITER}$${b64(salt)}$${b64(bits)}`;
}
async function verifyPassword(password, stored){
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = parseInt(parts[1], 10);
  if (!(iterations > 0)) return false;
  const bits = await pbkdf2(password, unb64(parts[2]), iterations);
  return sameBytes(bits, unb64(parts[3]));
}

/* A date label in someone's own timezone. en-CA formats as YYYY-MM-DD. */
function todayIn(tz, fallback){
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC' }).format(new Date());
  } catch (e) {
    return fallback || new Date().toISOString().slice(0, 10);
  }
}
function prevDay(key){
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - 1);
  return dt.toISOString().slice(0, 10);
}
/* The same count the app makes: a run of days, which may end today or yesterday. */
function streakFrom(daySet, today){
  let cursor = today;
  if (!daySet.has(cursor)) cursor = prevDay(cursor);
  let streak = 0;
  while (daySet.has(cursor)) { streak++; cursor = prevDay(cursor); }
  return streak;
}

/* ---------- responses ---------- */
function cors(request, env){
  const origin = request.headers.get('Origin') || '';
  const list = String(env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean);
  const allow = list.includes('*') ? '*' : (list.includes(origin) ? origin : '');
  const h = {
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Max-Age': '600',
    'Vary': 'Origin'
  };
  if (allow) h['Access-Control-Allow-Origin'] = allow;
  return h;
}
function json(data, status, request, env){
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',      // never let a cache hold one person's data
      ...cors(request, env)
    }
  });
}
const fail = (msg, status, request, env) => json({ error: msg }, status || 400, request, env);

/* ---------- validation ---------- */
const ID_RE  = /^[A-Za-z0-9_-]{8,64}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MON_RE = /^\d{4}-\d{2}$/;

function cleanSit(raw){
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '');
  if (!ID_RE.test(id)) return null;
  const day = String(raw.day || '');
  if (!DAY_RE.test(day)) return null;
  const at = Number(raw.at), seconds = Number(raw.seconds), planned = Number(raw.planned);
  if (!Number.isFinite(at) || at <= 0) return null;
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 86400) return null;
  if (!Number.isFinite(planned) || planned < 0 || planned > 86400) return null;
  return {
    id, day, at: Math.round(at),
    seconds: Math.round(seconds), planned: Math.round(planned),
    complete: raw.complete ? 1 : 0
  };
}

/* ---------- sessions ---------- */
function bearer(request, body){
  const m = (request.headers.get('Authorization') || '').match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  // A request with no custom headers needs no CORS preflight, so the client may send the
  // token in the body instead. Some networks and blockers drop OPTIONS entirely.
  if (body && typeof body.token === 'string') return body.token.trim();
  return null;
}
async function authenticate(request, env, body){
  const token = bearer(request, body);
  if (!token) return null;
  const hash = await sha256hex(token);
  const row = await env.DB.prepare(
    `SELECT s.token_hash, s.last_seen, s.expires_at,
            u.id, u.username, u.name, u.tz, u.is_admin
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`).bind(hash).first();
  const now = Date.now();
  if (!row) return null;
  if (row.expires_at < now) {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(hash).run();
    return null;
  }
  if (now - row.last_seen > SLIDE_MS) {           // keep it alive, without writing every request
    await env.DB.prepare('UPDATE sessions SET last_seen = ?, expires_at = ? WHERE token_hash = ?')
      .bind(now, now + SESSION_DAYS * 86400000, hash).run();
  }
  return row;
}
async function openSession(env, userId){
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO sessions (token_hash, user_id, created_at, last_seen, expires_at)
     VALUES (?, ?, ?, ?, ?)`)
    .bind(await sha256hex(token), userId, now, now, now + SESSION_DAYS * 86400000).run();
  return token;
}

/* ---------- throttling ---------- */
async function throttled(env, key){
  const row = await env.DB.prepare('SELECT fails, until FROM throttle WHERE key = ?').bind(key).first();
  return !!(row && row.until > Date.now());
}
async function noteFail(env, key){
  const row = await env.DB.prepare('SELECT fails FROM throttle WHERE key = ?').bind(key).first();
  const fails = (row ? row.fails : 0) + 1;
  const until = fails >= MAX_FAILS ? Date.now() + LOCK_MS : 0;
  await env.DB.prepare(
    `INSERT INTO throttle (key, fails, until) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET fails = excluded.fails, until = excluded.until`)
    .bind(key, fails, until).run();
}
const clearFails = (env, key) => env.DB.prepare('DELETE FROM throttle WHERE key = ?').bind(key).run();

const publicUser = u => ({ id: u.id, username: u.username, name: u.name, isAdmin: !!u.is_admin });

/* ---------- reading a device's missing sits ---------- */
async function sitsSince(env, userId, since){
  const { results } = await env.DB.prepare(
    `SELECT id, at, day, seconds, planned, complete
       FROM sits WHERE user_id = ? AND created_at >= ?
      ORDER BY at ASC`).bind(userId, since).all();
  return (results || []).map(r => ({
    id: r.id, at: r.at, day: r.day,
    seconds: r.seconds, planned: r.planned, complete: !!r.complete
  }));
}
async function readSettings(env, userId){
  const row = await env.DB.prepare('SELECT json, updated_at FROM settings WHERE user_id = ?')
    .bind(userId).first();
  if (!row) return { settings: null, settingsAt: 0 };
  try { return { settings: JSON.parse(row.json), settingsAt: row.updated_at }; }
  catch (e) { return { settings: null, settingsAt: 0 }; }
}

/* ---------- routes ---------- */
/* Short aliases as well as the plain names. Some security products inspect request
   bodies and block anything that looks like credentials being posted to a domain they
   do not recognise, which is indistinguishable from a dead network in the browser. */
const pick = (body, ...names) => {
  for (const n of names) if (typeof body[n] === 'string') return body[n];
  return '';
};
async function claim(request, env, body){
  const username = pick(body, 'username', 'u').trim().toLowerCase();
  const code = pick(body, 'code', 'c').trim().toUpperCase();
  const password = pick(body, 'password', 'p');
  if (!username || !code) return fail('Enter your name and setup code.', 400, request, env);
  if (!KEY_RE.test(password))
    return fail('This app is out of date. Reload the page and try again.', 400, request, env);

  const key = 'claim:' + username;
  if (await throttled(env, key))
    return fail('Too many attempts. Try again in 15 minutes.', 429, request, env);

  const user = await env.DB.prepare(
    'SELECT id, username, name, pw_hash, setup_code, is_admin FROM users WHERE username = ?')
    .bind(username).first();
  if (!user) { await noteFail(env, key); return fail('No account with that name.', 404, request, env); }
  if (user.pw_hash)
    return fail('That account already has a password. Sign in instead.', 409, request, env);
  if (!user.setup_code || user.setup_code.toUpperCase() !== code) {
    await noteFail(env, key);
    return fail('That setup code is not right.', 401, request, env);
  }

  const hash = await hashPassword(password);
  await env.DB.prepare('UPDATE users SET pw_hash = ?, setup_code = NULL, tz = ? WHERE id = ?')
    .bind(hash, String(body.tz || '').slice(0, 64) || null, user.id).run();
  await clearFails(env, key);
  return json({ token: await openSession(env, user.id), user: publicUser(user) }, 200, request, env);
}

async function login(request, env, body){
  const username = pick(body, 'username', 'u').trim().toLowerCase();
  const password = pick(body, 'password', 'p');
  if (!username || !password) return fail('Enter your name and password.', 400, request, env);

  const key = 'login:' + username;
  if (await throttled(env, key))
    return fail('Too many attempts. Try again in 15 minutes.', 429, request, env);

  const user = await env.DB.prepare(
    'SELECT id, username, name, pw_hash, is_admin FROM users WHERE username = ?')
    .bind(username).first();
  if (!user || !user.pw_hash) {
    await noteFail(env, key);
    return fail(user ? 'That account has not been set up yet.' : 'No account with that name.',
                user ? 409 : 404, request, env);
  }
  if (!(await verifyPassword(password, user.pw_hash))) {
    await noteFail(env, key);
    return fail('That password is not right.', 401, request, env);
  }
  await clearFails(env, key);
  if (body.tz) await env.DB.prepare('UPDATE users SET tz = ? WHERE id = ?')
    .bind(String(body.tz).slice(0, 64), user.id).run();
  return json({ token: await openSession(env, user.id), user: publicUser(user) }, 200, request, env);
}

async function changePassword(request, env, me, body){
  const next = pick(body, 'next', 'n');
  if (!KEY_RE.test(next))
    return fail('This app is out of date. Reload the page and try again.', 400, request, env);
  const row = await env.DB.prepare('SELECT pw_hash FROM users WHERE id = ?').bind(me.id).first();
  if (!(await verifyPassword(pick(body, 'current', 'q'), row && row.pw_hash)))
    return fail('That current password is not right.', 401, request, env);
  await env.DB.prepare('UPDATE users SET pw_hash = ? WHERE id = ?')
    .bind(await hashPassword(next), me.id).run();
  // every other device has to sign in again; this one stays
  await env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?')
    .bind(me.id, me.token_hash).run();
  return json({ ok: true }, 200, request, env);
}

async function sync(request, env, me, body){
  const url = new URL(request.url);
  body = body || {};
  const since = Math.max(0, Number(body.since ?? url.searchParams.get('since') ?? 0) || 0);
  const now = Date.now();

  // Clearing your history has to reach here, or the device and the server drift apart
  // for good: the record would be gone from the phone and still counted in the table.
  if (body.forget) {
    await env.DB.prepare('DELETE FROM sits WHERE user_id = ?').bind(me.id).run();
  }

  const incoming = Array.isArray(body.sits) ? body.sits : [];
  if (incoming.length > MAX_SITS_SYNC)
    return fail('Too many sits in one request.', 413, request, env);

  const clean = incoming.map(cleanSit).filter(Boolean);
  if (clean.length) {
    const stmt = env.DB.prepare(
      `INSERT OR IGNORE INTO sits (id, user_id, at, day, seconds, planned, complete, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    await env.DB.batch(clean.map(s =>
      stmt.bind(s.id, me.id, s.at, s.day, s.seconds, s.planned, s.complete, now)));
  }

  if (body.settings && typeof body.settings === 'object') {
    const text = JSON.stringify(body.settings);
    if (text.length > MAX_SETTINGS) return fail('Settings too large.', 413, request, env);
    const at = Number(body.settingsAt) || 0;
    await env.DB.prepare(
      `INSERT INTO settings (user_id, json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at
        WHERE excluded.updated_at > settings.updated_at`)
      .bind(me.id, text, at).run();
  }

  const stored = await readSettings(env, me.id);
  return json({
    user: publicUser(me),
    sits: await sitsSince(env, me.id, since),
    settings: stored.settings, settingsAt: stored.settingsAt,
    now,
    forgot: !!body.forget
  }, 200, request, env);
}

async function leaderboard(request, env, me, body){
  const url = new URL(request.url);
  const ask = (k) => (body && body[k]) || url.searchParams.get(k) || '';
  const month = MON_RE.test(ask('month')) ? ask('month') : todayIn(me.tz).slice(0, 7);
  const clientToday = DAY_RE.test(ask('today')) ? ask('today') : null;

  const { results } = await env.DB.prepare(
    `SELECT u.id, u.name, u.tz,
       COALESCE(SUM(CASE WHEN substr(s.day,1,7) = ?1 THEN s.seconds END), 0) AS m_seconds,
       COUNT(CASE WHEN substr(s.day,1,7) = ?1 THEN 1 END)                    AS m_sits,
       COUNT(DISTINCT CASE WHEN substr(s.day,1,7) = ?1
             AND (s.complete = 1 OR s.seconds >= 300) THEN s.day END)        AS m_days,
       COALESCE(SUM(s.seconds), 0)                                          AS a_seconds,
       COUNT(s.id)                                                          AS a_sits,
       COUNT(DISTINCT CASE WHEN s.complete = 1 OR s.seconds >= 300
             THEN s.day END)                                                AS a_days
     FROM users u LEFT JOIN sits s ON s.user_id = u.id
     GROUP BY u.id, u.name, u.tz`).bind(month).all();

  // the days that count, for the streaks — a year back is more than enough
  const floor = prevDay(todayIn(me.tz, clientToday));
  let cutoff = floor;
  for (let i = 0; i < 400; i++) cutoff = prevDay(cutoff);
  const days = await env.DB.prepare(
    `SELECT user_id, day FROM sits
      WHERE (complete = 1 OR seconds >= 300) AND day >= ?
      GROUP BY user_id, day`).bind(cutoff).all();

  const byUser = new Map();
  for (const r of (days.results || [])) {
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, new Set());
    byUser.get(r.user_id).add(r.day);
  }

  const rows = (results || []).map(r => ({
    id: r.id,
    name: r.name,
    you: r.id === me.id,
    month: { seconds: r.m_seconds, sits: r.m_sits, days: r.m_days },
    all:   { seconds: r.a_seconds, sits: r.a_sits, days: r.a_days },
    // each person's run is counted against their own local today
    streak: streakFrom(byUser.get(r.id) || new Set(), todayIn(r.tz, clientToday)),
    today: (byUser.get(r.id) || new Set()).has(todayIn(r.tz, clientToday))
  }));
  rows.sort((a, b) => b.month.seconds - a.month.seconds || a.name.localeCompare(b.name));
  return json({ month, rows }, 200, request, env);
}

/* Creating or resetting an account without opening the database console. */
async function adminUsers(request, env, body){
  const username = String(body.username || '').trim().toLowerCase();
  const name = String(body.name || '').trim();
  const code = String(body.code || '').trim().toUpperCase();
  if (!username || !name || !code)
    return fail('username, name and code are all required.', 400, request, env);
  const existing = await env.DB.prepare('SELECT id FROM users WHERE username = ?').bind(username).first();
  if (existing) {
    if (!body.reset) return fail('That name is taken. Pass reset:true to reset it.', 409, request, env);
    await env.DB.batch([
      env.DB.prepare('UPDATE users SET pw_hash = NULL, setup_code = ?, name = ? WHERE id = ?')
        .bind(code, name, existing.id),
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(existing.id),
      env.DB.prepare('DELETE FROM throttle WHERE key IN (?, ?)')
        .bind('login:' + username, 'claim:' + username)
    ]);
    return json({ ok: true, reset: true, username, code }, 200, request, env);
  }
  await env.DB.prepare(
    `INSERT INTO users (id, username, name, pw_hash, setup_code, is_admin, created_at)
     VALUES (?, ?, ?, NULL, ?, 0, ?)`)
    .bind(crypto.randomUUID(), username, name, code, Date.now()).run();
  return json({ ok: true, created: true, username, code }, 200, request, env);
}

/* ---------- entry ---------- */
const ACTIONS = {
  claim:       '/auth/claim',
  login:       '/auth/login',
  logout:      '/auth/logout',
  password:    '/auth/password',
  sync:        '/sync',
  leaderboard: '/leaderboard',
  users:       '/admin/users'
};

export default {
  async fetch(request, env){
    const url = new URL(request.url);
    let path = url.pathname.replace(/\/+$/, '') || '/';
    const method = request.method;

    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(request, env) });

    try {
      // Read it once. The client sends text/plain so the browser treats these as simple
      // requests and skips the preflight; the body is still JSON either way.
      // JSON, or the same fields form-encoded. The client falls back to the second when a
      // request never arrives, because some middleboxes object to one shape and not the other.
      let body = {};
      if (method === 'POST') {
        const raw = await request.text().catch(() => '');
        try { body = JSON.parse(raw); }
        catch (e) {
          body = {};
          try { for (const [k, v] of new URLSearchParams(raw)) body[k] = v; } catch (e2) {}
        }
      }
      if (!body || typeof body !== 'object') body = {};

      // Everything can also be asked for at the root, naming the action in the body. Paths
      // like /auth/login are matched by content blockers and network filters, which drop the
      // request before it is sent and report nothing a browser can distinguish from a dead
      // network. One neutral path avoids the whole class of problem.
      if (method === 'POST' && typeof body.action === 'string' && ACTIONS[body.action]) {
        path = ACTIONS[body.action];
      }
      if (path === '/' || path === '/health')
        return json({ ok: true, service: 'still' }, 200, request, env);

      if (path === '/auth/claim' && method === 'POST') return claim(request, env, body);
      if (path === '/auth/login' && method === 'POST') return login(request, env, body);

      if (path === '/admin/users' && method === 'POST') {
        const given = String(bearer(request, body) || '');
        const want = String(env.ADMIN_TOKEN || '');
        if (!want || given.length !== want.length || !sameBytes(enc.encode(given), enc.encode(want)))
          return fail('Not allowed.', 403, request, env);
        return adminUsers(request, env, body);
      }

      const me = await authenticate(request, env, body);
      if (!me) return fail('Sign in again.', 401, request, env);

      if (path === '/auth/logout' && method === 'POST') {
        await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(me.token_hash).run();
        return json({ ok: true }, 200, request, env);
      }
      if (path === '/auth/password' && method === 'POST') return changePassword(request, env, me, body);
      if (path === '/me' && method === 'GET') return sync(request, env, me, {});
      if (path === '/sync' && method === 'POST') return sync(request, env, me, body);
      if (path === '/leaderboard' && (method === 'GET' || method === 'POST')) return leaderboard(request, env, me, body);

      return fail('No such route.', 404, request, env);
    } catch (err) {
      return json({ error: 'Something went wrong.', detail: String(err && err.message || err) },
                  500, request, env);
    }
  }
};
