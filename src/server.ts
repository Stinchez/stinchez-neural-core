import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { friendlyError, learn } from './learn.ts';
import { handleOAuth, sameOrigin } from './oauth.ts';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

// The browser streams market data from Deriv's Options API directly; the server
// serves public/, runs /api/learn (reads a strategy source with Claude) and the
// "Log in with Deriv" OAuth flow plus its account proxy (src/oauth.ts).
const root = resolve(import.meta.dirname, '..', 'public');
const port = Number(process.env.PORT ?? 3200);
const host = process.env.HOST ?? '127.0.0.1';

const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

async function readJson(req: IncomingMessage, limit = 1_000_000): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error('Request too large (pasted text is limited to about 1 MB).');
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  if (await handleOAuth(req, res, path, port)) return;
  if (path === '/api/learn') {
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST' });
    // Other websites must not be able to spend this server's Claude credits.
    if (!sameOrigin(req)) return sendJson(res, 403, { error: 'Cross-site request refused' });
    try {
      const body = await readJson(req);
      const result = await learn({ url: typeof body.url === 'string' ? body.url : undefined, text: typeof body.text === 'string' ? body.text : undefined });
      sendJson(res, 200, result);
    } catch (err) {
      console.warn('[learn]', err instanceof Error ? err.message : err);
      sendJson(res, 400, { error: friendlyError(err) });
    }
    return;
  }
  const file = normalize(join(root, path === '/' ? 'index.html' : path));
  if (!file.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': types[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
      'content-security-policy':
        "default-src 'self'; connect-src 'self' wss://api.derivws.com https://api.derivws.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:",
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
  }
});

server.listen(port, host, () => {
  console.log(`STINCHEZ Analysis Desk running at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
});
