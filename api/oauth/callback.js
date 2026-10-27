// Vercel function for /oauth/callback (rewritten from /oauth/callback in vercel.json).
import { handleOAuth } from '../../src/oauth.js';

export default async function handler(req, res) {
  await handleOAuth(req, res, '/oauth/callback');
}
