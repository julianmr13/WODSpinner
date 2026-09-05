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
    `SELECT users.id, users.email, users.display_name FROM sessions
     JOIN users ON users.id = sessions.user_id
     WHERE sessions.id = ? AND sessions.expires_at > ?`
  ).b
