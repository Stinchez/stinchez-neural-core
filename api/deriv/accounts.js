// Vercel function for /api/deriv/accounts — the Deriv account proxy in src/oauth.js.
import { handleOAuth } from '../../src/oauth.js';

export default async function handler(req, res) {
  await handleOAuth(req, res, '/api/deriv/accounts');
}
