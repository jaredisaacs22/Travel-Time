// Trip planner API: handles every /api/* route (called from src/index.js).
//
// Identity: no accounts. The client sends the traveler's first/last name in
// X-First-Name / X-Last-Name headers (URI-encoded) and every request — read or
// write — is checked against the `travelers` allowlist in D1.

const MAX_DESTINATIONS = 3;
const MAX_DATE_OPTIONS_PER_PERSON = 6;
const DATE_ANSWERS = ['yes', 'maybe', 'no'];
const MAX_BODY_BYTES = 16 * 1024;

// [requests, window seconds] per client IP.
const LIMITS = {
  login: [10, 60],
  read: [120, 60],
  write: [30, 60],
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

// Must match normalizeName() in scripts/seed-allowlist.mjs.
function normalizeName(s) {
  return String(s ?? '').normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function decodeHeader(request, name) {
  const raw = request.headers.get(name) || '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return '';
  }
}

async function rateLimit(ctx, bucket) {
  const { env, request } = ctx;
  const [limit, windowSec] = LIMITS[bucket];
  const ip = request.headers.get('CF-Connecting-IP') || 'local';
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % windowSec);
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1)
     ON CONFLICT(key) DO UPDATE SET
       count = CASE WHEN window_start = ?2 THEN count + 1 ELSE 1 END,
       window_start = ?2
     RETURNING count`
  )
    .bind(`${bucket}:${ip}`, windowStart)
    .first();
  // Occasionally sweep stale counters so the table stays tiny.
  if (Math.random() < 0.02) {
    ctx.waitUntil(env.DB.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(now - 3600).run());
  }
  if (row.count > limit) throw new HttpError(429, 'Too many requests. Please wait a minute and try again.');
}

async function findTraveler(env, first, last) {
  const f = normalizeName(first);
  const l = normalizeName(last);
  if (!f || !l || f.length > 60 || l.length > 60) return null;
  return env.DB.prepare(
    'SELECT id, first_display AS first, last_display AS last FROM travelers WHERE first_norm = ? AND last_norm = ?'
  )
    .bind(f, l)
    .first();
}

async function requireTraveler(env, request) {
  const me = await findTraveler(env, decodeHeader(request, 'X-First-Name'), decodeHeader(request, 'X-Last-Name'));
  if (!me) throw new HttpError(401, "That name isn't on the trip list.");
  return me;
}

async function readJson(request) {
  if (!(request.headers.get('content-type') || '').toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'Expected JSON.');
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, 'Request too large.');
  try {
    const body = JSON.parse(text);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new HttpError(400, 'Invalid JSON.');
  }
}

// ---- Validation -------------------------------------------------------------

// Strip control characters (keeping newlines when allowed) and trim.
function cleanText(v, field, { min = 0, max, multiline = false }) {
  if (v == null) v = '';
  if (typeof v !== 'string') throw new HttpError(400, `${field} must be text.`);
  let s = v.normalize('NFC').replace(/\r\n?/g, '\n');
  s = multiline ? s.replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '') : s.replace(/[\u0000-\u001F\u007F]/g, ' ');
  s = s.trim();
  if (!multiline) s = s.replace(/\s+/g, ' ');
  if (s.length < min) throw new HttpError(400, min === 1 ? `${field} is required.` : `${field} is too short.`);
  if (s.length > max) throw new HttpError(400, `${field} must be at most ${max} characters.`);
  return s;
}

function cleanNumber(v, field, { min, max, integer = false }) {
  if (v === '' || v == null) v = 0;
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new HttpError(400, `${field} must be a number.`);
  if (n < min || n > max) throw new HttpError(400, `${field} must be between ${min} and ${max.toLocaleString('en-US')}.`);
  if (integer && !Number.isInteger(n)) throw new HttpError(400, `${field} must be a whole number.`);
  return integer ? n : Math.round(n * 100) / 100;
}

function cleanDestination(body) {
  return {
    name: cleanText(body.name, 'Destination', { min: 1, max: 80 }),
    lat: cleanNumber(body.lat, 'Latitude', { min: -90, max: 90 }),
    lng: cleanNumber(body.lng, 'Longitude', { min: -180, max: 180 }),
    flight_cost: cleanNumber(body.flight_cost, 'Flight cost', { min: 0, max: 100000 }),
    hotel_per_night: cleanNumber(body.hotel_per_night, 'Hotel per night', { min: 0, max: 20000 }),
    nights: cleanNumber(body.nights, 'Nights', { min: 0, max: 60, integer: true }),
    food_activities: cleanNumber(body.food_activities, 'Food & activities', { min: 0, max: 100000 }),
    notes: cleanText(body.notes, 'Notes', { max: 1000, multiline: true }),
  };
}

function cleanId(v) {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw new HttpError(404, 'Not found.');
  return n;
}

async function loadOwnedDestination(env, id, me) {
  const row = await env.DB.prepare('SELECT id, owner_id FROM destinations WHERE id = ?').bind(id).first();
  if (!row) throw new HttpError(404, 'Destination not found.');
  if (row.owner_id !== me.id) throw new HttpError(403, 'Only the person who added this destination can change it.');
  return row;
}

// ---- Handlers ---------------------------------------------------------------

async function login(ctx) {
  await rateLimit(ctx, 'login');
  const body = await readJson(ctx.request);
  const me = await findTraveler(ctx.env, body.first, body.last);
  if (!me) throw new HttpError(401, "That name isn't on the trip list. Check the spelling, or ask the organizer to add you.");
  return json({ me });
}

async function getState(ctx, me) {
  const { env } = ctx;
  const [dests, votes, comments, travelers, quotes, dateOptions, dateVotes] = await env.DB.batch([
    env.DB.prepare(
      `SELECT d.id, d.owner_id, t.first_display || ' ' || t.last_display AS owner_name, d.name, d.lat, d.lng,
              d.flight_cost, d.hotel_per_night, d.nights, d.food_activities, d.notes, d.created_at, d.updated_at
       FROM destinations d JOIN travelers t ON t.id = d.owner_id
       ORDER BY d.created_at`
    ),
    env.DB.prepare(
      `SELECT v.destination_id, v.voter_id, t.first_display || ' ' || t.last_display AS voter_name
       FROM votes v JOIN travelers t ON t.id = v.voter_id
       ORDER BY v.created_at`
    ),
    env.DB.prepare(
      `SELECT c.id, c.destination_id, c.author_id, t.first_display || ' ' || t.last_display AS author_name,
              c.body, c.created_at
       FROM comments c JOIN travelers t ON t.id = c.author_id
       ORDER BY c.created_at`
    ),
    env.DB.prepare(
      `SELECT id, first_display AS first, last_display AS last, home_label, home_lat, home_lng
       FROM travelers ORDER BY id`
    ),
    env.DB.prepare('SELECT destination_id, traveler_id, price, updated_at FROM flight_quotes'),
    env.DB.prepare('SELECT id, created_by, start_date, end_date, note, created_at FROM date_options ORDER BY start_date, end_date'),
    env.DB.prepare('SELECT option_id, traveler_id, answer FROM date_votes'),
  ]);

  const byDest = new Map();
  for (const v of votes.results) {
    if (!byDest.has(v.destination_id)) byDest.set(v.destination_id, []);
    byDest.get(v.destination_id).push(v);
  }
  const destinations = dests.results.map((d) => {
    const vs = byDest.get(d.id) || [];
    return {
      ...d,
      total: Math.round((d.flight_cost + d.hotel_per_night * d.nights + d.food_activities) * 100) / 100,
      votes: vs.length,
      voted: vs.some((v) => v.voter_id === me.id),
      voters: vs.map((v) => v.voter_name),
    };
  });
  return json({
    me,
    max_destinations: MAX_DESTINATIONS,
    destinations,
    comments: comments.results,
    travelers: travelers.results,
    flight_quotes: quotes.results,
    date_options: dateOptions.results,
    date_votes: dateVotes.results,
  });
}

async function createDestination(ctx, me) {
  const d = cleanDestination(await readJson(ctx.request));
  const now = Date.now();
  // Single conditional insert so concurrent requests can't exceed the cap.
  const res = await ctx.env.DB.prepare(
    `INSERT INTO destinations
       (owner_id, name, lat, lng, flight_cost, hotel_per_night, nights, food_activities, notes, created_at, updated_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10
     WHERE (SELECT COUNT(*) FROM destinations WHERE owner_id = ?1) < ?11`
  )
    .bind(me.id, d.name, d.lat, d.lng, d.flight_cost, d.hotel_per_night, d.nights, d.food_activities, d.notes, now, MAX_DESTINATIONS)
    .run();
  if (!res.meta.changes) throw new HttpError(409, `You can add up to ${MAX_DESTINATIONS} destinations. Edit or remove one first.`);
  return json({ id: res.meta.last_row_id }, 201);
}

async function updateDestination(ctx, me, id) {
  await loadOwnedDestination(ctx.env, id, me);
  const d = cleanDestination(await readJson(ctx.request));
  await ctx.env.DB.prepare(
    `UPDATE destinations SET name = ?, lat = ?, lng = ?, flight_cost = ?, hotel_per_night = ?, nights = ?,
       food_activities = ?, notes = ?, updated_at = ?
     WHERE id = ? AND owner_id = ?`
  )
    .bind(d.name, d.lat, d.lng, d.flight_cost, d.hotel_per_night, d.nights, d.food_activities, d.notes, Date.now(), id, me.id)
    .run();
  return json({ ok: true });
}

async function deleteDestination(ctx, me, id) {
  await loadOwnedDestination(ctx.env, id, me);
  await ctx.env.DB.prepare('DELETE FROM destinations WHERE id = ? AND owner_id = ?').bind(id, me.id).run();
  return json({ ok: true });
}

async function requireDestination(env, id) {
  const row = await env.DB.prepare('SELECT id FROM destinations WHERE id = ?').bind(id).first();
  if (!row) throw new HttpError(404, 'Destination not found.');
}

async function addComment(ctx, me, destId) {
  const body = await readJson(ctx.request);
  const text = cleanText(body.body, 'Comment', { min: 1, max: 1000, multiline: true });
  await requireDestination(ctx.env, destId);
  const res = await ctx.env.DB.prepare(
    'INSERT INTO comments (destination_id, author_id, body, created_at) VALUES (?, ?, ?, ?)'
  )
    .bind(destId, me.id, text, Date.now())
    .run();
  return json({ id: res.meta.last_row_id }, 201);
}

async function deleteComment(ctx, me, id) {
  const row = await ctx.env.DB.prepare('SELECT author_id FROM comments WHERE id = ?').bind(id).first();
  if (!row) throw new HttpError(404, 'Comment not found.');
  if (row.author_id !== me.id) throw new HttpError(403, 'You can only delete your own comments.');
  await ctx.env.DB.prepare('DELETE FROM comments WHERE id = ?').bind(id).run();
  return json({ ok: true });
}

async function setVote(ctx, me, destId, on) {
  await requireDestination(ctx.env, destId);
  const stmt = on
    ? ctx.env.DB.prepare('INSERT OR IGNORE INTO votes (destination_id, voter_id, created_at) VALUES (?, ?, ?)').bind(destId, me.id, Date.now())
    : ctx.env.DB.prepare('DELETE FROM votes WHERE destination_id = ? AND voter_id = ?').bind(destId, me.id);
  await stmt.run();
  return json({ ok: true });
}

// A traveler's own fare from their hometown; clearing it falls back to the proposer's estimate.
async function setMyFlight(ctx, me, destId, on) {
  await requireDestination(ctx.env, destId);
  if (!on) {
    await ctx.env.DB.prepare('DELETE FROM flight_quotes WHERE destination_id = ? AND traveler_id = ?').bind(destId, me.id).run();
    return json({ ok: true });
  }
  const price = cleanNumber((await readJson(ctx.request)).price, 'Flight price', { min: 0, max: 100000 });
  await ctx.env.DB.prepare(
    `INSERT INTO flight_quotes (destination_id, traveler_id, price, updated_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(destination_id, traveler_id) DO UPDATE SET price = excluded.price, updated_at = excluded.updated_at`
  )
    .bind(destId, me.id, price, Date.now())
    .run();
  return json({ ok: true });
}

// ---- Trip dates -------------------------------------------------------------

// Strict YYYY-MM-DD that round-trips (rejects 2027-02-30), returned as a UTC Date.
function cleanDate(v, field) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new HttpError(400, `${field} must be a date.`);
  const d = new Date(v + 'T00:00:00Z');
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw new HttpError(400, `${field} isn't a real date.`);
  return d;
}

async function createDateOption(ctx, me) {
  const body = await readJson(ctx.request);
  const start = cleanDate(body.start, 'Start date');
  const end = cleanDate(body.end, 'End date');
  const note = cleanText(body.note, 'Note', { max: 80 });
  const day = 86400000;
  const today = Date.now() - day; // a day of slack for time zones
  if (start.getTime() < today) throw new HttpError(400, 'Pick dates in the future.');
  if (start.getTime() > Date.now() + 3 * 365 * day) throw new HttpError(400, 'Pick dates within the next 3 years.');
  if (end < start) throw new HttpError(400, 'The end date must be on or after the start date.');
  if ((end - start) / day > 60) throw new HttpError(400, 'Keep the window to 60 days or less.');
  const res = await ctx.env.DB.prepare(
    `INSERT INTO date_options (created_by, start_date, end_date, note, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5
     WHERE (SELECT COUNT(*) FROM date_options WHERE created_by = ?1) < ?6`
  )
    .bind(me.id, body.start, body.end, note, Date.now(), MAX_DATE_OPTIONS_PER_PERSON)
    .run();
  if (!res.meta.changes) throw new HttpError(409, `You can suggest up to ${MAX_DATE_OPTIONS_PER_PERSON} date windows. Remove one first.`);
  // Suggesting dates implies they work for you.
  await ctx.env.DB.prepare('INSERT INTO date_votes (option_id, traveler_id, answer, updated_at) VALUES (?, ?, ?, ?)')
    .bind(res.meta.last_row_id, me.id, 'yes', Date.now())
    .run();
  return json({ id: res.meta.last_row_id }, 201);
}

async function deleteDateOption(ctx, me, id) {
  const row = await ctx.env.DB.prepare('SELECT created_by FROM date_options WHERE id = ?').bind(id).first();
  if (!row) throw new HttpError(404, 'Date option not found.');
  if (row.created_by !== me.id) throw new HttpError(403, 'Only the person who suggested these dates can remove them.');
  await ctx.env.DB.prepare('DELETE FROM date_options WHERE id = ?').bind(id).run();
  return json({ ok: true });
}

async function setDateVote(ctx, me, id, on) {
  const row = await ctx.env.DB.prepare('SELECT id FROM date_options WHERE id = ?').bind(id).first();
  if (!row) throw new HttpError(404, 'Date option not found.');
  if (!on) {
    await ctx.env.DB.prepare('DELETE FROM date_votes WHERE option_id = ? AND traveler_id = ?').bind(id, me.id).run();
    return json({ ok: true });
  }
  const { answer } = await readJson(ctx.request);
  if (!DATE_ANSWERS.includes(answer)) throw new HttpError(400, 'Answer must be yes, maybe or no.');
  await ctx.env.DB.prepare(
    `INSERT INTO date_votes (option_id, traveler_id, answer, updated_at) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(option_id, traveler_id) DO UPDATE SET answer = excluded.answer, updated_at = excluded.updated_at`
  )
    .bind(id, me.id, answer, Date.now())
    .run();
  return json({ ok: true });
}

// ---- Router -----------------------------------------------------------------

async function route(ctx) {
  const { request, env } = ctx;
  const method = request.method;
  const parts = [].concat(ctx.params.path || []);
  const [a, b, c] = parts;

  if (method === 'POST' && a === 'login' && parts.length === 1) return login(ctx);

  const isWrite = method !== 'GET' && method !== 'HEAD';
  await rateLimit(ctx, isWrite ? 'write' : 'read');
  const me = await requireTraveler(env, request);

  if (a === 'state' && parts.length === 1 && method === 'GET') return getState(ctx, me);

  if (a === 'destinations') {
    if (parts.length === 1 && method === 'POST') return createDestination(ctx, me);
    if (parts.length === 2) {
      const id = cleanId(b);
      if (method === 'PUT') return updateDestination(ctx, me, id);
      if (method === 'DELETE') return deleteDestination(ctx, me, id);
    }
    if (parts.length === 3 && c === 'comments' && method === 'POST') return addComment(ctx, me, cleanId(b));
    if (parts.length === 3 && c === 'vote' && (method === 'PUT' || method === 'DELETE')) {
      return setVote(ctx, me, cleanId(b), method === 'PUT');
    }
    if (parts.length === 3 && c === 'my-flight' && (method === 'PUT' || method === 'DELETE')) {
      return setMyFlight(ctx, me, cleanId(b), method === 'PUT');
    }
  }

  if (a === 'comments' && parts.length === 2 && method === 'DELETE') return deleteComment(ctx, me, cleanId(b));

  if (a === 'dates') {
    if (parts.length === 1 && method === 'POST') return createDateOption(ctx, me);
    if (parts.length === 2 && method === 'DELETE') return deleteDateOption(ctx, me, cleanId(b));
    if (parts.length === 3 && c === 'vote' && (method === 'PUT' || method === 'DELETE')) {
      return setDateVote(ctx, me, cleanId(b), method === 'PUT');
    }
  }

  throw new HttpError(404, 'Not found.');
}

export async function onRequest(ctx) {
  try {
    return await route(ctx);
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    console.error(err);
    return json({ error: 'Something went wrong on our side.' }, 500);
  }
}
