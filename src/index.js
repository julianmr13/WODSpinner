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
      if (path === '/api/favourites' && request.method === 'GET') return handleListFavourites(request, env);
      if (path === '/api/favourites' && request.method === 'POST') return handleAddFavourite(request, env);
      if (path.startsWith('/api/favourites/') && request.method === 'DELETE') {
        return handleDeleteFavourite(request, env, path.slice('/api/favourites/'.length));
      }
      if (path === '/api/popular') return handlePopular(request, env);
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
    if (profile.picture && profile.picture !== user.avatar_url) {
      await env.DB.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').bind(profile.picture, user.id).run();
      user.avatar_url = profile.picture;
    }
  }

  const sessionId = generateId(32);
  const expiresAt = Date.now() + 90 * 24 * 60 * 60 * 1000;
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

// ---- popularity (aggregated across everyone, not just the current user) ----

async function handlePopular(request, env) {
  const { results: formats } = await env.DB.prepare(
    'SELECT format, COUNT(*) as count FROM favourites GROUP BY format ORDER BY count DESC LIMIT 10'
  ).all();

  const { results: allFavs } = await env.DB.prepare('SELECT workout_json FROM favourites').all();
  const exerciseCounts = {};
  for (const row of allFavs) {
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

  return json({ popularFormats: formats, popularExercises });
}
