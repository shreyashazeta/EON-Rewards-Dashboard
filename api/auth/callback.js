const { sign, setCookie, clearCookie, parseCookies, SESSION_COOKIE, STATE_COOKIE } = require('../../lib/session');

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

module.exports = async (req, res) => {
  const { code, state } = req.query;
  const cookies = parseCookies(req);

  if (!code || !state || state !== cookies[STATE_COOKIE]) {
    return res.status(400).send('Login failed: invalid or expired state. Please try logging in again.');
  }

  const clientId = (process.env.ATLASSIAN_CLIENT_ID || "").trim();
  const clientSecret = (process.env.ATLASSIAN_CLIENT_SECRET || "").trim();
  console.log("[auth-debug]", JSON.stringify({ idLen: clientId.length, idStart: clientId.slice(0, 4), secretLen: clientSecret.length, rawSecretLen: (process.env.ATLASSIAN_CLIENT_SECRET || "").length, secretStart: clientSecret.slice(0, 4), secretEnd: clientSecret.slice(-2), redirectUri: (process.env.PUBLIC_URL || "") + "/api/auth/callback" }));
  const publicUrl = process.env.PUBLIC_URL;
  const sessionSecret = process.env.SESSION_SECRET;
  const allowedDomain = process.env.ALLOWED_EMAIL_DOMAIN; // e.g. "zeta.tech" — leave unset to allow any Atlassian account

  if (!clientId || !clientSecret || !publicUrl || !sessionSecret) {
    return res.status(500).send('Missing one of ATLASSIAN_CLIENT_ID, ATLASSIAN_CLIENT_SECRET, PUBLIC_URL, SESSION_SECRET.');
  }

  try {
    const redirectUri = `${publicUrl}/api/auth/callback`;
    const tokenRes = await fetch('https://auth.atlassian.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      }),
    });
    if (!tokenRes.ok) {
      const body = await tokenRes.text().catch(() => '');
      return res.status(502).send(`Token exchange failed: ${tokenRes.status} ${body.slice(0, 300)}`);
    }
    const { access_token } = await tokenRes.json();

    const meRes = await fetch('https://api.atlassian.com/me', {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    if (!meRes.ok) {
      return res.status(502).send('Could not fetch your Atlassian profile.');
    }
    const me = await meRes.json(); // { account_id, email, name, picture }

    if (allowedDomain && !(me.email || '').toLowerCase().endsWith('@' + allowedDomain.toLowerCase())) {
      return res.status(403).send(`Access restricted to @${allowedDomain} accounts. Signed in as ${me.email}.`);
    }

    const session = sign(
      { email: me.email, name: me.name, accountId: me.account_id, exp: Date.now() + SESSION_TTL_MS },
      sessionSecret
    );
    setCookie(res, SESSION_COOKIE, session, { maxAge: SESSION_TTL_MS / 1000 });
    clearCookie(res, STATE_COOKIE);

    const returnTo = cookies['eon_return_to'] || '/';
    clearCookie(res, 'eon_return_to');

    res.writeHead(302, { Location: returnTo.startsWith('/') ? returnTo : '/' });
    res.end();
  } catch (err) {
    res.status(500).send('Login error: ' + err.message);
  }
};
