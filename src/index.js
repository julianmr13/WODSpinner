// WOD Spinner backend — Google login, sessions, and shared favourites.
// Runs as a Cloudflare Worker alongside the static site: any request that
// matches a route below is handled here; everything else falls through to
// the static HTML/CSS/JS via the ASSETS binding.

function generateId(len = 32) {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function parseCookies(request) {
  const header = request.headers.get('Cookie') || '';
  const cookies = {};
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    cookies[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return cookies;
}

function setCookieHeader(name, value, maxAgeSeconds) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}
function clearCookieHeader(name) {
  return `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

async function getSessionUser(request, env) {
  const cookies = parseCookies(request);
  const sid = cookies['wodspinner_session'];
  if (!sid) return null;
  const row = await env.DB.prepare(
    `SELECT users.id, users.email, users.display_name, users.nickname, users.avatar_url,
            users.is_admin, users.tier
     FROM sessions
     JOIN users ON users.id = sessions.user_id
     WHERE sessions.id = ? AND sessions.expires_at > ?`
  ).bind(sid, Date.now()).first();
  return row || null;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === '/auth/google/login') return handleGoogleLogin(request, env, url);
      if (path === '/auth/google/callback') return handleGoogleCallback(request, env, url);
      if (path === '/auth/logout' && request.method === 'POST') return handleLogout(request, env);
      if (path === '/api/me') return handleMe(request, env);
      if (path === '/api/me/nickname' && request.method === 'PUT') return handleUpdateNickname(request, env);
      if (path === '/api/me/streak') return handleMyStreak(request, env);
      if (path === '/api/favourites' && request.method === 'GET') return handleListFavourites(request, env);
      if (path === '/api/favourites' && request.method === 'POST') return handleAddFavourite(request, env);
      if (path.startsWith('/api/favourites/') && request.method === 'DELETE') {
        return handleDeleteFavourite(request, env, path.slice('/api/favourites/'.length));
      }
      if (path === '/api/popular') return handlePopular(request, env);
      if (path === '/api/gym-data') return handleGymData(request, env);
      if (path === '/api/my/equipment-lists' && request.method === 'GET') return handleListEquipmentLists(request, env);
      if (path === '/api/my/equipment-lists' && request.method === 'POST') return handleCreateEquipmentList(request, env);
      if (path.startsWith('/api/my/equipment-lists/') && request.method === 'DELETE') {
        return handleDeleteEquipmentList(request, env, path.slice('/api/my/equipment-lists/'.length));
      }
      if (path.startsWith('/api/my/equipment-lists/') && request.method === 'PUT') {
        return handleRenameEquipmentList(request, env, path.slice('/api/my/equipment-lists/'.length));
      }
      if (path === '/api/my/equipment-off' && request.method === 'PUT') return handleToggleEquipmentOff(request, env);
      if (path === '/api/my/equipment' && request.method === 'POST') return handleAddMyEquipment(request, env);
      if (path.startsWith('/api/my/equipment/') && request.method === 'DELETE') {
        return handleDeleteMyEquipment(request, env, path.slice('/api/my/equipment/'.length));
      }
      if (path === '/api/my/hidden-exercises' && request.method === 'PUT') return handleToggleHiddenExercise(request, env);
      if (path === '/api/my/exercises' && request.method === 'POST') return handleAddMyExercise(request, env);
      if (path.startsWith('/api/my/exercises/') && request.method === 'DELETE') {
        return handleDeleteMyExercise(request, env, path.slice('/api/my/exercises/'.length));
      }
      if (path === '/api/my/favourite-exercises' && request.method === 'PUT') return handleToggleFavouriteExercise(request, env);
      if (path === '/api/history' && request.method === 'POST') return handleAddHistory(request, env);
      if (path === '/api/history/recent') return handleRecentHistory(request, env);
      if (path.startsWith('/api/history/') && path.endsWith('/feedback') && request.method === 'PUT') {
        return handleSetHistoryFeedback(request, env, path.slice('/api/history/'.length, -'/feedback'.length));
      }
      if (path === '/api/admin/feedback-summary' && request.method === 'GET') return handleAdminFeedbackSummary(request, env);
      if (path === '/api/admin/equipment' && request.method === 'GET') return handleAdminListEquipment(request, env);
      if (path === '/api/admin/equipment' && request.method === 'POST') return handleAdminAddEquipment(request, env);
      if (path.startsWith('/api/admin/equipment/') && request.method === 'PUT') {
        return handleAdminUpdateEquipment(request, env, path.slice('/api/admin/equipment/'.length));
      }
      if (path.startsWith('/api/admin/equipment/') && request.method === 'DELETE') {
        return handleAdminDeleteEquipment(request, env, path.slice('/api/admin/equipment/'.length));
      }
      if (path === '/api/admin/exercises' && request.method === 'GET') return handleAdminListExercises(request, env);
      if (path === '/api/admin/users' && request.method === 'GET') return handleAdminListUsers(request, env);
      if (path.startsWith('/api/admin/users/') && path.endsWith('/tier') && request.method === 'PUT') {
        return handleAdminSetUserTier(request, env, path.slice('/api/admin/users/'.length, -'/tier'.length));
      }
      if (path === '/api/admin/review/equipment' && request.method === 'GET') return handleAdminListPendingEquipment(request, env);
      if (path.startsWith('/api/admin/review/equipment/') && path.endsWith('/promote') && request.method === 'POST') {
        return handleAdminPromoteEquipment(request, env, path.slice('/api/admin/review/equipment/'.length, -'/promote'.length));
      }
      if (path.startsWith('/api/admin/review/equipment/') && path.endsWith('/dismiss') && request.method === 'POST') {
        return handleAdminDismissEquipment(request, env, path.slice('/api/admin/review/equipment/'.length, -'/dismiss'.length));
      }
      if (path === '/api/admin/review/exercises' && request.method === 'GET') return handleAdminListPendingExercises(request, env);
      if (path.startsWith('/api/admin/review/exercises/') && path.endsWith('/promote') && request.method === 'POST') {
        return handleAdminPromoteExercise(request, env, path.slice('/api/admin/review/exercises/'.length, -'/promote'.length));
      }
      if (path.startsWith('/api/admin/review/exercises/') && path.endsWith('/dismiss') && request.method === 'POST') {
        return handleAdminDismissExercise(request, env, path.slice('/api/admin/review/exercises/'.length, -'/dismiss'.length));
      }
      if (path === '/api/admin/exercises' && request.method === 'POST') return handleAdminAddExercise(request, env);
      if (path.startsWith('/api/admin/exercises/') && request.method === 'PUT') {
        return handleAdminUpdateExercise(request, env, path.slice('/api/admin/exercises/'.length));
      }
      if (path.startsWith('/api/admin/exercises/') && request.method === 'DELETE') {
        return handleAdminDeleteExercise(request, env, path.slice('/api/admin/exercises/'.length));
      }
    } catch (err) {
      return json({ error: 'Server error', detail: String(err && err.message || err) }, 500);
    }

    // not one of our API routes — serve the static site
    return env.ASSETS.fetch(request);
  },
};

// ---- Google OAuth (standard Authorization Code flow — safe to use the
// client secret here since this all runs server-side, never in the browser) ----

async function handleGoogleLogin(request, env, url) {
  const state = generateId(16);
  const redirectUri = `${url.origin}/auth/google/callback`;
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'openid email profile',
    state,
    access_type: 'online',
    prompt: 'select_account',
  });
  const headers = new Headers({
    Location: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
  });
  headers.append('Set-Cookie', setCookieHeader('wodspinner_oauth_state', state, 600));
  return new Response(null, { status: 302, headers });
}

async function handleGoogleCallback(request, env, url) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const err = url.searchParams.get('error');
  const cookies = parseCookies(request);

  if (err) {
    return new Response(`Login was not completed (Google returned: ${err}). Go back and try again.`, { status: 400 });
  }
  if (!code || !state || state !== cookies['wodspinner_oauth_state']) {
    return new Response('Login could not be verified (state mismatch). Please try connecting again.', { status: 400 });
  }

  const redirectUri = `${url.origin}/auth/google/callback`;
  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  const tokenData = await tokenResp.json();
  if (!tokenData.access_token) {
    return new Response('Login failed: Google did not return an access token. Try again.', { status: 400 });
  }

  const profileResp = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  const profile = await profileResp.json();
  if (!profile.sub || !profile.email) {
    return new Response('Login failed: could not fetch your Google profile.', { status: 400 });
  }

  let user = await env.DB.prepare(
    'SELECT id, email, display_name, nickname, avatar_url, is_admin, tier FROM users WHERE google_sub = ?'
  ).bind(profile.sub).first();

  if (!user) {
    const id = generateId(16);
    await env.DB.prepare(
      'INSERT INTO users (id, email, display_name, google_sub, avatar_url, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(id, profile.email, profile.name || profile.email, profile.sub, profile.picture || null, Date.now()).run();
    user = {
      id, email: profile.email, display_name: profile.name || profile.email,
      nickname: null, avatar_url: profile.picture || null, is_admin: 0, tier: 'free',
    };
  } else {
    // refresh the avatar on every login in case they've changed their Google
    // profile picture since — cheap to keep in sync, no reason to let it go stale
    if (profile.picture && profile.picture !== user.avatar_url) {
      await env.DB.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').bind(profile.picture, user.id).run();
      user.avatar_url = profile.picture;
    }
  }

  const sessionId = generateId(32);
  const expiresAt = Date.now() + 90 * 24 * 60 * 60 * 1000; // 90 days
  await env.DB.prepare(
    'INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'
  ).bind(sessionId, user.id, Date.now(), expiresAt).run();

  const headers = new Headers({ Location: '/' });
  headers.append('Set-Cookie', setCookieHeader('wodspinner_session', sessionId, 90 * 24 * 60 * 60));
  headers.append('Set-Cookie', clearCookieHeader('wodspinner_oauth_state'));
  return new Response(null, { status: 302, headers });
}

async function handleLogout(request, env) {
  const cookies = parseCookies(request);
  const sid = cookies['wodspinner_session'];
  if (sid) await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sid).run();
  const headers = new Headers({ 'Content-Type': 'application/json' });
  headers.append('Set-Cookie', clearCookieHeader('wodspinner_session'));
  return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
}

async function handleMe(request, env) {
  const user = await getSessionUser(request, env);
  if (!user) return json({ loggedIn: false });
  return json({ loggedIn: true, user });
}

async function handleUpdateNickname(request, env) {
  const user = await getSessionUser(request, env);
  if (!user) return json({ error: 'Not logged in' }, 401);
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'Invalid JSON body' }, 400); }
  const trimmed = String((body || {}).nickname || '').trim().slice(0, 40);
  await env.DB.prepare('UPDATE users SET nickname = ? WHERE id = ?').bind(trimmed || null, user.id).run();
  return json({ ok: true, nickname: trimmed || null });
}

// A "streak" is consecutive WEEKS with at least one logged session, not
// consecutive days — training every single day isn't the expectation here,
// and a day-based streak would reset unfairly on a normal rest day. Weeks
// are Monday-start, UTC, so this doesn't depend on any user's local timezone.
function mondayOfWeekUTC(ts){
  const d = new Date(ts);
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const diffToMonday = (day===0) ? -6 : (1-day);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()+diffToMonday);
}

async function handleMyStreak(request, env) {
  const user = await getSessionUser(request, env);
  if (!user) return json({ error: 'Not logged in' }, 401);

  const { results } = await env.DB.prepare(
    'SELECT created_at FROM workout_history WHERE user_id = ? ORDER BY created_at ASC'
  ).bind(user.id).all();

  const WEEK_MS = 7*24*60*60*1000;
  const weekKeys = Array.from(new Set(results.map(r=>mondayOfWeekUTC(r.created_at)))).sort((a,b)=>a-b);

  let longestStreak = 0, run = 0, prev = null;
  for (const wk of weekKeys) {
    run = (prev !== null && wk-prev===WEEK_MS) ? run+1 : 1;
    if (run>longestStreak) longestStreak = run;
    prev = wk;
  }

  let currentStreak = 0;
  if (weekKeys.length>0) {
    const thisWeekKey = mondayOfWeekUTC(Date.now());
    const lastWeekKey = thisWeekKey - WEEK_MS;
    const mostRecent = weekKeys[weekKeys.length-1];
    // the streak is only still "alive" if the most recent trained week is
    // this week or last week — anything older means it's already broken
    if (mostRecent===thisWeekKey || mostRecent===lastWeekKey) {
      let idx = weekKeys.length-1, count = 1;
      while (idx>0 && weekKeys[idx]-weekKeys[idx-1]===WEEK_MS) { count++; idx--; }
      currentStreak = count;
    }
  }

  const thisWeekKeyNow = mondayOfWeekUTC(Date.now());
  const sessionsThisWeek = results.filter(r=>mondayOfWeekUTC(r.created_at)===thisWeekKeyNow).length;

  return json({ currentStreak, longestStreak, sessionsThisWeek, totalSessions: results.length });
}

// ---- favourites ----

async function handleListFavourites(request, env) {
  const user = await getSessionUser(request, env);
  if (!user) return json({ error: 'Not logged in' }, 401);
  const { results } = await env.DB.prepare(
    'SELECT id, group_size, format, tier_label, workout_json, created_at FROM favourites WHERE user_id = ? ORDER BY created_at DESC'
  ).bind(user.id).all();
  const favourites = results.map(r => ({
    id: r.id,
    groupSize: r.group_size,
    format: r.format,
    tierLabel: r.tier_label,
    workout: JSON.parse(r.workout_json),
    createdAt: r.created_at,
  }));
  return json({ favourites });
}

async function handleAddFavourite(request, env) {
  const user = await getSessionUser(request, env);
  if (!user) return json({ error: 'Not logged in' }, 401);
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'Invalid JSON body' }, 400); }
  const { groupSize, format, tierLabel, workout } = body || {};
  if (!groupSize || !format || !workout) return json({ error: 'Missing groupSize, format, or workout' }, 400);
  const id = generateId(16);
  await env.DB.prepare(
    'INSERT INTO favourites (id, user_id, group_size, format, tier_label, workout_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, user.id, groupSize, format, tierLabel || null, JSON.stringify(workout), Date.now()).run();
  return json({ id }, 201);
}

async function handleDeleteFavourite(request, env, id) {
  const user = await getSessionUser(request, env);
  if (!user) return json({ error: 'Not logged in' }, 401);
  await env.DB.prepare('DELETE FROM favourites WHERE id = ? AND user_id = ?').bind(id, user.id).run();
  return json({ ok: true });
}

// ---- workout history (logged on Start, not just on opening a card) ----

async function handleAddHistory(request, env) {
  const user = await getSessionUser(request, env);
  if (!user) return json({ error: 'Not logged in' }, 401);
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'Invalid JSON body' }, 400); }
  const { groupSize, format, tierLabel, workout } = body || {};
  if (!groupSize || !format || !workout) return json({ error: 'Missing groupSize, format, or workout' }, 400);

  const id = generateId(16);
  const now = Date.now();
  await env.DB.prepare(
    'INSERT INTO workout_history (id, user_id, group_size, format, tier_label, workout_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, user.id, groupSize, format, tierLabel || null, JSON.stringify(workout), now).run();

  // opportunistic prune: delete this user's history older than a year,
  // right here rather than needing a separate scheduled cron job
  const oneYearAgo = now - 365 * 24 * 60 * 60 * 1000;
  await env.DB.prepare(
    'DELETE FROM workout_history WHERE user_id = ? AND created_at < ?'
  ).bind(user.id, oneYearAgo).run();

  return json({ id }, 201);
}

async function handleRecentHistory(request, env) {
  const user = await getSessionUser(request, env);
  if (!user) return json({ recentExerciseIds: [] });
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const { results } = await env.DB.prepare(
    'SELECT workout_json FROM workout_history WHERE user_id = ? AND created_at >= ?'
  ).bind(user.id, sevenDaysAgo).all();

  const ids = new Set();
  for (const row of results) {
    try {
      const w = JSON.parse(row.workout_json);
      (w.exercises || []).forEach(e => { if (e && e.id) ids.add(e.id); });
    } catch (e) { /* skip malformed rows */ }
  }
  return json({ recentExerciseIds: Array.from(ids) });
}

async function handleSetHistoryFeedback(request, env, id) {
  const user = await getSessionUser(request, env);
  if (!user) return json({ error: 'Not logged in' }, 401);
  let body;
  try { body = await request.json(); } catch (e) { return json({ error: 'Invalid JSON body' }, 400); }
  const { feedback } = body || {};
  if (!['easy', 'right', 'hard'].includes(feedback)) return json({ error: 'Invalid feedback value' }, 400);
  await env.DB.prepare(
    'UPDATE workout_history SET feedback = ? WHERE id = ? AND user_id = ?'
  ).bind(feedback, id, user.id).run();
  return json({ ok: true });
}

async function requireAdmin(request, env){
  const user = await getSessionUser(request, env);
  if(!user || !user.is_admin) return null;
  return user;
}

function slugifyServer(name){
  const base = String(name).toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'');
  return base + '_' + Math.random().toString(36).slice(2,6);
}

// ---- admin: post-workout feedback summary ----

async function handleAdminFeedbackSummary(request, env){
  const admin = await requireAdmin(request, env);
  if(!admin) return json({error:'Forbidden'}, 403);

  const { results: overall } = await env.DB.prepare(
    `SELECT feedback, COUNT(*) as count FROM workout_history
     WHERE feedback IS NOT NULL GROUP BY feedback`
  ).all();

  const { results: byFormat } = await env.DB.prepare(
    `SELECT format, feedback, COUNT(*) as count FROM workout_history
     WHERE feedback IS NOT NULL GROUP BY format, feedback ORDER BY format`
  ).all();

  const { results: totalRow } = await env.DB.prepare(
    'SELECT COUNT(*) as total FROM workout_history'
  ).all();
  const { results: ratedRow } = await env.DB.prepare(
    'SELECT COUNT(*) as rated FROM workout_history WHERE feedback IS NOT NULL'
  ).all();

  return json({
    overall,
    byFormat,
    totalSessions: totalRow[0] ? totalRow[0].total : 0,
    ratedSessions: ratedRow[0] ? ratedRow[0].rated : 0,
  });
}

// ---- admin: user tier management (TFO/Premium) ----

async function handleAdminListUsers(request, env){
  const admin = await requireAdmin(request, env);
  if(!admin) return json({error:'Forbidden'}, 403);
  const { results } = await env.DB.prepare(
    'SELECT id, email, display_name, nickname, tier, is_admin, created_at FROM users ORDER BY created_at DESC'
  ).all();
  return json({ users: results });
}

async function handleAdminSetUserTier(request, env, id){
  const admin = await requireAdmin(request, env);
  if(!admin) return json({error:'Forbidden'}, 403);
  let body;
  try{ body = await request.json(); }catch(e){ return json({error:'Invalid JSON body'}, 400); }
  const { tier } = body || {};
  if(!['free','tfo','premium'].includes(tier)) return json({error:'Invalid tier'}, 400);
  await env.DB.prepare(
    'UPDATE users SET tier = ?, tier_granted_by = ?, tier_expires_at = NULL WHERE id = ?'
  ).bind(tier, admin.id, id).run();
  return json({ ok:true });
}

// ---- admin: review queue for user-submitted custom equipment/exercises ----

async function handleAdminListPendingEquipment(request, env){
  const admin = await requireAdmin(request, env);
  if(!admin) return json({error:'Forbidden'}, 403);
  const { results } = await env.DB.prepare(
    `SELECT user_equipment_custom.id, user_equipment_custom.name, user_equipment_custom.rotation_only,
            user_equipment_custom.created_at, users.email, users.display_name
     FROM user_equipment_custom
     JOIN users ON users.id = user_equipment_custom.user_id
     WHERE user_equipment_custom.promoted_master_id IS NULL AND user_equipment_custom.dismissed = 0
     ORDER BY user_equipment_custom.created_at ASC`
  ).all();
  return json({ pending: results });
}

async function handleAdminPromoteEquipment(request, env, id){
  const admin = await requireAdmin(request, env);
  if(!admin) return json({error:'Forbidden'}, 403);
  const row = await env.DB.prepare('SELECT * FROM user_equipment_custom WHERE id = ?').bind(id).first();
  if(!row) return json({error:'Not found'}, 404);
  const masterId = slugifyServer(row.name);
  await env.DB.prepare(
    'INSERT INTO master_equipment (id, name, rotation_only, created_at) VALUES (?, ?, ?, ?)'
  ).bind(masterId, row.name, row.rotation_only, Date.now()).run();
  await env.DB.prepare('UPDATE user_equipment_custom SET promoted_master_id = ? WHERE id = ?').bind(masterId, id).run();
  return json({ ok:true, masterId });
}

async function handleAdminDismissEquipment(request, env, id){
  const admin = await requireAdmin(request, env);
  if(!admin) return json({error:'Forbidden'}, 403);
  await env.DB.prepare('UPDATE user_equipment_custom SET dismissed = 1 WHERE id = ?').bind(id).run();
  return json({ ok:true });
}

async function handleAdminListPendingExercises(request, env){
  const admin = await requireAdmin(request, env);
  if(!admin) return json({error:'Forbidden'}, 403);
  const { results } = await env.DB.prepare(
    `SELECT user_exercises.id, user_exercises.name, user_exercises.pattern, user_exercises.equip_json,
            user_exercises.unit, user_exercises.base, user_exercises.intensity, user_exercises.cue,
            user_exercises.created_at, users.email, users.display_name
     FROM user_exercises
     JOIN users ON users.id = user_exercises.user_id
     WHERE user_exercises.promoted_master_id IS NULL AND user_exercises.dismissed = 0
     ORDER BY user_exercises.created_at ASC`
  ).all();
  const pending = results.map(r => ({ ...r, equip: JSON.parse(r.equip_json) }));
  return json({ pending });
}

async function handleAdminPromoteExercise(request, env, id){
  const admin = await requireAdmin(request, env);
  if(!admin) return json({error:'Forbidden'}, 403);
  const row = await env.DB.prepare('SELECT * FROM user_exercises WHERE id = ?').bind(id).first();
  if(!row) return json({error:'Not found'}, 404);
  const masterId = slugifyServer(row.name);
  await env.DB.prepare(
    'INSERT INTO master_exercises (id, name, pattern, equip_json, unit, base, intensity, cue, is_trigger, unilateral, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)'
  ).bind(masterId, row.name, row.pattern, row.equip_json, row.unit, row.base, row.intensity, row.cue||'', row.unilateral||0, Date.now()).run();
  await env.DB.prepare('UPDATE user_exercises SET promoted_master_id = ? WHERE id = ?').bind(masterId, id).run();
  return json({ ok:true, masterId });
}

async function handleAdminDismissExercise(request, env, id){
  const admin = await requireAdmin(request, env);
  if(!admin) return json({error:'Forbidden'}, 403);
  await env.DB.prepare('UPDATE user_exercises SET dismissed = 1 WHERE id = ?').bind(id).run();
  return json({ ok:true });
}

// ---- admin: master equipment management ----

async function handleAdminListEquipment(request, env){
  const admin = await requireAdmin(request, env);
  if(!admin) return json({error:'Forbidden'}, 403);
  const { results } = await env.DB.prepare(
    'SELECT id, name, rotation_only, created_at FROM master_equipment ORDER BY name'
  ).all();
  return json({ equipment: results });
}

async function handleAdminAddEquipment(request, env){
  const admin = await requireAdmin(request, env);
  if(!admin) return json({error:'Forbidden'}, 403);
  let body;
  try{ body = await request.json(); }catch(e){ return json({error:'Invalid JSON body'}, 400); }
  const { id, name, rotationOnly } = body || {};
  if(!id || !name) return json({error:'Missing id or name'}, 400);
  await env.DB.prepare(
    'INSERT INTO master_equipment (id, name, rotation_only, created_at) VALUES (?, ?, ?, ?)'
  ).bind(id, name, rotationOnly?1:0, Date.now()).run();
  return json({ ok:true }, 201);
}

async function handleAdminUpdateEquipment(request, env, id){
  const admin = await requireAdmin(request, env);
  if(!admin) return json({error:'Forbidden'}, 403);
  let body;
  try{ body = await request.json(); }catch(e){ return json({error:'Invalid JSON body'}, 400); }
  const { name, rotationOnly } = body || {};
  await env.DB.prepare(
    'UPDATE master_equipment SET name=?, rotation_only=? WHERE id=?'
  ).bind(name, rotationOnly?1:0, id).run();
  return json({ ok:true });
}

async function handleAdminDeleteEquipment(request, env, id){
  const admin = await requireAdmin(request, env);
  if(!admin) return json({error:'Forbidden'}, 403);
  try {
    // clean up anything still referencing this equipment id first, otherwise
    // SQLite's foreign key constraints silently block the delete below
    await env.DB.prepare('UPDATE user_equipment_custom SET promoted_master_id = NULL WHERE promoted_master_id = ?').bind(id).run();
    await env.DB.prepare('DELETE FROM user_equipment_off WHERE equipment_id = ?').bind(id).run();
    await env.DB.prepare('DELETE FROM master_equipment WHERE id=?').bind(id).run();
    return json({ ok:true });
  } catch(err) {
    return json({ error:'Delete failed', detail: String(err && err.message || err) }, 500);
  }
}

// ---- admin: master exercise management ----

async function handleAdminListExercises(request, env){
  const admin = await requireAdmin(request, env);
  if(!admin) return json({error:'Forbidden'}, 403);
  const { results } = await env.DB.prepare(
    'SELECT id, name, pattern, equip_json, unit, base, intensity, cue, is_trigger, unilateral, created_at FROM master_exercises ORDER BY name'
  ).all();
  const exercises = results.map(r => ({ ...r, equip: JSON.parse(r.equip_json) }));
  return json({ exercises });
}

async function handleAdminAddExercise(request, env){
  const admin = await requireAdmin(request, env);
  if(!admin) return json({error:'Forbidden'}, 403);
  let body;
  try{ body = await request.json(); }catch(e){ return json({error:'Invalid JSON body'}, 400); }
  const { id, name, pattern, equip, unit, base, intensity, cue, isTrigger, unilateral } = body || {};
  if(!id || !name || !pattern || !equip || !unit) return json({error:'Missing required fields'}, 400);
  await env.DB.prepare(
    'INSERT INTO master_exercises (id, name, pattern, equip_json, unit, base, intensity, cue, is_trigger, unilateral, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, name, pattern, JSON.stringify(equip), unit, base||10, intensity||2, cue||'', isTrigger?1:0, unilateral?1:0, Date.now()).run();
  return json({ ok:true }, 201);
}

async function handleAdminUpdateExercise(request, env, id){
  const admin = await requireAdmin(request, env);
  if(!admin) return json({error:'Forbidden'}, 403);
  let body;
  try{ body = await request.json(); }catch(e){ return json({error:'Invalid JSON body'}, 400); }
  const { name, pattern, equip, unit, base, intensity, cue, isTrigger, unilateral } = body || {};
  await env.DB.prepare(
    'UPDATE master_exercises SET name=?, pattern=?, equip_json=?, unit=?, base=?, intensity=?, cue=?, is_trigger=?, unilateral=? WHERE id=?'
  ).bind(name, pattern, JSON.stringify(equip||[]), unit, base||10, intensity||2, cue||'', isTrigger?1:0, unilateral?1:0, id).run();
  return json({ ok:true });
}

async function handleAdminDeleteExercise(request, env, id){
  const admin = await requireAdmin(request, env);
  if(!admin) return json({error:'Forbidden'}, 403);
  try {
    await env.DB.prepare('UPDATE user_exercises SET promoted_master_id = NULL WHERE promoted_master_id = ?').bind(id).run();
    await env.DB.prepare('DELETE FROM user_hidden_exercises WHERE exercise_id = ?').bind(id).run();
    await env.DB.prepare('DELETE FROM master_exercises WHERE id=?').bind(id).run();
    return json({ ok:true });
  } catch(err) {
    return json({ error:'Delete failed', detail: String(err && err.message || err) }, 500);
  }
}

// ---- effective gym data: master lists minus personal hides/off, plus
// personal additions — logged-out users get master-only, read-only ----

async function handleGymData(request, env){
  const user = await getSessionUser(request, env);
  const url = new URL(request.url);
  const listId = url.searchParams.get('list');

  const { results: masterEquip } = await env.DB.prepare(
    'SELECT id, name, rotation_only FROM master_equipment ORDER BY name'
  ).all();
  const { results: masterEx } = await env.DB.prepare(
    'SELECT id, name, pattern, equip_json, unit, base, intensity, cue, is_trigger, unilateral FROM master_exercises ORDER BY name'
  ).all();

  if(!user){
    return json({
      loggedIn: false,
      equipment: masterEquip.map(e=>({ id:e.id, name:e.name, rotationOnly:!!e.rotation_only, personal:false, off:false })),
      exercises: masterEx.map(e=>({
        id:e.id, name:e.name, pattern:e.pattern, equip:JSON.parse(e.equip_json),
        unit:e.unit, base:e.base, intensity:e.intensity, cue:e.cue, trigger:!!e.is_trigger, unilateral:!!e.unilateral, personal:false, hidden:false,
      })),
      favouriteExerciseIds: [],
    });
  }

  // Equipment on/off + custom equipment come from a specific named list when
  // one's given and actually belongs to this user (Premium/TFO) — otherwise
  // fall back to the classic per-user tables untouched by any of this, which
  // is what free/logged-out-equivalent accounts always use.
  let offIds, customEquipResults;
  if(listId){
    const list = await env.DB.prepare('SELECT id FROM user_equipment_lists WHERE id = ? AND user_id = ?').bind(listId, user.id).first();
    if(list){
      const [offRows, customRows] = await Promise.all([
        env.DB.prepare('SELECT equipment_id FROM list_equipment_off WHERE list_id = ?').bind(listId).all(),
        env.DB.prepare('SELECT id, name, rotation_only FROM list_equipment_custom WHERE list_id = ? AND promoted_master_id IS NULL').bind(listId).all(),
      ]);
      offIds = new Set(offRows.results.map(r=>r.equipment_id));
      customEquipResults = customRows.results;
    }
  }
  if(offIds === undefined){
    const [offRows, customRows] = await Promise.all([
      env.DB.prepare('SELECT equipment_id FROM user_equipment_off WHERE user_id = ?').bind(user.id).all(),
      env.DB.prepare('SELECT id, name, rotation_only FROM user_equipment_custom WHERE user_id = ? AND promoted_master_id IS NULL').bind(user.id).all(),
    ]);
    offIds = new Set(offRows.results.map(r=>r.equipment_id));
    customEquipResults = customRows.results;
  }

  const [hiddenRows, customExRows, favRows] = await Promise.all([
    env.DB.prepare('SELECT exercise_id FROM user_hidden_exercises WHERE user_id = ?').bind(user.id).all(),
    env.DB.prepare('SELECT id, name, pattern, equip_json, unit, base, intensity, cue, unilateral FROM user_exercises WHERE user_id = ? AND promoted_master_id IS NULL').bind(user.id).all(),
    env.DB.prepare('SELECT exercise_id FROM user_favourite_exercises WHERE user_id = ?').bind(user.id).all(),
  ]);
  const hiddenIds = new Set(hiddenRows.results.map(r=>r.exercise_id));

  // Always return every master item, tagged with whether it's off/hidden for
  // this user — filtering it out of the response entirely (rather than just
  // flagging it) would mean Settings could never show it again to undo.
  const equipment = [
    ...masterEquip.map(e=>({ id:e.id, name:e.name, rotationOnly:!!e.rotation_only, personal:false, off:offIds.has(e.id) })),
    ...customEquipResults.map(e=>({ id:e.id, name:e.name, rotationOnly:!!e.rotation_only, personal:true, off:false })),
  ];
  const exercises = [
    ...masterEx.map(e=>({
      id:e.id, name:e.name, pattern:e.pattern, equip:JSON.parse(e.equip_json),
      unit:e.unit, base:e.base, intensity:e.intensity, cue:e.cue, trigger:!!e.is_trigger, unilateral:!!e.unilateral, personal:false, hidden:hiddenIds.has(e.id),
    })),
    ...customExRows.results.map(e=>({
      id:e.id, name:e.name, pattern:e.pattern, equip:JSON.parse(e.equip_json),
      unit:e.unit, base:e.base, intensity:e.intensity, cue:e.cue, trigger:false, unilateral:!!e.unilateral, personal:true, hidden:false,
    })),
  ];

  return json({
    loggedIn: true,
    equipment,
    exercises,
    favouriteExerciseIds: favRows.results.map(r=>r.exercise_id),
  });
}

// ---- equipment lists (Premium/TFO — multiple named equipment setups) ----

async function handleListEquipmentLists(request, env){
  const user = await getSessionUser(request, env);
  if(!user) return json({error:'Not logged in'}, 401);
  const { results } = await env.DB.prepare(
    'SELECT id, name, created_at FROM user_equipment_lists WHERE user_id = ? ORDER BY created_at ASC'
  ).bind(user.id).all();
  return json({ lists: results });
}

async function handleCreateEquipmentList(request, env){
  const user = await getSessionUser(request, env);
  if(!user) return json({error:'Not logged in'}, 401);
  let body;
  try{ body = await request.json(); }catch(e){ return json({error:'Invalid JSON body'}, 400); }
  const name = String((body||{}).name||'').trim().slice(0,60);
  if(!name) return json({error:'Missing name'}, 400);

  if(user.tier !== 'premium' && user.tier !== 'tfo'){
    const { results } = await env.DB.prepare('SELECT id FROM user_equipment_lists WHERE user_id = ?').bind(user.id).all();
    if(results.length >= 1) return json({error:'Free accounts can only have one equipment list'}, 403);
  }

  const id = generateId(12);
  await env.DB.prepare(
    'INSERT INTO user_equipment_lists (id, user_id, name, created_at) VALUES (?, ?, ?, ?)'
  ).bind(id, user.id, name, Date.now()).run();
  return json({ id, name }, 201);
}

async function handleRenameEquipmentList(request, env, id){
  const user = await getSessionUser(request, env);
  if(!user) return json({error:'Not logged in'}, 401);
  let body;
  try{ body = await request.json(); }catch(e){ return json({error:'Invalid JSON body'}, 400); }
  const name = String((body||{}).name||'').trim().slice(0,60);
  if(!name) return json({error:'Missing name'}, 400);
  const list = await env.DB.prepare('SELECT id FROM user_equipment_lists WHERE id = ? AND user_id = ?').bind(id, user.id).first();
  if(!list) return json({error:'Not found'}, 404);
  await env.DB.prepare('UPDATE user_equipment_lists SET name = ? WHERE id = ?').bind(name, id).run();
  return json({ ok:true, name });
}

async function handleDeleteEquipmentList(request, env, id){
  const user = await getSessionUser(request, env);
  if(!user) return json({error:'Not logged in'}, 401);
  // free accounts must always have exactly one list — the generator relies
  // on that (it's what falls back to when nothing's explicitly chosen)
  if(user.tier !== 'premium' && user.tier !== 'tfo') return json({error:'Free accounts can\u2019t delete their equipment list \u2014 rename or edit it instead'}, 403);
  const list = await env.DB.prepare('SELECT id FROM user_equipment_lists WHERE id = ? AND user_id = ?').bind(id, user.id).first();
  if(!list) return json({error:'Not found'}, 404);
  await env.DB.prepare('DELETE FROM list_equipment_off WHERE list_id = ?').bind(id).run();
  await env.DB.prepare('DELETE FROM list_equipment_custom WHERE list_id = ?').bind(id).run();
  await env.DB.prepare('DELETE FROM user_equipment_lists WHERE id = ?').bind(id).run();
  return json({ ok:true });
}

// ---- personal equipment ----

async function handleToggleEquipmentOff(request, env){
  const user = await getSessionUser(request, env);
  if(!user) return json({error:'Not logged in'}, 401);
  let body;
  try{ body = await request.json(); }catch(e){ return json({error:'Invalid JSON body'}, 400); }
  const { equipmentId, off, listId } = body || {};
  if(!equipmentId) return json({error:'Missing equipmentId'}, 400);

  if(listId){
    const list = await env.DB.prepare('SELECT id FROM user_equipment_lists WHERE id = ? AND user_id = ?').bind(listId, user.id).first();
    if(!list) return json({error:'List not found'}, 404);
    if(off){
      await env.DB.prepare('INSERT OR IGNORE INTO list_equipment_off (list_id, equipment_id) VALUES (?, ?)').bind(listId, equipmentId).run();
    } else {
      await env.DB.prepare('DELETE FROM list_equipment_off WHERE list_id = ? AND equipment_id = ?').bind(listId, equipmentId).run();
    }
    return json({ ok:true });
  }

  if(off){
    await env.DB.prepare('INSERT OR IGNORE INTO user_equipment_off (user_id, equipment_id) VALUES (?, ?)').bind(user.id, equipmentId).run();
  } else {
    await env.DB.prepare('DELETE FROM user_equipment_off WHERE user_id = ? AND equipment_id = ?').bind(user.id, equipmentId).run();
  }
  return json({ ok:true });
}

async function handleAddMyEquipment(request, env){
  const user = await getSessionUser(request, env);
  if(!user) return json({error:'Not logged in'}, 401);
  let body;
  try{ body = await request.json(); }catch(e){ return json({error:'Invalid JSON body'}, 400); }
  const { name, rotationOnly, listId } = body || {};
  if(!name) return json({error:'Missing name'}, 400);

  if(listId){
    const list = await env.DB.prepare('SELECT id FROM user_equipment_lists WHERE id = ? AND user_id = ?').bind(listId, user.id).first();
    if(!list) return json({error:'List not found'}, 404);
    const id = generateId(12);
    await env.DB.prepare(
      'INSERT INTO list_equipment_custom (id, list_id, user_id, name, rotation_only, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(id, listId, user.id, name, rotationOnly?1:0, Date.now()).run();
    return json({ id }, 201);
  }

  const id = generateId(12);
  await env.DB.prepare(
    'INSERT INTO user_equipment_custom (id, user_id, name, rotation_only, created_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(id, user.id, name, rotationOnly?1:0, Date.now()).run();
  return json({ id }, 201);
}

async function handleDeleteMyEquipment(request, env, id){
  const user = await getSessionUser(request, env);
  if(!user) return json({error:'Not logged in'}, 401);
  // the id could belong to either the classic per-user table or a list —
  // try both, scoped to this user's own rows either way; only the real match deletes anything
  await env.DB.prepare('DELETE FROM user_equipment_custom WHERE id = ? AND user_id = ?').bind(id, user.id).run();
  await env.DB.prepare(
    'DELETE FROM list_equipment_custom WHERE id = ? AND list_id IN (SELECT id FROM user_equipment_lists WHERE user_id = ?)'
  ).bind(id, user.id).run();
  return json({ ok:true });
}

// ---- personal exercises ----

async function handleToggleHiddenExercise(request, env){
  const user = await getSessionUser(request, env);
  if(!user) return json({error:'Not logged in'}, 401);
  let body;
  try{ body = await request.json(); }catch(e){ return json({error:'Invalid JSON body'}, 400); }
  const { exerciseId, hidden } = body || {};
  if(!exerciseId) return json({error:'Missing exerciseId'}, 400);
  if(hidden){
    await env.DB.prepare('INSERT OR IGNORE INTO user_hidden_exercises (user_id, exercise_id) VALUES (?, ?)').bind(user.id, exerciseId).run();
  } else {
    await env.DB.prepare('DELETE FROM user_hidden_exercises WHERE user_id = ? AND exercise_id = ?').bind(user.id, exerciseId).run();
  }
  return json({ ok:true });
}

async function handleAddMyExercise(request, env){
  const user = await getSessionUser(request, env);
  if(!user) return json({error:'Not logged in'}, 401);
  let body;
  try{ body = await request.json(); }catch(e){ return json({error:'Invalid JSON body'}, 400); }
  const { name, pattern, equip, unit, base, intensity, cue, unilateral } = body || {};
  if(!name || !pattern || !equip || !unit) return json({error:'Missing required fields'}, 400);
  const id = generateId(12);
  await env.DB.prepare(
    'INSERT INTO user_exercises (id, user_id, name, pattern, equip_json, unit, base, intensity, cue, unilateral, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, user.id, name, pattern, JSON.stringify(equip), unit, base||10, intensity||2, cue||'', unilateral?1:0, Date.now()).run();
  return json({ id }, 201);
}

async function handleDeleteMyExercise(request, env, id){
  const user = await getSessionUser(request, env);
  if(!user) return json({error:'Not logged in'}, 401);
  await env.DB.prepare('DELETE FROM user_exercises WHERE id = ? AND user_id = ?').bind(id, user.id).run();
  return json({ ok:true });
}

async function handleToggleFavouriteExercise(request, env){
  const user = await getSessionUser(request, env);
  if(!user) return json({error:'Not logged in'}, 401);
  let body;
  try{ body = await request.json(); }catch(e){ return json({error:'Invalid JSON body'}, 400); }
  const { exerciseId, favourite } = body || {};
  if(!exerciseId) return json({error:'Missing exerciseId'}, 400);
  if(favourite){
    await env.DB.prepare('INSERT OR IGNORE INTO user_favourite_exercises (user_id, exercise_id) VALUES (?, ?)').bind(user.id, exerciseId).run();
  } else {
    await env.DB.prepare('DELETE FROM user_favourite_exercises WHERE user_id = ? AND exercise_id = ?').bind(user.id, exerciseId).run();
  }
  return json({ ok:true });
}

// ---- popularity (aggregated across everyone, not just the current user) ----

async function handlePopular(request, env) {
  // Based on actual workout_history (every session someone started), not
  // just favourites — a far richer signal of real gym usage than the small
  // subset of workouts someone happened to star.
  const { results: formats } = await env.DB.prepare(
    'SELECT format, COUNT(*) as count FROM workout_history GROUP BY format ORDER BY count DESC LIMIT 10'
  ).all();

  // exercise-level popularity: aggregate in JS rather than relying on SQLite's
  // JSON1 functions, since gym-scale data (dozens to low hundreds of rows) is
  // trivial to process this way and it avoids depending on exact D1 JSON support
  const { results: allHistory } = await env.DB.prepare('SELECT workout_json FROM workout_history').all();
  const exerciseCounts = {};
  for (const row of allHistory) {
    try {
      const w = JSON.parse(row.workout_json);
      (w.exercises || []).forEach(e => {
        if (!e || !e.name) return;
        exerciseCounts[e.name] = (exerciseCounts[e.name] || 0) + 1;
      });
    } catch (e) { /* skip malformed rows */ }
  }
  const popularExercises = Object.entries(exerciseCounts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
  const totalSessions = allHistory.length;

  return json({ popularFormats: formats, popularExercises, totalSessions });
}