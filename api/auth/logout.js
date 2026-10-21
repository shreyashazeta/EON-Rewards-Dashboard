const { clearCookie, SESSION_COOKIE } = require('../../lib/session');

module.exports = async (req, res) => {
  clearCookie(res, SESSION_COOKIE);
  res.status(200).json({ loggedOut: true });
};
