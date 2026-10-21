const { getSession } = require('../lib/session');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  const session = getSession(req);
  if (!session) {
    return res.status(401).json({ error: 'Not signed in.' });
  }

  res.status(200).json({
    aiSummaryEnabled: Boolean(process.env.ANTHROPIC_API_KEY),
  });
};
