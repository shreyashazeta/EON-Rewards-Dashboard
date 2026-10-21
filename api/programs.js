// Combined into one file deliberately — Vercel's Hobby plan hard-caps at
// 12 Serverless Functions per deployment for non-framework projects (every
// .js under api/ counts as its own function, nothing gets auto-bundled).
// Splitting list/add into two files pushed the project to 13 and broke every
// deployment with a generic-looking error. GET lists programs, POST adds one
// — same resource, different verbs, a natural single-file REST endpoint.
const { getSession } = require('../lib/session');
const { jiraFetch } = require('../lib/jira');
const { listPrograms, addProgram, updateProgram, deleteProgram, isAdmin } = require('../lib/programs');

function stripTags(s) { return String(s || '').replace(/<[^>]*>/g, ''); }

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOWED_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method === 'GET') {
    const suggest = req.query && req.query.suggest;
    const q = (req.query && req.query.q || '').trim();

    // Live suggestions while filling out the Add Program form — kept as a
    // branch on this same file rather than a new one, for the same reason
    // everything else here is combined: the Hobby plan's 12-function cap.
    if (suggest === 'labels') {
      if (!q) return res.status(200).json({ suggestions: [] });
      try {
        const data = await jiraFetch(`/rest/api/3/jql/autocompletedata/suggestions?fieldName=labels&fieldValue=${encodeURIComponent(q)}`);
        const suggestions = (data.results || []).map(r => stripTags(r.displayName || r.value)).filter(Boolean);
        return res.status(200).json({ suggestions });
      } catch (e) {
        return res.status(200).json({ suggestions: [] }); // suggestions are a nicety — never block the form on this failing
      }
    }

    if (suggest === 'boards') {
      if (!q) return res.status(200).json({ suggestions: [] });
      try {
        const data = await jiraFetch(`/rest/agile/1.0/board?name=${encodeURIComponent(q)}&maxResults=8`);
        const suggestions = (data.values || []).map(b => ({ id: b.id, name: b.name }));
        return res.status(200).json({ suggestions });
      } catch (e) {
        return res.status(200).json({ suggestions: [] });
      }
    }

    try {
      const programs = await listPrograms();
      return res.status(200).json({ programs });
    } catch (e) {
      return res.status(500).json({ error: 'Could not load program list.', detail: e.message });
    }
  }

  if (req.method === 'POST') {
    const session = getSession(req);
    if (!session) {
      return res.status(401).json({ error: 'Sign in before adding a program.' });
    }
    try {
      const { name, quarter, projectKey, boardId, streams } = req.body || {};
      const record = await addProgram({
        name, quarter, projectKey, boardId, streams,
        addedBy: session.email || session.name || 'unknown',
      });
      return res.status(201).json({ program: record });
    } catch (e) {
      // addProgram throws plain, readable Error messages for every validation
      // failure — safe to surface directly to the form rather than a generic
      // "something went wrong."
      return res.status(400).json({ error: e.message });
    }
  }

  if (req.method === 'PATCH') {
    const session = getSession(req);
    if (!session) {
      return res.status(401).json({ error: 'Sign in before editing a program.' });
    }
    try {
      const { id, name, quarter, projectKey, boardId, streams } = req.body || {};
      if (!id) return res.status(400).json({ error: 'Program id is required.' });
      const record = await updateProgram(id, { name, quarter, projectKey, boardId, streams });
      return res.status(200).json({ program: record });
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  }

  if (req.method === 'DELETE') {
    const session = getSession(req);
    if (!session) {
      return res.status(401).json({ error: 'Sign in before deleting a program.' });
    }
    // ADMIN_EMAILS unset = anyone signed in can delete (same zero-config
    // default as everything else); set it to restrict this specific,
    // irreversible action to a named list of emails.
    if (!isAdmin(session)) {
      return res.status(403).json({ error: 'Only an admin can delete a program. Ask your admin, or add your email to ADMIN_EMAILS.' });
    }
    try {
      const { id } = req.body || {};
      if (!id) return res.status(400).json({ error: 'Program id is required.' });
      const result = await deleteProgram(id);
      return res.status(200).json({ deleted: result });
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
  }

  res.status(405).json({ error: 'Use GET, POST, PATCH, or DELETE.' });
};
