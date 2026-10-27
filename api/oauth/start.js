// Vercel function for /oauth/start (rewritten from /oauth/start in vercel.json).
import { handleOAuth } from '../../src/oauth.js';

export default async function handler(req, res) {
  await handleOAuth(req, res, '/oauth/start');
}
