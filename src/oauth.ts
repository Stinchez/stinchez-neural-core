import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

// "Log in with Deriv": OAuth 2.0 authorization code flow with PKCE.
// The access token never reaches the browser — it stays in this server's memory,
// keyed by an HttpOnly session cookie, and the page talks to Deriv's account
// REST endpoints through the small proxy below.

const AUTH_URL = 'https://auth.deriv.com/oauth2/auth';
const TOKEN_URL = 'https://auth.deriv.com/oauth2/token';
const API_BASE = 'https://api.derivws.com/trading/v1/options';
const COOKIE = 'stz_sid';

const b64url = (buf: Buffer) => buf.toString('base64url');
const pending = new Map<string, { verifier: string; clientId: string; redirectUri: string; at: number }>();
const sessions = new Map<string, { token: string; expiresAt: number }>();

function cookieOf(req: IncomingMessage) {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`).exec(req.headers.cookie ?? '');
  return m?.[1] ?? null;
}

function sessionOf(req: IncomingMessage) {
  const sid = cookieOf(req);
  const s = sid ? sessions.get(sid) : undefined;
  if (s && s.expiresAt < Date.now()) { sessions.delete(sid!); return null; }
  return s ?? null;
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }).end(JSON.stringify(body));
}

function redirect(res: ServerResponse, location: string, headers: Record<string, string> = {}) {
  res.writeHead(302, { location, 'cache-control': 'no-store', ...headers }).end();
}

// POSTs must come from this app's own page (the cookie is SameSite=Lax as well).
export function sameOrigin(req: IncomingMessage) {
  const origin = req.headers.origin;
  return !origin || origin === `http://${req.headers.host}` || origin === `https://${req.headers.host}`;
}

async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 10_000) throw new Error('Body too large');
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
}

async function derivApi(token: string, path: string, method = 'GET') {
  const res = await fetch(`${API_BASE}${path}`, { method, headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  let body: any;
  try { body = JSON.parse(text); } catch { body = { message: text }; }
  if (!res.ok) throw Object.assign(new Error(body?.errors?.[0]?.message ?? body?.message ?? `Deriv answered HTTP ${res.status}`), { status: res.status });
  return body;
}

/** Handles /oauth/* and /api/deriv/*; returns false for any other path. */
export async function handleOAuth(req: IncomingMessage, res: ServerResponse, path: string, port: number): Promise<boolean> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (path === '/oauth/start') {
    const clientId = process.env.DERIV_CLIENT_ID || url.searchParams.get('client_id') || '';
    if (!/^[\w-]{1,64}$/.test(clientId)) {
      redirect(res, `/?link_error=${encodeURIComponent('Enter your Deriv OAuth client ID (App ID) first — register the app at developers.deriv.com.')}`);
      return true;
    }
    const redirectUri = process.env.DERIV_REDIRECT_URI || `http://localhost:${port}/oauth/callback`;
    const state = b64url(randomBytes(24));
    const verifier = b64url(randomBytes(32));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    // Forget abandoned logins after 10 minutes.
    for (const [k, v] of pending) if (Date.now() - v.at > 600_000) pending.delete(k);
    pending.set(state, { verifier, clientId, redirectUri, at: Date.now() });
    const auth = new URL(AUTH_URL);
    auth.search = new URLSearchParams({
      response_type: 'code', client_id: clientId, redirect_uri: redirectUri, scope: 'trade',
      state, code_challenge: challenge, code_challenge_method: 'S256',
    }).toString();
    redirect(res, auth.toString());
    return true;
  }

  if (path === '/oauth/callback') {
    const fail = (msg: string) => redirect(res, `/?link_error=${encodeURIComponent(msg)}`);
    const state = url.searchParams.get('state') ?? '';
    const p = pending.get(state);
    pending.delete(state);
    if (url.searchParams.get('error')) return fail(`Deriv login was cancelled: ${url.searchParams.get('error_description') ?? url.searchParams.get('error')}`), true;
    if (!p) return fail('Login expired or was started elsewhere. Please click "Log in with Deriv" again.'), true;
    const code = url.searchParams.get('code');
    if (!code) return fail('Deriv did not return a login code.'), true;
    try {
      const tokenRes = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'authorization_code', client_id: p.clientId, code, code_verifier: p.verifier, redirect_uri: p.redirectUri }),
        signal: AbortSignal.timeout(20_000),
      });
      const body = (await tokenRes.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string; error?: string };
      if (!tokenRes.ok || !body.access_token) return fail(`Deriv refused the login: ${body.error_description ?? body.error ?? tokenRes.status}`), true;
      const sid = b64url(randomBytes(32));
      const ttl = Math.max(60, Number(body.expires_in) || 3600);
      sessions.set(sid, { token: body.access_token, expiresAt: Date.now() + ttl * 1000 });
      redirect(res, '/?linked=1', { 'set-cookie': `${COOKIE}=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${ttl}` });
    } catch (err) {
      fail(`Could not reach Deriv to finish login: ${err instanceof Error ? err.message : err}`);
    }
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
    const sid = cookieOf(req);
    if (sid) sessions.delete(sid);
    json(res, 200, { ok: true }, { 'set-cookie': `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0` });
    return true;
  }
  if (!s) return json(res, 401, { error: 'Not logged in to Deriv (or the login expired). Click "Log in with Deriv".' }), true;

  try {
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
  } catch (err) {
    const status = (err as { status?: number }).status === 401 ? 401 : 502;
    json(res, status, { error: err instanceof Error ? err.message : String(err) });
    return true;
  }
  json(res, 404, { error: 'Unknown endpoint' });
  return true;
}
