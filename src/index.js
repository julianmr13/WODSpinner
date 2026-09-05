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
    ).bind(id, profile.email, profile.name
