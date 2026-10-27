// Vercel function for /api/learn: reads a strategy source with Claude (src/learn.js).
import { friendlyError, learn } from '../src/learn.js';
import { sameOrigin } from '../src/oauth.js';

const send = (res, status, body) =>
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }).end(JSON.stringify(body));

async function readJson(req) {
  if (req.body && typeof req.body === 'object') return req.body; // parsed by Vercel
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
  // Other websites must not be able to spend this deployment's Claude credits.
  if (!sameOrigin(req)) return send(res, 403, { error: 'Cross-site request refused' });
  try {
    const body = await readJson(req);
    send(res, 200, await learn({ url: typeof body.url === 'string' ? body.url : undefined, text: typeof body.text === 'string' ? body.text : undefined }));
  } catch (err) {
    send(res, 400, { error: friendlyError(err) });
  }
}
