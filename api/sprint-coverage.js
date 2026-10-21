const { jiraFetch, searchAll } = require('../lib/jira');
const { getSession } = require('../lib/session');
const { getProgram } = require('../lib/programs');

const FIELDS = ['summary', 'issuetype', 'status', 'assignee', 'labels'];

function setCors(res) {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const session = getSession(req);
  if (!session) {
    return res.status(401).json({ error: 'Not signed in.' });
  }

  try {
    const programId = (req.query && req.query.program) || 'eon';
    const program = await getProgram(programId);
    if (!program) {
      return res.status(404).json({ error: `Unknown program "${programId}".` });
    }
    const TRACKED_LABELS = program.streams.map(s => s.label);

    // Real sprint list straight from the board — not derived from already-labeled
    // tickets, so this catches sprints that have zero labeled tickets in them too.
    const boardSprints = await jiraFetch(`/rest/agile/1.0/board/${program.boardId}/sprint?state=active,closed&maxResults=50`);
    const sprints = (boardSprints.values || [])
      .sort((a, b) => new Date(b.startDate || 0) - new Date(a.startDate || 0))
      .slice(0, 4);

    const result = {};

    for (const sprint of sprints) {
      const issues = await searchAll(
        `project = ${program.projectKey} AND sprint = ${sprint.id} AND issuetype != Epic`,
        FIELDS,
        300
      );

      const untracked = issues.filter(iss => {
        const labels = (iss.fields.labels || []).map(l => l.toLowerCase());
        return !TRACKED_LABELS.some(t => labels.includes(t.toLowerCase()));
      });

      result[sprint.name] = {
        sprintId: sprint.id,
        sprintState: sprint.state,
        totalInSprint: issues.length,
        untrackedCount: untracked.length,
        untracked: untracked.map(iss => {
          const f = iss.fields;
          const a = f.assignee;
          return {
            k: iss.key,
            sum: f.summary,
            t: f.issuetype ? f.issuetype.name : null,
            status: f.status ? f.status.name : null,
            a: a ? a.displayName : 'Unassigned',
            labels: f.labels || [],
          };
        }),
      };
    }

    res.status(200).json({
      meta: { dataPulledAt: new Date().toISOString(), trackedLabels: TRACKED_LABELS },
      sprints: result,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
