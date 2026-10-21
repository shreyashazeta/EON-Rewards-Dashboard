const crypto = require('crypto');
const { setCookie, STATE_COOKIE } = require('../../lib/session');

module.exports = async (req, res) => {
  const clientId = process.env.ATLASSIAN_CLIENT_ID;
  const publicUrl = process.env.PUBLIC_URL; // e.g. https://eon-jira-dashboards.vercel.app
  if (!clientId || !publicUrl) {
    return res.status(500).send('Missing ATLASSIAN_CLIENT_ID or PUBLIC_URL environment variable.');
  }

  const state = crypto.randomBytes(16).toString('hex');
  setCookie(res, STATE_COOKIE, state, { maxAge: 600 }); // 10 min to complete login

  // Where to send the user back after they log in — pass through so
  // /api/auth/login?returnTo=/sprint-health.html works.
  const returnTo = typeof req.query.returnTo === 'string' ? req.query.returnTo : '/';
  setCookie(res, 'eon_return_to', returnTo, { maxAge: 600 });

  const redirectUri = `${publicUrl}/api/auth/callback`;
  const params = new URLSearchParams({
    audience: 'api.atlassian.com',
    client_id: clientId,
    scope: 'read:me offline_access',
    redirect_uri: redirectUri,
    state,
    response_type: 'code',
    prompt: 'consent',
  });

  res.writeHead(302, { Location: `https://auth.atlassian.com/authorize?${params.toString()}` });
  res.end();
};
