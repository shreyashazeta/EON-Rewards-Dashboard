const { getSession } = require('../../lib/session');
const { isAdmin } = require('../../lib/programs');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  const session = getSession(req);
  if (!session) {
    return res.status(200).json({ authenticated: false });
  }
  res.status(200).json({ authenticated: true, email: session.email, name: session.name, isAdmin: isAdmin(session) });
};
