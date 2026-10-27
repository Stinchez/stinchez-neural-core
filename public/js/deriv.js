// Minimal client for Deriv's Options API (api.derivws.com): request/response by
// req_id, streaming subscriptions, keep-alive pings and automatic reconnects.
// Market data uses the public socket; trading uses a per-account socket whose
// URL carries a single-use OTP, so it asks for a fresh URL on every reconnect.

export const API_BASE = 'https://api.derivws.com/trading/v1/options';
export const PUBLIC_WS = 'wss://api.derivws.com/trading/v1/options/ws/public';

export class DerivClient extends EventTarget {
  // getUrl: () => string | Promise<string>
  constructor(getUrl = () => PUBLIC_WS) {
    super();
    this.getUrl = getUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.streams = new Map();
    this.status = 'idle';
    this.retry = 0;
  }

  setStatus(status) {
    this.status = status;
    this.dispatchEvent(new CustomEvent('status', { detail: status }));
  }

  connect() {
    if (this.status === 'connecting' || (this.ws && this.ws.readyState <= 1)) return this.ready;
    this.closing = false;
    this.setStatus('connecting');
    this.ready = (async () => {
      const ws = new WebSocket(await this.getUrl());
      this.ws = ws;
      ws.onmessage = (ev) => this.onMessage(JSON.parse(ev.data));
      ws.onclose = () => this.onClose();
      await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = () => reject(new Error('Could not reach Deriv'));
      });
      this.retry = 0;
      this.setStatus('online');
      clearInterval(this.pinger);
      this.pinger = setInterval(() => this.send({ ping: 1 }).catch(() => {}), 25_000);
      this.dispatchEvent(new Event('open'));
    })();
    this.ready.catch(() => { if (!this.ws) this.onClose(); });
    return this.ready;
  }

  onClose() {
    clearInterval(this.pinger);
    for (const { reject } of this.pending.values()) reject(new Error('Connection closed'));
    this.pending.clear();
    this.streams.clear();
    this.ws = null;
    this.setStatus('offline');
    if (this.closing) return;
    const wait = Math.min(15_000, 1000 * 2 ** this.retry++);
    setTimeout(() => this.connect().catch(() => {}), wait);
  }

  close() {
    this.closing = true;
    this.ws?.close();
  }

  onMessage(msg) {
    const id = msg.req_id;
    const stream = this.streams.get(id);
    if (stream) {
      if (msg.error) stream.onError?.(msg.error);
      else stream.onMessage(msg);
    }
    const p = this.pending.get(id);
    if (p) {
      this.pending.delete(id);
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
      else p.resolve(msg);
    }
  }

  async send(req) {
    await this.ready;
    const req_id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(req_id, { resolve, reject });
      this.ws.send(JSON.stringify({ ...req, req_id }));
    });
  }

  // Sends a subscribing request; every message for it (including the first) goes to onMessage.
  async subscribe(req, onMessage, onError) {
    await this.ready;
    const req_id = this.nextId++;
    const handle = { req_id, subscriptionId: null };
    this.streams.set(req_id, {
      onMessage: (msg) => {
        handle.subscriptionId ??= msg.subscription?.id ?? null;
        onMessage(msg);
      },
      onError,
    });
    const first = new Promise((resolve, reject) => this.pending.set(req_id, { resolve, reject }));
    this.ws.send(JSON.stringify({ ...req, subscribe: 1, req_id }));
    await first.catch((err) => {
      this.streams.delete(req_id);
      throw err;
    });
    handle.forget = () => {
      this.streams.delete(req_id);
      if (handle.subscriptionId && this.ws?.readyState === 1) this.send({ forget: handle.subscriptionId }).catch(() => {});
    };
    return handle;
  }
}

// REST call with a Personal Access Token (PAT needs the Deriv-App-ID header).
async function rest(path, token, appId, method = 'GET') {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(appId ? { 'Deriv-App-ID': appId } : {}) },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { message: text }; }
  if (!res.ok) throw new Error(body?.errors?.[0]?.message ?? body?.message ?? `HTTP ${res.status}`);
  return body;
}

// [{ account_id, balance, currency, account_type: 'demo' | 'real', status, group }]
export async function listAccounts(token, appId) {
  return (await rest('/accounts', token, appId)).data ?? [];
}

// ---- "Log in with Deriv" (OAuth): the server holds the token, the page uses its proxy ----

async function proxy(path, init) {
  const res = await fetch(path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  return body;
}

export const oauthSession = () => proxy('/api/deriv/session');
export const oauthLogout = () => proxy('/api/deriv/logout', { method: 'POST' });
export const listAccountsOAuth = async () => (await proxy('/api/deriv/accounts')).accounts;

export function tradingClientOAuth(accountId) {
  return new DerivClient(async () => (await proxy('/api/deriv/otp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account_id: accountId }),
  })).url);
}

// A trading socket for one account; each (re)connect fetches a fresh OTP URL.
export function tradingClient(token, appId, accountId) {
  return new DerivClient(async () => (await rest(`/accounts/${encodeURIComponent(accountId)}/otp`, token, appId, 'POST')).data.url);
}
