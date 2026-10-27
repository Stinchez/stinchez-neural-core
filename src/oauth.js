import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

// "Log in with Deriv": OAuth 2.0 authorization code flow with PKCE.
//
// Stateless, so it works on serverless hosts (Vercel) as well as the local
// server: the login-in-progress and the access token live in AES-256-GCM
// encrypted, HttpOnly cookies, never in server memory or page JavaScript.
// The page reaches Deriv's account REST endpoints through the proxy below.

const AUTH_URL = 'https://auth.deriv.com/oauth2/auth';
const TOKEN_URL = 'https://auth.deriv.com/oauth2/token';
const API_BASE = 'https://api.derivws.com/trading/v1/options';
const SESSION = 'stz_sid';
const PENDING = 'stz_oauth';

let localKey = null;

// Cookie encryption key. Serverless instances must share it, so on Vercel it comes
// from SESSION_SECRET; locally a random per-process key is fine (restart = log in again).
function key() {
  const secret = process.env.SESSION_SECRET;
  if (secret) return createHash('sha256').update(secret).digest();
  if (process.env.VERCEL) throw new Error('SESSION_SECRET is not set. Add it in Vercel → Project → Settings → Environment Variables (any long random text), then redeploy.');
  return (localKey ??= randomBytes(32));
}

function seal(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

function unseal(text) {
  try {
    const raw = Buffer.from(text, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8'));
  } catch {
    return null; // tampered, expired key or not ours
  }
}

const b64url = (buf) => buf.toString('base64url');

function cookieOf(req, name) {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.cookie ?? '');
  return m?.[1] ?? null;
}

const isHttps = (req) => (req.headers['x-forwarded-proto'] ?? '').split(',')[0].trim() === 'https' || Boolean(req.socket?.encrypted);

function cookie(req, name, value, maxAge) {
  return `${name}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;
}

function sessionOf(req) {
  const raw = cookieOf(req, SESSION);
  const s = raw ? unseal(raw) : null;
  return s && s.expiresAt > Date.now() ? s : null;
}

// The callback URL Deriv redirects back to: this site's own origin, unless overridden.
function redirectUriOf(req) {
  if (process.env.DERIV_REDIRECT_URI) return process.env.DERIV_REDIRECT_URI;
  const host = req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost:3200';
  return `${isHttps(req) ? 'https' : 'http'}://${host}/oauth/callback`;
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }).end(JSON.stringify(body));
}

function redirect(res, location, headers = {}) {
  res.writeHead(302, { location, 'cache-control': 'no-store', ...headers }).end();
}

// POSTs must come from this app's own page (the cookies are SameSite=Lax as well).
export function sameOrigin(req) {
  const origin = req.headers.origin;
  const host = req.headers['x-forwarded-host'] ?? req.headers.host;
  return !origin || origin === `http://${host}` || origin === `https://${host}`;
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body; // already parsed by the host (Vercel)
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 10_000) throw new Error('Body too large');
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function derivApi(token, path, method = 'GET') {
  const res = await fetch(`${API_BASE}${path}`, { method, headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { message: text }; }
  if (!res.ok) throw Object.assign(new Error(body?.errors?.[0]?.message ?? body?.message ?? `Deriv answered HTTP ${res.status}`), { status: res.status });
  return body;
}

/** Handles /oauth/* and /api/deriv/*; returns false for any other path. */
export async function handleOAuth(req, res, path) {
  const url = new URL(req.url ?? '/', 'http://local');
  const fail = (msg) => redirect(res, `/?link_error=${encodeURIComponent(msg)}`);

  try {
    if (path === '/oauth/start') {
      const clientId = process.env.DERIV_CLIENT_ID || url.searchParams.get('client_id') || '';
      if (!/^[\w-]{1,64}$/.test(clientId)) {
        fail('Enter your Deriv OAuth client ID (App ID) first — register the app at developers.deriv.com.');
        return true;
      }
      const redirectUri = redirectUriOf(req);
      const state = b64url(randomBytes(24));
      const verifier = b64url(randomBytes(32));
      const challenge = b64url(createHash('sha256').update(verifier).digest());
      const pending = seal({ state, verifier, clientId, redirectUri, at: Date.now() });
      const auth = new URL(AUTH_URL);
      auth.search = new URLSearchParams({
        response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope: 'trade',
        state, code_challenge: challenge, code_challenge_method: 'S256',
      }).toString();
      redirect(res, auth.toString(), { 'set-cookie': cookie(req, PENDING, pending, 600) });
      return true;
    }

    if (path === '/oauth/callback') {
      const raw = cookieOf(req, PENDING);
      const p = raw ? unseal(raw) : null;
      const clearPending = cookie(req, PENDING, '', 0);
      const failClear = (msg) => redirect(res, `/?link_error=${encodeURIComponent(msg)}`, { 'set-cookie': clearPending });
      if (url.searchParams.get('error')) return failClear(`Deriv login was cancelled: ${url.searchParams.get('error_description') ?? url.searchParams.get('error')}`), true;
      if (!p || p.state !== url.searchParams.get('state') || Date.now() - p.at > 600_000) return failClear('Login expired or was started elsewhere. Please click "Log in with Deriv" again.'), true;
      const code = url.searchParams.get('code');
      if (!code) return failClear('Deriv did not return a login code.'), true;
      const tokenRes = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', client_id: p.clientId, code, code_verifier: p.verifier, redirect_uri: p.redirectUri }),
        signal: AbortSignal.timeout(20_000),
      });
      const body = await tokenRes.json().catch(() => ({}));
      if (!tokenRes.ok || !body.access_token) return failClear(`Deriv refused the login: ${body.error_description ?? body.error ?? tokenRes.status}`), true;
      const ttl = Math.max(60, Number(body.expires_in) || 3600);
      const session = seal({ token: body.access_token, expiresAt: Date.now() + ttl * 1000 });
      redirect(res, '/?linked=1', { 'set-cookie': [clearPending, cookie(req, SESSION, session, ttl)] });
      return true;
    }

    if (!path.startsWith('/api/deriv/')) return false;
    if (req.method === 'POST' && !sameOrigin(req)) return json(res, 403, { error: 'Cross-site request refused' }), true;
    const s = sessionOf(req);

    if (path === '/api/deriv/session') {
      json(res, 200, { linked: Boolean(s), expiresAt: s?.expiresAt ?? null, clientIdConfigured: Boolean(process.env.DERIV_CLIENT_ID) });
      return true;
    }
    if (path === '/api/deriv/logout' && req.method === 'POST') {
      json(res, 200, { ok: true }, { 'set-cookie': cookie(req, SESSION, '', 0) });
      return true;
    }
    if (!s) return json(res, 401, { error: 'Not logged in to Deriv (or the login expired). Click "Log in with Deriv".' }), true;

    if (path === '/api/deriv/accounts' && req.method === 'GET') {
      json(res, 200, { accounts: (await derivApi(s.token, '/accounts')).data ?? [] });
      return true;
    }
    if (path === '/api/deriv/otp' && req.method === 'POST') {
      const { account_id } = await readBody(req);
      if (typeof account_id !== 'string' || !/^[\w-]{1,40}$/.test(account_id)) return json(res, 400, { error: 'Bad account id' }), true;
      json(res, 200, { url: (await derivApi(s.token, `/accounts/${encodeURIComponent(account_id)}/otp`, 'POST')).data.url });
      return true;
    }
    json(res, 404, { error: 'Unknown endpoint' });
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (path.startsWith('/oauth/')) fail(msg);
    else json(res, err?.status === 401 ? 401 : 502, { error: msg });
    return true;
  }
}
