const { searchAll, deriveTicketFields } = require('../lib/jira');
const { getSession } = require('../lib/session');
const { getProgram } = require('../lib/programs');

// Shared field list works for both stories and epics — deriveTicketFields()
// already checks two candidate fields for Dev ETA and two for QA ETA, which
// covers the fact that epics use customfield_11750 ("QA-ETA") while stories
// use customfield_10447 ("QA Expected Complete Date"). Confirmed directly
// against a live epic (EON-820) before shipping this.
const FIELDS = [
  'summary', 'issuetype', 'status', 'assignee', 'created', 'customfield_10021',
  'customfield_11798', 'customfield_11037', 'customfield_11749', 'customfield_10023',
  'customfield_10447', 'customfield_11750', 'duedate', 'fixVersions', 'components', 'labels', 'parent',
];

function setCors(res) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const session = getSession(req);
  if (!session) {
    return res.status(401).json({ error: 'Not signed in.', loginUrl: '/api/auth/login?returnTo=/hygiene.html' });
  }

  try {
    const programId = (req.query && req.query.program) || 'eon';
    const program = await getProgram(programId);
    if (!program) {
      return res.status(404).json({ error: `Unknown program "${programId}".` });
    }
    const LABELS = program.streams.map(s => s.label);

    const data = {};
    const epicData = {};

    for (const rawLabel of LABELS) {
      const label = rawLabel.trim();

      const storyJql = `project = "${program.projectKey}" AND labels = "${label}" AND issuetype != Epic ORDER BY updated DESC`;
      const storyIssues = await searchAll(storyJql, FIELDS);
      data[label] = storyIssues.map(deriveTicketFields);

      const epicJql = `project = "${program.projectKey}" AND labels = "${label}" AND issuetype = Epic ORDER BY updated DESC`;
      const epicIssues = await searchAll(epicJql, FIELDS);
      epicData[label] = epicIssues.map(deriveTicketFields);
    }

    res.status(200).json({
      meta: { dataPulledAt: new Date().toISOString(), program: program.id, programName: program.name, streams: program.streams },
      data,
      epicData,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
